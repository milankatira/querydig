import type { Finding, LiveSummary, QueryShape } from '../types.js';
import { correlate } from './correlate.js';
import { redactText, redactUri, resolveTable } from './match.js';
import { MongoAdapter } from './mongo.js';
import { PostgresAdapter } from './postgres.js';
import type { LiveAdapter, LiveData, LiveOptions, PlanSummary } from './types.js';

export type { LiveOptions } from './types.js';
export { correlate } from './correlate.js';
export { redactUri } from './match.js';

export function adapterFor(opts: LiveOptions): LiveAdapter {
  if (/^mongodb(\+srv)?:\/\//i.test(opts.uri)) return new MongoAdapter(opts);
  if (/^postgres(ql)?:\/\//i.test(opts.uri)) return new PostgresAdapter(opts);
  throw new Error('Unsupported --uri. Use mongodb://, mongodb+srv://, postgres:// or postgresql://');
}

async function pool<T, R>(items: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx]);
    }
  }));
  return out;
}

/** Connect, collect evidence for the static shapes, and return it. Always closes the connection. */
export async function collectLive(shapes: QueryShape[], opts: LiveOptions, adapter: LiveAdapter = adapterFor(opts)): Promise<LiveData> {
  try {
    await adapter.connect();
    const tableList = await adapter.tables();
    const tables = new Map(tableList.map((t) => [t.name, t]));
    const relevantDb = adapter.name === 'mongodb' ? 'mongodb' : 'sql';
    const shapeTables = new Map<string, string>();
    for (const s of shapes) {
      if (s.db !== relevantDb && s.db !== 'unknown') continue;
      const t = resolveTable(s.collection, tables.keys());
      if (t) shapeTables.set(s.id, t);
    }
    const used = [...new Set(shapeTables.values())];
    const indexes = await adapter.indexes(adapter.name === 'mongodb' ? used.length ? used : [...tables.keys()] : [...tables.keys()]);
    const fks = await adapter.foreignKeys().catch(() => [] as LiveData["fks"]);

    // dedupe identical shapes, then explain each once
    const groups = new Map<string, QueryShape[]>();
    for (const s of shapes) {
      const t = shapeTables.get(s.id);
      if (!t) continue;
      const key = `${t}|${[...s.filterKeys].sort().join(',')}|${s.sortKeys.map((k) => k.key + k.dir).join(',')}|${s.kind}|${s.hasLimit}|${s.sql ?? ''}`;
      (groups.get(key) ?? groups.set(key, []).get(key)!).push(s);
    }
    const plans = new Map<string, PlanSummary>();
    const work = [...groups.values()].slice(0, opts.maxExplain);
    let explained = 0;
    await pool(work, adapter.name === "postgres" ? 1 : 4, async (group) => {
      const s = group[0];
      try {
        const p = await adapter.explain(s, shapeTables.get(s.id)!);
        if (p) {
          explained++;
          for (const g of group) plans.set(g.id, p);
        }
      } catch {
        /* a shape that can't be planned (unknown column, permissions) is skipped */
      }
    });

    const slow = await adapter.slowQueries(opts.slowMs).catch(() => [] as LiveData["slow"]);
    const warnings: string[] = await adapter.warnings().catch(() => [] as string[]);
    if (groups.size > opts.maxExplain) warnings.push(`Explained ${opts.maxExplain} of ${groups.size} query shapes (raise with --max-explain).`);
    if (!shapeTables.size && shapes.length) warnings.push(`None of the ${shapes.length} queries in the code matched a ${adapter.name === 'mongodb' ? 'collection' : 'table'} in ${adapter.database}. Is this the right database?`);

    return { adapter: adapter.name, database: adapter.database, tables, indexes, plans, shapeTables, slow, fks, explained, warnings };
  } catch (e) {
    throw new Error(redactText((e as Error).message, opts.uri));
  } finally {
    await adapter.close();
  }
}

/** Collect live evidence and merge it into the findings. */
export async function runLive(findings: Finding[], shapes: QueryShape[], opts: LiveOptions): Promise<{ findings: Finding[]; summary: LiveSummary }> {
  const adapterName = /^mongodb/i.test(opts.uri) ? 'mongodb' : 'postgres';
  try {
    const data = await collectLive(shapes, opts);
    return {
      findings: correlate(findings, shapes, data),
      summary: { adapter: data.adapter, database: data.database, tables: data.tables.size, explained: data.explained, slowQueries: data.slow.length, warnings: data.warnings },
    };
  } catch (e) {
    return { findings, summary: { adapter: adapterName, database: '', tables: 0, explained: 0, slowQueries: 0, warnings: [], error: `${(e as Error).message} (${redactUri(opts.uri)})` } };
  }
}
