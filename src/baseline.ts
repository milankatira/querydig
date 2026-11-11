import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { Finding } from './types.js';

interface BaselineFile {
  version: 1;
  generatedAt: string;
  fingerprints: Record<string, { count: number; ruleId: string; file: string }>;
}

export function readBaseline(path: string): Map<string, number> | undefined {
  if (!existsSync(path)) return undefined;
  const data = JSON.parse(readFileSync(path, 'utf8')) as BaselineFile;
  return new Map(Object.entries(data.fingerprints ?? {}).map(([k, v]) => [k, v.count]));
}

export function writeBaseline(path: string, findings: Finding[]): number {
  const fingerprints: BaselineFile['fingerprints'] = {};
  for (const f of findings) {
    const e = (fingerprints[f.fingerprint] ??= { count: 0, ruleId: f.ruleId, file: f.file });
    e.count++;
  }
  const data: BaselineFile = { version: 1, generatedAt: new Date().toISOString(), fingerprints };
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n');
  return findings.length;
}
