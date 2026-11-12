import { createHash } from 'node:crypto';
import { RULE_MAP } from '../rules.js';
import type { Evidence, Finding, QueryShape, Severity } from '../types.js';
import { indexCovers, matchSlowQuery, suggestIndex } from './match.js';
import type { LiveData, PlanSummary } from './types.js';

export const THRESHOLDS = { big: 100_000, huge: 1_000_000, scanMin: 10_000, tiny: 1_000, criticalMs: 1_000 };

const fmt = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}k` : String(Math.round(n)));
const unit = (adapter: LiveData['adapter']) => (adapter === 'mongodb' ? 'docs' : 'rows');
const fp = (...parts: (string | number | undefined)[]) => createHash('sha1').update(parts.join('|')).digest('hex').slice(0, 16);

function change(f: Finding, to: Severity, ev: Evidence): Finding {
  if (to === f.severity) return { ...f, evidence: ev };
  return { ...f, severity: to, evidence: { ...ev, severityChange: { from: f.severity, to } } };
}

/**
 * Merge live database evidence into static findings and add live-only findings.
 * Pure: no I/O, so it can be unit tested with fake LiveData.
 */
export function correlate(findings: Finding[], shapes: QueryShape[], data: LiveData): Finding[] {
  const shapeById = new Map(shapes.map((s) => [s.id, s]));
  const u = unit(data.adapter);
  const rowsOf = (t?: string) => (t ? data.tables.get(t)?.rows : undefined);
  const tableIndexes = (t: string) => data.indexes.filter((i) => i.table === t);
  const planText = (p: PlanSummary) => `${p.text}${p.docsExamined != null ? ` · ${fmt(p.docsExamined)} ${u} examined` : ''}${p.ms != null ? ` · ${p.ms}ms` : ''}`;
  const handled = new Set<string>(); // shapeIds whose full-scan / sort issue is already attached to a static finding

  // ---- 1. enrich static findings ------------------------------------------
  const out: Finding[] = findings.map((f) => {
    const shape = f.shapeId ? shapeById.get(f.shapeId) : undefined;
    if (!shape) return f;
    const table = data.shapeTables.get(shape.id);
    if (!table) return f;
    const rows = rowsOf(table);
    const plan = data.plans.get(shape.id);
    const base: Evidence = {
      source: plan ? 'explain' : 'stats', collection: table, rows, plan: plan ? planText(plan) : undefined, index: plan?.indexUsed,
      docsExamined: plan?.docsExamined, ms: plan?.ms,
      note: `${table}: ${rows != null ? `${fmt(rows)} ${u}` : 'size unknown'}${plan ? ` · ${planText(plan)}` : ''}`,
    };

    switch (f.ruleId) {
      case 'QD001': case 'QD002': case 'QD003': {
        if (plan?.fullScan && rows != null && rows >= THRESHOLDS.big) {
          handled.add(shape.id);
          const idx = suggestIndex(data.adapter, table, shape.filterKeys, shape.sortKeys);
          const g = change(f, 'critical', { ...base, note: `Each iteration does a full scan of ${table} (${fmt(rows)} ${u}): N × ${fmt(rows)} ${u} read.` });
          return idx ? { ...g, fix: `${f.fix} Until then, at least add an index: ${idx}` } : g;
        }
        if (plan?.indexUsed) return { ...f, evidence: { ...base, note: `${base.note}. The inner query uses an index, so each round-trip is cheap, but N round-trips remain.` } };
        return { ...f, evidence: base };
      }
      case 'MQ001': case 'SQ001': {
        if (rows == null) return f;
        handled.add(shape.id);
        if (rows < THRESHOLDS.tiny) return change(f, 'low', { ...base, note: `${table} has only ${fmt(rows)} ${u}: harmless today, but it will grow with the table.` });
        if (rows >= THRESHOLDS.huge) return change(f, 'critical', { ...base, note: `Reads all ${fmt(rows)} ${u} of ${table} on every call.` });
        return { ...f, evidence: { ...base, note: `Reads all ${fmt(rows)} ${u} of ${table} on every call.` } };
      }
      case 'MQ005': {
        handled.add(shape.id);
        const covered = tableIndexes(table).find((i) => indexCovers(i, shape.filterKeys, shape.sortKeys));
        if (covered) return change(f, 'low', { ...base, source: 'indexes', index: covered.name, note: `Index ${covered.name} already serves this filter and sort; adding a limit is still recommended.` });
        const idx = suggestIndex(data.adapter, table, shape.filterKeys, shape.sortKeys);
        return { ...f, evidence: { ...base, note: `No index serves this sort on ${table}${rows != null ? ` (${fmt(rows)} ${u})` : ''}.` }, fix: idx ? `Add .limit(n) and create: ${idx}` : f.fix };
      }
      case 'SQ004': case 'MQ004': case 'SQ005': case 'SQ003': case 'MQ002':
        if (plan?.fullScan) handled.add(shape.id);
        return { ...f, evidence: base };
      default:
        return f;
    }
  });

  const add = (ruleId: string, x: Omit<Finding, 'ruleId' | 'title' | 'fix' | 'confidence' | 'lang'> & { fix?: string; lang?: Finding['lang']; confidence?: Finding['confidence'] }) => {
    const rule = RULE_MAP.get(ruleId)!;
    out.push({ ruleId, title: rule.title, fix: x.fix ?? rule.fix, confidence: x.confidence ?? 'high', lang: x.lang ?? 'db', ...x } as Finding);
  };
  const dbLoc = (table?: string) => `db://${data.database}${table ? '/' + table : ''}`;

  // ---- 2. LV001 / LV002 from plans of static shapes -----------------------
  const seenPlan = new Set<string>();
  for (const s of shapes) {
    const plan = data.plans.get(s.id);
    const table = data.shapeTables.get(s.id);
    if (!plan || !table || handled.has(s.id)) continue;
    const rows = rowsOf(table) ?? plan.estRows ?? 0;
    const key = `${table}|${[...s.filterKeys].sort().join(',')}|${s.sortKeys.map((k) => k.key + k.dir).join(',')}|${s.file}`;
    if (seenPlan.has(key)) continue;
    seenPlan.add(key);
    const idx = suggestIndex(data.adapter, table, s.filterKeys, s.sortKeys);
    const snippet = s.sql ?? `${table}.${s.method}(${s.filterKeys.length ? `{ ${s.filterKeys.join(', ')} }` : ''})${s.sortKeys.length ? `.sort({ ${s.sortKeys.map((k) => `${k.key}: ${k.dir}`).join(', ')} })` : ''}`;
    const ev: Evidence = { source: 'explain', collection: table, rows, plan: planText(plan), index: plan.indexUsed, docsExamined: plan.docsExamined, ms: plan.ms, note: '' };
    if (plan.fullScan && rows >= THRESHOLDS.scanMin) {
      add('LV001', {
        severity: rows >= THRESHOLDS.huge ? 'critical' : 'high', db: s.db, file: s.file, line: s.line, column: 1, snippet,
        message: `Full ${data.adapter === 'mongodb' ? 'collection' : 'table'} scan of ${table} (${fmt(rows)} ${u})${s.filterKeys.length ? ` filtering on ${s.filterKeys.join(', ')}` : ''}${s.inLoop ? ', inside a loop' : ''}.`,
        fix: idx ? `Create an index: ${idx}` : undefined,
        evidence: { ...ev, note: `${table}: ${fmt(rows)} ${u} · ${planText(plan)}` },
        fingerprint: fp('LV001', s.file, table, key), shapeId: s.id,
      });
    } else if (plan.inMemorySort && s.sortKeys.length && rows >= THRESHOLDS.scanMin) {
      add('LV002', {
        severity: 'medium', db: s.db, file: s.file, line: s.line, column: 1, snippet,
        message: `Sorts ${table} in memory on ${s.sortKeys.map((k) => k.key).join(', ')} (${fmt(rows)} ${u}).`,
        fix: idx ? `Create an index: ${idx}` : undefined,
        evidence: { ...ev, note: `${table}: ${fmt(rows)} ${u} · ${planText(plan)}` },
        fingerprint: fp('LV002', s.file, table, key), shapeId: s.id,
      });
    }
  }

  // ---- 3. LV003 slow queries from profiler / pg_stat_statements -----------
  for (const q of data.slow) {
    const shape = matchSlowQuery(q, shapes, data.shapeTables);
    const idx = q.table ? suggestIndex(data.adapter, q.table, q.filterKeys, q.sortKeys) : undefined;
    const covered = q.table ? tableIndexes(q.table).some((i) => indexCovers(i, q.filterKeys, q.sortKeys)) : false;
    add('LV003', {
      severity: q.meanMs >= THRESHOLDS.criticalMs ? 'critical' : 'high', db: data.adapter === 'mongodb' ? 'mongodb' : 'sql',
      file: shape?.file ?? dbLoc(q.table), line: shape?.line ?? 0, column: shape ? 1 : 0, lang: shape ? undefined : 'db',
      snippet: q.text.slice(0, 240),
      message: `Averages ${Math.round(q.meanMs)}ms over ${q.calls} call(s)${q.table ? ` on ${q.table}` : ''}${q.plan ? ` (${q.plan})` : ''}${shape ? '' : '. No matching call found in the code.'}`,
      fix: idx && !covered ? `Likely missing index: ${idx}` : undefined,
      evidence: { source: 'profiler', collection: q.table, ms: Math.round(q.meanMs), plan: q.plan, docsExamined: q.docsExamined, note: `${q.calls} call(s), mean ${Math.round(q.meanMs)}ms${q.docsExamined != null ? `, ${fmt(q.docsExamined)} ${u} examined` : ''}` },
      fingerprint: fp('LV003', q.table, q.filterKeys.join(','), q.sortKeys.map((k) => k.key).join(',')), shapeId: shape?.id,
      confidence: shape ? 'high' : 'medium',
    });
  }

  // ---- 4. LV004 unused indexes --------------------------------------------
  for (const i of data.indexes) {
    if (i.usage !== 0 || i.primary || i.unique || i.name === '_id_') continue;
    const drop = data.adapter === 'mongodb' ? `db.${i.table}.dropIndex("${i.name}")` : `DROP INDEX CONCURRENTLY "${i.name}";`;
    add('LV004', {
      severity: 'low', db: data.adapter === 'mongodb' ? 'mongodb' : 'sql', file: dbLoc(i.table), line: 0, column: 0,
      snippet: i.definition ?? `${i.name} (${i.keys.map((k) => k.key).join(', ')})`,
      message: `Index ${i.name} on ${i.table} has not been used since statistics were reset.`,
      fix: `Confirm on every replica over a full business cycle, then: ${drop}`,
      evidence: { source: 'indexes', collection: i.table, index: i.name, note: `0 uses recorded` },
      fingerprint: fp('LV004', i.table, i.name),
    });
  }

  // ---- 5. LV005 foreign keys without index that the code filters on -------
  for (const k of data.fks) {
    const indexed = tableIndexes(k.table).some((i) => i.keys[0]?.key === k.column);
    if (indexed) continue;
    const users = shapes.filter((s) => data.shapeTables.get(s.id) === k.table && s.filterKeys.includes(k.column));
    if (!users.length) continue;
    const s = users.find((x) => x.inLoop) ?? users[0];
    add('LV005', {
      severity: 'medium', db: 'sql', file: s.file, line: s.line, column: 1, snippet: s.sql ?? `${k.table}.${k.column} → ${k.refTable}`,
      message: `${k.table}.${k.column} references ${k.refTable} but has no index; ${users.length} quer${users.length === 1 ? 'y filters' : 'ies filter'} on it.`,
      fix: `CREATE INDEX CONCURRENTLY ON "${k.table}" ("${k.column}");`,
      evidence: { source: 'indexes', collection: k.table, rows: rowsOf(k.table), note: `no index starts with ${k.column}` },
      fingerprint: fp('LV005', k.table, k.column), shapeId: s.id,
    });
  }

  return out;
}
