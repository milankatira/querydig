// Drizzle, Kysely and Supabase patterns querydig flags (see `npx querydig examples/sample-app`).
import { eq, ilike } from 'drizzle-orm';
import { createClient } from '@supabase/supabase-js';
import { db } from './db';
import { users, posts } from './schema';

const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_KEY!);

// Next.js server action: one query per author (QD002)
export async function authorsWithPosts() {
  'use server';
  const authors = await db.select().from(users).where(eq(users.active, true));
  return Promise.all(authors.map(async (a) => ({ ...a, posts: await db.query.posts.findMany({ where: eq(posts.authorId, a.id), limit: 5 }) })));
}

// Leading-wildcard search (SQ003)
export async function search(term: string) {
  return db.select().from(users).where(ilike(users.name, `%${term}%`)).limit(20);
}

// Supabase: one update per row (QD003) and an unbounded read (SQ001)
export async function closeOrders(ids: string[]) {
  for (const id of ids) await supabase.from('orders').update({ status: 'closed' }).eq('id', id);
  const { data } = await supabase.from('orders').select('*').order('created_at');
  return data;
}
