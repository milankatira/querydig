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
