import type { Analyzer, Ctx, OpDef, QueryCall } from '../analyzer.js';
import type { LangSpec } from '../languages.js';
import type { TSNode } from '../parser.js';
import type { Autofix } from '../types.js';

/** The parts of a call node the analyzer needs: `receiver.method(args)`. */
export interface CallInfo {
  method: string;
  /** node holding the method name (used for positions) */
  methodNode: TSNode | null;
  /** the expression the method is called on, or null for a bare call `foo()` */
  receiver: TSNode | null;
  /** the argument-list node (its named children are the arguments), or null */
  args: TSNode | null;
}

/**
 * A language plugin. JS/TS, Python and Go are handled inline in analyzer.ts; newer languages
 * (Java, Ruby, PHP, ...) live in src/langs/<lang>.ts and plug in through these hooks.
 *
 * Every hook is optional. A hook that returns `undefined` means "no opinion, use the generic logic".
 */
export interface LangPlugin {
  spec: LangSpec;
  /** file extensions (lowercase, with dot) mapped to this language */
  extensions: string[];

  /** Decompose a call node (any of spec.call). Required when the grammar has no `function` field on calls. */
  callInfo?(node: TSNode): CallInfo | null;

  /** Extra source-level markers that a file talks to MongoDB / SQL (imports, annotations, base classes). */
  fileHints?: { mongo?: RegExp; sql?: RegExp };

  /**
   * Map a call to a database operation. Return an OpDef, `null` to reject the call outright,
   * or `undefined` to fall back to `ops[method]`.
   */
  opDef?(method: string, receiver: string, args: TSNode[], a: Analyzer, node: TSNode): OpDef | null | undefined;
  /** Method name -> operation table (used when opDef returns undefined). */
  ops?: Record<string, OpDef>;

  /** Handle a loop node (any of spec.loops). Return true when handled (you must visit the children yourself). */
  visitLoop?(node: TSNode, ctx: Ctx, a: Analyzer): boolean;
  /**
   * Called for every call node before generic child traversal. Return true when you visited the
   * children yourself (e.g. Ruby `users.each do |u| ... end`, Java `list.forEach(u -> ...)`).
   * Classification/evaluation of the call itself has already happened.
   */
  visitCall?(node: TSNode, ctx: Ctx, a: Analyzer): boolean;

  /** Filter keys for live-mode shapes and index suggestions. */
  filterKeys?(q: QueryCall, a: Analyzer): string[] | undefined;
  /** Fix text for N+1 findings. */
  batchFix?(q: QueryCall): string | undefined;
  /** SQ001: is this ORM read unbounded? */
  unbounded?(q: QueryCall, a: Analyzer): boolean | undefined;
  /** Variable that the result of `top` is assigned to (for QD002 tracking). */
  assignTarget?(top: TSNode): TSNode | null | undefined;
  /** Run language-specific rules for a classified query (after the generic ones). Use `a.add(...)`. */
  extraRules?(q: QueryCall, ctx: Ctx, a: Analyzer): void;
  /** Run once per file after traversal (e.g. string-only checks). */
  finish?(root: TSNode, a: Analyzer): void;
  /** Build an autofix for a finding produced by the generic rules (e.g. MQ008/SQ009). */
  autofix?(ruleId: string, q: QueryCall, a: Analyzer): Autofix | undefined;
}
