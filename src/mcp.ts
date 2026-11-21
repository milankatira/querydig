import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { analyzeSource } from './analyzer.js';
import { loadConfig } from './config.js';
import { applyFixes } from './fix.js';
import { planIndexes, renderIndexScript } from './indexes.js';
import { langForFile } from './languages.js';
import { RULES, findRule, type RuleMeta } from './rules.js';
import { scan } from './scan.js';
import { SEVERITIES, type Finding, type ScanSummary, type Severity } from './types.js';
import { VERSION } from './version.js';

/**
 * MCP server: exposes querydig to AI assistants (Claude Code, Claude Desktop, Cursor, VS Code…).
 * The assistant does the rewriting; querydig finds the slow queries, explains them, supplies the
 * surrounding code and re-checks the result, so every AI fix is verified by the same analyzer.
 */

const severity = z.enum(SEVERITIES as [Severity, ...Severity[]]);
const pathArg = z.string().optional().describe('Project root to scan. Defaults to the directory the MCP server was started in.');

interface ScanArgs {
  path?: string;
  files?: string[];
  minSeverity?: Severity;
  rules?: string[];
  diff?: string;
  includeTests?: boolean;
  uri?: string;
  db?: string;
}

function rootOf(path?: string): string {
  const root = resolve(process.cwd(), path ?? '.');
  if (!existsSync(root)) throw new Error(`path not found: ${root}`);
  return root;
}

/** Resolve a file the client named, refusing anything outside the project root. */
function fileIn(root: string, file: string): { abs: string; rel: string } {
  const abs = resolve(root, file);
  const rel = relative(root, abs);
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error(`${file} is outside the project root ${root}`);
  return { abs, rel: rel.split(sep).join('/') };
}

async function runScan(a: ScanArgs): Promise<{ root: string; summary: ScanSummary }> {
  const root = rootOf(a.path);
  const cfg = loadConfig(root);
  const rules: Record<string, 'off' | Severity> = { ...(cfg.rules ?? {}) };
  const only = (a.rules ?? []).map((r) => r.toUpperCase());
  if (only.length) for (const r of RULES) if (!only.includes(r.id)) rules[r.id] = 'off';
  const uri = a.uri ?? process.env.QUERYDIG_DB_URI;
  const summary = await scan({
    root,
    files: a.files?.map((f) => fileIn(root, f).abs),
    ignore: cfg.ignore,
    include: cfg.include,
    includeTests: a.includeTests ?? (a.files?.length ? true : cfg.includeTests),
    rules,
    minSeverity: a.minSeverity ?? cfg.minSeverity,
    diff: a.diff,
    live: uri ? { uri, db: a.db, slowMs: 100, explainExecute: false, maxExplain: 200, timeoutMs: 5000 } : undefined,
  });
  return { root, summary };
}

/** What an assistant needs per finding; drops byte offsets and internal ids. */
function compact(f: Finding) {
  return {
    ruleId: f.ruleId,
    severity: f.severity,
    title: f.title,
    location: f.line > 0 ? `${f.file}:${f.line}:${f.column}` : f.file,
    snippet: f.snippet,
    message: f.message,
    fix: f.fix,
    confidence: f.confidence,
    db: f.db,
    ...(f.autofix ? { autoFixable: f.autofix.description } : {}),
    ...(f.evidence ? { evidence: f.evidence } : {}),
    ...(f.suggestedIndex ? { suggestedIndex: f.suggestedIndex.statement } : {}),
  };
}

function ruleDoc(r: RuleMeta): string {
  const ex = r.example ? `\n\nBefore:\n${r.example.bad}\n\nAfter:\n${r.example.good}` : '';
  return `${r.id} · ${r.title} (${r.name}, default ${r.severity}, ${r.db})\n\nWhy it is slow: ${r.why}\n\nHow to fix: ${r.fix}${ex}`;
}

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });
const json = (v: unknown) => text(JSON.stringify(v, null, 2));
const fail = (e: unknown) => ({ isError: true, ...text(`querydig: ${(e as Error).message}`) });

export function createServer(): McpServer {
  const server = new McpServer({ name: 'querydig', version: VERSION });

  server.registerTool(
    'scan_queries',
    {
      title: 'Scan for slow queries',
      description:
        'Statically scan a project for slow, N+1 and unoptimized MongoDB/SQL queries (JS/TS, Python, Go, Java, Ruby, PHP). ' +
        'Returns findings sorted by severity with location, explanation and fix advice. Pass `files` to re-check specific files after editing them. ' +
        'If QUERYDIG_DB_URI is set (or `uri` is given), it also connects read-only to MongoDB/Postgres for live evidence: full scans, missing indexes, slow queries.',
      inputSchema: {
        path: pathArg,
        files: z.array(z.string()).optional().describe('Only scan these files (relative to path). Use to verify a fix.'),
        minSeverity: severity.optional().describe('Hide findings below this severity.'),
        rules: z.array(z.string()).optional().describe('Only report these rule ids, e.g. ["QD001","QD002"].'),
        diff: z.string().optional().describe('Only scan files changed since this git ref, e.g. "origin/main".'),
        includeTests: z.boolean().optional().describe('Also scan tests, fixtures, migrations and seeds.'),
        maxFindings: z.number().int().min(1).max(500).optional().describe('Maximum findings returned (default 50).'),
        uri: z.string().optional().describe('Read-only MongoDB/Postgres URI for live evidence. Prefer setting QUERYDIG_DB_URI in the server env so the secret stays out of the chat.'),
        db: z.string().optional().describe('MongoDB database name when the URI has none.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (a) => {
      try {
        const { summary } = await runScan(a);
        const max = a.maxFindings ?? 50;
        return json({
          root: summary.root,
          filesScanned: summary.filesScanned,
          grade: summary.grade,
          score: summary.score,
          bySeverity: summary.bySeverity,
          totalFindings: summary.findings.length,
          returned: Math.min(max, summary.findings.length),
          findings: summary.findings.slice(0, max).map(compact),
          ...(summary.live ? { live: summary.live } : {}),
          ...(summary.errors.length ? { parseErrors: summary.errors.slice(0, 10) } : {}),
          next: summary.findings.length
            ? 'Call get_finding_context for a finding to see the surrounding code and the rule\'s before/after example, rewrite it, then call scan_queries with `files` to verify.'
            : 'No slow query patterns found.',
        });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    'get_finding_context',
    {
      title: 'Get code context for a finding',
      description:
        'Return the code around a line (with line numbers), every querydig finding in that file near the line, and the matching rule docs with a before/after example. ' +
        'Use this before rewriting a slow query so the fix fits the surrounding code (variables, loop bounds, ORM in use).',
      inputSchema: {
        path: pathArg,
        file: z.string().describe('File relative to the project root, as reported in a finding location.'),
        line: z.number().int().min(1).describe('1-based line of the finding.'),
        contextLines: z.number().int().min(0).max(200).optional().describe('Lines of context above and below (default 25).'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ path, file, line, contextLines }) => {
      try {
        const root = rootOf(path);
        const { abs, rel } = fileIn(root, file);
        const lines = readFileSync(abs, 'utf8').split('\n');
        const ctx = contextLines ?? 25;
        const from = Math.max(1, line - ctx);
        const to = Math.min(lines.length, line + ctx);
        const width = String(to).length;
        const code = lines
          .slice(from - 1, to)
          .map((l, i) => `${String(from + i).padStart(width)}${from + i === line ? ' >' : '  '} ${l}`)
          .join('\n');

        const { summary } = await runScan({ path, files: [rel], includeTests: true });
        const near = summary.findings.filter((f) => f.line >= from && f.line <= to);
        const docs = [...new Set(near.map((f) => f.ruleId))].map((id) => findRule(id)).filter((r): r is RuleMeta => !!r).map(ruleDoc);

        return text(
          [
            `File: ${rel} (lines ${from}-${to} of ${lines.length})`,
            '```',
            code,
            '```',
            near.length ? `Findings in this range:\n${JSON.stringify(near.map(compact), null, 2)}` : 'No querydig findings in this range.',
            ...(docs.length ? ['Rule reference:', ...docs] : []),
          ].join('\n\n'),
        );
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    'analyze_snippet',
    {
      title: 'Check a code snippet',
      description:
        'Run querydig on code that is not saved yet, e.g. a proposed rewrite, and return any slow query patterns still present. ' +
        'Use it to check an optimized version before writing it to disk.',
      inputSchema: {
        code: z.string().describe('Source code to analyze.'),
        filename: z.string().describe('A file name whose extension picks the language, e.g. "orders.service.ts", "views.py", "repo.go", "UserService.java", "user.rb", "UserController.php".'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ code, filename }) => {
      try {
        const lang = langForFile(filename);
        if (!lang) throw new Error(`unsupported file type: ${filename}`);
        const findings = await analyzeSource(code, { relPath: filename, lang });
        return json({ clean: findings.length === 0, findings: findings.map(compact) });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    'explain_rule',
    {
      title: 'Explain a rule',
      description: 'Why a querydig rule is slow, how to fix it, and a before/after example. Accepts an id (QD001) or name (n-plus-one).',
      inputSchema: { rule: z.string().describe('Rule id or name.') },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ rule }) => {
      const r = findRule(rule);
      return r ? text(ruleDoc(r)) : fail(new Error(`unknown rule ${rule}; call list_rules`));
    },
  );

  server.registerTool(
    'list_rules',
    {
      title: 'List rules',
      description: 'All querydig rules with id, default severity, database and title.',
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => json(RULES.map((r) => ({ id: r.id, name: r.name, severity: r.severity, db: r.db, title: r.title }))),
  );

  server.registerTool(
    'apply_safe_fixes',
    {
      title: 'Apply safe automatic fixes',
      description:
        'Apply querydig\'s mechanical, behavior-preserving fixes (.lean() on read-only Mongoose queries, limit 1 on existence counts, Django .exists(), and similar). ' +
        'Defaults to a dry run that only shows the diff; pass dryRun=false to write files. N+1 rewrites, limits and projections are never changed here.',
      inputSchema: {
        path: pathArg,
        files: z.array(z.string()).optional().describe('Only fix these files.'),
        dryRun: z.boolean().optional().describe('Show changes without writing (default true).'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ path, files, dryRun }) => {
      try {
        const dry = dryRun ?? true;
        const { root, summary } = await runScan({ path, files });
        const res = applyFixes(root, summary.findings, { dryRun: dry });
        return json({
          dryRun: dry,
          changedLines: res.changes.length,
          files: res.files,
          changes: res.changes,
          note: res.changes.length
            ? dry ? 'Nothing written. Call again with dryRun=false to apply.' : 'Files written. Review with git diff and run the tests.'
            : 'Nothing to fix automatically; the remaining findings need a rewrite.',
        });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    'suggest_indexes',
    {
      title: 'Suggest missing indexes',
      description:
        'Connect read-only to MongoDB or Postgres (QUERYDIG_DB_URI or `uri`), explain the queries found in the code, and return a de-duplicated script of indexes that would fix full scans and in-memory sorts. ' +
        'Nothing is created on the database.',
      inputSchema: {
        path: pathArg,
        uri: z.string().optional().describe('Read-only connection string. Prefer QUERYDIG_DB_URI in the server env.'),
        db: z.string().optional().describe('MongoDB database name when the URI has none.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ path, uri, db }) => {
      try {
        if (!uri && !process.env.QUERYDIG_DB_URI) throw new Error('no database: set QUERYDIG_DB_URI in the MCP server env or pass `uri`');
        const { summary } = await runScan({ path, uri, db });
        if (summary.live?.error) throw new Error(`live mode failed: ${summary.live.error}`);
        const plans = planIndexes(summary.findings);
        return plans.length
          ? text(`${plans.length} suggested index(es). Review before running:\n\n\`\`\`\n${renderIndexScript(plans, VERSION)}\`\`\``)
          : text('No missing indexes found for the queries in this code.');
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerPrompt(
    'optimize_queries',
    {
      title: 'Find and fix slow queries',
      description: 'Scan the project, then rewrite the worst slow queries one by one and verify each fix with querydig.',
      argsSchema: {
        path: z.string().optional().describe('Project root (default: current directory).'),
        minSeverity: z.string().optional().describe('critical, high, medium or low (default high).'),
      },
    },
    ({ path, minSeverity }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: [
              `Find and fix slow database queries in ${path ?? 'this project'} using the querydig tools.`,
              '',
              `1. Call scan_queries${path ? ` with path "${path}"` : ''} and minSeverity "${minSeverity ?? 'high'}". If it reports a live database, use its evidence (row counts, plans) to prioritize.`,
              '2. Call apply_safe_fixes (dry run) and show me the mechanical fixes; apply them only if I agree.',
              '3. For each remaining finding, worst first: call get_finding_context, then write a rewrite that keeps behavior identical',
              '   (same results, ordering and error handling). Typical fixes: batch N+1 lookups with $in / IN (...) and a Map, use JOIN / $lookup /',
              '   include / select_related / Preload, use bulk writes, add limits and projections, use keyset pagination instead of skip/OFFSET.',
              '4. Before saving, call analyze_snippet on the rewritten code. After saving, call scan_queries with `files` to confirm the finding is gone.',
              '5. If a fix needs an index, say which one (or call suggest_indexes when a database is configured). Never run DDL yourself.',
              '6. Finish with a table: finding, file:line, what changed, expected impact, and anything left for me to decide.',
            ].join('\n'),
          },
        },
      ],
    }),
  );

  return server;
}

export async function startMcpServer(): Promise<void> {
  const server = createServer();
  await server.connect(new StdioServerTransport());
}
