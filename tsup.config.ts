import { readFileSync } from 'node:fs';
import { defineConfig } from 'tsup';

const { version } = JSON.parse(readFileSync('./package.json', 'utf8'));

export default defineConfig({
  entry: ['src/cli.ts', 'src/worker.ts', 'src/index.ts'],
  format: ['esm'],
  target: 'node20',
  platform: 'node',
  clean: true,
  splitting: true,
  sourcemap: false,
  external: ['web-tree-sitter', 'mongodb', 'pg'],
  define: { __QUERYDIG_VERSION__: JSON.stringify(version) },
});
