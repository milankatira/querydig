import type { QueryShape, SortKey } from '../types.js';
import type { ForeignKey, IndexInfo, LiveAdapter, LiveOptions, PlanSummary, SlowQuery, TableInfo } from './types.js';

type Doc = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const keysOf = (spec: Doc | undefined): SortKey[] =>
  Object.entries(spec ?? {}).map(([key, v]) => ({ key, dir: (Number(v) === -1 ? -1 : 1) as 1 | -1 }));

/** Top-level field names of a filter, flattening $and / $or and skipping operators. */
export function filterFields(filter: Doc | undefined): string[] {
  const out = new Set<string>();
  const walk = (f: Doc | undefined) => {
    if (!f || typeof f !== 'object') return;
    for (const [k, v] of Object.entries(f)) {
      if (k === '$and' || k === '$or' || k === '$nor') (Array.isArray(v) ? v : []).forEach(walk);
      else if (!k.startsWith('$')) out.add(k);
    }
  };
  walk(filter);
  return [...out];
}

/** Walk a winning plan (classic or SBE `queryPlan`) and summarise it. */
export function summarisePlan(plan: Doc | undefined, table: string): Omit<PlanSummary, 'estRows' | 'docsExamined' | 'ms'> {
  const stages: string[] = [];
  let fullScan = false;
  let inMemorySort = false;
  let indexUsed: string | undefined;
  const walk = (n: Doc | undefined) => {
    if (!n || typeof n !== 'object') return;
    const node = n.queryPlan ?? n;
    const stage: string | undefined = node.stage;
    if (stage) {
      stages.push(stage === 'IXSCAN' && node.indexName ? `IXSCAN ${node.indexName}` : stage);
      if (stage === 'COLLSCAN') fullScan = true;
      if (stage === 'SORT') inMemorySort = true;
      if ((stage === 'IXSCAN' || stage === 'COUNT_SCAN' || stage === 'DISTINCT_SCAN') && node.indexName) indexUsed ??= node.indexName;
      if (stage === 'IDHACK' || stage === 'EXPRESS_IXSCAN' || stage === 'EXPRESS_CLUSTERED_IXSCAN') indexUsed ??= '_id_';
    }
    walk(node.inputStage);
    (node.inputStages ?? []).forEach(walk);
  };
  walk(plan);
  return { table, fullScan, inMemorySort, indexUsed, text: stages.reverse().join(' → ') || 'unknown' };
}

export class MongoAdapter implements LiveAdapter {
  readonly name = 'mongodb' as const;
  database = '';
  private client: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  private db: any; // eslint-disable-line @typescript-eslint/no-explicit-any

  constructor(private opts: LiveOptions) {}

  async connect(): Promise<void> {
    let mod: typeof import('mongodb');
    try {
      mod = await import('mongodb');
    } catch {
      throw new Error('The "mongodb" driver is not installed. Run: npm i -D mongodb');
    }
    this.client = new mod.MongoClient(this.opts.uri, {
      appName: 'querydig',
      readPreference: 'secondaryPreferred',
      serverSelectionTimeoutMS: 8000,
      connectTimeoutMS: 8000,
      retryWrites: false,
    });
    await this.client.connect();
    const fromUri = (this.client.options?.dbName as string | undefined) ?? undefined;
    const name = this.opts.db ?? (fromUri && fromUri !== 'test' ? fromUri : undefined);
    if (!name) throw new Error('No database name in the URI. Add it to the path (mongodb://host/mydb) or pass --db <name>.');
    this.database = name;
    this.db = this.client.db(name);
  }

  private get t() {
    return this.opts.timeoutMs;
  }

  async tables(): Promise<TableInfo[]> {
    const cols: Doc[] = await this.db.listCollections({ type: 'collection' }, { nameOnly: true }).toArray();
    const names = cols.map((c) => c.name as string).filter((n) => !n.startsWith('system.'));
    const out: TableInfo[] = [];
    for (const name of names) {
      try {
        out.push({ name, rows: await this.db.collection(name).estimatedDocumentCount({ maxTimeMS: this.t }) });
      } catch {
        out.push({ name, rows: 0 });
      }
    }
    return out;
  }

  async indexes(tables: string[]): Promise<IndexInfo[]> {
    const out: IndexInfo[] = [];
    for (const table of tables) {
      const coll = this.db.collection(table);
      let list: Doc[] = [];
      try {
        list = await coll.listIndexes().toArray();
      } catch {
        continue;
      }
      const usage = new Map<string, number>();
      try {
        const stats: Doc[] = await coll.aggregate([{ $indexStats: {} }], { maxTimeMS: this.t }).toArray();
        for (const s of stats) usage.set(s.name, (usage.get(s.name) ?? 0) + Number(s.accesses?.ops ?? 0));
      } catch {
        /* $indexStats needs clusterMonitor on some deployments */
      }
      for (const i of list) {
        out.push({
          table, name: i.name, keys: keysOf(i.key), unique: !!i.unique, primary: i.name === '_id_',
          usage: usage.size ? usage.get(i.name) ?? 0 : undefined, definition: `${i.name} ${JSON.stringify(i.key)}`,
        });
      }
    }
    return out;
  }

  async foreignKeys(): Promise<ForeignKey[]> {
    return [];
  }

  async explain(shape: QueryShape, table: string): Promise<PlanSummary | null> {
    if (!['read', 'readMany', 'count'].includes(shape.kind)) return null;
    const filter = Object.fromEntries(shape.filterKeys.map((k) => [k, null]));
    const sort = Object.fromEntries(shape.sortKeys.map((k) => [k.key, k.dir]));
    const verbosity = this.opts.explainExecute ? 'executionStats' : 'queryPlanner';
    const cursor = this.db.collection(table).find(filter, { sort: shape.sortKeys.length ? sort : undefined, limit: shape.hasLimit ? 1 : undefined, maxTimeMS: this.t });
    const res: Doc = await cursor.explain(verbosity);
    const qp = res.queryPlanner ?? res.stages?.[0]?.$cursor?.queryPlanner;
    const sum = summarisePlan(qp?.winningPlan, table);
    const es = res.executionStats;
    return { ...sum, docsExamined: es?.totalDocsExamined, ms: es?.executionTimeMillis };
  }

  async slowQueries(slowMs: number): Promise<SlowQuery[]> {
    let level = 0;
    try {
      const p = await this.db.command({ profile: -1 });
      level = Number(p.was ?? 0);
    } catch {
      return [];
    }
    const prof = this.db.collection('system.profile');
    let rows: Doc[] = [];
    try {
      rows = await prof.aggregate([
        { $match: { millis: { $gte: slowMs }, op: { $in: ['query', 'command', 'getmore', 'update', 'remove'] }, appName: { $ne: 'querydig' }, ns: { $not: /\.system\./ } } },
        { $group: { _id: { ns: '$ns', h: { $ifNull: ['$queryHash', '$planCacheShapeHash'] } }, calls: { $sum: 1 }, ms: { $avg: '$millis' }, ex: { $avg: '$docsExamined' }, cmd: { $first: '$command' }, plan: { $first: '$planSummary' } } },
        { $sort: { ms: -1 } },
        { $limit: 50 },
      ], { maxTimeMS: this.t }).toArray();
    } catch {
      return [];
    }
    if (!rows.length && level === 0) return [];
    return rows.map((r) => {
      const ns: string = r._id.ns ?? '';
      const table = ns.includes('.') ? ns.slice(ns.indexOf('.') + 1) : undefined;
      const cmd: Doc = r.cmd ?? {};
      const filter = cmd.filter ?? cmd.q ?? cmd.query ?? cmd.pipeline?.[0]?.$match;
      return {
        table, filterKeys: filterFields(filter), sortKeys: keysOf(cmd.sort), meanMs: Number(r.ms), calls: Number(r.calls),
        text: JSON.stringify({ [Object.keys(cmd)[0] ?? 'op']: table, filter: filter ?? {}, ...(cmd.sort ? { sort: cmd.sort } : {}) }),
        plan: r.plan, docsExamined: r.ex != null ? Math.round(r.ex) : undefined,
      };
    });
  }

  async warnings(): Promise<string[]> {
    const w: string[] = [];
    try {
      const p = await this.db.command({ profile: -1 });
      if (Number(p.was ?? 0) === 0) w.push(`Profiling is off on ${this.database}, so slow queries (LV003) can't be read. Enable with db.setProfilingLevel(1, { slowms: 100 }) on a replica.`);
    } catch { /* not permitted */ }
    try {
      const s = await this.db.command({ connectionStatus: 1, showPrivileges: true });
      const users = s.authInfo?.authenticatedUsers ?? [];
      const privs: Doc[] = s.authInfo?.authenticatedUserPrivileges ?? [];
      const writes = privs.some((p) => (p.actions ?? []).some((a: string) => ['insert', 'update', 'remove', 'dropCollection', 'createIndex'].includes(a)));
      if (!users.length) w.push('Connected without authentication. querydig only sends read commands, but prefer a user with the built-in "read" role.');
      else if (writes) w.push('The connected user can write. querydig only sends read commands, but a user with the built-in "read" role is safer.');
    } catch { /* ignore */ }
    return w;
  }

  async close(): Promise<void> {
    await this.client?.close().catch(() => undefined);
  }
}
