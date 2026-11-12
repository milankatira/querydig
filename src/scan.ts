import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import fg from 'fast-glob';
import ignore from 'ignore';
import { DEFAULT_IGNORE, TEST_IGNORE, type QuerydigConfig } from './config.js';
import { analyzeFile } from './fileAnalyzer.js';
import { SUPPORTED_EXTENSIONS } from './languages.js';
import { SEVERITIES, SEVERITY_RANK, type FileResult, type Finding, type ScanSummary, type Severity } from './types.js';
import { VERSION } from './version.js';
import type { LiveOptions } from './live/types.js';
import type { LiveSummary, QueryShape } from './types.js';

export interface ScanOptions extends QuerydigConfig {
  root: string;
  files?: string[];
  diff?: string;
  baseline?: Set<string> | Map<string, number>;
  threads?: number;
  onProgress?: (done: number, total: number) => void;
  /** connect to a live database for evidence (--uri) */
  live?: LiveOptions;
  onLiveStart?: () => void;
}

export async function listFiles(opts: ScanOptions): Promise<string[]> {
  const root = resolve(opts.root);
  const patterns = opts.include?.length ? opts.include : [`**/*{${SUPPORTED_EXTENSIONS.join(',')}}`];
  const ignorePatterns = [...DEFAULT_IGNORE, ...(opts.includeTests ? [] : TEST_IGNORE), ...(opts.ignore ?? [])];
  let files = await fg(patterns, { cwd: root, ignore: ignorePatterns, dot: false, onlyFiles: true, followSymbolicLinks: false });
  const gi = join(root, '.gitignore');
  if (existsSync(gi)) {
    const ig = ignore().add(readFileSync(gi, 'utf8'));
    files = files.filter((f) => !ig.ignores(f));
  }
  if (opts.diff) {
    const changed = new Set(gitChanged(root, opts.diff));
    files = files.filter((f) => changed.has(f));
  }
  if (opts.files?.length) {
    const only = new Set(opts.files.map((f) => relative(root, resolve(f)).split(sep).join('/')));
    files = files.filter((f) => only.has(f));
  }
  return files.sort();
}

function gitChanged(root: string, ref: string): string[] {
  const top = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: root, encoding: 'utf8' }).trim();
  const out = execFileSync('git', ['diff', '--name-only', '--diff-filter=ACMR', `${ref}...HEAD`], { cwd: root, encoding: 'utf8' });
  const untracked = execFileSync('git', ['ls-files', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8' });
  const staged = execFileSync('git', ['diff', '--name-only', '--diff-filter=ACMR', 'HEAD'], { cwd: root, encoding: 'utf8' });
  return [...out.split('\n'), ...untracked.split('\n'), ...staged.split('\n')]
    .filter(Boolean)
    .map((f) => relative(root, join(top, f)).split(sep).join('/'));
}

async function runPool(root: string, files: string[], threads: number, onProgress?: (d: number, t: number) => void): Promise<FileResult[]> {
  const workerUrl = new URL('./worker.js', import.meta.url);
  const canUseWorkers = workerUrl.protocol === 'file:' && existsSync(fileURLToPath(workerUrl));
  const results: FileResult[] = new Array(files.length);
  let done = 0;

  if (!canUseWorkers || threads <= 1 || files.length < 64) {
    let next = 0;
    const lanes = Array.from({ length: Math.min(8, files.length) }, async () => {
      while (next < files.length) {
        const i = next++;
        results[i] = await analyzeFile(root, files[i]);
        onProgress?.(++done, files.length);
      }
    });
    await Promise.all(lanes);
    return results;
  }

  const n = Math.min(threads, Math.ceil(files.length / 32));
  let next = 0;
  await Promise.all(
    Array.from({ length: n }, () => new Promise<void>((resolveLane, reject) => {
      const w = new Worker(workerUrl);
      const send = () => {
        if (next >= files.length) {
          void w.terminate();
          resolveLane();
          return;
        }
        const id = next++;
        w.postMessage({ id, root, file: files[id] });
      };
      w.on('message', (m: { id: number; result: FileResult }) => {
        results[m.id] = m.result;
        onProgress?.(++done, files.length);
        send();
      });
      w.on('error', reject);
      send();
    })),
  );
  return results;
}

export function gradeFor(findings: Finding[], files: number): { grade: string; score: number } {
  const weights: Record<Severity, number> = { critical: 10, high: 5, medium: 2, low: 0.5, info: 0 };
  const penalty = findings.reduce((s, f) => s + weights[f.severity], 0);
  const density = penalty / Math.max(1, Math.sqrt(Math.max(files, 1)));
  const score = Math.max(0, Math.round(100 - density * 4));
  const grade = score >= 90 ? 'A' : score >= 80 ? 'B' : score >= 65 ? 'C' : score >= 50 ? 'D' : 'F';
  return { grade, score };
}

export async function scan(opts: ScanOptions): Promise<ScanSummary> {
  const started = Date.now();
  const root = resolve(opts.root);
  const files = await listFiles({ ...opts, root });
  const threads = opts.threads ?? Math.max(1, availableParallelism() - 1);
  const results = await runPool(root, files, threads, opts.onProgress);

  let findings: Finding[] = [];
  const shapes: QueryShape[] = [];
  const errors: { file: string; error: string }[] = [];
  for (const r of results) {
    if (!r) continue;
    if (r.error) errors.push({ file: r.file, error: r.error });
    findings.push(...r.findings);
    if (r.shapes) shapes.push(...r.shapes);
  }

  let live: LiveSummary | undefined;
  if (opts.live) {
    opts.onLiveStart?.();
    const { runLive } = await import('./live/index.js');
    const res = await runLive(findings, shapes, opts.live);
    findings = res.findings;
    live = res.summary;
  }

  // rule overrides
  if (opts.rules) {
    findings = findings.flatMap((f) => {
      const o = opts.rules![f.ruleId];
      if (o === 'off') return [];
      return o ? [{ ...f, severity: o }] : [f];
    });
  }
  if (opts.minSeverity) findings = findings.filter((f) => SEVERITY_RANK[f.severity] >= SEVERITY_RANK[opts.minSeverity!]);

  // baseline: fingerprint -> allowed count
  let suppressedByBaseline = 0;
  if (opts.baseline) {
    const remaining = new Map<string, number>();
    if (opts.baseline instanceof Map) for (const [k, v] of opts.baseline) remaining.set(k, v);
    else for (const k of opts.baseline) remaining.set(k, (remaining.get(k) ?? 0) + 1);
    findings = findings.filter((f) => {
      const c = remaining.get(f.fingerprint) ?? 0;
      if (c > 0) {
        remaining.set(f.fingerprint, c - 1);
        suppressedByBaseline++;
        return false;
      }
      return true;
    });
  }

  findings.sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] || a.file.localeCompare(b.file) || a.line - b.line);

  const bySeverity = Object.fromEntries(SEVERITIES.map((s) => [s, 0])) as Record<Severity, number>;
  const byRule: Record<string, number> = {};
  for (const f of findings) {
    bySeverity[f.severity]++;
    byRule[f.ruleId] = (byRule[f.ruleId] ?? 0) + 1;
  }
  const { grade, score } = gradeFor(findings, files.length);
  return {
    root, filesScanned: files.length, durationMs: Date.now() - started, findings, bySeverity, byRule, grade, score,
    suppressedByBaseline, errors, version: VERSION, ...(live ? { live } : {}),
  };
}
