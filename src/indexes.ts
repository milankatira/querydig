import type { Finding, SuggestedIndex } from './types.js';

export interface IndexPlan { index: SuggestedIndex; reasons: string[] }

const sig = (i: SuggestedIndex) => `${i.table}|${i.keys.map((k) => `${k.key}:${k.dir}`).join(',')}`;

/** Collect suggested indexes from findings, de-duplicate, and drop ones that are a prefix of another. */
export function planIndexes(findings: Finding[]): IndexPlan[] {
  const map = new Map<string, IndexPlan>();
  for (const f of findings) {
    const i = f.suggestedIndex;
    if (!i || !i.keys.length) continue;
    const reason = `${f.ruleId} ${f.line > 0 ? `${f.file}:${f.line}` : f.file}`;
    const p = map.get(sig(i)) ?? map.set(sig(i), { index: i, reasons: [] }).get(sig(i))!;
    if (!p.reasons.includes(reason)) p.reasons.push(reason);
  }
  const all = [...map.values()].sort((a, b) => b.index.keys.length - a.index.keys.length);
  const kept: IndexPlan[] = [];
  for (const p of all) {
    // {a} is served by an existing {a, b} suggestion (prefix), as long as directions match or are fully reversed
    const host = kept.find((k) => {
      if (k.index.table !== p.index.table) return false;
      const h = k.index.keys;
      const same = p.index.keys.every((key, n) => h[n]?.key === key.key && h[n].dir === key.dir);
      const reversed = p.index.keys.every((key, n) => h[n]?.key === key.key && h[n].dir === -key.dir);
      return same || reversed;
    });
    if (host) host.reasons.push(...p.reasons.filter((r) => !host.reasons.includes(r)));
    else kept.push(p);
  }
  return kept.sort((a, b) => a.index.table.localeCompare(b.index.table) || a.index.statement.localeCompare(b.index.statement));
}

/** A reviewed, ready-to-run script: mongosh JavaScript or SQL. */
export function renderIndexScript(plans: IndexPlan[], version: string): string {
  if (!plans.length) return '';
  const { adapter, database } = plans[0].index;
  const c = adapter === 'mongodb' ? '//' : '--';
  const lines: string[] = [
    `${c} Suggested indexes from querydig ${version} for ${adapter} database "${database}" (${new Date().toISOString().slice(0, 10)}).`,
    `${c} Review each one before running. Build on a replica or at low traffic; large collections take a while.`,
    adapter === 'mongodb'
      ? `${c} Run with: mongosh "<connection string>" ${'<this file>'}`
      : `${c} Run with: psql "<connection string>" -f <this file>   (CONCURRENTLY can't run inside a transaction)`,
    '',
  ];
  if (adapter === 'mongodb') lines.push(`db = db.getSiblingDB(${JSON.stringify(database)});`, '');
  for (const p of plans) {
    lines.push(`${c} ${p.index.table}: fixes ${p.reasons.slice(0, 6).join(', ')}${p.reasons.length > 6 ? ` and ${p.reasons.length - 6} more` : ''}`);
    lines.push(adapter === 'mongodb' ? `${p.index.statement};` : p.index.statement, '');
  }
  return lines.join('\n');
}
