import type { LangId } from './types.js';

export interface LangSpec {
  id: LangId;
  grammar: string;
  call: string[];
  /** member access node type -> [objectField, propertyField] */
  member: Record<string, [string, string]>;
  loops: string[];
  /** function boundaries that reset loop context */
  functions: string[];
  lambdas: string[];
  strings: string[];
  regex?: string;
  /** callback-iterating method names (arr.map(fn) etc.) */
  iterMethods: string[];
}

const JS_BASE = {
  call: ['call_expression'],
  member: { member_expression: ['object', 'property'] as [string, string] },
  loops: ['for_statement', 'for_in_statement', 'while_statement', 'do_statement'],
  functions: ['function_declaration', 'method_definition', 'generator_function_declaration', 'class_declaration'],
  lambdas: ['arrow_function', 'function_expression', 'function'],
  strings: ['string', 'template_string'],
  regex: 'regex',
  iterMethods: ['map', 'forEach', 'flatMap', 'reduce', 'filter', 'some', 'every', 'each', 'mapSeries', 'eachSeries', 'mapLimit', 'eachLimit', 'forEachOf', 'times'],
};

export const LANGS: Record<LangId, LangSpec> = {
  javascript: { id: 'javascript', grammar: 'tree-sitter-javascript.wasm', ...JS_BASE },
  typescript: { id: 'typescript', grammar: 'tree-sitter-typescript.wasm', ...JS_BASE },
  tsx: { id: 'tsx', grammar: 'tree-sitter-tsx.wasm', ...JS_BASE },
  python: {
    id: 'python',
    grammar: 'tree-sitter-python.wasm',
    call: ['call'],
    member: { attribute: ['object', 'attribute'] },
    loops: ['for_statement', 'while_statement', 'list_comprehension', 'set_comprehension', 'dictionary_comprehension', 'generator_expression'],
    functions: ['function_definition', 'class_definition'],
    lambdas: ['lambda'],
    strings: ['string'],
    iterMethods: [],
  },
  go: {
    id: 'go',
    grammar: 'tree-sitter-go.wasm',
    call: ['call_expression'],
    member: { selector_expression: ['operand', 'field'] },
    loops: ['for_statement'],
    functions: ['function_declaration', 'method_declaration'],
    lambdas: ['func_literal'],
    strings: ['interpreted_string_literal', 'raw_string_literal'],
    iterMethods: [],
  },
};

const EXT: Record<string, LangId> = {
  '.js': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript', '.jsx': 'tsx',
  '.ts': 'typescript', '.mts': 'typescript', '.cts': 'typescript', '.tsx': 'tsx',
  '.py': 'python',
  '.go': 'go',
};

export function langForFile(file: string): LangId | undefined {
  const i = file.lastIndexOf('.');
  if (i < 0) return undefined;
  if (file.endsWith('.d.ts')) return undefined;
  return EXT[file.slice(i).toLowerCase()];
}

export const SUPPORTED_EXTENSIONS = Object.keys(EXT);
