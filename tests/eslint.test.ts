import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Linter } from 'eslint';
import { describe, expect, it } from 'vitest';
import querydig from '../src/eslint.js';

const N_PLUS_ONE = `
const orders = await Order.find({ status: 'open' }).limit(10).lean();
for (const o of orders) {
  o.user = await User.findById(o.userId);
}
`;

function lint(code: string, opts: { filename?: string; cwd?: string; options?: object; fix?: boolean } = {}) {
  const linter = new Linter({ cwd: opts.cwd ?? process.cwd() });
  const config = [
    { languageOptions: { ecmaVersion: 'latest' as const, sourceType: 'module' as const } },
    querydig.configs.recommended as Linter.Config,
    ...(opts.options ? [{ rules: { 'querydig/no-slow-queries': ['warn', opts.options] } } as Linter.Config] : []),
  ];
  const filename = join(opts.cwd ?? process.cwd(), opts.filename ?? 'src/orders.js');
  if (opts.fix) return linter.verifyAndFix(code, config, { filename });
  return { messages: linter.verify(code, config, { filename }), output: code };
}

const ids = (msgs: Linter.LintMessage[]) => msgs.map((m) => m.message.split(' ')[0]);

describe('eslint plugin', () => {
  it('reports N+1 queries at the query line', () => {
    const { messages } = lint(N_PLUS_ONE);
    const qd = messages.find((m) => m.message.startsWith('QD002'));
    expect(qd).toBeDefined();
    expect(qd!.line).toBe(4);
    expect(qd!.ruleId).toBe('querydig/no-slow-queries');
    expect(qd!.message).toContain('(critical)');
  });

  it('honours minSeverity and disable', () => {
    expect(ids(lint(N_PLUS_ONE, { options: { minSeverity: 'critical' } }).messages)).toEqual(['QD002']);
    expect(ids(lint(N_PLUS_ONE, { options: { disable: ['QD002'] } }).messages)).not.toContain('QD002');
  });

  it('skips test files unless includeTests is set', () => {
    expect(lint(N_PLUS_ONE, { filename: 'src/orders.test.js' }).messages).toHaveLength(0);
    expect(lint(N_PLUS_ONE, { filename: 'src/orders.test.js', options: { includeTests: true } }).messages.length).toBeGreaterThan(0);
  });

  it('reads rule overrides and ignores from querydig.config.json', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'querydig-eslint-'));
    writeFileSync(join(cwd, 'querydig.config.json'), JSON.stringify({ rules: { QD002: 'off' }, ignore: ['scripts/**'] }));
    expect(ids(lint(N_PLUS_ONE, { cwd }).messages)).not.toContain('QD002');
    expect(lint(N_PLUS_ONE, { cwd, filename: 'scripts/backfill.js' }).messages).toHaveLength(0);
  });

  it('applies querydig autofixes through eslint --fix', () => {
    const code = "import mongoose from 'mongoose';\nexport const has = async (email) => (await User.countDocuments({ email })) > 0;\n";
    const res = lint(code, { fix: true }) as Linter.FixReport;
    expect(res.fixed).toBe(true);
    expect(res.output).toContain('countDocuments({ email }).limit(1)');
  });

  it('ignores non-JS files and files without queries', () => {
    expect(lint('const x = 1;').messages).toHaveLength(0);
    expect(lint(N_PLUS_ONE, { filename: 'src/orders.py' }).messages.filter((m) => m.ruleId === 'querydig/no-slow-queries')).toHaveLength(0);
  });
});
