/**
 * Live-mode integration tests against real databases.
 * Run: docker compose -f docker-compose.test.yml up -d, seed (see tests/live/seed), then
 *      QUERYDIG_IT=1 npx vitest run tests/live/integration.test.ts
 */
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { scan } from '../../src/scan.js';

const IT = process.env.QUERYDIG_IT === '1';
const MONGO = process.env.QUERYDIG_IT_MONGO ?? 'mongodb://localhost:27018/shop';
const PG = process.env.QUERYDIG_IT_PG ?? 'postgres://postgres:querydig@localhost:54329/shop';
const root = new URL('../../examples/sample-app', import.meta.url).pathname;
const live = (uri: string, slowMs = 5) => ({ uri, slowMs, explainExecute: false, maxExplain: 200, timeoutMs: 5000 });

async function mongoWrites(): Promise<number> {
  const { MongoClient } = await import('mongodb');
  const c = new MongoClient(MONGO);
  await c.connect();
  const s = await c.db('admin').command({ serverStatus: 1 });
  await c.close();
  return Number(s.opcounters.insert) + Number(s.opcounters.update) + Number(s.opcounters.delete);
}

async function pgWrites(): Promise<number> {
  const pg = (await import('pg')).default;
  const c = new pg.Client({ connectionString: PG });
  await c.connect();
  await c.query('SELECT pg_stat_clear_snapshot()');
  const r = await c.query(`SELECT (sum(n_tup_ins + n_tup_upd + n_tup_del))::bigint AS n FROM pg_stat_user_tables`);
  await c.end();
  return Number(r.rows[0].n);
}

describe.skipIf(!IT)('live: MongoDB', () => {
  it('adds evidence, promotes, demotes and reports live-only findings without writing', async () => {
    const before = await mongoWrites();
    const s = await scan({ root, threads: 1, live: live(MONGO, 50) });
    const after = await mongoWrites();
    expect(after - before).toBeLessThanOrEqual(0);

    expect(s.live).toMatchObject({ adapter: 'mongodb', database: 'shop' });
    expect(s.live?.error).toBeUndefined();
    const at = (file: string, line: number, rule: string) => s.findings.find((f) => f.file === file && f.line === line && f.ruleId === rule);

    // N+1 over orders with an indexed inner query: explained, still critical (QD002 default)
    expect(at('js/orders.service.ts', 7, 'QD002')?.evidence?.note).toContain('uses an index');
    // inner query is a full scan of 300k orders: promoted, index suggested
    const inner = at('js/orders.service.ts', 15, 'QD002');
    expect(inner?.evidence?.note).toContain('full scan of orders');
    expect(inner?.fix).toContain('db.orders.createIndex({ userId: 1 })');
    // unindexed status filter on a big collection
    expect(at('js/orders.service.ts', 5, 'LV001')?.fix).toContain('db.orders.createIndex({ status: 1 })');
    // unbounded read of a 50-doc collection is demoted
    expect(at('js/orders.service.ts', 21, 'MQ001')?.severity).toBe('low');
    // unused index and profiler
    expect(s.findings.some((f) => f.ruleId === 'LV004' && f.message.includes('email_1'))).toBe(true);
    expect(s.findings.some((f) => f.ruleId === 'LV003' && f.evidence?.collection === 'orders')).toBe(true);
  }, 60_000);
});

describe.skipIf(!IT)('live: Postgres', () => {
  it('adds evidence and live-only findings inside read-only transactions', async () => {
    const before = await pgWrites();
    const s = await scan({ root, threads: 1, live: live(PG) });
    const after = await pgWrites();
    expect(after).toBe(before);

    expect(s.live).toMatchObject({ adapter: 'postgres', database: 'shop' });
    const at = (file: string, line: number, rule: string) => s.findings.find((f) => f.file === file && f.line === line && f.ruleId === rule);
    const prismaLoop = at('js/sql.ts', 9, 'QD002');
    expect(prismaLoop?.evidence?.note).toContain('full scan of posts');
    expect(at('js/sql.ts', 9, 'LV005')?.fix).toBe('CREATE INDEX CONCURRENTLY ON "posts" ("authorId");');
    expect(at('js/sql.ts', 7, 'SQ001')?.severity).toBe('low'); // 500 users
    expect(s.findings.some((f) => f.ruleId === 'LV004' && f.message.includes('users_name_idx'))).toBe(true);
    expect(s.findings.some((f) => f.ruleId === 'LV001' && f.evidence?.collection === 'events')).toBe(true);
  }, 60_000);

  it('never leaks the password when the connection fails', async () => {
    const s = await scan({ root, threads: 1, live: live('postgres://postgres:wrong-Secret-123@localhost:54329/shop') });
    expect(s.live?.error).toBeTruthy();
    expect(JSON.stringify(s)).not.toContain('wrong-Secret-123');
    expect(s.findings.length).toBeGreaterThan(0); // static findings still reported
  }, 30_000);
});

describe.skipIf(!IT)('live: CLI', () => {
  it('prints evidence lines', () => {
    const out = execFileSync('npx', ['tsx', 'src/cli.ts', root, '--uri', MONGO, '--limit', '0'], { encoding: 'utf8', cwd: new URL('../..', import.meta.url).pathname, env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0', CI: '' } });
    expect(out).toContain('live: mongodb shop');
    expect(out).toMatch(/live: .*COLLSCAN/);
  }, 60_000);
});
