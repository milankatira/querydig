import { op, same, sqlShape, stripQuotes, type Analyzer, type Ctx, type OpDef, type QueryCall } from '../analyzer.js';
import type { TSNode } from '../parser.js';
import type { Autofix, Confidence } from '../types.js';
import type { CallInfo, LangPlugin } from './plugin.js';

/**
 * Ruby: Rails ActiveRecord first, Mongoid basics, a little Sequel (`DB[:users]`).
 *
 * Ruby calls are `call` nodes (receiver / method / arguments / block). `User.all` and `u.orders`
 * (no parens) are calls too, so association access looks exactly like a method call. To keep
 * false positives low, a lowercase receiver only counts as a query when:
 *  - the method only exists on relations/records (`where`, `find_by`, `update_all`, `save!` ...), or
 *  - the method is Enumerable-ambiguous (`count`, `first`, `find`, `sum` ...) but the receiver is an
 *    association-looking call (`u.orders`) in a Rails file or on a row of a DB query.
 */

// ---------------------------------------------------------------------------------------- tables

/** Valid on any receiver: these methods do not exist on Array/Hash/String. */
const STRONG: Record<string, OpDef['kind']> = {
  where: 'readMany', rewhere: 'readMany', find_by: 'read', 'find_by!': 'read', find_sole_by: 'read', 'exists?': 'count',
  update_all: 'batchWrite', delete_all: 'batchWrite', destroy_all: 'batchWrite', insert_all: 'batchWrite', 'insert_all!': 'batchWrite',
  upsert_all: 'batchWrite', delete_by: 'batchWrite', destroy_by: 'batchWrite',
  find_each: 'readMany', find_in_batches: 'readMany', in_batches: 'readMany',
  find_or_create_by: 'write', 'find_or_create_by!': 'write', create_or_find_by: 'write', 'create_or_find_by!': 'write',
  find_or_initialize_by: 'read', first_or_create: 'write', 'first_or_create!': 'write', first_or_initialize: 'read',
  save: 'write', 'save!': 'write', 'update!': 'write', update_attribute: 'write', update_attributes: 'write', 'update_attributes!': 'write',
  update_column: 'write', update_columns: 'write', 'destroy!': 'write', 'increment!': 'write', 'decrement!': 'write', 'toggle!': 'write',
  reload: 'read',
};

/** Ambiguous with Enumerable/Array: only on model constants or association-looking receivers. */
const MODELISH: Record<string, OpDef['kind']> = {
  all: 'readMany', find: 'read', first: 'read', 'first!': 'read', last: 'read', 'last!': 'read', take: 'read', 'take!': 'read',
  second: 'read', third: 'read', sole: 'read', pick: 'read', pluck: 'readMany', ids: 'readMany',
  count: 'count', sum: 'aggregate', minimum: 'aggregate', maximum: 'aggregate', average: 'aggregate', calculate: 'aggregate',
  create: 'write', 'create!': 'write',
};

/** Relation builders: only on model constants (`User.order(:x)`), never on plain values. */
const BUILDERS = new Set([
  'order', 'reorder', 'includes', 'preload', 'eager_load', 'joins', 'left_joins', 'left_outer_joins', 'limit', 'offset', 'distinct',
  'group', 'having', 'unscoped', 'select', 'none', 'in_order_of', 'lock', 'readonly', 'references', 'extending', 'strict_loading',
]);
/** Class-level methods that only make sense on a model constant. */
const CONST_ONLY: Record<string, OpDef['kind']> = {
  find_by_sql: 'readMany', count_by_sql: 'count', insert: 'write', upsert: 'write', 'insert!': 'write',
  update: 'write', destroy: 'write', delete: 'write',
};
/** Raw SQL through the connection (`ActiveRecord::Base.connection.execute`, Sequel `DB.run`). */
const RAW = new Set(['execute', 'exec_query', 'select_all', 'select_one', 'select_value', 'select_values', 'select_rows', 'exec_update', 'exec_delete', 'exec_insert', 'run', 'fetch']);
const RAW_RECV_RE = /(connection|\bconn\b|\bdb\b|^DB\b)/i;

/** Constants that are not models. */
const NOT_MODELS = new Set([
  'Array', 'Hash', 'String', 'Symbol', 'Integer', 'Float', 'Numeric', 'BigDecimal', 'Rational', 'Complex', 'Object', 'Class', 'Module',
  'Kernel', 'Comparable', 'Enumerable', 'Struct', 'OpenStruct', 'Set', 'Range', 'Regexp', 'Proc', 'Method', 'Time', 'Date', 'DateTime',
  'File', 'Dir', 'IO', 'Tempfile', 'Pathname', 'FileUtils', 'Find', 'Process', 'Thread', 'Mutex', 'Queue', 'Fiber', 'Ractor', 'Signal',
  'ENV', 'ARGV', 'JSON', 'YAML', 'CSV', 'ERB', 'Marshal', 'Math', 'Random', 'SecureRandom', 'Digest', 'Base64', 'OpenSSL', 'Zlib',
  'URI', 'Net', 'Socket', 'Logger', 'Benchmark', 'Timeout', 'GC', 'ObjectSpace', 'Encoding', 'Rails', 'ActiveRecord', 'ActiveSupport',
  'ActiveModel', 'ActionController', 'ActionView', 'ActionMailer', 'ActiveJob', 'ActiveStorage', 'ActionCable', 'I18n', 'Arel',
  'Mongoid', 'Sequel', 'Sidekiq', 'Resque', 'Redis', 'Faraday', 'HTTParty', 'RestClient', 'Typhoeus', 'Nokogiri', 'Stripe', 'Aws',
  'Twilio', 'Slack', 'Google', 'OpenAI', 'Octokit', 'Braintree', 'PayPal', 'Shopify', 'SendGrid', 'Mailchimp', 'Sentry', 'Honeybadger',
  'Bugsnag', 'NewRelic', 'Datadog', 'Prometheus', 'Kaminari', 'WillPaginate', 'Pagy', 'Devise', 'Warden', 'Pundit', 'CanCan',
  'RSpec', 'Minitest', 'FactoryBot', 'Faker', 'Capybara', 'Rake', 'Bundler', 'Gem', 'Concurrent', 'Oj', 'MultiJson',
]);

/** Association-looking names that are almost always plain data. */
const NOT_ASSOC = new Set([
  'keys', 'values', 'params', 'errors', 'attributes', 'options', 'headers', 'args', 'arguments', 'chars', 'lines', 'bytes', 'codepoints',
  'words', 'methods', 'instance_variables', 'constants', 'ancestors', 'columns', 'column_names', 'reflections', 'changes',
  'previous_changes', 'saved_changes', 'messages', 'details', 'records', 'results', 'rows', 'entries', 'elements', 'parts', 'segments',
  'matches', 'captures', 'names', 'extensions', 'files', 'paths', 'urls', 'ids', 'items_count', 'status', 'process', 'address',
]);

/** Block-taking methods that iterate. */
const ITER = new Set([
  'each', 'each_with_index', 'each_with_object', 'map', 'collect', 'flat_map', 'collect_concat', 'filter_map', 'select', 'filter',
  'reject', 'find_all', 'detect', 'find', 'sum', 'count', 'group_by', 'index_by', 'index_with', 'partition', 'sort_by', 'min_by',
  'max_by', 'inject', 'reduce', 'times', 'upto', 'downto', 'step', 'each_key', 'each_value', 'each_pair', 'each_cons', 'any?', 'all?',
  'none?', 'one?', 'map!', 'select!', 'reject!', 'each_entry', 'tally_by', 'uniq', 'find_each',
]);
/** Iterators that hand out a batch per iteration: one query per batch is the point, so don't count depth. */
const BATCH = new Set(['find_in_batches', 'in_batches', 'each_slice', 'in_groups_of']);
/** Iterations over a whole relation that SQ010 cares about. */
const SQ010_ITER = new Set(['each', 'each_with_index', 'each_with_object', 'map', 'collect', 'flat_map', 'filter_map']);
/** Relation methods that build a query without loading it. */
const RELATION = new Set(['where', 'rewhere', 'not', 'all', 'missing', 'associated', ...BUILDERS]);
/** Links after which a relation is no longer "the whole table". */
const BOUNDING = /^(limit|first|first!|last|last!|take|take!|page|per|paginate|per_page|find_each|find_in_batches|in_batches|find|find_by|find_by!|where|rewhere|none|ids|pluck|pick|count|size|exists\?|any\?|empty\?|none\?|sum|minimum|maximum|average|calculate|update_all|delete_all|destroy_all|first_or_create|first_or_initialize|sole|ransack|search|to_sql|explain|load_async)$/;
/** find_each ignores these, so .each -> .find_each would silently change behaviour. */
const FIND_EACH_UNSAFE = /^(order|reorder|limit|offset|select|group|distinct|in_order_of|having|reverse_order)$/;

const RAILS_PATH_RE = /(^|\/)(app\/(models|controllers|services|jobs|workers|mailers|helpers|views|graphql|serializers|policies|queries|interactors|operations|forms|presenters|decorators|channels)|lib\/tasks|db\/(migrate|seeds))\//;

// ---------------------------------------------------------------------------------------- state

interface State { ivars: Set<string>; lowConf: Set<string>; mongoidFind: Set<string> }
const STATE = new WeakMap<Analyzer, State>();
const st = (a: Analyzer): State => {
  let s = STATE.get(a);
  if (!s) STATE.set(a, (s = { ivars: new Set(), lowConf: new Set(), mongoidFind: new Set() }));
  return s;
};
const pos = (n: TSNode) => `${n.startPosition.row + 1}:${n.startPosition.column + 1}`;

// ---------------------------------------------------------------------------------------- helpers

function callInfo(node: TSNode): CallInfo | null {
  if (node.type !== 'call') return null;
  const m = node.childForFieldName('method');
  if (!m) return null;
  return { method: m.text, methodNode: m, receiver: node.childForFieldName('receiver'), args: node.childForFieldName('arguments') };
}

const args = (n: TSNode): TSNode[] => (n.childForFieldName('arguments')?.namedChildren ?? []).filter((c) => c.type !== 'comment');
const hasBlock = (n: TSNode) => !!n.childForFieldName('block') || args(n).some((c) => c.type === 'block_argument');

/** Bottom of a receiver chain: `User` in `User.where(..).order(..)`. */
function chainRoot(n: TSNode): TSNode {
  let cur = n;
  for (let i = 0; i < 20 && cur.type === 'call'; i++) {
    const r = cur.childForFieldName('receiver');
    if (!r) break;
    cur = r;
  }
  return cur;
}

/** `User`, `Admin::User`, Sequel `DB[:users]`. */
function isModelConst(n: TSNode): boolean {
  if (n.type === 'element_reference') return /^DB\[/.test(n.text);
  if (n.type !== 'constant' && n.type !== 'scope_resolution') return false;
  const first = n.text.replace(/^::/, '').split('::')[0];
  const last = n.text.split('::').pop() ?? '';
  if (NOT_MODELS.has(first) || NOT_MODELS.has(last)) return false;
  if (/^[A-Z][A-Z0-9_]+$/.test(last)) return false; // FOO_LIST.first is a constant array
  return /^[A-Z]/.test(last);
}

/** Receiver chain starts at a model and only goes through plain method calls: `User.active.recent`. */
function modelChain(recv: TSNode | null): boolean {
  if (!recv) return false;
  const root = chainRoot(recv);
  if (!isModelConst(root)) return false;
  let depth = 0;
  for (let c: TSNode | null = recv; c && c.type === 'call'; c = c.childForFieldName('receiver')) {
    if (++depth > 4 || hasBlock(c)) return false;
    if (!/^[a-z_][\w]*[!?]?$/.test(c.childForFieldName('method')?.text ?? '')) return false;
  }
  return true;
}

/** `u.orders` → 'orders': a no-arg, no-block, plural-looking call on a variable. */
function assocName(recv: TSNode | null): string | undefined {
  if (!recv || recv.type !== 'call') return undefined;
  if (recv.childForFieldName('arguments') || recv.childForFieldName('block')) return undefined;
  const name = recv.childForFieldName('method')?.text ?? '';
  if (!/^[a-z_][a-z0-9_]*$/.test(name) || NOT_ASSOC.has(name)) return undefined;
  if (!/(s|children|people|data)$/.test(name) || /(ss|us|is)$/.test(name)) return undefined;
  const r = recv.childForFieldName('receiver');
  if (!r || !['identifier', 'instance_variable', 'self', 'call'].includes(r.type)) return undefined;
  if (r.type === 'call' && isModelConst(chainRoot(r))) return undefined;
  return name;
}

const isRails = (a: Analyzer) => a.hasSql || RAILS_PATH_RE.test(a.opts.relPath);

/** Is this receiver (or its chain root) a variable holding query results? */
function isQueryVar(n: TSNode, a: Analyzer): boolean {
  const root = chainRoot(n);
  if (root.type === 'instance_variable') return st(a).ivars.has(root.text);
  if (root.type === 'identifier') return a.queryVars.has(root.text);
  return false;
}

/** Does `name` come from a block / for loop that iterates over query results? */
function dbLoopVar(from: TSNode, name: string, a: Analyzer): boolean {
  for (let p = from.parent; p; p = p.parent) {
    if (['method', 'singleton_method', 'class', 'module'].includes(p.type)) return false;
    if (p.type === 'block' || p.type === 'do_block') {
      const params = p.childForFieldName('parameters');
      if (!params || !a.identsOf(params).includes(name)) continue;
      const call = p.parent;
      const r = call?.type === 'call' ? call.childForFieldName('receiver') : null;
      return !!r && (a.containsQuery(r) || isQueryVar(r, a));
    }
    if (p.type === 'for') {
      if (!a.identsOf(p.childForFieldName('pattern')).includes(name)) continue;
      const it = p.childForFieldName('value')?.namedChildren[0];
      return !!it && (a.containsQuery(it) || isQueryVar(it, a));
    }
  }
  return false;
}

function db(a: Analyzer, recvRoot?: TSNode): { db: 'sql' | 'mongodb'; orm: string } {
  if (recvRoot?.type === 'element_reference') return { db: 'sql', orm: 'sequel' };
  if (a.hasMongo && !a.hasSql) return { db: 'mongodb', orm: 'mongoid' };
  return { db: 'sql', orm: 'activerecord' };
}

const snake = (s: string) => s.replace(/([a-z\d])([A-Z])/g, '$1_$2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2').toLowerCase();
const plural = (s: string) => (/(s|x|z|ch|sh)$/.test(s) ? `${s}es` : /[^aeiou]y$/.test(s) ? `${s.slice(0, -1)}ies` : `${s}s`);

/** Table behind a query: `Admin::OrderItem` → order_items, `u.orders` → orders, `DB[:users]` → users. */
function tableOf(q: QueryCall): string | undefined {
  const recv = callInfo(q.node)?.receiver;
  if (!recv) return undefined;
  const root = chainRoot(recv);
  if (root.type === 'element_reference') return /^DB\[\s*:(\w+)/.exec(root.text)?.[1];
  if (isModelConst(root)) return plural(snake(root.text.split('::').pop()!));
  return assocName(recv);
}

/** Keys of `where(a: 1, "b" => 2, :c => 3)` or a `"a = ? AND b > ?"` string. */
function hashKeys(nodes: TSNode[]): string[] {
  const out: string[] = [];
  for (const n of nodes) {
    if (n.type === 'pair') {
      const k = n.childForFieldName('key');
      if (k) out.push(stripQuotes(k.text.replace(/^:/, '').replace(/:$/, '')));
    } else if (n.type === 'hash') out.push(...hashKeys(n.namedChildren));
    else if (n.type === 'string' && !n.namedChildren.some((c) => c.type === 'interpolation')) {
      out.push(...sqlShape(`select 1 from t where ${stripQuotes(n.text)}`).filterKeys);
    }
  }
  return out.filter((k) => /^[\w.]+$/.test(k));
}

const strArg = (n: TSNode | undefined) => !!n && n.type === 'string';
const STMT_PARENTS = new Set(['program', 'body_statement', 'block_body', 'then', 'else', 'do', 'begin', 'ensure', 'parenthesized_statements']);
/** `n` is a statement on its own line, so its return value is unused (method bodies aside). */
const statement = (n: TSNode) => !!n.parent && STMT_PARENTS.has(n.parent.type);
const exprStmt = (n: TSNode) => {
  const p = n.parent;
  return !!p && !(p.type === 'call' && same(p.childForFieldName('receiver'), n));
};

// ---------------------------------------------------------------------------------------- opDef

function opDef(method: string, _receiver: string, argv: TSNode[], a: Analyzer, node: TSNode): OpDef | null {
  const recv = node.childForFieldName('receiver');
  if (!recv) return null;
  const root = chainRoot(recv);
  const isModel = modelChain(recv);
  const blockGiven = hasBlock(node);
  const where = db(a, root);
  const def = (kind: OpDef['kind']) => op(kind, where.db, 'none', where.orm);

  // raw SQL through the connection
  if (RAW.has(method)) {
    if (method === 'fetch' || method === 'run') return /^DB$/.test(recv.text) ? op('raw', 'sql', 'none', 'sequel') : null;
    return RAW_RECV_RE.test(recv.text) ? op('raw', 'sql', 'none', 'activerecord') : null;
  }

  // File.exists?, Rails.cache, Stripe::Customer.create ... are not models
  if ((root.type === 'constant' || root.type === 'scope_resolution') && !isModelConst(root)) return null;

  if (isModel) {
    if (BUILDERS.has(method)) {
      if (method === 'select' && (blockGiven || argv.length === 0)) return null;
      return def('readMany');
    }
    if (CONST_ONLY[method]) {
      // `User.update(attrs)` / `User.destroy(id)`; plain `Foo.delete` without args is not AR-shaped enough
      if ((method === 'delete' || method === 'destroy' || method === 'update') && argv.length === 0) return null;
      return def(CONST_ONLY[method]);
    }
  }

  if (STRONG[method]) {
    // `save`/`destroy!` etc. on literals are not records
    if (['string', 'array', 'hash', 'integer', 'float'].includes(recv.type)) return null;
    if (method === 'find_each' || method === 'find_in_batches' || method === 'in_batches') return def('readMany');
    return def(STRONG[method]);
  }

  const kind = MODELISH[method];
  // instance writes that also exist on Hash/Array: `u.update(name: x)`, `record.destroy`, `record.delete`
  if (!kind && !isModel && ['update', 'destroy', 'delete', 'touch'].includes(method)) {
    if (!['identifier', 'instance_variable', 'self', 'call'].includes(recv.type)) return null;
    if (method === 'update') {
      const first = argv[0];
      if (!first || !(first.type === 'pair' || /params\b/.test(first.text))) return null;
    } else if (argv.length > 0) return null;
    if (recv.type === 'call' && !assocName(recv) && !isModelConst(root)) {
      // `foo.bar.destroy` — fine when it is the loop row or an association-ish target
      if (!/^[a-z_]\w*$/.test(recv.childForFieldName('method')?.text ?? '')) return null;
    }
    return def('write');
  }
  if (!kind) return null;

  if (isModel) {
    if (blockGiven && method !== 'create' && method !== 'create!') return null;
    if (where.orm === 'mongoid' && method === 'find') st(a).mongoidFind.add(pos(node));
    return def(kind);
  }

  // association-looking receiver: u.orders.count / u.orders.first / u.orders.create(...)
  const assoc = assocName(recv);
  if (!assoc) return null;
  if (blockGiven && method !== 'create' && method !== 'create!') return null;
  if (method === 'all') return null; // `u.orders.all` is just the association
  if ((method === 'count' || method === 'find' || method === 'first' || method === 'last') && strArg(argv[0])) return null;
  const varRoot = root.type === 'identifier' || root.type === 'instance_variable' ? root.text : undefined;
  const fromDbLoop = !!varRoot && root.type === 'identifier' && dbLoopVar(node, varRoot, a);
  if (!fromDbLoop && !isRails(a)) return null;
  if (!fromDbLoop) st(a).lowConf.add(pos(node));
  return def(kind);
}

// ---------------------------------------------------------------------------------------- traversal

function visitCall(node: TSNode, ctx: Ctx, a: Analyzer): boolean {
  const ci = callInfo(node);
  if (!ci || !ci.receiver) return false;
  const m = ci.method;
  if (!ITER.has(m) && !BATCH.has(m)) return false;
  const block = node.childForFieldName('block');

  // `u.orders.each { }` / `u.orders.map(&:total)` while iterating rows: lazy-loads the association per row
  if (ITER.has(m) && m !== 'times' && ctx.depth > 0 && hasBlock(node)) assocIteration(node, ci, ctx, a);

  if (!block) return false;
  a.visit(ci.receiver, ctx);
  if (ci.args) a.visit(ci.args, ctx);
  const params = block.childForFieldName('parameters');
  if (BATCH.has(m)) {
    // one query per batch is fine; rows of the batch still come from the DB
    const over = ctx.over || a.isOverResults(ci.receiver) || isQueryVar(ci.receiver, a) || m !== 'each_slice' && m !== 'in_groups_of';
    a.visit(block, { ...ctx, over, overVar: over ? (ctx.overVar ?? a.path(ci.receiver)) : ctx.overVar, loopVars: [...(ctx.loopVars ?? []), ...a.identsOf(params)] });
    return true;
  }
  const forceOver = m === 'find_each' || isQueryVar(ci.receiver, a);
  const inner = a.inner(ctx, node, ci.receiver, forceOver, params);
  if (inner.over && (m === 'find_each' || !inner.overVar)) inner.overVar = `${a.path(ci.receiver).replace(/\(\)/g, '')}${m === 'find_each' ? '.find_each' : ''}`;
  a.visit(block, inner);
  return true;
}

function assocIteration(node: TSNode, ci: CallInfo, ctx: Ctx, a: Analyzer): void {
  const recv = ci.receiver!;
  const assoc = assocName(recv);
  if (!assoc) return;
  const root = chainRoot(recv);
  if (root.type !== 'identifier' || !(ctx.loopVars ?? []).includes(root.text)) return;
  if (!ctx.over && !isRails(a)) return;
  const where = db(a);
  const q: QueryCall = {
    node: recv, top: recv, method: assoc, kind: 'readMany', db: where.db, orm: where.orm, receiver: root.text,
    receiverText: recv.text, collection: undefined, args: [], argsText: '', chain: [], confidence: ctx.over ? 'high' : 'medium',
  };
  a.evaluate(q, ctx);
}

function visitLoop(node: TSNode, ctx: Ctx, a: Analyzer): boolean {
  if (node.type !== 'for') return false;
  const pattern = node.childForFieldName('pattern');
  const it = node.childForFieldName('value')?.namedChildren[0] ?? null;
  if (it) a.visit(it, ctx);
  const body = node.childForFieldName('body');
  if (body) a.visit(body, a.inner(ctx, node, it, !!it && isQueryVar(it, a), pattern));
  return true;
}

// ---------------------------------------------------------------------------------------- rules

/** Whole relation (`chain` up to `uptoIdx`) only uses relation builders, no materialising call. */
function relationSoFar(q: QueryCall, links: QueryCall['chain']): boolean {
  if (!RELATION.has(q.method) && q.method !== 'count') return false;
  return links.every((l) => RELATION.has(l.name));
}

function inScopeDefinition(n: TSNode): boolean {
  for (let p = n.parent, i = 0; p && i < 8; p = p.parent, i++) {
    if (p.type === 'method' || p.type === 'singleton_method') return false;
    if (p.type === 'call' && /^(scope|default_scope|has_many|has_one|belongs_to|has_and_belongs_to_many|lambda|proc)$/.test(p.childForFieldName('method')?.text ?? '')) return true;
  }
  return false;
}

function passedToPaginator(top: TSNode): boolean {
  const p = top.parent;
  if (p?.type !== 'argument_list') return false;
  const m = p.parent?.childForFieldName('method')?.text ?? '';
  return /^(pagy\w*|paginate|page|policy_scope|authorize|apply_scopes|decorate|ransack|search|filter|smart_listing_create|datatable)$/.test(m);
}

function unbounded(q: QueryCall, a: Analyzer): boolean {
  if (q.orm !== 'activerecord' || q.method !== 'all') return false;
  if (!isModelConst(chainRoot(q.node))) return false;
  if (q.chain.some((c) => BOUNDING.test(c.name) || SQ010_ITER.has(c.name))) return false;
  if (inScopeDefinition(q.top) || passedToPaginator(q.top)) return false;
  void a;
  return true;
}

/** Up-links (calls after q.node) only. */
const upLinks = (q: QueryCall) => q.chain.filter((c) => c.node.startIndex === q.node.startIndex && c.node.endIndex > q.node.endIndex);

function sq010(q: QueryCall, ctx: Ctx, a: Analyzer): void {
  if (ctx.depth > 0 || q.db !== 'sql') return;
  if (!['all', 'where', 'rewhere', ...BUILDERS].includes(q.method) || q.method === 'select' || q.method === 'limit' || q.method === 'none') return;
  const recv = callInfo(q.node)?.receiver;
  if (!recv || !isModelConst(chainRoot(recv)) || recv.type === 'call') return; // `User.where`, not `User.active.where`
  const ups = upLinks(q);
  const idx = ups.findIndex((l) => SQ010_ITER.has(l.name));
  if (idx < 0) return;
  const it = ups[idx];
  if (!hasBlock(it.node)) return;
  const before = ups.slice(0, idx);
  if (!before.every((l) => RELATION.has(l.name)) || before.some((l) => BOUNDING.test(l.name) && l.name !== 'where' && l.name !== 'rewhere')) return;
  if (before.some((l) => l.name === 'limit' || l.name === 'none')) return;
  const filtered = q.method === 'where' || q.method === 'rewhere' || before.some((l) => l.name === 'where' || l.name === 'rewhere');
  const whereArgs = [q.method === 'where' ? q.argsText : '', ...before.filter((l) => l.name === 'where').map((l) => l.args)].join(' ');
  if (/\bid:|\bids\b|_ids?:/.test(whereArgs)) return; // where(id: ids) is a bounded list

  let autofix: Autofix | undefined;
  const block = it.node.childForFieldName('block');
  const params = block?.childForFieldName('parameters');
  const oneParam = !!params && params.namedChildren.length === 1 && params.namedChildren[0].type === 'identifier';
  const unsafe = q.method !== 'all' && FIND_EACH_UNSAFE.test(q.method) || before.some((l) => FIND_EACH_UNSAFE.test(l.name));
  const itCi = callInfo(it.node);
  if (it.name === 'each' && block && oneParam && !unsafe && itCi?.methodNode && statement(it.node)) {
    if (q.method === 'all' && idx === 0) {
      const start = recv.endIndex;
      const end = itCi.methodNode.endIndex;
      if (/^\s*&?\.\s*all\s*&?\.\s*each$/.test(a.src.slice(start, end))) {
        autofix = { offset: start, deleteLength: end - start, insert: '.find_each', description: 'replace .all.each with .find_each' };
      }
    } else {
      const mn = itCi.methodNode;
      autofix = { offset: mn.startIndex, deleteLength: mn.endIndex - mn.startIndex, insert: 'find_each', description: 'replace .each with .find_each' };
    }
  }
  const model = chainRoot(recv).text;
  a.add('SQ010', q.node, q, {
    message: `\`${model}${filtered ? '.where(...)' : q.method === 'all' ? '.all' : `.${q.method}(...)`}.${it.name}\` loads ${filtered ? 'every matching row' : 'the whole table'} into memory before iterating.`,
    fix: it.name === 'each'
      ? `Use \`find_each\` (batches of 1000)${unsafe ? ' — note find_each ignores order/limit/select, so move ordering out or use in_batches' : ''}.`
      : `Iterate with \`find_each\` / \`in_batches\` instead of \`${it.name}\`, or pluck only the columns you need.`,
    confidence: filtered ? 'low' : 'high',
    autofix,
  });
}

/** SQ009: `rel.count > 0`, `rel.count.zero?`, `rel.present?` → `rel.exists?` */
function sq009(q: QueryCall, a: Analyzer): void {
  if (q.db !== 'sql') return;
  const ups = upLinks(q);
  const relRecv = callInfo(q.node)?.receiver;
  const relationish = !!relRecv && (modelChain(relRecv) || !!assocName(relRecv));

  // count-like node: q itself (`u.orders.count`) or a link of a relation chain (`User.where(..).count`)
  let countNode: TSNode | undefined;
  if (q.method === 'count' && q.args.length === 0 && !hasBlock(q.node)) countNode = q.node;
  else {
    const i = ups.findIndex((l) => /^(count|size|length)$/.test(l.name));
    if (i >= 0 && relationSoFar(q, ups.slice(0, i)) && args(ups[i].node).length === 0 && !hasBlock(ups[i].node)) countNode = ups[i].node;
  }
  if (countNode) {
    const rel = callInfo(countNode)!.receiver!.text;
    const p = countNode.parent;
    let expr: TSNode | undefined;
    let positive: boolean | undefined;
    if (p?.type === 'binary') {
      const op = p.childForFieldName('operator')?.text ?? '';
      const left = p.childForFieldName('left');
      const right = p.childForFieldName('right');
      const other = same(left, countNode) ? right : left;
      const n = other?.type === 'integer' ? other.text : undefined;
      const flip: Record<string, string> = { '>': '<', '<': '>', '>=': '<=', '<=': '>=', '==': '==', '!=': '!=' };
      const o = same(left, countNode) ? op : flip[op];
      if (n === '0' && (o === '>' || o === '!=')) positive = true;
      else if (n === '1' && o === '>=') positive = true;
      else if (n === '0' && (o === '==' || o === '<=')) positive = false;
      else if (n === '1' && o === '<') positive = false;
      if (positive !== undefined) expr = p;
    } else if (p?.type === 'call' && same(p.childForFieldName('receiver'), countNode) && !p.childForFieldName('arguments')) {
      const m = p.childForFieldName('method')?.text;
      if (m === 'zero?') positive = false;
      else if (m === 'positive?') positive = true;
      if (positive !== undefined) expr = p;
    }
    if (expr && positive !== undefined) {
      const replacement = `${positive ? '' : '!'}${rel}.exists?`;
      a.add('SQ009', expr, q, {
        message: `\`${expr.text.replace(/\s+/g, ' ').slice(0, 60)}\` counts every matching row only to test for existence.`,
        fix: `Use \`${replacement}\` — it runs SELECT 1 ... LIMIT 1.`,
        autofix: exprStmt(expr) ? { offset: expr.startIndex, deleteLength: expr.endIndex - expr.startIndex, insert: replacement, description: `replace with ${replacement}` } : undefined,
      });
    }
    return;
  }

  // rel.present? / rel.blank? load every record (any?/empty?/none? already use EXISTS on unloaded relations)
  if (!relationish && !RELATION.has(q.method)) return;
  const i = ups.findIndex((l) => l.name === 'present?' || l.name === 'blank?');
  if (i < 0 || !relationSoFar(q, ups.slice(0, i)) || i !== ups.length - 1) return;
  const link = ups[i];
  if (args(link.node).length || hasBlock(link.node)) return;
  const rel = callInfo(link.node)!.receiver!.text;
  const positive = link.name === 'present?';
  const replacement = `${positive ? '' : '!'}${rel}.exists?`;
  a.add('SQ009', link.node, q, {
    message: `\`${link.name}\` on a relation loads every matching record just to check whether there is one.`,
    fix: `Use \`${replacement}\` (or \`${positive ? 'any?' : 'none?'}\`, which issue SELECT 1 ... LIMIT 1 on an unloaded relation).`,
    confidence: 'medium',
    autofix: exprStmt(link.node) ? { offset: link.node.startIndex, deleteLength: link.node.endIndex - link.node.startIndex, insert: replacement, description: `replace with ${replacement}` } : undefined,
  });
}

/** Rails string fragments: where("name LIKE ?", "%#{q}%"), where("LOWER(email) = ?"), order("RANDOM()"), offset(n). */
function fragmentRules(q: QueryCall, a: Analyzer): void {
  if (q.db !== 'sql') return;
  const links: { name: string; node: TSNode; args: TSNode[] }[] = [
    { name: q.method, node: q.node, args: q.args },
    ...upLinks(q).map((l) => ({ name: l.name, node: l.node, args: args(l.node) })),
  ];
  for (const l of links) {
    const first = l.args[0];
    const firstTxt = first && first.type === 'string' ? stripQuotes(first.text) : '';
    if (/^(where|rewhere|not|having)$/.test(l.name) && firstTxt) {
      const pctArg = l.args.slice(1).some((x) => x.type === 'string' && /^["']%/.test(x.text));
      if (/\bi?like\s+['"]%/i.test(firstTxt) || (/\bi?like\s+(\?|:\w+)/i.test(firstTxt) && pctArg)) {
        a.add('SQ003', l.node, q, { message: 'LIKE pattern starts with % — no index can be used.' });
      }
      if (/(^|\b(and|or)\s+)(lower|upper|date|year|month|coalesce|cast|substring|substr|trim|to_char|date_trunc|ifnull)\s*\(/i.test(firstTxt.trim())) {
        a.add('SQ006', l.node, q, { message: `\`${firstTxt.slice(0, 50)}\` wraps a column in a function, so its index cannot be used.` });
      }
    }
    if (/^(order|reorder)$/.test(l.name) && l.args.some((x) => /\b(rand|random|newid)\s*\(\s*\)/i.test(x.text))) {
      a.add('SQ007', l.node, q, { message: 'ORDER BY random sorts the entire table.' });
    }
    if (l.name === 'offset' && first && !(first.type === 'integer' && Number(first.text) < 1000)) {
      a.add('SQ005', l.node, q, { message: `\`offset(${first.text.slice(0, 30)})\` pagination reads and discards every skipped row.` });
    }
  }
}

function extraRules(q: QueryCall, ctx: Ctx, a: Analyzer): void {
  // instance variables assigned from queries (@users = User.where(...)) for QD002
  const p = q.top.parent;
  if (p && (p.type === 'assignment' || p.type === 'operator_assignment') && same(p.childForFieldName('right'), q.top)) {
    const left = p.childForFieldName('left');
    if (left?.type === 'instance_variable') st(a).ivars.add(left.text);
  }
  // live mode: Rails table names
  const table = q.kind === 'raw' ? undefined : tableOf(q);
  if (table && q.shapeId) {
    const shape = a.shapes.find((s) => s.id === q.shapeId);
    if (shape) shape.collection = table;
  }
  if (q.db !== 'sql' || q.kind === 'raw') return;
  fragmentRules(q, a);
  if (q.orm !== 'activerecord') return; // find_each / exists? are ActiveRecord APIs
  sq010(q, ctx, a);
  sq009(q, a);
}

// ---------------------------------------------------------------------------------------- misc hooks

function filterKeys(q: QueryCall): string[] | undefined {
  if (q.kind === 'raw') return undefined;
  const KEYED = /^(where|rewhere|not|find_by|find_by!|find_sole_by|exists\?|find_or_create_by!?|find_or_initialize_by|create_or_find_by!?|delete_by|destroy_by)$/;
  const nodes: TSNode[] = [];
  if (KEYED.test(q.method)) nodes.push(...q.args);
  for (const l of upLinks(q)) if (KEYED.test(l.name)) nodes.push(...args(l.node));
  const keys = hashKeys(nodes);
  if (!keys.length && q.method === 'find' && q.args.length) return ['id'];
  return [...new Set(keys)];
}

function batchFix(q: QueryCall): string | undefined {
  if (q.orm === 'mongoid') return 'Eager load with `includes(:assoc)` on the outer criteria, or fetch once with `Model.in(id: ids)` and group in memory.';
  if (q.orm !== 'activerecord' && q.orm !== 'sequel') return undefined;
  const recv = q.node.type === 'call' ? callInfo(q.node)?.receiver : null;
  const known = q.method in STRONG || q.method in MODELISH || q.method in CONST_ONLY || BUILDERS.has(q.method) || RAW.has(q.method);
  const assoc = !known ? q.method : assocName(recv ?? null); // synthetic `u.orders` iteration, or `u.orders.count`
  if (assoc && q.kind === 'count') return `Preload counts in one query: \`Model.where(id: ids).joins(:${assoc}).group(:id).count\`, or add a \`counter_cache\` to the ${assoc} association.`;
  if (assoc) return `Preload the association on the outer query with \`includes(:${assoc})\` (or \`preload\` / \`eager_load\`) so it is loaded once instead of per row.`;
  const key = filterKeys(q)?.[0] ?? 'id';
  const model = recv ? chainRoot(recv).text : 'Model';
  return `Load the rows once with \`${model}.where(${key}: ids)\` and group them in memory (\`index_by\` / \`group_by\`), or preload an association with \`includes(:assoc)\` / \`preload\` / \`eager_load\` on the outer query.`;
}

function assignTarget(top: TSNode): TSNode | null | undefined {
  const p = top.parent;
  if (p?.type === 'operator_assignment' && same(p.childForFieldName('right'), top)) return p.childForFieldName('left');
  return undefined;
}

function finish(root: TSNode, a: Analyzer): void {
  const s = st(a);
  for (const f of a.findings) {
    const at = `${f.line}:${f.column}`;
    if (/^QD00[12]$/.test(f.ruleId) && s.lowConf.has(at)) f.confidence = 'medium' as Confidence;
  }
  if (s.mongoidFind.size) a.findings = a.findings.filter((f) => !(f.ruleId === 'MQ010' && s.mongoidFind.has(`${f.line}:${f.column}`)));
  // heredoc shapes: drop the closing terminator from the captured SQL
  const stack = [root];
  while (stack.length) {
    const n = stack.pop()!;
    if (n.type === 'heredoc_body') {
      const id = `${a.opts.relPath}:${n.startPosition.row + 1}:${n.startPosition.column + 1}:sql`;
      const shape = a.shapes.find((x) => x.id === id);
      const end = n.namedChildren.find((c) => c.type === 'heredoc_end')?.text;
      if (shape?.sql && end && shape.sql.endsWith(end)) shape.sql = shape.sql.slice(0, -end.length).trim();
      if (end) {
        const at = `${n.startPosition.row + 1}:${n.startPosition.column + 1}`;
        for (const f of a.findings) if (`${f.line}:${f.column}` === at) f.message = f.message.split(` ${end}\``).join('`');
      }
      continue;
    }
    stack.push(...n.namedChildren);
  }
}

export const ruby: LangPlugin = {
  extensions: ['.rb', '.rake'],
  spec: {
    id: 'ruby',
    grammar: 'tree-sitter-ruby.wasm',
    call: ['call'],
    member: {},
    loops: ['for'],
    functions: ['method', 'singleton_method', 'class', 'module'],
    lambdas: ['lambda', 'block', 'do_block'],
    strings: ['string', 'heredoc_body'],
    iterMethods: [],
  },
  fileHints: {
    sql: /\b(ActiveRecord|ApplicationRecord|ActiveRecord::Base|Sequel(::Model)?|ActionController|ApplicationController|ApplicationJob|has_many|belongs_to)\b/,
    mongo: /\b(Mongoid::Document|Mongoid)\b/,
  },
  callInfo,
  opDef,
  visitCall,
  visitLoop,
  filterKeys,
  batchFix,
  unbounded,
  assignTarget,
  extraRules,
  finish,
};
