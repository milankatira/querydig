import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { createServer } from '../src/mcp.js';

async function connect() {
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  await Promise.all([createServer().connect(a), client.connect(b)]);
  return client;
}
const body = (r: any) => r.content[0].text as string;

const N1 = "import mongoose from 'mongoose';\nexport async function f() {\n  const orders = await Order.find({ s: 1 }).limit(10).lean();\n  for (const o of orders) {\n    o.user = await User.findById(o.userId).lean();\n  }\n  return orders;\n}\n";

describe('mcp server', () => {
  it('lists tools and the optimize prompt', async () => {
    const c = await connect();
    const names = (await c.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual(['analyze_snippet', 'apply_safe_fixes', 'explain_rule', 'get_finding_context', 'list_rules', 'scan_queries', 'suggest_indexes']);
    expect((await c.listPrompts()).prompts.map((p) => p.name)).toContain('optimize_queries');
  });

  it('scans, gives context, and verifies a rewrite', async () => {
    const root = mkdtempSync(join(tmpdir(), 'querydig-mcp-'));
    writeFileSync(join(root, 'a.ts'), N1);
    const c = await connect();

    const scan = JSON.parse(body(await c.callTool({ name: 'scan_queries', arguments: { path: root } })));
    const f = scan.findings.find((x: any) => x.ruleId === 'QD002');
    expect(f.location).toBe('a.ts:5:20');

    const ctx = body(await c.callTool({ name: 'get_finding_context', arguments: { path: root, file: 'a.ts', line: 5 } }));
    expect(ctx).toContain('5 >');
    expect(ctx).toContain('Before:');

    const fixed = "import mongoose from 'mongoose';\nexport async function f() {\n  const orders = await Order.find({ s: 1 }).limit(10).lean();\n  const users = await User.find({ _id: { $in: orders.map(o => o.userId) } }).lean();\n  const byId = new Map(users.map(u => [String(u._id), u]));\n  for (const o of orders) o.user = byId.get(String(o.userId));\n  return orders;\n}\n";
    const check = JSON.parse(body(await c.callTool({ name: 'analyze_snippet', arguments: { code: fixed, filename: 'a.ts' } })));
    expect(check.findings.filter((x: any) => /^QD/.test(x.ruleId))).toHaveLength(0);
  });

  it('refuses files outside the root and defaults fixes to dry run', async () => {
    const root = mkdtempSync(join(tmpdir(), 'querydig-mcp-'));
    const src = "import mongoose from 'mongoose';\nexport const a = () => P.find({ x: 1 }).sort({ y: 1 });\n";
    writeFileSync(join(root, 'a.ts'), src);
    const c = await connect();
    const out = await c.callTool({ name: 'get_finding_context', arguments: { path: root, file: '../etc/passwd', line: 1 } });
    expect(out.isError).toBe(true);
    const dry = JSON.parse(body(await c.callTool({ name: 'apply_safe_fixes', arguments: { path: root } })));
    expect(dry.dryRun).toBe(true);
    expect(dry.changedLines).toBeGreaterThan(0);
    expect(readFileSync(join(root, 'a.ts'), 'utf8')).toBe(src);
  });
});
