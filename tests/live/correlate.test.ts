import { describe, expect, it } from 'vitest';
import { sqlShape } from '../../src/analyzer.js';
import { correlate } from '../../src/live/correlate.js';
import { indexCovers, matchSlowQuery, redactText, redactUri, resolveTable, suggestIndex } from '../../src/live/match.js';
import { filterFields, summarisePlan } from '../../src/live/mongo.js';
import { summarisePgPlan } from '../../src/live/postgres.js';
import type { IndexInfo, LiveData, PlanSummary } from '../../src/live/types.js';
import type { Finding, QueryShape } from '../../src/types.js';

const shape = (o: Partial<QueryShape>): QueryShape => ({
  id: 's1', db: 'mongodb', collection: 'Order', method: 'find', kind: 'readMany', filterKeys: [], sortKeys: [],
  hasLimit: false, inLoop: false, file: 'src/a.ts', line: 10, ...o,
});
const finding = (o: Partial<Finding>): Finding => ({
  ruleId: 'QD001', title: 't', severity: 'high', db: 'mongodb', lang: 'typescript', file: 'src/a.ts', line: 10, column: 1,
  snippet: 'x', message: 'm', fix: 'f', confidence: 'high', fingerprint: 'fp', shapeId: 's1', ...o,
});
const plan = (o: Partial<PlanSummary>): PlanSummary => ({ table: 'orders', fullScan: false, inMemorySort: false, text: 'x', ...o });
const data = (o: Partial<LiveData> = {}): LiveData => ({
  adapter: 'mongodb', database: 'shop', tables: new Map([['orders', { name: 'orders', rows: 300_000 }], ['products', { name: 'products', rows: 50 }]]),
  indexes: [], plans: new Map(), shapeTables: new Map([['s1', 'orders']]), slow: [], fks: [], explained: 0, warnings: [], ...o,
});

describe('match', () => {
  it('resolves code names to live names', () => {
    const t = ['users', 'order_items', 'shop_book', 'User', 'categories'];
    expect(resolveTable('User', ['users'])).toBe('users');
    expect(resolveTable('user', ['User'])).toBe('User');
    expect(resolveTable('OrderItem', t)).toBe('order_items');
    expect(resolveTable('Book', t)).toBe('shop_book');
    expect(resolveTable('Category', t)).toBe('categories');
    expect(resolveTable('Nope', t)).toBeUndefined();
  });

  it('checks index coverage in ESR order', () => {
    const idx: IndexInfo = { table: 'o', name: 'i', keys: [{ key: 'status', dir: 1 }, { key: 'createdAt', dir: -1 }], unique: false, primary: false };
    expect(indexCovers(idx, ['status'], [{ key: 'createdAt', dir: -1 }])).toBe(true);
    expect(indexCovers(idx, ['status'], [{ key: 'createdAt', dir: 1 }])).toBe(true); // reversed scan
    expect(indexCovers(idx, ['userId'], [])).toBe(false);
    expect(indexCovers(idx, [], [{ key: 'createdAt', dir: -1 }])).toBe(false);
  });

  it('suggests ready-to-run indexes', () => {
    expect(suggestIndex('mongodb', 'orders', ['status'], [{ key: 'createdAt', dir: -1 }])).toBe('db.orders.createIndex({ status: 1, createdAt: -1 })');
    expect(suggestIndex('postgres', 'events', [], [{ key: 'created_at', dir: -1 }])).toBe('CREATE INDEX CONCURRENTLY ON "events" ("created_at" DESC);');
  });

  it('matches slow queries to shapes', () => {
    const shapes = [shape({ id: 'a', filterKeys: ['status'] }), shape({ id: 'b', filterKeys: ['userId'] })];
    const st = new Map([['a', 'orders'], ['b', 'orders']]);
    expect(matchSlowQuery({ table: 'orders', filterKeys: ['userId'], sortKeys: [], meanMs: 200, calls: 3, text: '' }, shapes, st)?.id).toBe('b');
    expect(matchSlowQuery({ table: 'other', filterKeys: ['userId'], sortKeys: [], meanMs: 200, calls: 3, text: '' }, shapes, st)).toBeUndefined();
  });

  it('redacts credentials', () => {
    const uri = 'postgres://app:s3cr%40t@db.example.com:5432/shop';
    expect(redactUri(uri)).toBe('postgres://app:****@db.example.com:5432/shop');
    const msg = redactText(`password authentication failed for s3cr@t at ${uri}`, uri);
    expect(msg).not.toContain('s3cr');
  });
});

describe('plan parsing', () => {
  it('summarises MongoDB plans (classic and SBE)', () => {
    expect(summarisePlan({ stage: 'COLLSCAN' }, 'o').fullScan).toBe(true);
    const p = summarisePlan({ queryPlan: { stage: 'SORT', inputStage: { stage: 'FETCH', inputStage: { stage: 'IXSCAN', indexName: 'status_1' } } } }, 'o');
    expect(p).toMatchObject({ fullScan: false, inMemorySort: true, indexUsed: 'status_1' });
    expect(p.text).toBe('IXSCAN status_1 → FETCH → SORT');
    expect(filterFields({ status: 'a', $or: [{ x: 1 }, { y: { $gt: 1 } }] })).toEqual(['status', 'x', 'y']);
  });

  it('summarises Postgres plans', () => {
    const p = summarisePgPlan({ 'Node Type': 'Sort', 'Plan Rows': 9, Plans: [{ 'Node Type': 'Seq Scan', 'Relation Name': 'events' }] }, 'events');
    expect(p).toMatchObject({ fullScan: true, inMemorySort: true, estRows: 9 });
    expect(summarisePgPlan({ 'Node Type': 'Index Scan', 'Index Name': 'users_pkey' }, 'users').indexUsed).toBe('users_pkey');
  });

  it('extracts SQL shapes', () => {
    expect(sqlShape('SELECT id FROM "Users" u WHERE u.email = $1 AND status IN ($2) ORDER BY created_at DESC LIMIT 5'))
      .toEqual({ table: 'Users', filterKeys: ['email', 'status'], sortKeys: [{ key: 'created_at', dir: -1 }], hasLimit: true });
  });
});

describe('correlate', () => {
  it('promotes an N+1 whose inner query is a full scan of a big table', () => {
    const out = correlate([finding({})], [shape({ inLoop: true, filterKeys: ['userId'] })], data({ plans: new Map([['s1', plan({ fullScan: true, text: 'COLLSCAN' })]]) }));
    expect(out[0].severity).toBe('critical');
    expect(out[0].evidence?.severityChange).toEqual({ from: 'high', to: 'critical' });
    expect(out[0].fix).toContain('db.orders.createIndex({ userId: 1 })');
    expect(out.filter((f) => f.ruleId === 'LV001')).toHaveLength(0); // not reported twice
  });

  it('keeps an indexed N+1 at its severity but explains it', () => {
    const out = correlate([finding({})], [shape({ inLoop: true })], data({ plans: new Map([['s1', plan({ indexUsed: '_id_', text: 'IXSCAN _id_' })]]) }));
    expect(out[0].severity).toBe('high');
    expect(out[0].evidence?.note).toContain('uses an index');
  });

  it('demotes unbounded reads on tiny collections and promotes huge ones', () => {
    const tiny = correlate([finding({ ruleId: 'MQ001' })], [shape({})], data({ shapeTables: new Map([['s1', 'products']]) }));
    expect(tiny[0].severity).toBe('low');
    const huge = correlate([finding({ ruleId: 'MQ001' })], [shape({})], data({ tables: new Map([['orders', { name: 'orders', rows: 5_000_000 }]]) }));
    expect(huge[0].severity).toBe('critical');
  });

  it('demotes sort-without-limit when an index already serves it', () => {
    const idx: IndexInfo = { table: 'orders', name: 'status_1_createdAt_-1', keys: [{ key: 'status', dir: 1 }, { key: 'createdAt', dir: -1 }], unique: false, primary: false };
    const out = correlate([finding({ ruleId: 'MQ005', severity: 'medium' })], [shape({ filterKeys: ['status'], sortKeys: [{ key: 'createdAt', dir: -1 }] })], data({ indexes: [idx] }));
    expect(out[0].severity).toBe('low');
  });

  it('adds LV001, LV002, LV003, LV004 and LV005', () => {
    const shapes = [
      shape({ id: 'scan', filterKeys: ['status'] }),
      shape({ id: 'sort', filterKeys: [], sortKeys: [{ key: 'createdAt', dir: -1 }] }),
      shape({ id: 'fk', db: 'sql', collection: 'posts', filterKeys: ['authorId'], inLoop: true, line: 42 }),
    ];
    const out = correlate([], shapes, data({
      shapeTables: new Map([['scan', 'orders'], ['sort', 'orders'], ['fk', 'orders']]),
      plans: new Map([['scan', plan({ fullScan: true, text: 'COLLSCAN' })], ['sort', plan({ inMemorySort: true, indexUsed: 'x', text: 'IXSCAN x → SORT' })]]),
      slow: [{ table: 'orders', filterKeys: ['status'], sortKeys: [], meanMs: 1500, calls: 4, text: '{}' }, { table: 'ghost', filterKeys: [], sortKeys: [], meanMs: 300, calls: 1, text: '{}' }],
      indexes: [{ table: 'orders', name: 'old_1', keys: [{ key: 'old', dir: 1 }], unique: false, primary: false, usage: 0 }, { table: 'orders', name: '_id_', keys: [{ key: '_id', dir: 1 }], unique: true, primary: true, usage: 0 }],
      fks: [{ table: 'orders', column: 'authorId', refTable: 'users' }],
    }));
    const ids = out.map((f) => f.ruleId).sort();
    expect(ids).toEqual(['LV001', 'LV002', 'LV003', 'LV003', 'LV004', 'LV005']);
    const slow = out.filter((f) => f.ruleId === 'LV003');
    expect(slow.find((f) => f.file === 'src/a.ts')?.severity).toBe('critical');
    expect(slow.find((f) => f.file === 'db://shop/ghost')?.line).toBe(0);
    expect(out.find((f) => f.ruleId === 'LV005')?.line).toBe(42);
  });

  it('does nothing for shapes it cannot resolve', () => {
    const f = finding({});
    expect(correlate([f], [shape({})], data({ shapeTables: new Map() }))).toEqual([f]);
  });
});
