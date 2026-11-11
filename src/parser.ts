import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LANGS } from './languages.js';
import type { LangId } from './types.js';

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-var-requires
const Parser = require('web-tree-sitter');

export type TSNode = {
  type: string;
  text: string;
  startPosition: { row: number; column: number };
  endPosition: { row: number; column: number };
  startIndex: number;
  endIndex: number;
  parent: TSNode | null;
  childCount: number;
  namedChildCount: number;
  namedChildren: TSNode[];
  children: TSNode[];
  firstNamedChild: TSNode | null;
  childForFieldName(name: string): TSNode | null;
  namedChild(i: number): TSNode | null;
  child(i: number): TSNode | null;
  equals(other: TSNode): boolean;
};
export type TSTree = { rootNode: TSNode; delete(): void };

function grammarDir(): string {
  // dist/cli.js -> ../grammars ; src/parser.ts -> ../grammars
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 4; i++) {
    const candidate = join(dir, 'grammars');
    if (existsSync(candidate)) return candidate;
    dir = dirname(dir);
  }
  throw new Error('querydig: grammars directory not found');
}

let initPromise: Promise<void> | null = null;
const languages = new Map<LangId, unknown>();
const parsers = new Map<LangId, { parse(src: string): TSTree }>();

export function initParser(): Promise<void> {
  if (!initPromise) initPromise = Parser.init();
  return initPromise!;
}

export async function getParser(lang: LangId) {
  await initParser();
  let p = parsers.get(lang);
  if (p) return p;
  let language = languages.get(lang);
  if (!language) {
    language = await Parser.Language.load(join(grammarDir(), LANGS[lang].grammar));
    languages.set(lang, language);
  }
  const parser = new Parser();
  parser.setLanguage(language);
  p = parser as { parse(src: string): TSTree };
  parsers.set(lang, p);
  return p;
}
