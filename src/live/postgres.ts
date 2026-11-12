import { sqlShape } from '../analyzer.js';
import type { QueryShape } from '../types.js';
import type { ForeignKey, IndexInfo, LiveAdapter, LiveOptions, PlanSummary, SlowQuery, TableInfo } from './types.js';

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const SCHEMA_FILTER = `n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg_toast%'`;
const ident = (s: string) => `"${s.replace(/"/g, '""')}"`;

/** Summarise an EXPLAIN (FORMAT JSON) plan tree. */
export function summarisePgPlan(root: Row | undefined, table: string): PlanSummary {
  const stages: string[] = [];
  let fullScan = false;
  let inMemorySort = false;
  let indexUsed: string | undefined;
  const walk = (n: Row | undefined) => {
    if (!n) return;
    const t: string = n['Node Type'];
    const rel: string | undefined = n['Relation Name'];
    stages.push(t === 'Seq Scan' && rel ? `Seq Scan on ${rel}` : n['Index Name'] ? `${t} ${n['Index Name']}` : t);
    if (t === 'Seq Scan' && (!rel || rel === table)) fullScan = true;
    if (t === 'Sort' || t === 'Incremental Sort') inMemorySort = true;
    if (n['Index Name']) indexUsed ??= n['Index Name'];
    (n.Plans ?? []).forEach(walk);
  };
  walk(root);
  return {
    table, fullScan, inMemorySort, indexUsed, text: stages.join(' → ') || 'unknown',
    estRows: root?.['Plan Rows'], ms: root?.['Actual Total Time'] != null ? Math.round(root['Actual Total Time']) : undefined,
    docsExamined: undefined,
  };
}

export class PostgresAdapter implements LiveAdapter {
  readonly name = 'postgres' as const;
  database = '';
  private client: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  private version = 0;
  private columns = new Map<string, Set<string>>();

  constructor(private opts: LiveOptions) {}

  async connect(): Promise<void> {
    let pg: any; // eslint-disable-line @typescript-eslint/no-explicit-any
    try {
      pg = (await import('pg')).default;
    } catch {
      throw new Error('The "pg" driver is not installed. Run: npm i -D pg');
    }
    this.client = new pg.Client({ connectionString: this.opts.uri, application_name: 'querydig', connectionTimeoutMillis: 8000, statement_timeout: this.opts.timeoutMs });
    await this.client.connect();
    // every statement runs in its own read-only transaction
    await this.client.query('SET default_transaction_read_only = on');
    await this.client.query(`SET statement_timeout = ${Math.max(1000, Math.floor(this.opts.timeoutMs))}`);
    const r = await this.client.query(`SELECT current_database() AS db, current_setting('server_version_num')::int AS v`);
    this.database = r.rows[0].db;
    this.version = r.rows[0].v;
  }

  private async q(sql: string, params: unknown[] = []): Promise<Row[]> {
    return (await this.client.query(sql, params)).rows;
  }

  async tables(): Promise<TableInfo[]> {
    const rows = await this.q(`
      SELECT c.relname AS name, c.reltuples::bigint AS reltuples, COALESCE(s.n_live_tup, 0)::bigint AS live, pg_total_relation_size(c.oid)::bigint AS size
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      LEFT JOIN pg_stat_user_tables s ON s.relid = c.oid
      WHERE c.relkind IN ('r', 'p') AND ${SCHEMA_FILTER}`);
    const cols = await this.q(`
      SELECT c.relname AS t, a.attname AS col FROM pg_attribute a
      JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE a.attnum > 0 AND NOT a.attisdropped AND c.relkind IN ('r', 'p') AND ${SCHEMA_FILTER}`);
    for (const c of cols) (this.columns.get(c.t) ?? this.columns.set(c.t, new Set()).get(c.t)!).add(c.col);
    return rows.map((r) => ({ name: r.name, rows: Math.max(Number(r.reltuples), Number(r.live), 0), sizeBytes: Number(r.size) }));
  }

  async indexes(): Promise<IndexInfo[]> {
    const rows = await this.q(`
      SELECT t.relname AS tbl, i.relname AS idx, ix.indisunique AS uniq, ix.indisprimary AS pk, s.idx_scan AS scans,
             pg_get_indexdef(ix.indexrelid) AS def,
             ARRAY(SELECT a.attname FROM unnest(ix.indkey) WITH ORDINALITY k(attnum, ord)
                   JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum ORDER BY k.ord)::text[] AS cols,
             ARRAY(SELECT (o::int & 1) FROM unnest(ix.indoption) AS o)::int[] AS desc_flags
      FROM pg_index ix
      JOIN pg_class t ON t.oid = ix.indrelid JOIN pg_class i ON i.oid = ix.indexrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
      LEFT JOIN pg_stat_user_indexes s ON s.indexrelid = ix.indexrelid
      WHERE ${SCHEMA_FILTER}`);
    return rows.map((r) => ({
      table: r.tbl, name: r.idx, unique: r.uniq, primary: r.pk, usage: r.scans == null ? undefined : Number(r.scans), definition: r.def,
      keys: (r.cols as string[]).map((key, i) => ({ key, dir: (Number((r.desc_flags as number[])[i]) === 1 ? -1 : 1) as 1 | -1 })),
    }));
  }

  async foreignKeys(): Promise<ForeignKey[]> {
    const rows = await this.q(`
      SELECT cl.relname AS tbl, a.attname AS col, rt.relname AS ref
      FROM pg_constraint c
      JOIN pg_class cl ON cl.oid = c.conrelid JOIN pg_class rt ON rt.oid = c.confrelid
      JOIN pg_namespace n ON n.oid = cl.relnamespace
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
      WHERE c.contype = 'f' AND array_length(c.conkey, 1) = 1 AND ${SCHEMA_FILTER}`);
    return rows.map((r) => ({ table: r.tbl, column: r.col, refTable: r.ref }));
  }

  /** SQL to explain for a shape, or null when it can't be explained safely. */
  explainSql(shape: QueryShape, table: string): { sql: string; generic: boolean } | null {
    if (shape.sql) {
      const sql = shape.sql.trim().replace(/;\s*$/, '');
      if (!/^\s*(select|with)\b/i.test(sql) || /\?/.test(sql) || /;/.test(sql)) return null;
      return { sql, generic: /\$\d/.test(sql) };
    }
    if (!['read', 'readMany', 'count'].includes(shape.kind)) return null;
    const cols = this.columns.get(table);
    const filter = shape.filterKeys.filter((k) => cols?.has(k));
    const sort = shape.sortKeys.filter((k) => cols?.has(k.key));
    if (filter.length !== shape.filterKeys.length) return null; // column names differ from code names: don't guess
    const where = filter.length ? ` WHERE ${filter.map((k, i) => `${ident(k)} = $${i + 1}`).join(' AND ')}` : '';
    const order = sort.length ? ` ORDER BY ${sort.map((k) => `${ident(k.key)}${k.dir === -1 ? ' DESC' : ''}`).join(', ')}` : '';
    return { sql: `SELECT 1 FROM ${ident(table)}${where}${order}${shape.hasLimit ? ' LIMIT 1' : ''}`, generic: filter.length > 0 };
  }

  async explain(shape: QueryShape, table: string): Promise<PlanSummary | null> {
    const e = this.explainSql(shape, table);
    if (!e) return null;
    if (e.generic && this.version < 160000) return null; // GENERIC_PLAN needs PostgreSQL 16+
    const analyze = this.opts.explainExecute && !e.generic;
    const opts = ['FORMAT JSON', e.generic ? 'GENERIC_PLAN' : '', analyze ? 'ANALYZE' : ''].filter(Boolean).join(', ');
    const rows = await this.q(`EXPLAIN (${opts}) ${e.sql}`);
    const plan = rows[0]?.['QUERY PLAN']?.[0]?.Plan;
    return summarisePgPlan(plan, table);
  }

  async slowQueries(slowMs: number): Promise<SlowQuery[]> {
    const ext = await this.q(`SELECT 1 FROM pg_extension WHERE extname = 'pg_stat_statements'`);
    if (!ext.length) return [];
    let rows: Row[] = [];
    try {
      rows = await this.q(`
        SELECT query, calls, mean_exec_time AS mean FROM pg_stat_statements
        WHERE dbid = (SELECT oid FROM pg_database WHERE datname = current_database())
          AND mean_exec_time >= $1 AND query !~* '(pg_catalog|information_schema|pg_class|pg_stat|pg_index|pg_attribute|pg_constraint|pg_extension|pg_roles|pg_database|^\\s*(explain|set|show|begin|commit|rollback)\\b)'
        ORDER BY total_exec_time DESC LIMIT 50`, [slowMs]);
    } catch {
      return [];
    }
    return rows.map((r) => {
      const sh = sqlShape(r.query);
      return { table: sh.table, filterKeys: sh.filterKeys, sortKeys: sh.sortKeys, meanMs: Number(r.mean), calls: Number(r.calls), text: String(r.query).replace(/\s+/g, ' ').trim() };
    });
  }

  async warnings(): Promise<string[]> {
    const w: string[] = [];
    try {
      const ext = await this.q(`SELECT 1 FROM pg_extension WHERE extname = 'pg_stat_statements'`);
      if (!ext.length) w.push('pg_stat_statements is not installed, so slow queries (LV003) can\'t be read. Enable it with CREATE EXTENSION pg_stat_statements.');
      const r = await this.q(`SELECT rolsuper FROM pg_roles WHERE rolname = current_user`);
      const writes = await this.q(`SELECT count(*)::int AS n FROM information_schema.table_privileges WHERE grantee = current_user AND privilege_type IN ('INSERT', 'UPDATE', 'DELETE')`);
      if (r[0]?.rolsuper) w.push('Connected as a superuser. querydig runs every statement in a read-only transaction, but a role with pg_read_all_stats and SELECT is safer.');
      else if (writes[0]?.n > 0) w.push('The connected role can write. querydig runs every statement in a read-only transaction, but a read-only role is safer.');
      if (this.version < 160000) w.push(`PostgreSQL ${Math.floor(this.version / 10000)} can't plan parameterized queries; upgrade to 16+ for full explain coverage.`);
    } catch { /* ignore */ }
    return w;
  }

  async close(): Promise<void> {
    await this.client?.end().catch(() => undefined);
  }
}
