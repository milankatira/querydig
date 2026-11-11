import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderHtml } from '../src/report/html.js';
import { renderMarkdown, renderSarif } from '../src/report/formats.js';
import { scan } from '../src/scan.js';

function project() {
  const dir = mkdtempSync(join(tmpdir(), 'querydig-'));
  mkdirSync(join(dir, 'src'));
  mkdirSync(join(dir, 'tests'));
  const bad = "import mongoose from 'mongoose';\nexport async function a(ids){ for (const id of ids) { await User.findById(id); } }\n";
  writeFileSync(join(dir, 'src', 'a.ts'), bad);
  writeFileSync(join(dir, 'tests', 'a.test.ts'), bad);
  writeFileSync(join(dir, 'src', 'ignored.ts'), bad);
  writeFileSync(join(dir, '.gitignore'), 'src/ignored.ts\n');
  return dir;
}

describe('scan', () => {
  it('scans, skips tests + gitignored files, applies baseline and rule overrides', async () => {
    const root = project();
    const s = await scan({ root, threads: 1 });
    expect(s.filesScanned).toBe(1);
    expect(s.findings.map((f) => f.ruleId)).toEqual(['QD001']);

    const withTests = await scan({ root, threads: 1, includeTests: true });
    expect(withTests.filesScanned).toBe(2);

    const baselined = await scan({ root, threads: 1, baseline: new Map([[s.findings[0].fingerprint, 1]]) });
    expect(baselined.findings).toHaveLength(0);
    expect(baselined.suppressedByBaseline).toBe(1);

    const off = await scan({ root, threads: 1, rules: { QD001: 'off' } });
    expect(off.findings).toHaveLength(0);
    const sev = await scan({ root, threads: 1, rules: { QD001: 'low' } });
    expect(sev.findings[0].severity).toBe('low');
  });

  it('renders all report formats', async () => {
    const s = await scan({ root: project(), threads: 1 });
    const sarif = JSON.parse(renderSarif(s));
    expect(sarif.runs[0].results[0].ruleId).toBe('QD001');
    expect(renderMarkdown(s)).toContain('QD001');
    const html = renderHtml(s);
    expect(html).toContain('<!doctype html>');
    expect(html).not.toMatch(/<\/script>[\s\S]*<\/script>[\s\S]*<\/script>/);
  });
});
