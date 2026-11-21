import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyFixes } from '../src/fix.js';
import { planIndexes, renderIndexScript } from '../src/indexes.js';
import { scan } from '../src/scan.js';
import type { Finding, SuggestedIndex } from '../src/types.js';

function project(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), 'querydig-fix-'));
  for (const [f, c] of Object.entries(files)) writeFileSync(join(dir, f), c);
  return dir;
}

describe('--fix', () => {
  it('adds .lean() before exec(), is idempotent, and supports dry runs', async () => {
    const src = "import mongoose from 'mongoose';\nexport const a = () => P.find({ x: 1 }).sort({ y: 1 });\nexport const b = () => O.find({ s: 1 }).limit(5).exec();\n";
    const root = project({ 'a.ts': src });
    const s = await scan({ root, threads: 1 });

    const dry = applyFixes(root, s.findings, { dryRun: true });
    expect(dry.changes).toHaveLength(2);
    expect(readFileSync(join(root, 'a.ts'), 'utf8')).toBe(src);

    applyFixes(root, s.findings);
    const out = readFileSync(join(root, 'a.ts'), 'utf8');
    expect(out).toContain('P.find({ x: 1 }).sort({ y: 1 }).lean();');
    expect(out).toContain('O.find({ s: 1 }).limit(5).lean().exec();');

    const again = await scan({ root, threads: 1 });
    expect(again.findings.filter((f) => f.ruleId === 'MQ011')).toHaveLength(0);
  });

  it('never adds .lean() in files that mutate documents', async () => {
    const root = project({ 'b.ts': "import mongoose from 'mongoose';\nconst us = await User.find({ a: 1 });\nfor (const u of us) { u.n = 1; await u.save(); }\n" });
    const s = await scan({ root, threads: 1 });
    expect(applyFixes(root, s.findings).changes).toHaveLength(0);
  });
});

describe('--fix: existence checks (MQ008 / SQ009)', () => {
  /** scan a one-file project, apply the fixes, return the new content and a re-scan */
  async function fixFile(name: string, src: string, rule: string) {
    const root = project({ [name]: src });
    const s = await scan({ root, threads: 1 });
    const found = s.findings.filter((f) => f.ruleId === rule);
    const res = applyFixes(root, found);
    const out = readFileSync(join(root, name), 'utf8');
    const again = (await scan({ root, threads: 1 })).findings.filter((f) => f.ruleId === rule);
    return { found, res, out, again };
  }

  it('Mongoose: countDocuments(f) compared with 0 gets .limit(1)', async () => {
    const src = "import mongoose from 'mongoose';\nexport async function a(u) {\n  if ((await Order.countDocuments({ u })) > 0) return 1;\n  return !(await Order.countDocuments({ v: u }).exec());\n}\n";
    const { res, out, again } = await fixFile('m.ts', src, 'MQ008');
    expect(res.changes).toHaveLength(2);
    expect(out).toContain('if ((await Order.countDocuments({ u }).limit(1)) > 0) return 1;');
    expect(out).toContain('return !(await Order.countDocuments({ v: u }).limit(1).exec());');
    expect(again).toHaveLength(0);
  });

  it('Node driver: countDocuments(f) gets { limit: 1 } as options', async () => {
    const src = "import { MongoClient } from 'mongodb';\nexport const a = async () => (await db.collection('o').countDocuments({ a: 1 })) !== 0;\nexport const b = async () => (await users.countDocuments()) === 0;\n";
    const { out, again } = await fixFile('n.ts', src, 'MQ008');
    expect(out).toContain("db.collection('o').countDocuments({ a: 1 }, { limit: 1 })) !== 0;");
    expect(out).toContain('users.countDocuments({}, { limit: 1 })) === 0;');
    expect(again).toHaveLength(0);
  });

  it('MQ008: no autofix when the count matters or options are already passed', async () => {
    const src = "import mongoose from 'mongoose';\nexport async function a() {\n  if ((await Order.countDocuments({ a: 1 })) > 1) return 1;\n  if ((await Order.countDocuments({ a: 1 }, cb)) > 0) return 2;\n  const n = await Order.countDocuments({ a: 1 });\n  return n;\n}\nexport const c = async () => (await db.collection('o').countDocuments({ a: 1 }, { session })) > 0;\n";
    const { found, res, out } = await fixFile('neg.ts', src, 'MQ008');
    expect(found.length).toBeGreaterThan(0);
    expect(found.every((f) => !f.autofix)).toBe(true);
    expect(res.changes).toHaveLength(0);
    expect(out).toBe(src);
  });

  it('PyMongo / Motor: count_documents(f) gets limit=1', async () => {
    const src = 'from pymongo import MongoClient\n\nasync def a(db, u):\n    if await db.orders.count_documents({"u": u}) > 0:\n        return 1\n    return db.users.count_documents({"u": u}, session=s) == 0\n';
    const { out, again } = await fixFile('p.py', src, 'MQ008');
    expect(out).toContain('if await db.orders.count_documents({"u": u}, limit=1) > 0:');
    expect(out).toContain('return db.users.count_documents({"u": u}, session=s, limit=1) == 0');
    expect(again).toHaveLength(0);
  });

  it('PyMongo: no autofix for == 1 or **kwargs', async () => {
    const src = 'from pymongo import MongoClient\nif db.orders.count_documents({"u": 1}) == 1:\n    pass\nif db.orders.count_documents({"u": 1}, **opts) > 0:\n    pass\n';
    const { res, out } = await fixFile('p2.py', src, 'MQ008');
    expect(res.changes).toHaveLength(0);
    expect(out).toBe(src);
  });

  it('Go driver: SetLimit(1) only when options is already imported', async () => {
    const body = 'func f() bool {\n\tn, _ := coll.CountDocuments(ctx, bson.M{"a": 1})\n\treturn n > 0\n}\n';
    const withOpts = 'package x\n\nimport (\n\t"go.mongodb.org/mongo-driver/bson"\n\t"go.mongodb.org/mongo-driver/mongo/options"\n)\n\nvar _ = options.Find\n\n' + body;
    const { out, again } = await fixFile('a.go', withOpts, 'MQ008');
    expect(out).toContain('coll.CountDocuments(ctx, bson.M{"a": 1}, options.Count().SetLimit(1))');
    expect(again).toHaveLength(0);

    const noOpts = 'package x\n\nimport "go.mongodb.org/mongo-driver/bson"\n\n' + body;
    const r2 = await fixFile('b.go', noOpts, 'MQ008');
    expect(r2.found).toHaveLength(1);
    expect(r2.found[0].autofix).toBeUndefined();
    expect(r2.out).toBe(noOpts);

    // n is used for more than a 0 test: not an existence check at all
    const used = 'package x\n\nimport "go.mongodb.org/mongo-driver/bson"\n\nfunc f() int64 {\n\tn, _ := coll.CountDocuments(ctx, bson.M{"a": 1})\n\tif n > 0 {\n\t\treturn n\n\t}\n\treturn 0\n}\n';
    expect((await fixFile('c.go', used, 'MQ008')).found).toHaveLength(0);
  });

  it('Django: count() / len() used as existence checks become .exists()', async () => {
    const src = [
      'from django.db import models',
      '',
      'def a(u):',
      '    if Order.objects.filter(user=u).count() > 0:',
      '        pass',
      '    if Order.objects.filter(user=u).count() == 0:',
      '        pass',
      '    if u.order_set.count():',
      '        pass',
      '    ok = len(Order.objects.filter(user=u)) >= 1',
      '    none = not Order.objects.exclude(user=u).count()',
      '    return 0 != Order.objects.filter(user=u).count() and ok',
      '',
    ].join('\n');
    const { res, out, again } = await fixFile('d.py', src, 'SQ009');
    expect(res.changes).toHaveLength(6);
    expect(out).toBe([
      'from django.db import models',
      '',
      'def a(u):',
      '    if Order.objects.filter(user=u).exists():',
      '        pass',
      '    if not Order.objects.filter(user=u).exists():',
      '        pass',
      '    if u.order_set.exists():',
      '        pass',
      '    ok = Order.objects.filter(user=u).exists()',
      '    none = not Order.objects.exclude(user=u).exists()',
      '    return Order.objects.filter(user=u).exists() and ok',
      '',
    ].join('\n'));
    expect(again).toHaveLength(0);
  });

  it('Django: no rewrite when the count matters, for annotated querysets, or for plain variables', async () => {
    const src = 'from django.db import models\nif Order.objects.filter(a=1).count() > 1:\n    pass\nn = Order.objects.filter(a=1).count()\nif qs.count() > 0:\n    pass\nif Order.objects.values("a").annotate(c=Count("id")).filter(c__gt=1).count() > 0:\n    pass\n';
    const { found, res, out } = await fixFile('e.py', src, 'SQ009');
    expect(found.map((f) => f.line)).toEqual([7]);
    expect(found[0].autofix).toBeUndefined();
    expect(res.changes).toHaveLength(0);
    expect(out).toBe(src);
  });

  it('a negated comparison inside a larger expression is parenthesised', async () => {
    const src = 'from django.db import models\nx = [Order.objects.filter(a=1).count() == 0]\n';
    const { out } = await fixFile('f.py', src, 'SQ009');
    expect(out).toBe('from django.db import models\nx = [(not Order.objects.filter(a=1).exists())]\n');
  });

  it('.lean() and existence fixes coexist in one file', async () => {
    const src = "import mongoose from 'mongoose';\nexport const a = async () => { const xs = await P.find({ x: 1 }); return (await P.countDocuments({ x: 1 })) > 0 && xs; };\n";
    const root = project({ 'g.ts': src });
    const s = await scan({ root, threads: 1 });
    applyFixes(root, s.findings);
    const out = readFileSync(join(root, 'g.ts'), 'utf8');
    expect(out).toContain('await P.find({ x: 1 }).lean();');
    expect(out).toContain('await P.countDocuments({ x: 1 }).limit(1)) > 0');
    const again = await scan({ root, threads: 1 });
    expect(again.findings.filter((f) => f.ruleId === 'MQ011' || f.ruleId === 'MQ008')).toHaveLength(0);
  });
});

describe('applyFixes', () => {
  const fx = (offset: number, insert: string, deleteLength?: number, line = 1) =>
    ({ ruleId: 'XX000', file: 'z.txt', line, autofix: { offset, insert, deleteLength, description: insert } }) as unknown as Finding;

  it('applies only one of two overlapping replacements', () => {
    const root = project({ 'z.txt': 'abcdefghij\n' });
    const res = applyFixes(root, [fx(2, 'XY', 4), fx(4, 'Q', 4)]);
    expect(res.changes).toHaveLength(1);
    expect(res.applied).toHaveLength(1);
    expect(readFileSync(join(root, 'z.txt'), 'utf8')).toBe('abcdQij\n');
  });

  it('applies a replacement and an insert in the same file', () => {
    const root = project({ 'z.txt': 'count() > 0\nfind()\n' });
    const res = applyFixes(root, [fx(0, 'exists()', 11), fx(18, '.lean()', undefined, 2)]);
    expect(res.changes.map((c) => [c.line, c.before, c.after])).toEqual([[1, 'count() > 0', 'exists()'], [2, 'find()', 'find().lean()']]);
    expect(readFileSync(join(root, 'z.txt'), 'utf8')).toBe('exists()\nfind().lean()\n');
  });

  it('shows the whole text of a replacement that spans lines', () => {
    const root = project({ 'z.txt': 'a(\n  b\n) > 0\n' });
    const res = applyFixes(root, [fx(0, 'ok()', 12)], { dryRun: true });
    expect(res.changes[0].before).toBe('a(\n  b\n) > 0');
    expect(res.changes[0].after).toBe('ok()');
    expect(readFileSync(join(root, 'z.txt'), 'utf8')).toBe('a(\n  b\n) > 0\n');
  });
});

describe('--emit-indexes', () => {
  const ix = (table: string, keys: [string, 1 | -1][]): SuggestedIndex => ({
    adapter: 'mongodb', database: 'shop', table, keys: keys.map(([key, dir]) => ({ key, dir })),
    statement: `db.${table}.createIndex({ ${keys.map(([k, d]) => `${k}: ${d}`).join(', ')} })`,
  });
  const f = (rule: string, line: number, suggestedIndex: SuggestedIndex) => ({ ruleId: rule, file: 'a.ts', line, suggestedIndex }) as unknown as Finding;

  it('dedupes and folds prefix indexes into longer ones', () => {
    const plans = planIndexes([
      f('LV001', 1, ix('orders', [['status', 1]])),
      f('LV002', 2, ix('orders', [['status', 1], ['createdAt', -1]])),
      f('LV001', 3, ix('orders', [['status', 1], ['createdAt', -1]])),
      f('LV001', 4, ix('orders', [['userId', 1]])),
      f('LV001', 5, ix('users', [['status', 1]])),
    ]);
    expect(plans.map((p) => p.index.statement)).toEqual([
      'db.orders.createIndex({ status: 1, createdAt: -1 })',
      'db.orders.createIndex({ userId: 1 })',
      'db.users.createIndex({ status: 1 })',
    ]);
    expect(plans[0].reasons).toEqual(['LV002 a.ts:2', 'LV001 a.ts:3', 'LV001 a.ts:1']);
    const script = renderIndexScript(plans, '1.0.0');
    expect(script).toContain('db = db.getSiblingDB("shop");');
    expect(script).toContain('db.orders.createIndex({ userId: 1 });');
  });
});
