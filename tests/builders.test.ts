import { describe, expect, it } from 'vitest';
import { analyzeSource } from '../src/analyzer.js';

const run = async (src: string) => analyzeSource(src, { relPath: 'x.ts', lang: 'typescript' });
const ids = async (src: string) => (await run(src)).map((f) => f.ruleId).sort();

const DRIZZLE = "import { eq, ilike, inArray } from 'drizzle-orm';\nimport { db } from './db';\n";
const KYSELY = "import { Kysely } from 'kysely';\n";
const SUPABASE = "import { createClient } from '@supabase/supabase-js';\nconst supabase = createClient(url, key);\n";
const PRISMA = "import { PrismaClient } from '@prisma/client';\nconst prisma = new PrismaClient();\n";

describe('Drizzle', () => {
  it('flags select chains in a loop (N+1)', async () => {
    const f = await run(DRIZZLE + 'for (const id of ids) { await db.select().from(users).where(eq(users.id, id)); }');
    const q = f.find((x) => x.ruleId === 'QD001');
    expect(q?.db).toBe('sql');
    expect(q?.message).toContain('users.select');
    expect(q?.fix).toMatch(/inArray/);
  });

  it('flags a query per row of another select as QD002', async () => {
    expect(await ids(DRIZZLE + `async function a() {
      const rows = await db.select().from(users).where(eq(users.active, true));
      for (const u of rows) { await db.query.posts.findMany({ where: eq(posts.authorId, u.id), limit: 5 }); }
    }`)).toEqual(['QD002']);
  });

  it('flags inserts and updates in a loop', async () => {
    expect(await ids(DRIZZLE + 'for (const p of items) { await db.insert(posts).values(p); await tx.update(posts).set(p).where(eq(posts.id, p.id)); }'))
      .toEqual(['QD003', 'QD003']);
  });

  it('flags unbounded selects but not filtered, limited, aggregate or composed ones', async () => {
    expect(await ids(DRIZZLE + 'async function a() { return db.select().from(users); }')).toEqual(['SQ001']);
    expect(await ids(DRIZZLE + 'async function a() { return db.select().from(users).orderBy(users.id); }')).toEqual(['SQ001']);
    expect(await ids(DRIZZLE + 'async function a() { await db.select().from(users).where(eq(users.id, 1)); }')).toEqual([]);
    expect(await ids(DRIZZLE + 'async function a() { await db.select().from(users).limit(10); }')).toEqual([]);
    expect(await ids(DRIZZLE + 'async function a() { await db.select({ n: count() }).from(users); }')).toEqual([]);
    expect(await ids(DRIZZLE + 'function a() { const q = db.select().from(users); return q.where(x); }')).toEqual([]);
  });

  it('flags leading-wildcard ilike and large offsets', async () => {
    expect(await ids(DRIZZLE + 'async function a(t) { await db.select().from(users).where(ilike(users.name, `%${t}%`)).limit(20); }')).toEqual(['SQ003']);
    expect(await ids(DRIZZLE + 'async function a(t) { await db.select().from(users).where(ilike(users.name, `${t}%`)).limit(20); }')).toEqual([]);
    expect(await ids(DRIZZLE + 'async function a(page) { await db.select().from(users).limit(20).offset(page * 20); }')).toEqual(['SQ005']);
    expect(await ids(DRIZZLE + 'async function a() { await db.select().from(users).limit(20).offset(20); }')).toEqual([]);
  });

  it('flags deeply nested with', async () => {
    expect(await ids(DRIZZLE + 'await db.query.users.findMany({ limit: 10, with: { posts: { with: { comments: { with: { author: true } } } } } });'))
      .toEqual(['SQ011']);
    expect(await ids(DRIZZLE + 'await db.query.users.findMany({ limit: 10, with: { posts: { with: { comments: true } } } });')).toEqual([]);
  });

  it('ignores select/from on non-database receivers', async () => {
    expect(await ids(DRIZZLE + 'for (const el of els) { el.select(); input.select(); Array.from(el); }')).toEqual([]);
  });
});

describe('Kysely', () => {
  it('flags queries and writes in loops', async () => {
    expect(await ids(KYSELY + `for (const id of ids) {
      await db.selectFrom('person').selectAll().where('id', '=', id).executeTakeFirst();
      await db.deleteFrom('pet').where('owner_id', '=', id).execute();
    }`)).toEqual(['QD001', 'QD003']);
  });

  it('flags unbounded executed reads, leading wildcards and offsets', async () => {
    expect(await ids(KYSELY + "await db.selectFrom('person').selectAll().execute();")).toEqual(['SQ001']);
    expect(await ids(KYSELY + "await db.selectFrom('person').selectAll().where('id', '=', 1).execute();")).toEqual([]);
    expect(await ids(KYSELY + "const q = db.selectFrom('person').selectAll();")).toEqual([]);
    expect(await ids(KYSELY + "await db.selectFrom('person').selectAll().where('name', 'like', `%${t}`).limit(5).execute();")).toEqual(['SQ003']);
    expect(await ids(KYSELY + "await db.selectFrom('person').selectAll().limit(10).offset(n).execute();")).toEqual(['SQ005']);
  });
});

describe('Supabase', () => {
  it('flags from() queries in a loop and over previous results', async () => {
    expect(await ids(SUPABASE + "for (const id of ids) { await supabase.from('profiles').select('*').eq('id', id).single(); }")).toEqual(['QD001']);
    const f = await run(SUPABASE + `async function a() {
      const { data: orders } = await supabase.from('orders').select('id').eq('status', 'open');
      for (const o of orders) { await supabase.from('items').select('*').eq('order_id', o.id); }
    }`);
    expect(f.map((x) => x.ruleId)).toEqual(['QD002']);
    expect(f[0].fix).toMatch(/\.in\(/);
  });

  it('treats insert/update/delete chains as writes and rpc as a query', async () => {
    expect(await ids(SUPABASE + "for (const r of rows) { await supabase.from('items').update({ done: true }).eq('id', r.id); }")).toEqual(['QD003']);
    expect(await ids(SUPABASE + "await Promise.all(ids.map((id) => supabase.rpc('touch', { id })));")).toEqual(['QD001']);
  });

  it('flags unbounded selects only when executed as written', async () => {
    expect(await ids(SUPABASE + "async function a() { const { data } = await supabase.from('posts').select('*').order('created_at'); }")).toEqual(['SQ001']);
    expect(await ids(SUPABASE + "async function a() { await supabase.from('posts').select('*').range(0, 9); }")).toEqual([]);
    expect(await ids(SUPABASE + "async function a() { await supabase.from('posts').select('*', { count: 'exact', head: true }); }")).toEqual([]);
    expect(await ids(SUPABASE + "function a() { let q = supabase.from('posts').select('*'); if (x) q = q.eq('a', x); return q; }")).toEqual([]);
    expect(await ids(SUPABASE + "async function a() { await supabase.from('posts').select('id').ilike('title', `%${t}%`).limit(10); }")).toEqual(['SQ003']);
  });

  it('ignores storage and non-string from()', async () => {
    expect(await ids(SUPABASE + "for (const f of files) { await supabase.storage.from('avatars').upload(f.name, f); Readable.from(f); }")).toEqual([]);
  });
});

describe('Prisma relation depth', () => {
  it('flags include nested 3+ levels deep', async () => {
    expect(await ids(PRISMA + 'await prisma.user.findMany({ take: 10, include: { posts: { include: { comments: { include: { author: true } } } } } });'))
      .toEqual(['SQ011']);
    expect(await ids(PRISMA + 'await prisma.user.findMany({ take: 10, include: { posts: { include: { comments: true } } } });')).toEqual([]);
    expect(await ids(PRISMA + 'await prisma.token.findFirst({ where: { t }, include: { team: { include: { org: { include: { owner: true } } } } } });')).toEqual([]);
  });

  it('server action N+1 via Promise.all(map(async …))', async () => {
    expect(await ids(PRISMA + "export async function act(ids) { 'use server'; return Promise.all(ids.map(async (id) => await prisma.user.findUnique({ where: { id } }))); }"))
      .toEqual(['QD001']);
  });
});
