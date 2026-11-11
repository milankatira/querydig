import { RULES, RULE_MAP } from '../rules.js';
import type { ScanSummary, Severity } from '../types.js';

export function renderJson(s: ScanSummary): string {
  return JSON.stringify(s, null, 2);
}

const SARIF_LEVEL: Record<Severity, string> = { critical: 'error', high: 'error', medium: 'warning', low: 'note', info: 'note' };
const SECURITY_SEVERITY: Record<Severity, string> = { critical: '9.0', high: '7.0', medium: '5.0', low: '3.0', info: '1.0' };

export function renderSarif(s: ScanSummary): string {
  const used = new Set(s.findings.map((f) => f.ruleId));
  const rules = RULES.filter((r) => used.has(r.id));
  const sarif = {
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [{
      tool: {
        driver: {
          name: 'querydig',
          version: s.version,
          informationUri: 'https://www.npmjs.com/package/querydig',
          rules: rules.map((r) => ({
            id: r.id,
            name: r.name,
            shortDescription: { text: r.title },
            fullDescription: { text: r.why },
            help: { text: r.fix, markdown: `**Why:** ${r.why}\n\n**Fix:** ${r.fix}` },
            defaultConfiguration: { level: SARIF_LEVEL[r.severity] },
            properties: { tags: ['performance', 'database', r.db], 'security-severity': SECURITY_SEVERITY[r.severity] },
          })),
        },
      },
      results: s.findings.map((f) => ({
        ruleId: f.ruleId,
        ruleIndex: rules.findIndex((r) => r.id === f.ruleId),
        level: SARIF_LEVEL[f.severity],
        message: { text: `${f.message} Fix: ${f.fix}` },
        locations: [{ physicalLocation: { artifactLocation: { uri: f.file }, region: { startLine: f.line, startColumn: f.column } } }],
        partialFingerprints: { querydig: f.fingerprint },
        properties: { severity: f.severity, db: f.db, confidence: f.confidence },
      })),
    }],
  };
  return JSON.stringify(sarif, null, 2);
}

const EMOJI: Record<Severity, string> = { critical: '🔴', high: '🟠', medium: '🟡', low: '🔵', info: '⚪' };

export function renderMarkdown(s: ScanSummary, limit = 50): string {
  const o: string[] = [];
  o.push(`## querydig — query performance report`);
  o.push('');
  o.push(`**Health: ${s.grade} (${s.score}/100)** · ${s.filesScanned} files · ${s.findings.length} issue(s)` + (s.suppressedByBaseline ? ` · ${s.suppressedByBaseline} hidden by baseline` : ''));
  o.push('');
  o.push('| Severity | Count |');
  o.push('|---|---|');
  for (const k of ['critical', 'high', 'medium', 'low'] as Severity[]) o.push(`| ${EMOJI[k]} ${k} | ${s.bySeverity[k]} |`);
  o.push('');
  if (!s.findings.length) {
    o.push('✅ No query performance issues found.');
    return o.join('\n');
  }
  o.push('| | Rule | Location | Issue |');
  o.push('|---|---|---|---|');
  for (const f of s.findings.slice(0, limit)) {
    o.push(`| ${EMOJI[f.severity]} | \`${f.ruleId}\` ${RULE_MAP.get(f.ruleId)?.name ?? ''} | \`${f.file}:${f.line}\` | ${f.message.replace(/\|/g, '\\|')} |`);
  }
  if (s.findings.length > limit) o.push(`\n…and ${s.findings.length - limit} more.`);
  o.push('');
  o.push('<details><summary>How to fix</summary>\n');
  for (const id of Object.keys(s.byRule)) {
    const r = RULE_MAP.get(id);
    if (r) o.push(`- **${r.id} ${r.title}** — ${r.fix}`);
  }
  o.push('\n</details>');
  return o.join('\n');
}
