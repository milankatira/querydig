export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info';
export const SEVERITIES: Severity[] = ['critical', 'high', 'medium', 'low', 'info'];
export const SEVERITY_RANK: Record<Severity, number> = { critical: 4, high: 3, medium: 2, low: 1, info: 0 };

export type Db = 'mongodb' | 'sql' | 'unknown';
export type LangId = 'javascript' | 'typescript' | 'tsx' | 'python' | 'go';
export type Confidence = 'high' | 'medium' | 'low';

export interface Finding {
  ruleId: string;
  title: string;
  severity: Severity;
  db: Db;
  lang: LangId | 'db';
  file: string;
  line: number;
  column: number;
  snippet: string;
  message: string;
  fix: string;
  confidence: Confidence;
  fingerprint: string;
  /** id of the static query shape this finding belongs to (for live correlation) */
  shapeId?: string;
  /** evidence gathered from a live database (--uri) */
  evidence?: Evidence;
}

export interface SortKey { key: string; dir: 1 | -1 }

/** A database call found in the code, described well enough to explain it against a live DB. */
export interface QueryShape {
  id: string;
  db: Db;
  orm?: string;
  collection?: string;
  method: string;
  kind: string;
  filterKeys: string[];
  sortKeys: SortKey[];
  hasLimit: boolean;
  inLoop: boolean;
  sql?: string;
  file: string;
  line: number;
}

export interface Evidence {
  source: 'explain' | 'profiler' | 'stats' | 'indexes';
  collection?: string;
  rows?: number;
  plan?: string;
  index?: string;
  ms?: number;
  docsExamined?: number;
  note: string;
  severityChange?: { from: Severity; to: Severity };
}

export interface FileResult {
  file: string;
  findings: Finding[];
  shapes?: QueryShape[];
  error?: string;
}

export interface LiveSummary {
  adapter: 'mongodb' | 'postgres';
  database: string;
  tables: number;
  explained: number;
  slowQueries: number;
  warnings: string[];
  error?: string;
}

export interface ScanSummary {
  root: string;
  filesScanned: number;
  durationMs: number;
  findings: Finding[];
  bySeverity: Record<Severity, number>;
  byRule: Record<string, number>;
  grade: string;
  score: number;
  suppressedByBaseline: number;
  errors: { file: string; error: string }[];
  version: string;
  live?: LiveSummary;
}
