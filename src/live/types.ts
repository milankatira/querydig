import type { QueryShape, SortKey } from '../types.js';

export type AdapterName = 'mongodb' | 'postgres';

export interface TableInfo { name: string; rows: number; sizeBytes?: number }

export interface IndexInfo {
  table: string;
  name: string;
  keys: SortKey[];
  unique: boolean;
  primary: boolean;
  /** number of recorded uses; undefined when the database does not expose it */
  usage?: number;
  definition?: string;
}

export interface PlanSummary {
  table: string;
  fullScan: boolean;
  inMemorySort: boolean;
  indexUsed?: string;
  estRows?: number;
  docsExamined?: number;
  ms?: number;
  /** short human readable plan, e.g. "COLLSCAN" or "IXSCAN status_1 → FETCH" */
  text: string;
}

export interface SlowQuery {
  table?: string;
  filterKeys: string[];
  sortKeys: SortKey[];
  meanMs: number;
  calls: number;
  text: string;
  plan?: string;
  docsExamined?: number;
}

export interface ForeignKey { table: string; column: string; refTable: string }

export interface LiveData {
  adapter: AdapterName;
  database: string;
  tables: Map<string, TableInfo>;
  indexes: IndexInfo[];
  /** plan per static shape id */
  plans: Map<string, PlanSummary>;
  /** static shape id -> resolved live table name */
  shapeTables: Map<string, string>;
  slow: SlowQuery[];
  fks: ForeignKey[];
  explained: number;
  warnings: string[];
}

export interface LiveOptions {
  uri: string;
  db?: string;
  slowMs: number;
  explainExecute: boolean;
  maxExplain: number;
  timeoutMs: number;
}

export interface LiveAdapter {
  readonly name: AdapterName;
  readonly database: string;
  connect(): Promise<void>;
  tables(): Promise<TableInfo[]>;
  indexes(tables: string[]): Promise<IndexInfo[]>;
  foreignKeys(): Promise<ForeignKey[]>;
  explain(shape: QueryShape, table: string): Promise<PlanSummary | null>;
  slowQueries(slowMs: number): Promise<SlowQuery[]>;
  warnings(): Promise<string[]>;
  close(): Promise<void>;
}
