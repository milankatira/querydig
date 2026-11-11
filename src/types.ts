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
  lang: LangId;
  file: string;
  line: number;
  column: number;
  snippet: string;
  message: string;
  fix: string;
  confidence: Confidence;
  fingerprint: string;
}

export interface FileResult {
  file: string;
  findings: Finding[];
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
}
