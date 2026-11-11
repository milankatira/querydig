#!/usr/bin/env node
import { existsSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Command, Option } from 'commander';
import pc from 'picocolors';
import { readBaseline, writeBaseline } from './baseline.js';
import { CONFIG_FILES, loadConfig } from './config.js';
import { renderJson, renderMarkdown, renderSarif } from './report/formats.js';
import { renderHtml } from './report/html.js';
import { renderTerminal } from './report/terminal.js';
import { RULES, findRule } from './rules.js';
import { scan } from './scan.js';
import { SEVERITIES, SEVERITY_RANK, type Severity } from './types.js';
import { VERSION } from './version.js';

const program = new Command();
program
  .name('querydig')
  .description('Find slow and unoptimized database queries (MongoDB, SQL) in JS/TS, Python and Go code.')
  .version(VERSION);

program
  .command('scan', { isDefault: true })
  .description('Scan a project for slow query patterns')
  .argument('[path]', 'project root', '.')
  .addOption(new Option('-f, --format <format>', 'output format').choices(['terminal', 'json', 'sarif', 'md', 'html']).default('terminal'))
  .option('-o, --output <file>', 'write report to a file (default for html: querydig-report.html)')
  .addOption(new Option('--fail-on <severity>', 'exit with code 1 if any finding is at or above this severity').choices([...SEVERITIES, 'none']))
  .addOption(new Option('--min-severity <severity>', 'hide findings below this severity').choices(SEVERITIES))
  .option('--baseline <file>', 'ignore findings recorded in this baseline file')
  .option('--update-baseline [file]', 'write all current findings to a baseline file and exit 0')
  .option('--diff <ref>', 'only scan files changed since a git ref (e.g. origin/main)')
  .option('--include-tests', 'also scan tests, fixtures, migrations and seeds', false)
  .option('--ignore <globs...>', 'extra glob patterns to ignore')
  .option('--rules <list>', 'only report these rule ids (comma separated)')
  .option('--disable <list>', 'disable these rule ids (comma separated)')
  .option('-c, --config <file>', 'path to a config file')
  .option('--limit <n>', 'max findings shown in terminal (0 = all)', '25')
  .option('--threads <n>', 'worker threads')
  .option('-v, --verbose', 'show confidence, fingerprints and parse errors', false)
  .action(async (path: string, o) => {
    const root = resolve(path);
    if (!existsSync(root)) {
      console.error(pc.red(`querydig: path not found: ${root}`));
      process.exit(2);
    }
    const cfg = loadConfig(root, o.config);
    const rules: Record<string, 'off' | Severity> = { ...(cfg.rules ?? {}) };
    for (const id of splitList(o.disable)) rules[id] = 'off';
    const only = splitList(o.rules);
    if (only.length) for (const r of RULES) if (!only.includes(r.id)) rules[r.id] = 'off';

    const baselinePath = o.baseline ? resolve(o.baseline) : undefined;
    const updating = o.updateBaseline !== undefined;
    const baseline = !updating && baselinePath ? readBaseline(baselinePath) : undefined;
    if (baselinePath && !updating && !baseline) console.error(pc.yellow(`querydig: baseline ${baselinePath} not found — reporting all findings`));

    const interactive = o.format === 'terminal' && process.stderr.isTTY;
    let last = 0;
    const summary = await scan({
      root,
      ignore: [...(cfg.ignore ?? []), ...(o.ignore ?? [])],
      include: cfg.include,
      includeTests: o.includeTests || cfg.includeTests,
      rules,
      minSeverity: o.minSeverity ?? cfg.minSeverity,
      diff: o.diff,
      baseline,
      threads: o.threads ? Number(o.threads) : undefined,
      onProgress: interactive
        ? (d, t) => {
            const now = Date.now();
            if (now - last > 80 || d === t) {
              last = now;
              process.stderr.write(`\r${pc.dim(`scanning ${d}/${t}`)}${d === t ? '\r\x1b[K' : ''}`);
            }
          }
        : undefined,
    });

    if (updating) {
      const file = resolve(typeof o.updateBaseline === 'string' ? o.updateBaseline : baselinePath ?? '.querydig-baseline.json');
      const n = writeBaseline(file, summary.findings);
      console.log(pc.green(`querydig: wrote ${n} finding(s) to ${file}`));
      return;
    }

    let text: string;
    switch (o.format) {
      case 'json': text = renderJson(summary); break;
      case 'sarif': text = renderSarif(summary); break;
      case 'md': text = renderMarkdown(summary); break;
      case 'html': text = renderHtml(summary); break;
      default: text = renderTerminal(summary, { limit: Number(o.limit) || Infinity, verbose: o.verbose });
    }
    const outFile = o.output ?? (o.format === 'html' ? 'querydig-report.html' : undefined);
    if (outFile) {
      writeFileSync(resolve(outFile), text);
      if (o.format === 'html' || o.format === 'terminal') {
        console.log(renderTerminal(summary, { limit: 0 === Number(o.limit) ? Infinity : 5 }).trimEnd());
      }
      console.error(pc.green(`report written to ${resolve(outFile)}`));
    } else {
      process.stdout.write(text.endsWith('\n') ? text : text + '\n');
    }

    const failOn: Severity | 'none' | undefined = o.failOn ?? cfg.failOn;
    if (failOn && failOn !== 'none') {
      const failing = summary.findings.filter((f) => SEVERITY_RANK[f.severity] >= SEVERITY_RANK[failOn]);
      if (failing.length) {
        console.error(pc.red(`querydig: ${failing.length} finding(s) at or above "${failOn}" — failing.`));
        process.exitCode = 1;
      }
    }
  });

program
  .command('rules')
  .description('List all rules')
  .action(() => {
    for (const r of RULES) console.log(`${pc.bold(r.id)}  ${r.severity.padEnd(8)} ${pc.dim(r.db.padEnd(7))} ${r.title}`);
  });

program
  .command('explain')
  .description('Explain a rule and how to fix it')
  .argument('<rule>', 'rule id or name, e.g. QD001 or n-plus-one')
  .action((id: string) => {
    const r = findRule(id);
    if (!r) {
      console.error(pc.red(`Unknown rule ${id}. Run \`querydig rules\`.`));
      process.exit(2);
    }
    console.log(`\n${pc.bold(`${r.id} · ${r.title}`)}  ${pc.dim(`(${r.name}, default ${r.severity}, ${r.db})`)}\n`);
    console.log(`${pc.bold('Why it is slow')}\n  ${r.why}\n`);
    console.log(`${pc.bold('How to fix')}\n  ${r.fix}\n`);
    if (r.example) {
      console.log(pc.red('Before'));
      console.log(r.example.bad.replace(/^/gm, '  '));
      console.log(pc.green('\nAfter'));
      console.log(r.example.good.replace(/^/gm, '  ') + '\n');
    }
  });

program
  .command('init')
  .description('Create a querydig.config.json')
  .action(() => {
    const file = resolve(CONFIG_FILES[0]);
    if (existsSync(file)) {
      console.error(pc.yellow(`${file} already exists`));
      return;
    }
    writeFileSync(file, JSON.stringify({ ignore: [], includeTests: false, failOn: 'high', rules: { MQ010: 'off', MQ011: 'off' } }, null, 2) + '\n');
    console.log(pc.green(`created ${file}`));
  });

function splitList(v?: string): string[] {
  return v ? v.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean) : [];
}

program.parseAsync().catch((e) => {
  console.error(pc.red(`querydig: ${(e as Error).message}`));
  process.exit(2);
});
