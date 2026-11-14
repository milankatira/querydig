import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Finding } from './types.js';

export interface FixChange { file: string; line: number; ruleId: string; description: string; before: string; after: string }
export interface FixResult { changes: FixChange[]; files: string[]; applied: Finding[] }

/**
 * Apply the safe, mechanical edits attached to findings (`finding.autofix`).
 * Edits are applied from the end of each file backwards so offsets stay valid.
 */
export function applyFixes(root: string, findings: Finding[], opts: { dryRun?: boolean } = {}): FixResult {
  const byFile = new Map<string, Finding[]>();
  for (const f of findings) if (f.autofix) (byFile.get(f.file) ?? byFile.set(f.file, []).get(f.file)!).push(f);

  const changes: FixChange[] = [];
  const applied: Finding[] = [];
  const files: string[] = [];
  for (const [file, list] of byFile) {
    const path = join(root, file);
    let src: string;
    try {
      src = readFileSync(path, 'utf8');
    } catch {
      continue;
    }
    const original = src;
    const ordered = [...list].sort((a, b) => b.autofix!.offset - a.autofix!.offset);
    let floor = Infinity; // start of the last applied edit: later (earlier-offset) edits must end before it
    for (const f of ordered) {
      const { offset, insert, description } = f.autofix!;
      const del = f.autofix!.deleteLength ?? 0;
      if (offset < 0 || offset + del > src.length || offset + del > floor) continue; // overlapping / out of range
      if (offset + del === floor && del === 0 && floor !== Infinity) continue; // same insertion point twice
      if (del === 0 && src.slice(offset, offset + insert.length) === insert) continue; // insert already applied
      const lineStart = src.lastIndexOf('\n', offset - 1) + 1;
      const lineEndIdx = src.indexOf('\n', offset + del);
      const lineEnd = lineEndIdx === -1 ? src.length : lineEndIdx;
      const before = src.slice(lineStart, lineEnd);
      src = src.slice(0, offset) + insert + src.slice(offset + del);
      const after = src.slice(lineStart, lineEnd - del + insert.length);
      floor = offset;
      changes.push({ file, line: src.slice(0, offset).split('\n').length, ruleId: f.ruleId, description, before: before.trim(), after: after.trim() });
      applied.push(f);
    }
    if (src !== original) {
      files.push(file);
      if (!opts.dryRun) writeFileSync(path, src);
    }
  }
  changes.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  return { changes, files, applied };
}
