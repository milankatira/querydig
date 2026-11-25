import { relative, sep } from 'node:path';
import { analyzeWithParser } from './analyzer.js';
import ignore, { type Ignore } from 'ignore';
import { loadConfig, TEST_IGNORE, type QuerydigConfig } from './config.js';
import { QUICK_FILTER } from './fileAnalyzer.js';
import { langForFile } from './languages.js';
import { getParser } from './parser.js';
import { SEVERITIES, SEVERITY_RANK, type Finding, type LangId, type Severity } from './types.js';
import { VERSION } from './version.js';

/**
 * ESLint plugin: querydig findings as editor diagnostics and in `eslint` CI runs.
 *
 *   // eslint.config.js
 *   import querydig from 'querydig/eslint';
 *   export default [querydig.configs.recommended];
 *
 * ESLint rules must be synchronous, while tree-sitter loads its WASM grammars asynchronously,
 * so the JS/TS parsers are loaded once with top-level await when the plugin is imported.
 */

const JS_LANGS: LangId[] = ['javascript', 'typescript', 'tsx'];
const parsers = new Map(await Promise.all(JS_LANGS.map(async (l) => [l, await getParser(l)] as const)));

interface RuleOptions {
  /** Hide findings below this severity (default: the config file's minSeverity, else "low"). */
  minSeverity?: Severity;
  /** querydig rule ids to skip, e.g. ["MQ010", "SQ002"]. */
  disable?: string[];
  /** Also check tests, specs, fixtures, migrations and seeds (default: the config file's includeTests, else false). */
  includeTests?: boolean;
  /** Read rule overrides and ignores from querydig.config.json in the ESLint cwd (default true). */
  useConfigFile?: boolean;
}

// Minimal structural types so the plugin doesn't depend on @types/eslint.
interface RuleContext {
  filename: string;
  cwd: string;
  options: RuleOptions[];
  sourceCode: { text: string; lines: string[] };
  report(d: {
    loc: { start: { line: number; column: number }; end: { line: number; column: number } };
    messageId: string;
    data: Record<string, string>;
    fix?: (fixer: Fixer) => unknown;
  }): void;
}
interface Fixer { replaceTextRange(range: [number, number], text: string): unknown }

const configCache = new Map<string, QuerydigConfig>();
function configFor(cwd: string): QuerydigConfig {
  let c = configCache.get(cwd);
  if (!c) {
    try {
      c = loadConfig(cwd);
    } catch {
      c = {};
    }
    configCache.set(cwd, c);
  }
  return c;
}

const ignoreCache = new Map<string, Ignore>();
function isIgnored(rel: string, patterns: string[]): boolean {
  if (!patterns.length || rel.startsWith('..')) return false;
  const key = patterns.join('\0');
  let ig = ignoreCache.get(key);
  if (!ig) ignoreCache.set(key, (ig = ignore().add(patterns)));
  return ig.ignores(rel);
}

function findingsFor(ctx: RuleContext): Finding[] {
  const lang = langForFile(ctx.filename);
  const parser = lang && parsers.get(lang);
  const src = ctx.sourceCode.text;
  if (!parser || !QUICK_FILTER.test(src)) return [];
  const opts = ctx.options[0] ?? {};
  const cfg = opts.useConfigFile === false ? {} : configFor(ctx.cwd);
  const rel = relative(ctx.cwd, ctx.filename).split(sep).join('/');
  const includeTests = opts.includeTests ?? cfg.includeTests ?? false;
  if (isIgnored(rel, [...(cfg.ignore ?? []), ...(includeTests ? [] : TEST_IGNORE)])) return [];
  const minSeverity = opts.minSeverity ?? cfg.minSeverity ?? 'low';
  const disabled = new Set((opts.disable ?? []).map((r) => r.toUpperCase()));
  return analyzeWithParser(parser, src, { relPath: rel, lang: lang! }).findings.flatMap((f) => {
    const o = cfg.rules?.[f.ruleId];
    if (o === 'off' || disabled.has(f.ruleId)) return [];
    const severity = o ?? f.severity;
    return SEVERITY_RANK[severity] >= SEVERITY_RANK[minSeverity] ? [{ ...f, severity }] : [];
  });
}

const noSlowQueries = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Disallow N+1, unbounded and other slow database query patterns (querydig)',
      url: 'https://github.com/milankatira/querydig#rules',
    },
    fixable: 'code',
    schema: [{
      type: 'object',
      properties: {
        minSeverity: { enum: SEVERITIES },
        disable: { type: 'array', items: { type: 'string' } },
        includeTests: { type: 'boolean' },
        useConfigFile: { type: 'boolean' },
      },
      additionalProperties: false,
    }],
    messages: { finding: '{{ruleId}} ({{severity}}): {{message}} Fix: {{fix}}' },
  },
  create(ctx: RuleContext) {
    return {
      'Program:exit'() {
        const lines = ctx.sourceCode.lines;
        for (const f of findingsFor(ctx)) {
          const lineText = lines[f.line - 1] ?? '';
          const column = Math.min(Math.max(f.column - 1, 0), lineText.length);
          const end = lineText.length > column ? lineText.length : column;
          const autofix = f.autofix;
          ctx.report({
            loc: { start: { line: f.line, column }, end: { line: f.line, column: end } },
            messageId: 'finding',
            data: { severity: f.severity, ruleId: f.ruleId, message: f.message, fix: f.fix },
            ...(autofix && {
              fix: (fixer: Fixer) => fixer.replaceTextRange([autofix.offset, autofix.offset + (autofix.deleteLength ?? 0)], autofix.insert),
            }),
          });
        }
      },
    };
  },
};

const plugin = {
  meta: { name: 'querydig', version: VERSION },
  rules: { 'no-slow-queries': noSlowQueries },
  configs: {} as Record<string, unknown>,
};

// No `files`/`ignores` here: the rule only runs on JS/TS and skips tests itself, so a later
// `rules: { 'querydig/no-slow-queries': … }` override always finds the plugin.
plugin.configs.recommended = {
  name: 'querydig/recommended',
  plugins: { querydig: plugin },
  rules: { 'querydig/no-slow-queries': 'warn' },
};

export default plugin;
export const rules = plugin.rules;
export const configs = plugin.configs;
