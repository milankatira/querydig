import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Severity } from './types.js';

export interface QuerydigConfig {
  include?: string[];
  ignore?: string[];
  includeTests?: boolean;
  /** rule id -> 'off' | severity override */
  rules?: Record<string, 'off' | Severity>;
  failOn?: Severity;
  minSeverity?: Severity;
}

export const CONFIG_FILES = ['querydig.config.json', '.querydigrc.json', '.querydigrc'];

export const DEFAULT_IGNORE = [
  '**/node_modules/**', '**/dist/**', '**/build/**', '**/out/**', '**/.next/**', '**/.nuxt/**', '**/coverage/**',
  '**/vendor/**', '**/.git/**', '**/.venv/**', '**/venv/**', '**/__pycache__/**', '**/site-packages/**',
  '**/*.min.js', '**/*.bundle.js', '**/*.d.ts', '**/.querydig/**',
];

export const TEST_IGNORE = [
  '**/*.test.*', '**/*.spec.*', '**/*_test.go', '**/test_*.py', '**/*_test.py', '**/tests/**', '**/test/**',
  '**/__tests__/**', '**/__mocks__/**', '**/spec/**', '**/specs/**', '**/benchmark/**', '**/benchmarks/**', '**/bench/**', '**/e2e/**', '**/fixtures/**', '**/migrations/**', '**/migration/**', '**/*migration*/**', '**/alembic/**', '**/tests.py', '**/conftest.py', '**/testdata/**', '**/testutil/**', '**/unittest/**', '**/testing/**', '**/seed/**', '**/seeds/**', '**/seeders/**',
];

export function loadConfig(root: string, explicit?: string): QuerydigConfig {
  const candidates = explicit ? [explicit] : CONFIG_FILES.map((f) => join(root, f));
  for (const file of candidates) {
    if (!existsSync(file)) continue;
    try {
      return JSON.parse(readFileSync(file, 'utf8')) as QuerydigConfig;
    } catch (e) {
      throw new Error(`querydig: invalid config ${file}: ${(e as Error).message}`);
    }
  }
  return {};
}
