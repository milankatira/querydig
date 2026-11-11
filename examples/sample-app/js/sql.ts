import { PrismaClient } from '@prisma/client';
import { Pool } from 'pg';
const prisma = new PrismaClient();
const pool = new Pool();

export async function posts() {
  const users = await prisma.user.findMany();
  for (const u of users) {
    const p = await prisma.post.findMany({ where: { authorId: u.id } });
  }
}

export async function raw(ids: number[]) {
  for (const id of ids) {
    await pool.query('SELECT * FROM users WHERE id = $1', [id]);
  }
  await pool.query(`SELECT id FROM users WHERE lower(email) = $1`, ['a']);
  await pool.query("SELECT id FROM products WHERE name LIKE '%phone%'");
  await pool.query('SELECT id FROM events ORDER BY created_at OFFSET $1 LIMIT 20', [100]);
  await pool.query('DELETE FROM sessions');
  await pool.query('SELECT id FROM users ORDER BY RANDOM() LIMIT 1');
}
