import type { QueryShape, SortKey } from '../types.js';
import type { IndexInfo, SlowQuery } from './types.js';

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

function singular(s: string): string {
  if (s.endsWith('ies') && s.length > 4) return s.slice(0, -3) + 'y';
  if (/(ses|xes|zes|ches|shes)$/.test(s)) return s.slice(0, -2);
  if (s.endsWith('s') && !s.endsWith('ss') && s.length > 3) return s.slice(0, -1);
  return s;
}

/**
 * Resolve a collection/model name seen in code to a live table/collection name.
 * Handles Mongoose (User → users), Prisma (user → User), Django (Book → shop_book), snake/camel case.
 */
export function resolveTable(name: string | undefined, tables: Iterable<string>): string | undefined {
  if (!name) return undefined;
  const all = [...tables];
  const n = norm(name);
  const ns = singular(n);
  const exact = all.find((t) => t === name);
  if (exact) return exact;
  const byNorm = all.find((t) => norm(t) === n);
  if (byNorm) return byNorm;
  const bySingular = all.find((t) => singular(norm(t)) === ns);
  if (bySingular) return bySingular;
  // Django: <app>_<model>
  const byDjango = all.find((t) => t.includes('_') && singular(norm(t.split('_').pop()!)) === ns);
  return byDjango;
}

/** Does an index serve this filter + sort? Equality keys (any order) as the prefix, then sort keys in order. */
export function indexCovers(index: IndexInfo, filterKeys: string[], sortKeys: SortKey[]): boolean {
  const keys = index.keys.map((k) => k.key);
  const f = [...new Set(filterKeys)];
  if (!f.length && !sortKeys.length) return false;
  const prefix = keys.slice(0, f.length);
  if (f.some((k) => !prefix.includes(k))) return false;
  const rest = index.keys.slice(f.length, f.length + sortKeys.length);
  if (rest.length < sortKeys.length) return !sortKeys.length;
  const same = sortKeys.every((s, i) => rest[i].key === s.key && rest[i].dir === s.dir);
  const reversed = sortKeys.every((s, i) => rest[i].key === s.key && rest[i].dir === -s.dir);
  return same || reversed;
}

/** ESR order: equality fields, then sort fields. */
export function indexKeys(filterKeys: string[], sortKeys: SortKey[]): SortKey[] {
  const keys: SortKey[] = [...new Set(filterKeys)].map((key) => ({ key, dir: 1 as const }));
  for (const s of sortKeys) if (!keys.some((k) => k.key === s.key)) keys.push(s);
  return keys;
}

/** ESR-ordered index suggestion as a ready-to-run statement. */
export function suggestIndex(adapter: 'mongodb' | 'postgres', table: string, filterKeys: string[], sortKeys: SortKey[]): string | undefined {
  const keys = indexKeys(filterKeys, sortKeys);
  if (!keys.length) return undefined;
  if (adapter === 'mongodb') return `db.${table}.createIndex({ ${keys.map((k) => `${/^[A-Za-z_$][\w$]*$/.test(k.key) ? k.key : `"${k.key}"`}: ${k.dir}`).join(', ')} })`;
  return `CREATE INDEX CONCURRENTLY ON "${table}" (${keys.map((k) => `"${k.key}"${k.dir === -1 ? ' DESC' : ''}`).join(', ')});`;
}

/** Find the static shape that most likely produced a slow query seen by the database. */
export function matchSlowQuery(q: SlowQuery, shapes: QueryShape[], shapeTables: Map<string, string>): QueryShape | undefined {
  if (!q.table) return undefined;
  const set = new Set(q.filterKeys);
  let best: { s: QueryShape; score: number } | undefined;
  for (const s of shapes) {
    if (shapeTables.get(s.id) !== q.table) continue;
    const overlap = s.filterKeys.filter((k) => set.has(k)).length;
    const exact = overlap === set.size && overlap === new Set(s.filterKeys).size;
    const sortMatch = q.sortKeys.length > 0 && q.sortKeys.every((k, i) => s.sortKeys[i]?.key === k.key);
    const score = (exact ? 10 : overlap) + (sortMatch ? 3 : 0) + (s.inLoop ? 1 : 0);
    if (score > 0 && (!best || score > best.score)) best = { s, score };
  }
  return best?.s;
}

export function redactUri(uri: string): string {
  return uri.replace(/\/\/([^:@/]+):([^@/]*)@/, '//$1:****@');
}

/** Replace any credential that leaked into an error message. */
export function redactText(text: string, uri: string): string {
  const m = /\/\/([^:@/]+):([^@/]*)@/.exec(uri);
  let out = text.split(uri).join(redactUri(uri));
  if (m && m[2]) {
    out = out.split(m[2]).join('****');
    try { out = out.split(decodeURIComponent(m[2])).join('****'); } catch { /* ignore */ }
  }
  return out;
}
