import { createHash } from 'node:crypto';
import { LANGS, type LangSpec } from './languages.js';
import { getParser, type TSNode } from './parser.js';
import { RULE_MAP } from './rules.js';
import type { Confidence, Db, Finding, LangId, QueryShape, Severity, SortKey } from './types.js';

// ---------------------------------------------------------------------------
// Operation catalogue
// ---------------------------------------------------------------------------

type Kind = 'read' | 'readMany' | 'write' | 'batchWrite' | 'count' | 'aggregate' | 'raw';
type Hint = 'none' | 'weak' | 'strong';
interface OpDef { kind: Kind; db: Db | 'any'; hint: Hint; orm?: string }

const op = (kind: Kind, db: Db | 'any', hint: Hint = 'none', orm?: string): OpDef => ({ kind, db, hint, orm });

const JS_OPS: Record<string, OpDef> = {
  find: op('readMany', 'any', 'weak'),
  findOne: op('read', 'any', 'weak'),
  findById: op('read', 'mongodb', 'weak', 'mongoose'),
  exists: op('count', 'mongodb', 'weak'),
  countDocuments: op('count', 'mongodb'),
  estimatedDocumentCount: op('count', 'mongodb'),
  count: op('count', 'any', 'weak'),
  aggregate: op('aggregate', 'any', 'weak'),
  distinct: op('readMany', 'mongodb', 'weak'),
  mapReduce: op('aggregate', 'mongodb', 'weak'),
  updateOne: op('write', 'mongodb'),
  updateMany: op('write', 'any', 'weak'),
  deleteOne: op('write', 'mongodb'),
  deleteMany: op('write', 'any', 'weak'),
  insertOne: op('write', 'mongodb'),
  insertMany: op('batchWrite', 'mongodb'),
  replaceOne: op('write', 'mongodb'),
  bulkWrite: op('batchWrite', 'mongodb'),
  findOneAndUpdate: op('write', 'mongodb'),
  findOneAndDelete: op('write', 'mongodb'),
  findOneAndReplace: op('write', 'mongodb'),
  findByIdAndUpdate: op('write', 'mongodb', 'none', 'mongoose'),
  findByIdAndDelete: op('write', 'mongodb', 'none', 'mongoose'),
  findByIdAndRemove: op('write', 'mongodb', 'none', 'mongoose'),
  create: op('write', 'any', 'weak'),
  save: op('write', 'any', 'weak'),
  insert: op('write', 'any', 'strong'),
  update: op('write', 'any', 'strong'),
  delete: op('write', 'any', 'strong'),
  remove: op('write', 'any', 'strong'),
  upsert: op('write', 'any', 'strong'),
  // Prisma
  findUnique: op('read', 'sql', 'none', 'prisma'),
  findUniqueOrThrow: op('read', 'sql', 'none', 'prisma'),
  findFirst: op('read', 'sql', 'none', 'prisma'),
  findFirstOrThrow: op('read', 'sql', 'none', 'prisma'),
  findMany: op('readMany', 'sql', 'none', 'prisma'),
  createMany: op('batchWrite', 'sql', 'none', 'prisma'),
  $queryRaw: op('raw', 'sql'), $queryRawUnsafe: op('raw', 'sql'), $executeRaw: op('raw', 'sql'), $executeRawUnsafe: op('raw', 'sql'),
  // TypeORM
  findOneBy: op('read', 'sql', 'none', 'typeorm'),
  findOneOrFail: op('read', 'sql', 'none', 'typeorm'),
  findOneByOrFail: op('read', 'sql', 'none', 'typeorm'),
  findBy: op('readMany', 'sql', 'none', 'typeorm'),
  findAndCount: op('readMany', 'sql', 'none', 'typeorm'),
  findAndCountBy: op('readMany', 'sql', 'none', 'typeorm'),
  getMany: op('readMany', 'sql', 'none', 'typeorm'),
  getOne: op('read', 'sql', 'none', 'typeorm'),
  getRawMany: op('readMany', 'sql', 'none', 'typeorm'),
  getRawOne: op('read', 'sql', 'none', 'typeorm'),
  // Sequelize
  findAll: op('readMany', 'sql', 'none', 'sequelize'),
  findByPk: op('read', 'sql', 'none', 'sequelize'),
  findOrCreate: op('write', 'sql', 'none', 'sequelize'),
  bulkCreate: op('batchWrite', 'sql', 'none', 'sequelize'),
  // raw drivers (pg, mysql2, knex.raw, sequelize.query, typeorm query)
  query: op('raw', 'sql', 'strong'),
  execute: op('raw', 'sql', 'strong'),
  raw: op('raw', 'sql', 'strong'),
};

const PY_OPS: Record<string, OpDef> = {
  find: op('readMany', 'mongodb', 'weak', 'pymongo'),
  find_one: op('read', 'mongodb', 'none', 'pymongo'),
  count_documents: op('count', 'mongodb', 'none', 'pymongo'),
  estimated_document_count: op('count', 'mongodb', 'none', 'pymongo'),
  aggregate: op('aggregate', 'mongodb', 'weak', 'pymongo'),
  distinct: op('readMany', 'mongodb', 'weak', 'pymongo'),
  map_reduce: op('aggregate', 'mongodb', 'weak', 'pymongo'),
  update_one: op('write', 'mongodb', 'none', 'pymongo'),
  update_many: op('write', 'mongodb', 'none', 'pymongo'),
  insert_one: op('write', 'mongodb', 'none', 'pymongo'),
  insert_many: op('batchWrite', 'mongodb', 'none', 'pymongo'),
  delete_one: op('write', 'mongodb', 'none', 'pymongo'),
  delete_many: op('write', 'mongodb', 'none', 'pymongo'),
  replace_one: op('write', 'mongodb', 'none', 'pymongo'),
  bulk_write: op('batchWrite', 'mongodb', 'none', 'pymongo'),
  find_one_and_update: op('write', 'mongodb', 'none', 'pymongo'),
  find_one_and_delete: op('write', 'mongodb', 'none', 'pymongo'),
  find_one_and_replace: op('write', 'mongodb', 'none', 'pymongo'),
  // raw DB-API cursors / SQLAlchemy
  execute: op('raw', 'sql', 'strong'),
  executemany: op('raw', 'sql', 'strong'),
  scalars: op('raw', 'sql', 'strong', 'sqlalchemy'),
  scalar: op('raw', 'sql', 'strong', 'sqlalchemy'),
};

/** Django manager / queryset methods, only when the receiver goes through `.objects` or `*_set`. */
const DJANGO_OPS: Record<string, Kind> = {
  get: 'read', first: 'read', last: 'read', earliest: 'read', latest: 'read',
  filter: 'readMany', all: 'readMany', exclude: 'readMany', values: 'readMany', values_list: 'readMany',
  count: 'count', exists: 'count', aggregate: 'aggregate',
  create: 'write', update: 'write', delete: 'write', get_or_create: 'write', update_or_create: 'write',
  bulk_create: 'batchWrite', bulk_update: 'batchWrite',
};

/** SQLAlchemy session methods, only when the receiver looks like a session. */
const SQLA_OPS: Record<string, Kind> = { query: 'readMany', get: 'read', add: 'write', merge: 'write', delete: 'write' };

const GO_OPS: Record<string, OpDef> = {
  FindOne: op('read', 'mongodb', 'none', 'mongo-go-driver'),
  CountDocuments: op('count', 'mongodb', 'none', 'mongo-go-driver'),
  EstimatedDocumentCount: op('count', 'mongodb', 'none', 'mongo-go-driver'),
  Aggregate: op('aggregate', 'mongodb', 'none', 'mongo-go-driver'),
  Distinct: op('readMany', 'mongodb', 'none', 'mongo-go-driver'),
  UpdateOne: op('write', 'mongodb', 'none', 'mongo-go-driver'),
  UpdateMany: op('write', 'mongodb', 'none', 'mongo-go-driver'),
  UpdateByID: op('write', 'mongodb', 'none', 'mongo-go-driver'),
  InsertOne: op('write', 'mongodb', 'none', 'mongo-go-driver'),
  InsertMany: op('batchWrite', 'mongodb', 'none', 'mongo-go-driver'),
  DeleteOne: op('write', 'mongodb', 'none', 'mongo-go-driver'),
  DeleteMany: op('write', 'mongodb', 'none', 'mongo-go-driver'),
  ReplaceOne: op('write', 'mongodb', 'none', 'mongo-go-driver'),
  BulkWrite: op('batchWrite', 'mongodb', 'none', 'mongo-go-driver'),
  FindOneAndUpdate: op('write', 'mongodb', 'none', 'mongo-go-driver'),
  FindOneAndDelete: op('write', 'mongodb', 'none', 'mongo-go-driver'),
  FindOneAndReplace: op('write', 'mongodb', 'none', 'mongo-go-driver'),
  // database/sql, sqlx, pgx
  Query: op('raw', 'sql', 'weak'),
  QueryContext: op('raw', 'sql', 'weak'),
  QueryRow: op('raw', 'sql', 'weak'),
  QueryRowContext: op('raw', 'sql', 'weak'),
  Exec: op('raw', 'sql', 'weak'),
  ExecContext: op('raw', 'sql', 'weak'),
  Raw: op('raw', 'sql', 'weak', 'gorm'),
  // gorm
  First: op('read', 'sql', 'weak', 'gorm'),
  Take: op('read', 'sql', 'weak', 'gorm'),
  Last: op('read', 'sql', 'weak', 'gorm'),
  Create: op('write', 'sql', 'weak', 'gorm'),
  Save: op('write', 'sql', 'weak', 'gorm'),
  Updates: op('write', 'sql', 'weak', 'gorm'),
  CreateInBatches: op('batchWrite', 'sql', 'weak', 'gorm'),
};

const HINT_RE = /(model|collection|\bcoll\b|repo|repository|\bdb\b|_db\b|db_|database|prisma|session|cursor|\bcur\b|pool|client|\bconn\b|connection|knex|sequelize|objects|\btx\b|\btrx\b|dao|datasource|\bem\b|entitymanager|mongo|gorm|stmt)/i;
const SQL_RECEIVER_RE = /(prisma|repository|repo\b|objects|session|entitymanager|\bem\b|knex|sequelize|gorm|_set$)/i;
const SQL_TEXT_RE = /^\s*(select|insert|update|delete|with|replace)\b/i;

const MONGO_FILE_RE = /\b(mongoose|mongodb|pymongo|motor|mongoengine|go\.mongodb\.org|bson)\b/;
const SQL_FILE_RE = /(@prisma\/client|\bprisma\b|typeorm|sequelize|\bknex\b|['"]pg['"]|mysql|sqlite|sqlalchemy|\bdjango\b|gorm\.io|database\/sql|sqlx|psycopg|drizzle|kysely|pgx)/;

const BUILTIN_ROOTS = new Set([
  'Object', 'Array', 'Promise', 'JSON', 'Math', 'Date', 'Reflect', 'Number', 'String', 'Symbol', 'Map', 'Set',
  'WeakMap', 'Intl', 'Buffer', 'process', 'console', 'window', 'document', 'localStorage', 'sessionStorage',
  'React', 'Vue', 'URL', 'Error', 'RegExp', 'Proxy', 'BigInt', 'Atomics', 'Event', 'Blob', 'File', 'FormData',
  'strings', 'bytes', 'sort', 'slices', 'maps', 'os', 'fmt', 're', 'json', 'math', 'time', 'path', 'filepath',
]);

const DEFAULT_TEST_LOOP_BREAKERS = new Set(['while_statement', 'do_statement']);

// ---------------------------------------------------------------------------

interface ChainLink { name: string; args: string; node: TSNode }
interface QueryCall {
  node: TSNode;
  top: TSNode;
  method: string;
  kind: Kind;
  db: Db;
  orm?: string;
  receiver: string;
  receiverText: string;
  collection?: string;
  args: TSNode[];
  argsText: string;
  chain: ChainLink[];
  confidence: Confidence;
  shapeId?: string;
}
interface Ctx { depth: number; over: boolean; loopLine?: number; overVar?: string; loopVars?: string[]; iterName?: string }

export interface AnalyzeOptions { relPath: string; lang: LangId }

const same = (a: TSNode | null | undefined, b: TSNode | null | undefined) =>
  !!a && !!b && a.startIndex === b.startIndex && a.endIndex === b.endIndex && a.type === b.type;

const stripQuotes = (s: string) => s.replace(/^[rRbBuUfF]{0,2}(['"`]{1,3})([\s\S]*?)\1$/, '$2');

export interface AnalyzeResult { findings: Finding[]; shapes: QueryShape[] }

export async function analyzeSourceFull(source: string, opts: AnalyzeOptions): Promise<AnalyzeResult> {
  if (/querydig-ignore-file/.test(source.slice(0, 2000))) return { findings: [], shapes: [] };
  const parser = await getParser(opts.lang);
  const tree = parser.parse(source);
  try {
    const a = new Analyzer(source, opts, LANGS[opts.lang]);
    const findings = a.run(tree.rootNode);
    return { findings, shapes: a.shapes };
  } finally {
    tree.delete();
  }
}

export async function analyzeSource(source: string, opts: AnalyzeOptions): Promise<Finding[]> {
  return (await analyzeSourceFull(source, opts)).findings;
}

/** Table name and WHERE / ORDER BY columns from a SQL string (best effort). */
export function sqlShape(sql: string): { table?: string; filterKeys: string[]; sortKeys: SortKey[]; hasLimit: boolean } {
  const unq = (x: string) => x.replace(/["`\[\]]/g, '').split('.').pop()!;
  const table = /\b(?:from|update|into)\s+([\w."`\[\]]+)/i.exec(sql)?.[1];
  const where = /\bwhere\b([\s\S]*?)(\border\s+by\b|\bgroup\s+by\b|\blimit\b|\boffset\b|\breturning\b|$)/i.exec(sql)?.[1] ?? '';
  const filterKeys = [...where.matchAll(/([\w."`]+)\s*(?:=|<>|!=|<=|>=|<|>|\bin\b|\blike\b|\bilike\b|\bis\b|\bbetween\b)/gi)]
    .map((m) => unq(m[1])).filter((k) => !/^(and|or|not|\d+)$/i.test(k));
  const order = /\border\s+by\s+([\s\S]*?)(\blimit\b|\boffset\b|$)/i.exec(sql)?.[1] ?? '';
  const sortKeys: SortKey[] = order.split(',').map((p) => p.trim()).filter((p) => /^[\w."`]+/.test(p) && !/\(/.test(p))
    .map((p) => ({ key: unq(p.split(/\s+/)[0]), dir: /\bdesc\b/i.test(p) ? -1 : 1 }) as SortKey);
  return { table: table ? unq(table) : undefined, filterKeys: [...new Set(filterKeys)], sortKeys, hasLimit: /\blimit\b|\bfetch\s+first\b/i.test(sql) };
}

class Analyzer {
  private lines: string[];
  private findings: Finding[] = [];
  shapes: QueryShape[] = [];
  private queryVars = new Set<string>();
  private hasMongo: boolean;
  private hasSql: boolean;
  private hasMongoose: boolean;
  private isJs: boolean;

  constructor(private src: string, private opts: AnalyzeOptions, private spec: LangSpec) {
    this.lines = src.split('\n');
    this.hasMongo = MONGO_FILE_RE.test(src);
    this.hasSql = SQL_FILE_RE.test(src);
    this.hasMongoose = /\bmongoose\b/.test(src) || /@nestjs\/mongoose|InjectModel/.test(src);
    this.isJs = spec.id === 'javascript' || spec.id === 'typescript' || spec.id === 'tsx';
  }

  run(root: TSNode): Finding[] {
    this.visit(root, { depth: 0, over: false });
    return this.applySuppressions();
  }

  // ------------------------------------------------------------- traversal

  private visit(node: TSNode, ctx: Ctx): void {
    const t = node.type;
    if (t === 'comment') return;
    if (this.spec.functions.includes(t)) ctx = { depth: 0, over: false };

    if (this.spec.loops.includes(t)) return this.visitLoop(node, ctx);
    if (this.spec.call.includes(t)) return this.visitCall(node, ctx);
    if (this.spec.strings.includes(t)) this.checkSqlString(node);

    for (const c of node.namedChildren) this.visit(c, ctx);
  }

  private identsOf(node: TSNode | null | undefined): string[] {
    if (!node) return [];
    const out: string[] = [];
    const stack = [node];
    while (stack.length) {
      const n = stack.pop()!;
      if (n.type === 'identifier' || n.type === 'shorthand_property_identifier_pattern') out.push(n.text);
      else if (n.type !== 'type_annotation') stack.push(...n.namedChildren);
    }
    return out;
  }

  private inner(ctx: Ctx, node: TSNode, iterable: TSNode | null, forceOver = false, vars?: TSNode | null): Ctx {
    const nextRecv = iterable ? /^([A-Za-z_]\w*)\.Next\(/.exec(iterable.text)?.[1] : undefined;
    const overVar = nextRecv ?? (iterable
      ? (this.spec.call.includes(iterable.type) || iterable.type === 'await_expression') && iterable.text.length <= 60
        ? iterable.text.replace(/\s+/g, ' ')
        : this.rootIdent(iterable)
      : undefined);
    const over = ctx.over || forceOver || (iterable ? this.isOverResults(iterable) : false);
    return {
      depth: ctx.depth + 1, over, loopLine: node.startPosition.row + 1, overVar: over ? (overVar ?? ctx.overVar) : ctx.overVar,
      loopVars: [...(ctx.loopVars ?? []), ...this.identsOf(vars)],
      iterName: iterable ? (this.path(iterable) || ctx.iterName) : ctx.iterName,
    };
  }

  private visitLoop(node: TSNode, ctx: Ctx): void {
    const t = node.type;
    const id = this.spec.id;

    // while / do-while are usually polling or batching loops: don't count as N+1 loops
    if (DEFAULT_TEST_LOOP_BREAKERS.has(t)) {
      for (const c of node.namedChildren) this.visit(c, ctx);
      return;
    }

    if (id === 'go') {
      const range = node.namedChildren.find((c) => c.type === 'range_clause');
      const clause = node.namedChildren.find((c) => c.type === 'for_clause');
      const body = node.childForFieldName('body') ?? node.namedChildren.find((c) => c.type === 'block');
      if (range) {
        const right = range.childForFieldName('right');
        if (right) this.visit(right, ctx);
        const inner = this.inner(ctx, node, right, false, range.childForFieldName('left'));
        if (body) this.visit(body, inner);
        return;
      }
      const cond = node.namedChildren.find((c) => c !== body && c.type !== 'block' && c.type !== 'for_clause');
      if (cond && /\.Next\(/.test(cond.text)) {
        const inner = this.inner(ctx, node, cond, true);
        this.visit(cond, ctx);
        if (body) this.visit(body, inner);
        return;
      }
      if (clause) {
        this.visit(clause, ctx);
        // `for i := 0; ; i += batch` has no condition: a batching loop, not a per-item loop
        if (body) this.visit(body, clause.childForFieldName('condition') ? this.inner(ctx, node, null) : ctx);
        return;
      }
      // `for {}` or `for cond {}`: polling loop
      for (const c of node.namedChildren) this.visit(c, ctx);
      return;
    }

    if (id === 'python') {
      if (t === 'for_statement') {
        const right = node.childForFieldName('right');
        if (right) this.visit(right, ctx);
        const inner = this.inner(ctx, node, right, false, node.childForFieldName('left'));
        for (const c of node.namedChildren) if (!same(c, right) && !same(c, node.childForFieldName('left'))) this.visit(c, inner);
        return;
      }
      // comprehensions
      const clauses = node.namedChildren.filter((c) => c.type === 'for_in_clause');
      const firstRight = clauses[0]?.childForFieldName('right') ?? null;
      if (firstRight) this.visit(firstRight, ctx);
      const inner = this.inner(ctx, node, firstRight, false, clauses[0]?.childForFieldName('left'));
      for (const c of node.namedChildren) {
        if (c.type === 'for_in_clause') {
          const r = c.childForFieldName('right');
          if (r && !same(r, firstRight)) this.visit(r, inner);
        } else this.visit(c, inner);
      }
      return;
    }

    // JS / TS
    if (t === 'for_in_statement') {
      const right = node.childForFieldName('right');
      if (right) this.visit(right, ctx);
      const inner = this.inner(ctx, node, right, false, node.childForFieldName('left'));
      const body = node.childForFieldName('body');
      if (body) this.visit(body, inner);
      return;
    }
    // C-style for: `for(;;)` without condition is a polling loop
    const cond = node.childForFieldName('condition');
    const isInfinite = !cond || cond.text.trim() === ';' || cond.text.trim() === 'true;' || cond.text.trim() === '';
    const inner = isInfinite ? ctx : this.inner(ctx, node, null);
    for (const c of node.namedChildren) this.visit(c, inner);
  }

  private visitCall(node: TSNode, ctx: Ctx): void {
    const q = this.classify(node);
    if (q) this.evaluate(q, ctx);

    // iterating callbacks: users.map(async u => ...)
    const callee = node.childForFieldName('function');
    const memberFields = callee ? this.spec.member[callee.type] : undefined;
    if (callee && memberFields && this.spec.iterMethods.length) {
      const prop = callee.childForFieldName(memberFields[1])?.text ?? '';
      const args = this.argNodes(node);
      if (this.spec.iterMethods.includes(prop) && args.some((a) => this.spec.lambdas.includes(a.type))) {
        const recv = callee.childForFieldName(memberFields[0]);
        if (recv) this.visit(recv, ctx);
        for (const a of args) {
          if (!this.spec.lambdas.includes(a.type)) {
            this.visit(a, ctx);
            continue;
          }
          const params = a.childForFieldName('parameters') ?? a.childForFieldName('parameter');
          this.visit(a, this.inner(ctx, node, recv, false, params));
        }
        return;
      }
    }
    for (const c of node.namedChildren) this.visit(c, ctx);
  }

  // ------------------------------------------------------------- helpers

  private argNodes(call: TSNode): TSNode[] {
    const a = call.childForFieldName('arguments');
    if (!a) return [];
    if (a.type === 'template_string' || a.type === 'generator_expression') return [a];
    return a.namedChildren.filter((c) => c.type !== 'comment');
  }

  /** Dotted path of an expression without call arguments: `db.collection().find` */
  private path(node: TSNode | null, depth = 0): string {
    if (!node || depth > 12) return '';
    const mf = this.spec.member[node.type];
    if (mf) return `${this.path(node.childForFieldName(mf[0]), depth + 1)}.${node.childForFieldName(mf[1])?.text ?? ''}`;
    if (this.spec.call.includes(node.type)) return `${this.path(node.childForFieldName('function'), depth + 1)}()`;
    switch (node.type) {
      case 'identifier': case 'this': case 'self': case 'property_identifier': case 'field_identifier': case 'type_identifier':
        return node.text;
      case 'await_expression': case 'parenthesized_expression': case 'non_null_expression': case 'as_expression': case 'await':
        return this.path(node.namedChildren[0] ?? null, depth + 1);
      case 'subscript': case 'subscript_expression': case 'index_expression':
        return `${this.path(node.namedChildren[0] ?? null, depth + 1)}[]`;
      default:
        return node.text.length < 40 ? node.text : node.type;
    }
  }

  private rootIdent(node: TSNode): string | undefined {
    const p = this.path(node);
    const m = /^[A-Za-z_$][\w$]*/.exec(p.replace(/^(this|self)\./, ''));
    return m?.[0];
  }

  private containsQuery(node: TSNode, depth = 0): boolean {
    if (depth > 40) return false;
    if (this.spec.call.includes(node.type) && this.classify(node, true)) return true;
    return node.namedChildren.some((c) => this.containsQuery(c, depth + 1));
  }

  private isOverResults(iterable: TSNode): boolean {
    const id = this.rootIdent(iterable);
    if (id && this.queryVars.has(id)) return true;
    return this.containsQuery(iterable);
  }

  private collectionName(receiver: TSNode | null): string | undefined {
    if (!receiver) return undefined;
    const txt = receiver.text;
    const m = /(?:collection|Collection|getCollection)\(\s*['"`]([\w.-]+)['"`]/.exec(txt) ?? /\[\s*['"]([\w.-]+)['"]\s*\]$/.exec(txt);
    if (m) return m[1];
    const p = this.path(receiver).split('.').filter(Boolean);
    const last = p[p.length - 1];
    if (!last || last.endsWith('()')) return undefined;
    if (/^(objects|db|this|self|prisma)$/i.test(last)) return p.length > 1 && last === 'objects' ? p[p.length - 2] : undefined;
    return last.replace(/(Model|Repository|Repo|Collection|Coll)$/i, '') || last;
  }

  // ------------------------------------------------------------- classification

  private classify(node: TSNode, quick = false): QueryCall | null {
    const callee = node.childForFieldName('function');
    if (!callee) return null;
    const mf = this.spec.member[callee.type];
    if (!mf) return null;
    const method = callee.childForFieldName(mf[1])?.text ?? '';
    const receiverNode = callee.childForFieldName(mf[0]);
    if (!method || !receiverNode) return null;
    const receiver = this.path(receiverNode);
    if (BUILTIN_ROOTS.has(receiver.split(/[.([]/)[0])) return null;
    const args = this.argNodes(node);
    const first = args[0];

    let def: OpDef | undefined;
    const id = this.spec.id;
    if (id === 'python') {
      if (/(^|\.)objects(\.|\(|$)|_set$/.test(receiver) && DJANGO_OPS[method]) def = op(DJANGO_OPS[method], 'sql', 'none', 'django');
      else if (/session|\bdb\b/i.test(receiver) && SQLA_OPS[method] && !/\.objects/.test(receiver)) def = op(SQLA_OPS[method], 'sql', 'none', 'sqlalchemy');
      else def = PY_OPS[method];
      if (def && method === 'find' && first && first.type === 'string') return null; // str.find / soup.find
    } else if (id === 'go') {
      if (method === 'Find') {
        def = this.hasMongo && first && /\b(ctx|context|Context\(\)|TODO\(\)|Background\(\))/.test(first.text)
          ? op('readMany', 'mongodb', 'none', 'mongo-go-driver')
          : op('readMany', 'sql', 'weak', 'gorm');
      } else def = GO_OPS[method];
    } else {
      def = Object.prototype.hasOwnProperty.call(JS_OPS, method) ? JS_OPS[method] : undefined;
      if (def && first && this.spec.lambdas.includes(first.type)) return null; // arr.find(x => ...)
      if (def && (method === 'find' || method === 'findOne') && first && (first.type === 'string' || first.type === 'number')) return null;
    }
    if (!def) return null;

    // raw query: require SQL-looking first argument or strong receiver hint
    const firstText = first ? stripQuotes(first.text) : '';
    const sqlArg = SQL_TEXT_RE.test(firstText);
    const hinted = HINT_RE.test(receiver);
    const capitalized = /^[A-Z]/.test(receiver.replace(/^(this|self)\./, ''));
    const isChainedFromCall = receiver.endsWith('()');
    if (def.kind === 'raw') {
      const plainString = !!first && this.spec.strings.includes(first.type) && !sqlArg;
      if (!sqlArg && !(hinted && args.length > 0 && !plainString)) return null;
    } else {
      if (def.hint === 'strong' && !hinted && !sqlArg) return null;
      const docSave = this.isJs && method === 'save' && args.length === 0 && (this.hasMongo || this.hasSql);
      if (def.hint === 'weak' && !hinted && !capitalized && !sqlArg && !docSave && !(id === 'go' && isChainedFromCall)) return null;
    }
    if (method === 'save' && this.isJs && args.length > 1) return null;

    // dedupe: if a call below us in the chain is itself a query, it owns the chain
    let down: TSNode | null = receiverNode;
    const downChain: ChainLink[] = [];
    while (down && this.spec.call.includes(down.type)) {
      const f = down.childForFieldName('function');
      const fm = f ? this.spec.member[f.type] : undefined;
      if (!f || !fm) break;
      if (!quick && this.classify(down, true)) return null;
      downChain.push({ name: f.childForFieldName(fm[1])?.text ?? '', args: down.childForFieldName('arguments')?.text ?? '', node: down });
      down = f.childForFieldName(fm[0]);
    }
    if (quick) return { node, top: node, method, kind: def.kind, db: 'unknown', receiver, receiverText: '', args, argsText: '', chain: [], confidence: 'low' };

    // walk up the fluent chain: .select().lean().limit()
    const up: ChainLink[] = [];
    let top = node;
    for (;;) {
      const p = top.parent;
      const pm = p ? this.spec.member[p.type] : undefined;
      if (!p || !pm || !same(p.childForFieldName(pm[0]), top)) break;
      const pp = p.parent;
      if (!pp || !this.spec.call.includes(pp.type) || !same(pp.childForFieldName('function'), p)) {
        break;
      }
      up.push({ name: p.childForFieldName(pm[1])?.text ?? '', args: pp.childForFieldName('arguments')?.text ?? '', node: pp });
      top = pp;
    }

    let db: Db = def.db === 'any' ? 'unknown' : def.db;
    if (def.db === 'any') {
      if (SQL_RECEIVER_RE.test(receiver) || sqlArg) db = 'sql';
      else if (/collection|mongo/i.test(receiver)) db = 'mongodb';
      else if (this.hasMongo && !this.hasSql) db = 'mongodb';
      else if (this.hasSql && !this.hasMongo) db = 'sql';
      else if (this.hasMongoose) db = 'mongodb';
    }
    if (def.kind === 'raw') db = 'sql';

    const confidence: Confidence = def.hint === 'none' || sqlArg ? 'high' : hinted ? 'medium' : 'low';
    const argsNode = node.childForFieldName('arguments');
    return {
      node, top, method, kind: def.kind, db, orm: def.orm ?? (this.hasMongoose && db === 'mongodb' && this.isJs ? 'mongoose' : undefined),
      receiver, receiverText: receiverNode.text, collection: this.collectionName(receiverNode), args, argsText: argsNode?.text ?? '',
      chain: [...downChain.reverse(), ...up], confidence,
    };
  }

  // ------------------------------------------------------------- rules

  private evaluate(q: QueryCall, ctx: Ctx): void {
    this.trackAssignment(q);
    this.recordShape(q, ctx);
    const target = q.collection ? `${q.collection}.${q.method}` : `${q.receiver}.${q.method}`;
    const loopInfo = ctx.loopLine ? ` (loop at line ${ctx.loopLine})` : '';

    // ---- loops ------------------------------------------------------
    const paginating = q.chain.some((c) => /^(skip|Skip|offset|Offset)$/.test(c.name) || (/^(Limit)$/.test(c.name) && c.args.includes(',')));
    if (ctx.depth > 0 && !paginating && !this.targetVariesPerIteration(q, ctx)) {
      const rawWrite = q.kind === 'raw' && /^\s*(insert|update|delete|replace)\b/i.test(q.args[0] ? stripQuotes(q.args[0].text) : '');
      const nested = ctx.depth >= 2 ? ` It is nested ${ctx.depth} loops deep, so the number of queries grows multiplicatively.` : '';
      if (q.kind === 'write' || q.kind === 'batchWrite' || rawWrite) {
        this.add('QD003', q.node, q, {
          severity: q.kind === 'batchWrite' ? 'medium' : ctx.depth >= 2 ? 'critical' : 'high',
          message: `\`${target}()\` runs once per iteration${loopInfo}.${nested}`,
          fix: q.db === 'mongodb' ? 'Collect the operations in an array and send them with one bulkWrite()/insertMany() call.' : undefined,
        });
      } else if (ctx.over) {
        this.add('QD002', q.node, q, {
          severity: 'critical',
          message: `\`${target}()\` is executed for every row of \`${ctx.overVar ?? 'a previous query'}\`, which itself came from the database${loopInfo}.${nested}`,
          fix: this.batchFix(q),
        });
      } else {
        this.add('QD001', q.node, q, {
          severity: ctx.depth >= 2 ? 'critical' : 'high',
          message: `\`${target}()\` is called inside a loop${loopInfo} — one round-trip per item.${nested}`,
          fix: this.batchFix(q),
        });
      }
    }

    if (q.db === 'mongodb') this.mongoRules(q);
    if (q.db === 'sql') this.sqlOrmRules(q);
  }

  private recordShape(q: QueryCall, ctx: Ctx): void {
    const id = `${this.opts.relPath}:${q.node.startPosition.row + 1}:${q.node.startPosition.column + 1}`;
    q.shapeId = id;
    let filterKeys = this.shapeFilterKeys(q);
    let sortKeys = this.sortKeys(q);
    let collection = q.collection;
    let sql: string | undefined;
    if (q.kind === 'raw' && q.args[0] && this.spec.strings.includes(q.args[0].type)) {
      sql = stripQuotes(q.args[0].text.replace(/\$\{[^}]*\}/g, '?')).replace(/\s+/g, ' ').trim();
      const sh = sqlShape(sql);
      collection = sh.table;
      filterKeys = sh.filterKeys;
      sortKeys = sh.sortKeys;
    }
    const hasLimit = q.kind === 'read' || this.chainHas(q, /^(limit|Limit|take|first|First|one|get|Take|Last)$/)
      || /\b(limit|take|SetLimit|first)\b/.test(q.argsText) || (!!sql && /\blimit\b/i.test(sql));
    this.shapes.push({
      id, db: q.db, orm: q.orm, collection, method: q.method, kind: q.kind, filterKeys, sortKeys, hasLimit,
      inLoop: ctx.depth > 0, sql, file: this.opts.relPath, line: q.node.startPosition.row + 1,
    });
  }

  private shapeFilterKeys(q: QueryCall): string[] {
    const clean = (k: string) => k.split('__')[0];
    // Prisma: { where: { ... } }
    if (q.orm === 'prisma' && q.args[0]?.type === 'object') {
      const where = q.args[0].namedChildren.find((c) => c.type === 'pair' && c.childForFieldName('key')?.text === 'where');
      const v = where?.childForFieldName('value');
      return v ? this.objectKeys(v) : [];
    }
    // Django / SQLAlchemy filter_by: keyword arguments, including chained filter() calls
    if (this.spec.id === 'python' && (q.orm === 'django' || q.orm === 'sqlalchemy')) {
      const txt = [q.argsText, ...q.chain.filter((c) => /^(filter|filter_by|get|exclude)$/.test(c.name)).map((c) => c.args)].join(' ');
      return [...new Set([...txt.matchAll(/(?:^|[(,\s])([a-z_][\w]*)\s*=(?!=)/gi)].map((m) => clean(m[1])))];
    }
    // GORM / xorm: Where("a = ? AND b > ?")
    if (q.orm === 'gorm' || this.spec.id === 'go') {
      const w = q.chain.filter((c) => /^(Where|And|Or)$/.test(c.name)).map((c) => c.args).join(' ');
      if (w) return sqlShape('select 1 from t where ' + stripQuotes(w.replace(/^\(|\)$/g, '').split(',')[0].trim())).filterKeys;
    }
    if (/^(findById|findByIdAndUpdate|findByIdAndDelete|findByIdAndRemove|findByPk|UpdateByID|findUnique)$/.test(q.method) && !this.filterKeys(q).length) return q.db === 'mongodb' ? ['_id'] : ['id'];
    return this.filterKeys(q);
  }

  /** Sort keys from .sort({ a: -1 }), .sort("a", -1), sort=[("a", -1)], SetSort(bson.D{{"a", -1}}), order_by("-a"). */
  private sortKeys(q: QueryCall): SortKey[] {
    const out: SortKey[] = [];
    const dirOf = (v?: string): 1 | -1 => (v && /^(-1|['"]?desc(ending)?['"]?|pymongo\.DESCENDING|DESCENDING)$/i.test(v.trim()) ? -1 : 1);
    const links = q.chain.filter((c) => /^(sort|Sort|order_by|orderBy|Order)$/.test(c.name)).map((c) => c.args);
    const fromArgs = /\bSetSort\(([^)]*\))|\bsort\s*=\s*(\[[^\]]*\])/.exec(q.argsText);
    if (fromArgs) links.push(fromArgs[1] ?? fromArgs[2]);
    const prismaOrder = /orderBy\s*:\s*(\{[^}]*\}|\[[^\]]*\])/.exec(q.argsText);
    if (prismaOrder) links.push(prismaOrder[1]);
    for (const txt of links) {
      const obj = /\{([^{}]*)\}/.exec(txt);
      if (obj && /:/.test(obj[1])) {
        for (const part of obj[1].split(',')) {
          const [k, v] = part.split(':').map((x) => x.trim().replace(/['"]/g, ''));
          if (k && /^[\w.]+$/.test(k)) out.push({ key: k, dir: dirOf(v) });
        }
        continue;
      }
      for (const m of txt.matchAll(/["'](-?)([\w.]+)["']\s*(?:,\s*(-?1|pymongo\.\w+|[A-Z]+))?/g)) {
        out.push({ key: m[2], dir: m[1] === '-' ? -1 : dirOf(m[3]) });
      }
    }
    const seen = new Set<string>();
    return out.filter((k) => !seen.has(k.key) && seen.add(k.key));
  }

  /** `collections.map(c => c.deleteMany({}))` hits a different collection each time: not N+1. */
  private targetVariesPerIteration(q: QueryCall, ctx: Ctx): boolean {
    const vars = ctx.loopVars ?? [];
    if (!vars.length) return false;
    const COLLECTIONISH = /(collection|coll\b|model|table|schema|repo|index|db\b|database|tenant|shard)/i;
    for (const v of vars) {
      const re = new RegExp(`(^|[^\\w$.])${v.replace(/\$/g, '\\$')}\\b`);
      if (!re.test(q.receiverText)) continue;
      if (COLLECTIONISH.test(v) || COLLECTIONISH.test(ctx.iterName ?? '') || /subclasses|models/i.test(ctx.iterName ?? '')) return true;
      if (/^[A-Z]/.test(v) && q.receiver.split('.')[0] === v) return true;
      if (new RegExp(`(collection|Collection|model|Model|table|Table)\\([^)]*\\b${v.replace(/\$/g, '\\$')}\\b`).test(q.receiverText)) return true;
    }
    return false;
  }

  private batchFix(q: QueryCall): string | undefined {
    if (q.db === 'mongodb') {
      const keys = this.filterKeys(q);
      const k = keys[0] ?? '_id';
      return `Collect the ${k} values first and run a single \`${q.collection ?? 'Model'}.find({ ${k}: { $in: values } })\`, then match results in memory with a Map. Or use $lookup in one aggregation.`;
    }
    if (q.orm === 'django') return 'Use select_related() / prefetch_related() on the outer queryset, or filter(id__in=ids) once.';
    if (q.orm === 'gorm') return 'Use Preload()/Joins() on the outer query or a single Where("id IN ?", ids).Find().';
    if (q.orm === 'prisma') return 'Use include/select relations on the outer query, or findMany({ where: { id: { in: ids } } }).';
    if (q.db === 'sql') return 'Use a JOIN or a single `WHERE id IN (...)`/`= ANY($1)` query and group the rows in memory.';
    return undefined;
  }

  private trackAssignment(q: QueryCall): void {
    let n: TSNode | null = q.top.parent;
    for (let i = 0; n && i < 4; i++) {
      if (['await_expression', 'parenthesized_expression', 'as_expression', 'non_null_expression', 'expression_list', 'await'].includes(n.type)) {
        n = n.parent;
        continue;
      }
      break;
    }
    if (!n) return;
    let target: TSNode | null = null;
    if (n.type === 'variable_declarator') target = n.childForFieldName('name');
    else if (n.type === 'assignment_expression' || n.type === 'assignment' || n.type === 'augmented_assignment') target = n.childForFieldName('left');
    else if (n.type === 'short_var_declaration' || n.type === 'assignment_statement') target = n.childForFieldName('left');
    if (!target) return;
    const name = /^[A-Za-z_$][\w$]*/.exec(target.text.replace(/^[\s[{(]+/, '').replace(/^(this|self)\./, ''));
    if (name) this.queryVars.add(name[0]);
  }

  private filterNode(q: QueryCall): TSNode | undefined {
    if (this.spec.id === 'go') return q.args[1];
    return q.args[0];
  }

  private filterKeys(q: QueryCall): string[] {
    const f = this.filterNode(q);
    return f ? this.objectKeys(f) : [];
  }

  private objectKeys(node: TSNode): string[] {
    const keys: string[] = [];
    const push = (k?: string | null) => {
      if (!k) return;
      const s = stripQuotes(k.trim());
      if (s && !s.startsWith('$') && /^[\w.]+$/.test(s)) keys.push(s);
    };
    if (node.type === 'object' || node.type === 'dictionary') {
      for (const c of node.namedChildren) if (c.type === 'pair') push(c.childForFieldName('key')?.text);
        else if (c.type === 'shorthand_property_identifier') push(c.text);
    } else if (node.type === 'composite_literal') {
      const body = node.childForFieldName('body');
      for (const c of body?.namedChildren ?? []) {
        if (c.type === 'keyed_element') push(c.namedChildren[0]?.text);
        else if (c.type === 'literal_value') push(c.namedChildren[0]?.text);
      }
    }
    return keys;
  }

  private isEmptyFilter(node: TSNode | undefined): boolean {
    if (!node) return true;
    const t = node.text.replace(/\s+/g, '');
    return /^(\{\}|bson\.(M|D)\{\}|primitive\.(M|D)\{\}|dict\(\)|map\[string\](interface\{\}|any)\{\})$/.test(t);
  }

  private chainHas(q: QueryCall, re: RegExp): boolean {
    return q.chain.some((c) => re.test(c.name));
  }

  private mongoRules(q: QueryCall): void {
    const filter = this.filterNode(q);
    const allText = q.argsText + ' ' + q.chain.map((c) => `${c.name}${c.args}`).join(' ');
    const hasLimit = this.chainHas(q, /^(limit|Limit|first|next|batch_size)$/) || /\b(limit|SetLimit|\$limit)\b/.test(q.argsText);
    const isFind = q.method === 'find' || q.method === 'Find';

    if (isFind) {
      const streaming = this.chainHas(q, /^(cursor|stream|eachAsync|batchSize|batch_size)$/);
      const unknownOpts = this.spec.id === 'go' && q.args.slice(2).some((a) => a.type === 'identifier');
      if (this.isEmptyFilter(filter) && !hasLimit && !unknownOpts) {
        this.add('MQ001', q.node, q, {
          severity: streaming ? 'medium' : 'high',
          message: `\`${q.collection ?? q.receiver}.${q.method}()\` has an empty filter and no limit: it reads the whole collection${streaming ? ' (streamed via cursor, but still a full COLLSCAN)' : ''}.`,
        });
      }
      const hasProjection = this.chainHas(q, /^(select|project|projection|only)$/)
        || /projection|SetProjection/.test(allText)
        || (this.isJs && q.orm === 'mongoose' && q.args.length >= 2)
        || (this.spec.id === 'python' && q.args.length >= 2)
        || unknownOpts;
      if (!hasProjection && !this.isEmptyFilter(filter)) {
        this.add('MQ010', q.node, q, { message: `\`${q.collection ?? q.receiver}.${q.method}()\` returns full documents.` });
      }
    }

    const modelLike = /^[A-Z]/.test(q.receiver.replace(/^this\./, '')) || /model$/i.test(q.receiver);
    if (this.isJs && q.orm === 'mongoose' && modelLike && ['find', 'findOne', 'findById'].includes(q.method) && !this.chainHas(q, /^lean$/)) {
      const usesSave = this.chainHas(q, /^(save|populate)$/);
      if (!usesSave && q.method === 'find') {
        this.add('MQ011', q.node, q, { message: `\`${q.collection ?? q.receiver}.find()\` hydrates full Mongoose documents.`, confidence: 'low', autofix: this.leanFix(q) });
      }
    }

    // sort without limit
    const hasSort = this.chainHas(q, /^(sort|Sort)$/) || /\bSetSort\(|\bsort\s*=/.test(q.argsText);
    if ((isFind || q.kind === 'readMany') && hasSort && !hasLimit) {
      const keys = this.filterKeys(q);
      const sortLink = q.chain.find((c) => /^sort$/i.test(c.name));
      const sortKeys = sortLink
        ? (/\{([^}]*)\}/.exec(sortLink.args)?.[1] ?? '').split(',').map((s) => {
            const [k, v] = s.split(':').map((x) => x.trim().replace(/['"]/g, ''));
            return k ? `${k}: ${v === '-1' || v === 'desc' || v === 'descending' ? -1 : 1}` : '';
          }).filter(Boolean)
        : [];
      const idx = [...keys.map((k) => `${k}: 1`), ...sortKeys.filter((k) => !keys.includes(k.split(':')[0]))];
      this.add('MQ005', q.node, q, {
        message: `\`${q.collection ?? q.receiver}.${q.method}()\` sorts without a limit.`,
        fix: idx.length ? `Add .limit(n) and an index matching filter + sort (ESR order), e.g. createIndex({ ${idx.join(', ')} }).` : undefined,
      });
    }

    // skip pagination
    const skipLink = q.chain.find((c) => /^(skip|Skip)$/.test(c.name));
    const skipInArgs = /\bSetSkip\(|\bskip\s*=|["']?\$skip["']?\s*:/.test(q.argsText);
    if (skipLink || skipInArgs) {
      const lit = skipLink ? /^\(\s*(\d+)\s*\)$/.exec(skipLink.args) : null;
      if (!lit || Number(lit[1]) >= 1000) {
        this.add('MQ004', skipLink?.node ?? q.node, q, { message: 'Offset pagination with skip() gets slower for every page.' });
      }
    }

    // regex
    const regexIssue = this.regexIssue(q);
    if (regexIssue) this.add('MQ002', q.node, q, { message: regexIssue, severity: regexIssue.startsWith('Case-insensitive') ? 'medium' : undefined });

    // server-side JS
    if (/\$where|\$function|\$accumulator/.test(q.argsText) || /^(mapReduce|map_reduce|MapReduce)$/.test(q.method)) {
      this.add('MQ003', q.node, q, { message: 'Executes JavaScript on the server for each document; indexes cannot be used.' });
    }

    // negation as filter
    if (q.kind !== 'aggregate' && filter && /["']?\$(nin|ne|not)["']?\s*[:,]/.test(filter.text)) {
      this.add('MQ009', q.node, q, { message: 'Filter relies on $ne/$nin/$not, which are not selective.' });
    }

    // count for existence
    if (q.kind === 'count' && q.method !== 'exists' && this.usedAsBoolean(q.top)) {
      this.add('MQ008', q.node, q, { message: `\`${q.method}()\` result is only compared against 0.` });
    }

    // aggregation pipeline order
    if (q.kind === 'aggregate' && filter) {
      const stages = this.pipelineStages(filter);
      if (stages) {
        const firstMatch = stages.findIndex((s) => s === 'match' || s === 'search' || s === 'geoNear');
        const heavy = stages.findIndex((s) => ['lookup', 'unwind', 'group', 'graphLookup', 'facet'].includes(s));
        if (heavy >= 0 && (firstMatch < 0 || firstMatch > heavy)) {
          this.add('MQ006', q.node, q, { message: `Pipeline runs $${stages[heavy]} before ${firstMatch < 0 ? 'any $match' : '$match'} (stages: ${stages.map((s) => '$' + s).join(' → ')}).` });
        }
        const sortIdx = stages.indexOf('sort');
        if (sortIdx >= 0 && !stages.slice(sortIdx).includes('limit') && !stages.slice(0, sortIdx).includes('group')) {
          this.add('MQ005', q.node, q, { message: 'Pipeline $sort without a following $limit.' });
        }
      }
    }

    // populate
    const pops = q.chain.filter((c) => c.name === 'populate');
    if (pops.length >= 3 || pops.some((p) => /populate\s*:/.test(p.args))) {
      this.add('MQ007', pops[0].node, q, { message: `${pops.length} populate() call(s)${pops.some((p) => /populate\s*:/.test(p.args)) ? ' with nested populate' : ''}: each path is an extra query.` });
    }
  }

  /**
   * Where to insert `.lean()`: after the last query-builder call, before exec()/then()/cursor().
   * Returns undefined when the file mutates documents (save, toObject, markModified...), because
   * lean() returns plain objects and those calls would break.
   */
  private leanFix(q: QueryCall): Finding['autofix'] {
    if (/\.(save|toObject|toJSON|markModified|isModified|depopulate|validate|increment|\$set|\$inc|ownerDocument|\$isDeleted)\s*\(/.test(this.src)) return undefined;
    const TERMINAL = /^(exec|then|catch|finally|cursor|stream|eachAsync|countDocuments|count|explain|toArray|session|orFail)$/;
    let at = q.node;
    for (;;) {
      const p = at.parent;
      const pm = p ? this.spec.member[p.type] : undefined;
      if (!p || !pm || !same(p.childForFieldName(pm[0]), at)) break;
      const pp = p.parent;
      if (!pp || !this.spec.call.includes(pp.type) || !same(pp.childForFieldName('function'), p)) break;
      if (TERMINAL.test(p.childForFieldName(pm[1])?.text ?? '')) break;
      at = pp;
    }
    return { offset: at.endIndex, insert: '.lean()', description: 'append .lean()' };
  }

  private regexIssue(q: QueryCall): string | null {
    const text = q.argsText;
    // JS regex literals
    for (const a of q.args) {
      const stack = [a];
      while (stack.length) {
        const n = stack.pop()!;
        if (n.type === 'regex') {
          const pat = n.childForFieldName('pattern')?.text ?? '';
          const flags = n.childForFieldName('flags')?.text ?? '';
          if (!pat.startsWith('^')) return `Regex /${pat}/${flags} is not anchored with ^ — it scans every key.`;
          if (flags.includes('i')) return `Case-insensitive regex /${pat}/i cannot use the index efficiently (anchored but case-insensitive).`;
        }
        stack.push(...n.namedChildren);
      }
    }
    const caseI = /\$options["']?\s*[:,]\s*["'`][^"'`]*i/.test(text) || /re\.(I|IGNORECASE)\b/.test(text) || /Options:\s*"[^"]*i/.test(text);
    const m = /["']?\$regex["']?\s*[:,]\s*([^,}\]\n]+)/.exec(text);
    if (m) {
      const v = m[1].trim();
      if (/^["'`]/.test(v)) {
        if (!/^["'`]\^/.test(v)) return `$regex ${v} is not anchored with ^ — it scans every key.`;
        if (caseI) return 'Case-insensitive $regex cannot use the index efficiently (anchored but case-insensitive).';
      } else return `$regex built from a variable (\`${v.slice(0, 40)}\`) — usually unanchored${caseI ? ' and case-insensitive' : ''}; this scans every key.`;
    }
    const ctor = /(new RegExp|re\.compile|primitive\.Regex\{\s*Pattern:)\s*\(?\s*([^,)}\n]+)/.exec(text);
    if (ctor) {
      const v = ctor[2].trim();
      if (!/^["'`]\^/.test(v)) return `Regex built with ${ctor[1]}(${v.slice(0, 40)}) is not anchored with ^ — it scans every key.`;
      if (caseI || /,\s*["'`][^"'`]*i/.test(text)) return 'Case-insensitive regex cannot use the index efficiently (anchored but case-insensitive).';
    }
    return null;
  }

  private pipelineStages(node: TSNode): string[] | null {
    let elems: TSNode[] = [];
    if (node.type === 'array' || node.type === 'list') elems = node.namedChildren;
    else if (node.type === 'composite_literal') elems = node.childForFieldName('body')?.namedChildren ?? [];
    else return null;
    elems = elems.filter((e) => e.type !== 'comment');
    const stages: string[] = [];
    for (const e of elems) {
      const m = /["']?\$(\w+)["']?\s*[:,]/.exec(e.text);
      if (!m) return null; // spread / variable stage — unknown
      stages.push(m[1]);
    }
    return stages.length ? stages : null;
  }

  private usedAsBoolean(top: TSNode): boolean {
    let n: TSNode | null = top.parent;
    while (n && ['await_expression', 'parenthesized_expression', 'await'].includes(n.type)) n = n.parent;
    if (!n) return false;
    if (n.type === 'unary_expression' && n.text.trim().startsWith('!')) return true;
    if (n.type === 'not_operator') return true;
    if (n.type === 'binary_expression' || n.type === 'comparison_operator') {
      return /(>|>=|===?|!==?|==|!=)\s*[01]\b|\b0\s*(<|===?|!==?)/.test(n.text);
    }
    if (n.type === 'if_statement' || n.type === 'ternary_expression' || n.type === 'conditional_expression') return true;
    return false;
  }

  private sqlOrmRules(q: QueryCall): void {
    if (q.kind !== 'readMany') return;
    const hasWhere = this.chainHas(q, /^(where|Where|filter|filter_by|exclude|get|Joins)$/)
      || q.args.some((a) => /\b(where|take|limit|first|cursor)\b/.test(a.text));
    const hasLimit = this.chainHas(q, /^(limit|Limit|take|first|one|one_or_none|scalar|paginate|get)$/)
      || q.top.parent?.type === 'subscript' || q.top.parent?.type === 'slice';
    let unbounded = false;
    if (q.orm === 'django') unbounded = q.method === 'all' && !hasLimit;
    else if (q.orm === 'sqlalchemy') unbounded = q.method === 'query' && !hasWhere && !hasLimit && this.chainHas(q, /^all$/);
    else if (q.orm === 'gorm') unbounded = q.chain.length === 0 && /^[a-z]\w*$/.test(q.receiver) && q.args.length <= 1;
    else if (this.isJs && ['findMany', 'findAll', 'find', 'findBy', 'findAndCount', 'getMany'].includes(q.method)) {
      const arg = q.args[0];
      const argHasFilter = arg && !this.isEmptyFilter(arg) && /\b(where|take|limit|skip|first|last|cursor|id)\b|^\{\s*\w+\s*:/.test(arg.text);
      unbounded = !argHasFilter && !hasWhere && !hasLimit && (q.method !== 'getMany');
    }
    if (!unbounded) return;
    const assignedTo = q.top.parent?.type === 'assignment' ? q.top.parent.childForFieldName('left')?.text : undefined;
    if (q.orm === 'django' && assignedTo && /^(queryset|self\.queryset|model)$/.test(assignedTo)) return; // lazily paginated by DRF / CBVs
    this.add('SQ001', q.node, q, {
      message: `\`${q.receiver}.${q.method}()\` has no filter and no limit — loads the whole table.`,
      severity: q.orm === 'django' ? 'medium' : undefined,
    });
  }

  // ------------------------------------------------------------- raw SQL strings

  private checkSqlString(node: TSNode): void {
    let txt = node.text;
    const dynamic = node.type === 'template_string' && /\$\{/.test(txt) || node.namedChildren.some((c) => c.type === 'interpolation');
    if (node.type === 'template_string') txt = txt.replace(/\$\{[^}]*\}/g, '?');
    txt = stripQuotes(txt).replace(/\s+/g, ' ').trim();
    if (!SQL_TEXT_RE.test(txt)) return;
    // prose like "Select a user from the list" is not SQL: need uppercase keywords or SQL syntax
    if (!/^\s*(SELECT|INSERT|UPDATE|DELETE|WITH|REPLACE)\b/.test(txt) && !/(\bwhere\b|\bjoin\b|\blimit\b|order by|group by|\bvalues\b|\$\d|\?|=|\*|`|"\w+"\.)/i.test(txt)) return;
    if (/^select\b/i.test(txt) && !/\bfrom\b/i.test(txt)) return;
    if (/^(update)\b/i.test(txt) && !/\bset\b/i.test(txt)) return;
    if (/^(delete)\b/i.test(txt) && !/\bfrom\b/i.test(txt)) return;
    if (/^insert\b/i.test(txt) && !/\binto\b/i.test(txt)) return;
    const pseudo: QueryCall = { node, top: node, method: 'sql', kind: 'raw', db: 'sql', receiver: 'sql', receiverText: '', args: [], argsText: txt, chain: [], confidence: 'high' };
    if (!dynamic) {
      const sh = sqlShape(txt);
      const id = `${this.opts.relPath}:${node.startPosition.row + 1}:${node.startPosition.column + 1}:sql`;
      pseudo.shapeId = id;
      this.shapes.push({ id, db: 'sql', collection: sh.table, method: 'sql', kind: /^select|^with/i.test(txt) ? 'readMany' : 'write', filterKeys: sh.filterKeys, sortKeys: sh.sortKeys, hasLimit: sh.hasLimit, inLoop: false, sql: txt, file: this.opts.relPath, line: node.startPosition.row + 1 });
    }
    const concatenated = !!node.parent && ['binary_expression', 'concatenated_string', 'binary_operator'].includes(node.parent.type);

    if (/^select\s+(\w+\.)?\*\s+from/i.test(txt)) this.add('SQ002', node, pseudo, { message: `\`${txt.slice(0, 60)}\` selects every column.` });
    if (/\b(i?like)\s+['"]%/i.test(txt) || /\b(i?like)\s+(concat\(\s*)?['"]%['"]\s*(\|\||,|\+)/i.test(txt)) {
      this.add('SQ003', node, pseudo, { message: 'LIKE pattern starts with % — no index can be used.' });
    }
    if (!concatenated && !dynamic) {
      if (/^(update|delete)\b/i.test(txt) && !/\bwhere\b/i.test(txt)) {
        this.add('SQ004', node, pseudo, { message: `\`${txt.slice(0, 50)}\` has no WHERE clause — touches every row.`, severity: 'high' });
      } else if (/^select\b/i.test(txt) && !/\b(where|limit|top|fetch\s+first|group\s+by|join)\b/i.test(txt) && !/^select\s+(count|sum|avg|min|max|exists)\s*\(/i.test(txt) && !/^select\s+\?/.test(txt)) {
        this.add('SQ004', node, pseudo, { message: `\`${txt.slice(0, 50)}\` has no WHERE and no LIMIT — full table scan.`, severity: 'medium' });
      }
    }
    if (/\boffset\s+(\$\d+|\?|:\w+|@\w+|%s|\d{4,})/i.test(txt) || /\blimit\s+\S+\s*,\s*\S+/i.test(txt)) {
      this.add('SQ005', node, pseudo, { message: 'OFFSET-based pagination reads and discards all skipped rows.' });
    }
    if (/\b(where|and|or)\s+(lower|upper|date|year|month|day|coalesce|cast|substring|substr|trim|to_char|date_trunc|ifnull|isnull)\s*\(/i.test(txt)) {
      this.add('SQ006', node, pseudo, { message: 'Function wrapped around a column in WHERE makes it non-sargable.' });
    }
    if (/order\s+by\s+(rand|random|newid)\s*\(\s*\)/i.test(txt)) this.add('SQ007', node, pseudo, { message: 'ORDER BY random sorts the entire table.' });
    if (/\bnot\s+in\s*\(\s*select\b/i.test(txt)) this.add('SQ008', node, pseudo, { message: 'NOT IN (SELECT ...) — prefer NOT EXISTS.' });
  }

  // ------------------------------------------------------------- output

  private add(ruleId: string, node: TSNode, q: QueryCall, o: { severity?: Severity; message: string; fix?: string; confidence?: Confidence; autofix?: Finding['autofix'] }): void {
    const rule = RULE_MAP.get(ruleId)!;
    const line = node.startPosition.row + 1;
    const endRow = Math.min(node.endPosition.row, node.startPosition.row + 2);
    const snippet = this.lines.slice(node.startPosition.row, endRow + 1).map((l) => l.replace(/\s+$/, '')).join('\n').trim();
    const norm = snippet.replace(/\s+/g, ' ');
    const fingerprint = createHash('sha1').update(`${ruleId}|${this.opts.relPath}|${norm}`).digest('hex').slice(0, 16);
    if (this.findings.some((f) => f.ruleId === ruleId && f.line === line && f.column === node.startPosition.column + 1)) return;
    this.findings.push({
      ruleId,
      title: rule.title,
      severity: o.severity ?? rule.severity,
      db: q.db,
      lang: this.opts.lang,
      file: this.opts.relPath,
      line,
      column: node.startPosition.column + 1,
      snippet,
      message: o.message,
      fix: o.fix ?? rule.fix,
      confidence: o.confidence ?? q.confidence,
      fingerprint,
      ...(q.shapeId ? { shapeId: q.shapeId } : {}),
      ...(o.autofix ? { autofix: o.autofix } : {}),
    });
  }

  private applySuppressions(): Finding[] {
    const re = /querydig-ignore(?!-file)(?:[\s:]+((?:[A-Z]{2}\d{3}[\s,]*)+))?/;
    return this.findings.filter((f) => {
      for (const ln of [f.line, f.line - 1]) {
        const m = re.exec(this.lines[ln - 1] ?? '');
        if (m && (!m[1] || m[1].split(/[\s,]+/).includes(f.ruleId))) return false;
      }
      return true;
    });
  }
}
