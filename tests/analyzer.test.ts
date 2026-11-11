import { describe, expect, it } from 'vitest';
import { analyzeSource } from '../src/analyzer.js';
import type { LangId } from '../src/types.js';

const run = async (src: string, lang: LangId = 'typescript') => analyzeSource(src, { relPath: `x.${lang}`, lang });
const ids = async (src: string, lang: LangId = 'typescript') => (await run(src, lang)).map((f) => f.ruleId).sort();

const MONGOOSE = "import mongoose from 'mongoose';\n";

describe('JS/TS — loops', () => {
  it('flags N+1 inside for..of', async () => {
    const f = await run(MONGOOSE + 'async function a(ids){ for (const id of ids) { await User.findById(id); } }');
    expect(f.map((x) => x.ruleId)).toContain('QD001');
    expect(f.find((x) => x.ruleId === 'QD001')!.severity).toBe('high');
  });

  it('flags nested query over results as critical', async () => {
    const f = await run(MONGOOSE + `async function a(){
      const users = await User.find({ active: true }).select('a').lean();
      for (const u of users) { await Order.find({ userId: u._id }).select('a').lean(); }
    }`);
    const q = f.find((x) => x.ruleId === 'QD002');
    expect(q?.severity).toBe('critical');
    expect(q?.db).toBe('mongodb');
  });

  it('flags queries inside .map callbacks (Promise.all)', async () => {
    expect(await ids(MONGOOSE + 'const r = await Promise.all(ids.map((id) => User.findOne({ _id: id }).lean()));')).toContain('QD001');
  });

  it('escalates nested loops to critical', async () => {
    const f = await run(MONGOOSE + 'for (const a of as) { for (const b of bs) { await X.findOne({ a, b }).lean(); } }');
    expect(f.find((x) => x.ruleId === 'QD001')?.severity).toBe('critical');
  });

  it('flags writes in loops', async () => {
    expect(await ids(MONGOOSE + 'for (const i of items) { await Item.updateOne({ _id: i.id }, { $set: { p: 1 } }); }')).toContain('QD003');
    expect(await ids(MONGOOSE + 'for (const u of users) { await u.save(); }')).toContain('QD003');
  });

  it('ignores polling while loops and for(;;)', async () => {
    expect(await ids(MONGOOSE + 'while (true) { const j = await Job.findOneAndUpdate({ s: 1 }, { s: 2 }); }')).toEqual([]);
    expect(await ids(MONGOOSE + 'for (;;) { await Job.findOne({ s: 1 }).lean(); }')).toEqual([]);
  });

  it('ignores loops over collections / models', async () => {
    expect(await ids('collections.map((collection) => collection.deleteMany({}))')).not.toContain('QD003');
    expect(await ids('for (const c of names) { await db.collection(c).drop(); await db.collection(c).deleteMany({}); }')).not.toContain('QD003');
  });

  it('does not flag array helpers', async () => {
    expect(await ids('for (const x of xs) { ys.find((y) => y === x); arr.filter(Boolean); m.delete(x); }')).toEqual([]);
    expect(await ids('Object.create(null); str.find("x");')).toEqual([]);
  });

  it('respects inline suppressions', async () => {
    expect(await ids(MONGOOSE + 'for (const id of ids) {\n  await User.findById(id); // querydig-ignore QD001\n}')).toEqual([]);
    expect(await ids(MONGOOSE + 'for (const id of ids) {\n  // querydig-ignore\n  await User.findById(id);\n}')).toEqual([]);
  });
});

describe('JS/TS — MongoDB query shape', () => {
  it('unbounded find', async () => {
    expect(await ids(MONGOOSE + 'Product.find({}).lean()')).toContain('MQ001');
    expect(await ids(MONGOOSE + 'Product.find().lean()')).toContain('MQ001');
    expect(await ids(MONGOOSE + 'Product.find({}).limit(10).lean()')).not.toContain('MQ001');
  });

  it('regex', async () => {
    const f = await run(MONGOOSE + 'User.find({ name: /john/ }).select("a").lean()');
    expect(f.find((x) => x.ruleId === 'MQ002')?.severity).toBe('high');
    expect(await ids(MONGOOSE + 'User.find({ name: /^john/ }).select("a").lean()')).not.toContain('MQ002');
    expect(await ids(MONGOOSE + 'User.find({ name: { $regex: q, $options: "i" } }).select("a").lean()')).toContain('MQ002');
    const ci = await run(MONGOOSE + 'User.find({ name: /^john/i }).select("a").lean()');
    expect(ci.find((x) => x.ruleId === 'MQ002')?.severity).toBe('medium');
  });

  it('$where', async () => {
    expect(await ids(MONGOOSE + 'Order.find({ $where: "this.a > 1" }).limit(1).select("a").lean()')).toContain('MQ003');
  });

  it('skip pagination', async () => {
    expect(await ids(MONGOOSE + 'P.find({ a: 1 }).skip(page * 20).limit(20).select("a").lean()')).toContain('MQ004');
    expect(await ids(MONGOOSE + 'P.find({ a: 1 }).skip(5).limit(20).select("a").lean()')).not.toContain('MQ004');
  });

  it('sort without limit suggests index with direction', async () => {
    const f = await run(MONGOOSE + 'P.find({ status: "x" }).sort({ createdAt: -1 }).select("a").lean()');
    const s = f.find((x) => x.ruleId === 'MQ005');
    expect(s?.fix).toContain('status: 1, createdAt: -1');
  });

  it('aggregation stage order', async () => {
    expect(await ids(MONGOOSE + 'O.aggregate([{ $lookup: { from: "u" } }, { $match: { a: 1 } }])')).toContain('MQ006');
    expect(await ids(MONGOOSE + 'O.aggregate([{ $match: { a: 1 } }, { $lookup: { from: "u" } }])')).not.toContain('MQ006');
  });

  it('count for existence', async () => {
    expect(await ids(MONGOOSE + 'if ((await O.countDocuments({ a: 1 })) > 0) {}')).toContain('MQ008');
    expect(await ids(MONGOOSE + 'const n = await O.countDocuments({ a: 1 });')).not.toContain('MQ008');
  });

  it('deep populate', async () => {
    expect(await ids(MONGOOSE + 'P.findOne({ a: 1 }).populate({ path: "a", populate: { path: "b" } }).lean()')).toContain('MQ007');
  });
});

describe('SQL', () => {
  it('raw query in loop + string rules', async () => {
    const r = await ids(`import { Pool } from 'pg'; const pool = new Pool();
      for (const id of ids) { await pool.query('SELECT * FROM users WHERE id = $1', [id]); }`);
    expect(r).toEqual(['QD001', 'SQ002']);
  });

  it('string rules', async () => {
    expect(await ids(`q("SELECT id FROM p WHERE name LIKE '%x%'")`)).toContain('SQ003');
    expect(await ids(`q('DELETE FROM sessions')`)).toContain('SQ004');
    expect(await ids('q(`SELECT a FROM t ${where}`)')).not.toContain('SQ004');
    expect(await ids(`q('SELECT a FROM t WHERE lower(email) = $1')`)).toContain('SQ006');
    expect(await ids(`q('SELECT a FROM t ORDER BY RANDOM() LIMIT 1')`)).toContain('SQ007');
    expect(await ids(`q('SELECT a FROM t WHERE x = 1 OFFSET $1 LIMIT 10')`)).toContain('SQ005');
    expect(await ids(`label('Select a user from the list')`)).toEqual([]);
  });

  it('prisma unbounded + nested', async () => {
    const r = await run(`import { PrismaClient } from '@prisma/client';
      const users = await prisma.user.findMany();
      for (const u of users) { await prisma.post.findMany({ where: { authorId: u.id } }); }`);
    expect(r.map((x) => x.ruleId).sort()).toEqual(['QD002', 'SQ001']);
  });
});

describe('Python', () => {
  it('pymongo N+1 over cursor', async () => {
    const r = await ids(`from pymongo import MongoClient
orders = db.orders.find({"s": 1}, {"a": 1})
for o in orders:
    db.users.find_one({"_id": o["u"]})
`, 'python');
    expect(r).toContain('QD002');
  });

  it('django manager in comprehension', async () => {
    expect(await ids('from django.db import models\nx = [Book.objects.get(pk=i) for i in ids]\n', 'python')).toContain('QD001');
  });

  it('ignores str.find and dict.get', async () => {
    expect(await ids('for s in xs:\n    s.find("a")\n    d.get("k")\n', 'python')).toEqual([]);
  });

  it('unbounded find and regex', async () => {
    const r = await ids('import pymongo\nlist(db.p.find({}))\ndb.u.find({"n": {"$regex": q}}, {"n": 1})\n', 'python');
    expect(r).toEqual(['MQ001', 'MQ002']);
  });
});

describe('Go', () => {
  const head = 'package x\nimport "go.mongodb.org/mongo-driver/bson"\n';

  it('mongo N+1 in cursor.Next loop', async () => {
    const r = await ids(head + `func f() {
  cur, _ := c.Find(ctx, bson.M{"a": 1}, opts)
  for cur.Next(ctx) { u.FindOne(ctx, bson.M{"_id": 1}) }
}`, 'go');
    expect(r).toContain('QD002');
  });

  it('range loop writes and sql', async () => {
    const r = await ids(head + `func f() {
  for _, it := range items { coll.UpdateOne(ctx, bson.M{"_id": it.ID}, u) }
  for _, id := range ids { db.QueryRow("SELECT name FROM users WHERE id = $1", id) }
}`, 'go');
    expect(r).toEqual(['QD001', 'QD003']);
  });

  it('polling for {} is not N+1', async () => {
    expect(await ids(head + 'func f() { for { coll.FindOne(ctx, bson.M{"s": 1}) } }', 'go')).toEqual([]);
  });

  it('unbounded Find', async () => {
    expect(await ids(head + 'func f() { coll.Find(ctx, bson.M{}) }', 'go')).toContain('MQ001');
  });
});

describe('regressions', () => {
  it('python_objects.get is not a Django manager', async () => {
    expect(await ids('for n in names:\n    python_objects.get(n)\n', 'python')).toEqual([]);
  });
  it('Go batching loop without condition is not N+1', async () => {
    expect(await ids('package x\nfunc f() { for start := 0; ; start += 50 { sess.Limit(50, start).Find(&u) } }', 'go')).toEqual([]);
  });
  it('loop over model subclasses is not N+1', async () => {
    expect(await ids('from django.db import models\nfor MC in Metric.__subclasses__():\n    MC.objects.get(slug=s)\n', 'python')).toEqual([]);
  });
});
