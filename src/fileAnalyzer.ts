import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { analyzeSource } from './analyzer.js';
import { langForFile } from './languages.js';
import type { FileResult } from './types.js';

const MAX_BYTES = 1_500_000;
const QUICK_FILTER = /find|aggregate|query|execute|Query|Exec|objects|count|Count|update|Update|insert|Insert|delete|Delete|save|Save|create|Create|select|SELECT|First|Take|remove|upsert|distinct|Distinct/;

export async function analyzeFile(root: string, rel: string): Promise<FileResult> {
  const lang = langForFile(rel);
  if (!lang) return { file: rel, findings: [] };
  try {
    const src = await readFile(join(root, rel), 'utf8');
    if (src.length > MAX_BYTES || !QUICK_FILTER.test(src)) return { file: rel, findings: [] };
    const findings = await analyzeSource(src, { relPath: rel, lang });
    return { file: rel, findings };
  } catch (e) {
    return { file: rel, findings: [], error: (e as Error).message };
  }
}
