import pc from 'picocolors';
import type { Finding, ScanSummary, Severity } from '../types.js';

const SEV_COLOR: Record<Severity, (s: string) => string> = {
  critical: (s) => pc.bgRed(pc.white(pc.bold(s))),
  high: (s) => pc.red(pc.bold(s)),
  medium: (s) => pc.yellow(s),
  low: (s) => pc.cyan(s),
  info: (s) => pc.dim(s),
};

const GRADE_COLOR: Record<string, (s: string) => string> = { A: pc.green, B: pc.green, C: pc.yellow, D: pc.red, F: pc.red };

export function renderTerminal(s: ScanSummary, opts: { limit?: number; verbose?: boolean } = {}): string {
  const out: string[] = [];
  const limit = opts.limit ?? 25;
  out.push('');
  out.push(pc.bold(`querydig ${pc.dim('v' + s.version)}  —  slow-query scan of ${s.root}`));
  out.push(pc.dim(`${s.filesScanned} files in ${(s.durationMs / 1000).toFixed(2)}s`));
  if (s.live && !s.live.error) {
    out.push(pc.dim(`live: ${s.live.adapter} ${s.live.database} · ${s.live.tables} ${s.live.adapter === 'mongodb' ? 'collections' : 'tables'} · ${s.live.explained} query plans · ${s.live.slowQueries} slow queries`));
  }
  for (const w of s.live?.warnings ?? []) out.push(pc.yellow(`  ! ${w}`));
  out.push('');

  if (!s.findings.length) {
    out.push(pc.green(pc.bold('✔ No query performance issues found.')));
    if (s.suppressedByBaseline) out.push(pc.dim(`  (${s.suppressedByBaseline} known issue(s) hidden by baseline)`));
    out.push('');
    return out.join('\n');
  }

  const shown = s.findings.slice(0, limit);
  for (const f of shown) out.push(renderFinding(f, opts.verbose));

  if (s.findings.length > shown.length) {
    out.push(pc.dim(`… ${s.findings.length - shown.length} more. Use --limit 0 to show all, or --format html for the full report.`));
    out.push('');
  }

  const sev = (k: Severity) => `${SEV_COLOR[k](` ${k.toUpperCase()} `)} ${s.bySeverity[k]}`;
  out.push(pc.bold('Summary'));
  out.push(`  ${sev('critical')}   ${sev('high')}   ${sev('medium')}   ${sev('low')}`);
  const g = (GRADE_COLOR[s.grade] ?? pc.white)(pc.bold(`${s.grade} (${s.score}/100)`));
  out.push(`  Query health: ${g}`);
  const top = Object.entries(s.byRule).sort((a, b) => b[1] - a[1]).slice(0, 5);
  out.push(`  Top rules: ${top.map(([r, n]) => `${r}×${n}`).join(', ')}`);
  if (s.suppressedByBaseline) out.push(pc.dim(`  ${s.suppressedByBaseline} known issue(s) hidden by baseline`));
  if (s.errors.length) out.push(pc.yellow(`  ${s.errors.length} file(s) could not be analyzed (run with --verbose)`));
  if (opts.verbose) for (const e of s.errors) out.push(pc.dim(`    ${e.file}: ${e.error}`));
  out.push(pc.dim('  Explain a rule: npx querydig explain <RULE>'));
  out.push('');
  return out.join('\n');
}

function renderFinding(f: Finding, verbose?: boolean): string {
  const lines: string[] = [];
  const db = f.db === 'unknown' ? '' : pc.dim(` [${f.db}]`);
  lines.push(`${SEV_COLOR[f.severity](` ${f.severity.toUpperCase()} `)} ${pc.bold(f.ruleId)} ${f.title}${db}`);
  lines.push(`  ${pc.underline(f.line > 0 ? `${f.file}:${f.line}:${f.column}` : f.file)}`);
  for (const l of f.snippet.split('\n').slice(0, 3)) lines.push(pc.dim('  │ ') + l);
  lines.push(`  ${f.message}`);
  if (f.evidence) {
    const sc = f.evidence.severityChange ? ` ${pc.bold(`(${f.evidence.severityChange.from} → ${f.evidence.severityChange.to})`)}` : '';
    lines.push(`  ${pc.magenta('live:')} ${f.evidence.note}${sc}`);
  }
  lines.push(`  ${pc.green('fix:')} ${f.fix}`);
  if (verbose) lines.push(pc.dim(`  confidence: ${f.confidence}  fingerprint: ${f.fingerprint}`));
  lines.push('');
  return lines.join('\n');
}
