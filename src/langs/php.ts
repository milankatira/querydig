import type { Analyzer, Ctx, Kind, OpDef, QueryCall } from '../analyzer.js';
import type { TSNode } from '../parser.js';
import type { Autofix } from '../types.js';
import type { CallInfo, LangPlugin } from './plugin.js';

// PHP: Laravel Eloquent / Query Builder, Doctrine ORM + DBAL, PDO / mysqli / pg_*, $wpdb, MongoDB PHP library.
//
// Note: this module is imported by analyzer.ts (via langs/index.ts), so it must not use runtime values from
// analyzer.ts at module-evaluation time. Everything below is self-contained.

const mk = (kind: Kind, db: OpDef['db'], orm?: string): OpDef => ({ kind, db, hint: 'none', orm });
const sameNode = (a: TSNode | null | undefined, b: TSNode | null | undefined) =>
  !!a && !!b && a.startIndex === b.startIndex && a.endIndex === b.endIndex && a.type === b.type;
const unquote = (s: string) => s.trim().replace(/^(['"])([\s\S]*)\1$/, '$2');
const SQL_RE = /^\s*(select|insert|update|delete|with|replace)\b/i;

const CALLS = ['member_call_expression', 'nullsafe_member_call_expression', 'scoped_call_expression', 'function_call_expression'];
const MEMBER_CALLS = ['member_call_expression', 'nullsafe_member_call_expression'];
const LAMBDAS = ['arrow_function', 'anonymous_function_creation_expression', 'anonymous_function'];
const STRINGS = ['string', 'encapsed_string', 'heredoc', 'nowdoc'];

// ------------------------------------------------------------------ API tables

/** Eloquent / query builder methods that execute the query. */
const BUILDER_TERMINAL: Record<string, Kind> = {
  get: 'readMany', pluck: 'readMany', findMany: 'readMany', paginate: 'readMany', simplePaginate: 'readMany', cursorPaginate: 'readMany',
  lazy: 'readMany', lazyById: 'readMany', lazyByIdDesc: 'readMany', cursor: 'readMany',
  chunk: 'readMany', chunkById: 'readMany', chunkByIdDesc: 'readMany', each: 'readMany', eachById: 'readMany',
  first: 'read', firstOrFail: 'read', sole: 'read', value: 'read', find: 'read', findOrFail: 'read', findOr: 'read',
  firstWhere: 'read', firstOr: 'read', firstOrNew: 'read',
  count: 'count', exists: 'count', doesntExist: 'count',
  sum: 'aggregate', avg: 'aggregate', average: 'aggregate', max: 'aggregate', min: 'aggregate',
  create: 'write', forceCreate: 'write', update: 'write', delete: 'write', forceDelete: 'write', increment: 'write', decrement: 'write',
  updateOrCreate: 'write', firstOrCreate: 'write', updateOrInsert: 'write', insertGetId: 'write', insertOrIgnore: 'write', insert: 'write',
  save: 'write', attach: 'write', detach: 'write', sync: 'write', syncWithoutDetaching: 'write', toggle: 'write', updateExistingPivot: 'write', restore: 'write',
  upsert: 'batchWrite', createMany: 'batchWrite', saveMany: 'batchWrite', insertUsing: 'batchWrite',
};
/** `Model::method()` statics that execute a query directly. */
const STATIC_TERMINAL: Record<string, Kind> = { ...BUILDER_TERMINAL, all: 'readMany', destroy: 'write' };
/** Methods on a model instance that hit the database. */
const INSTANCE_OPS: Record<string, Kind> = {
  save: 'write', update: 'write', delete: 'write', forceDelete: 'write', push: 'write', increment: 'write', decrement: 'write', touch: 'write', restore: 'write',
  load: 'read', loadMissing: 'read', loadCount: 'read', loadSum: 'read', refresh: 'read', fresh: 'read',
};
/** Query builder methods that only shape the query (do not execute). */
const BUILDER_METHOD = /^(where\w*|orWhere\w*|with\w*|without\w*|has|orHas|doesntHave|whereHas|select|addSelect|selectRaw|orderBy\w*|latest|oldest|limit|take|skip|offset|groupBy|having\w*|join|\w+Join|joinSub|distinct|query|newQuery|onlyTrashed|forPage|when|unless|lockForUpdate|sharedLock|inRandomOrder|reorder|from|table|union\w*|scopes|fromSub|tap|connection)$/;
/** Builder links that neither filter nor limit (SQ001 / SQ010). */
const NON_FILTER = /^(with|withCount|withSum|withAvg|withMax|withMin|withExists|withTrashed|without|select|addSelect|selectRaw|orderBy\w*|latest|oldest|reorder|query|newQuery|distinct|join|\w+Join|groupBy|table|from|connection|lockForUpdate|sharedLock)$/;
const COUNT_UNSAFE = /^(limit|take|skip|offset|groupBy|having\w*|distinct|union\w*|forPage)$/;

/** Facades and helpers whose static methods are not Eloquent models. */
const NOT_MODEL = new Set([
  'Carbon', 'CarbonImmutable', 'DateTime', 'DateTimeImmutable', 'Date', 'Collection', 'LazyCollection', 'Arr', 'Str', 'Stringable',
  'Route', 'Cache', 'Config', 'Session', 'Storage', 'Log', 'Http', 'Request', 'Response', 'Auth', 'Gate', 'Event', 'Queue', 'Mail',
  'Notification', 'Validator', 'View', 'URL', 'Redirect', 'Hash', 'Crypt', 'Lang', 'App', 'Artisan', 'Bus', 'Cookie', 'File', 'Schema',
  'Password', 'Broadcast', 'RateLimiter', 'Process', 'Blade', 'Vite', 'Number', 'Context', 'Concurrency', 'Redis', 'Pipeline', 'Inertia',
  'Livewire', 'Excel', 'PDF', 'Pdf', 'Image', 'Socialite', 'Uuid', 'Ulid', 'Factory', 'JsonResource', 'Faker', 'Js', 'Model', 'Builder',
  'Facade', 'Container', 'Closure', 'Exception', 'Fluent', 'Benchmark', 'Sleep', 'Once', 'Lottery', 'Feature', 'Pennant', 'Horizon', 'Telescope',
]);
const NOT_MODEL_SUFFIX = /(Facade|Helper|Service|Factory|Resource|Request|Controller|Exception|Enum|Event|Job|Mail|Notification|Policy|Rule|Test|Seeder|Interface|Trait|Util|Utils)$/;

const DB_FACADE: Record<string, Kind> = {
  select: 'readMany', selectOne: 'read', selectResultSets: 'readMany', scalar: 'read', cursor: 'readMany',
  insert: 'write', update: 'write', delete: 'write', statement: 'write', unprepared: 'write', affectingStatement: 'write',
};
const DB_FACADE_BUILDER = /^(table|connection|query)$/;

/** Bare database functions -> index of the SQL argument (-1 = last). */
const DB_FUNCS: Record<string, number> = {
  mysqli_query: 1, mysqli_real_query: 1, mysqli_multi_query: 1, mysqli_execute_query: 1, mysql_query: 0,
  pg_query: -1, pg_query_params: -2, pg_send_query: 1, pg_execute: -1, mysqli_stmt_execute: -1,
  sqlsrv_query: 1, oci_execute: -1, sqlite_query: -1,
};

const DOCTRINE_EM_RE = /(^|\.)\$?(em|entityManager|entity_manager|manager|objectManager|om|doctrine)$|getManager\(\)$|getEntityManager\(\)$/i;
const DOCTRINE_REPO_RE = /repo(sitory)?$|getRepository\(\)$/i;
const DQL_EXEC: Record<string, Kind> = {
  getResult: 'readMany', getArrayResult: 'readMany', getScalarResult: 'readMany', getSingleColumnResult: 'readMany', toIterable: 'readMany', iterate: 'readMany',
  getSingleResult: 'read', getOneOrNullResult: 'read', getSingleScalarResult: 'read', execute: 'readMany',
};
const DBAL_SQL_METHODS = /^(executeQuery|executeStatement|executeUpdate|fetchAllAssociative|fetchAssociative|fetchOne|fetchAllNumeric|fetchNumeric|fetchFirstColumn|fetchAllKeyValue|fetchAllAssociativeIndexed|iterateAssociative|iterateNumeric)$/;
const CONN_RE = /pdo|\bdb\b|\$db$|dbh|conn|connection|mysqli|\blink\b|database|wpdb|dbal/i;
const STMT_RE = /stmt|sth|statement|prepared|\$ps$|\$q$|query$/i;
const WPDB: Record<string, Kind> = { get_results: 'readMany', get_row: 'read', get_var: 'read', get_col: 'readMany', query: 'readMany', insert: 'write', update: 'write', delete: 'write', replace: 'write' };

const MONGO_OPS: Record<string, Kind> = {
  find: 'readMany', findOne: 'read', countDocuments: 'count', estimatedDocumentCount: 'count', aggregate: 'aggregate', distinct: 'readMany',
  insertOne: 'write', updateOne: 'write', updateMany: 'write', deleteOne: 'write', deleteMany: 'write', replaceOne: 'write',
  findOneAndUpdate: 'write', findOneAndDelete: 'write', findOneAndReplace: 'write', insertMany: 'batchWrite', bulkWrite: 'batchWrite',
};

/** Collection methods that run a callback per element. */
const ITER_METHODS = new Set(['each', 'eachSpread', 'map', 'mapSpread', 'mapWithKeys', 'mapToGroups', 'flatMap', 'filter', 'reject', 'transform', 'every', 'reduce', 'sum', 'sortBy', 'sortByDesc', 'groupBy', 'keyBy', 'partition', 'unique', 'countBy']);
/** Callbacks that run once per batch (chunk of rows), not once per row. */
const BATCH_CB = new Set(['chunk', 'chunkById', 'chunkByIdDesc', 'chunkMap']);
/** Array functions: [callback arg index, iterable arg index]. */
const ARRAY_FN: Record<string, [number, number]> = {
  array_map: [0, 1], array_filter: [1, 0], array_walk: [1, 0], array_walk_recursive: [1, 0], array_reduce: [1, 0],
  usort: [1, 0], uasort: [1, 0], uksort: [1, 0], array_find: [1, 0], array_any: [1, 0], array_all: [1, 0],
};
const FETCH_ALL = /^(fetchAll|fetch_all|fetchAllAssociative|fetchAllNumeric|fetchFirstColumn|get_result)$/;

const ELOQUENT_RE = /Illuminate\\|\bEloquent\b|extends\s+(Model|Authenticatable|Pivot)\b|App\\Models\\|\bDB::/;
const NOT_RELATION = /^(get[A-Z]\w*|to[A-Z]\w*|is[A-Z]\w*|has[A-Z]\w*|all|items|collect|values|keys|query|newQuery|toArray|toJson|json|input|only|except|validated|session|headers|cookies|files|user|route|getQuery|getResult)$/;
const NOT_RECORD_VAR = /request|response|cache|config|session|collection|coll\b|items|list|arr|array|container|\$app\b|form|validator|router|route|\$log|logger|storage|disk|file|cookie|carbon|date|\$str|http|client|event|queue|bag|headers|payload|params|attributes|options|settings|redis|mailer|cart|zip|image|pdf|stmt|query|builder|\$qb$|\$em$|manager|repo/i;

// ------------------------------------------------------------------ per-file state

interface Meta { base: 'eloquent' | 'db' | 'relation' | 'var' | 'instance' | 'doctrine' | 'pdo' | 'mongo'; table?: string; relation?: string }
interface FileState {
  eloquent: boolean;
  model: boolean;
  builderVars: Set<string>;
  stmtSql: Map<string, string>;
  meta: Map<number, Meta>;
  /** `$users = User::all()` that may later be iterated: var -> query */
  loadAll: Map<string, QueryCall>;
}
const STATE = new WeakMap<Analyzer, FileState>();

function state(a: Analyzer): FileState {
  let s = STATE.get(a);
  if (s) return s;
  const src = a.src;
  const builderVars = new Set<string>();
  for (const m of src.matchAll(/(\$\w+)\s*=\s*(?:[A-Z]\w*::(?:query|where\w*|with|select|orderBy\w*|latest|oldest|whereHas|has|join)\b|DB::table\b|\$\w+->createQueryBuilder\b)/g)) builderVars.add(m[1]);
  const stmtSql = new Map<string, string>();
  for (const m of src.matchAll(/(\$\w+)\s*=\s*\$[\w>-]+->prepare\(\s*(['"])([\s\S]*?)\2/g)) stmtSql.set(m[1], m[3]);
  for (const m of src.matchAll(/(\$\w+)\s*=\s*(?:mysqli|pg)_prepare\([^,]+,\s*(?:['"][^'"]*['"]\s*,\s*)?(['"])([\s\S]*?)\2/g)) stmtSql.set(m[1], m[3]);
  s = { eloquent: ELOQUENT_RE.test(src), model: /extends\s+(Model|Authenticatable|Pivot)\b/.test(src), builderVars, stmtSql, meta: new Map(), loadAll: new Map() };
  STATE.set(a, s);
  return s;
}

// ------------------------------------------------------------------ helpers

const lastSeg = (s: string) => s.replace(/^\\/, '').split('\\').pop() ?? s;
const snake = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
function tableOf(model: string): string {
  const s = snake(model);
  if (/[^aeiou]y$/.test(s)) return s.slice(0, -1) + 'ies';
  if (/(s|x|z|ch|sh)$/.test(s)) return s + 'es';
  return s + 's';
}
/** Expression inside an `argument` wrapper. */
const unwrap = (n: TSNode | undefined): TSNode | undefined => (n?.type === 'argument' ? n.namedChildren.find((c) => c.type !== 'name') ?? n.namedChildren[0] : n);
const varName = (n: TSNode | null | undefined) => (n?.type === 'variable_name' ? n.text : undefined);
function isLiteralString(n: TSNode | undefined): boolean {
  const u = unwrap(n);
  if (!u) return false;
  if (u.type === 'string' || u.type === 'nowdoc') return true;
  if (u.type === 'encapsed_string' || u.type === 'heredoc') return !hasInterpolation(u);
  return false;
}
function hasInterpolation(n: TSNode): boolean {
  const kids = n.type === 'heredoc' ? (n.childForFieldName('value')?.namedChildren ?? []) : n.namedChildren;
  return kids.some((c) => !['string_content', 'escape_sequence', 'string_value', 'nowdoc_string'].includes(c.type));
}
const textOf = (n: TSNode | undefined) => {
  const u = unwrap(n);
  if (!u) return '';
  if (u.type === 'heredoc' || u.type === 'nowdoc') return u.childForFieldName('value')?.text ?? '';
  return unquote(u.text);
};
function sqlKind(sql: string, fallback: Kind = 'readMany'): Kind {
  if (/^\s*(insert|update|delete|replace|merge)\b/i.test(sql)) return 'write';
  if (/^\s*select\b/i.test(sql) && /\blimit\s+1\b/i.test(sql)) return 'read';
  if (/^\s*(select|with)\b/i.test(sql)) return 'readMany';
  return fallback;
}
function lambdaParams(lambda: TSNode): string[] {
  const p = lambda.childForFieldName('parameters');
  const out: string[] = [];
  const stack = p ? [p] : [];
  while (stack.length) {
    const n = stack.pop()!;
    if (n.type === 'variable_name') out.push(n.text);
    else stack.push(...n.namedChildren);
  }
  return out;
}
function varsIn(nodes: TSNode[]): string[] {
  const out: string[] = [];
  const stack = [...nodes];
  while (stack.length) {
    const n = stack.pop()!;
    if (n.type === 'variable_name') out.push(n.text);
    else stack.push(...n.namedChildren);
  }
  return out;
}
const isCall = (n: TSNode | null | undefined): n is TSNode => !!n && CALLS.includes(n.type);

interface Link { name: string; node: TSNode; ci: CallInfo }

/** Walk down a receiver chain: `User::where(...)->orderBy(...)` -> base + links (outermost last). */
function chainOf(recv: TSNode, a: Analyzer): { links: Link[]; base: TSNode | null } {
  const links: Link[] = [];
  let n: TSNode | null = recv;
  for (let i = 0; isCall(n) && i < 30; i++) {
    const ci = a.callInfo(n);
    if (!ci) break;
    links.unshift({ name: ci.method, node: n, ci });
    if (n.type === 'scoped_call_expression' || n.type === 'function_call_expression') return { links, base: n.type === 'scoped_call_expression' ? ci.receiver : null };
    n = ci.receiver;
  }
  return { links, base: n };
}

function isModelScope(scope: TSNode | null, s: FileState): string | undefined {
  if (!scope) return undefined;
  if (scope.type === 'relative_scope') return s.model ? 'self' : undefined;
  if (scope.type !== 'name' && scope.type !== 'qualified_name') return undefined;
  const name = lastSeg(scope.text);
  if (!/^[A-Z][A-Za-z0-9]*$/.test(name) || name === 'DB' || NOT_MODEL.has(name) || NOT_MODEL_SUFFIX.test(name) || /^[A-Z0-9_]+$/.test(name)) return undefined;
  return s.eloquent ? name : undefined;
}

function isBuilderVar(n: TSNode | null, s: FileState): boolean {
  if (!n) return false;
  const name = n.type === 'variable_name' ? n.text : n.type === 'member_access_expression' ? '$' + (n.childForFieldName('name')?.text ?? '') : '';
  if (!name) return false;
  if (s.builderVars.has(name)) return true;
  return s.eloquent && /^\$(query|builder|qb|\w+Query|\w+Builder)$/i.test(name);
}

/** What kind of query builder (if any) `recv` is. */
function builderBase(recv: TSNode, a: Analyzer, s: FileState): Meta | null {
  const { links, base } = chainOf(recv, a);
  if (links.some((l) => l.node.type === 'function_call_expression')) return null;
  const first = links[0];
  if (first?.node.type === 'scoped_call_expression') {
    const scopeName = base ? lastSeg(base.text) : '';
    if (scopeName === 'DB') {
      if (!DB_FACADE_BUILDER.test(first.name)) return null;
      const tableLink = links.find((l) => l.name === 'table');
      const t = tableLink ? textOf(tableLink.ci.args?.namedChildren[0]) : undefined;
      return { base: 'db', table: t && /^[\w.]+$/.test(t) ? t.split(' ')[0] : undefined };
    }
    const model = isModelScope(base, s);
    if (!model) return null;
    // the static call must start a builder (where/with/query/...) or be a local scope (any lowercase method)
    if (STATIC_TERMINAL[first.name] && !BUILDER_METHOD.test(first.name)) return null;
    return { base: 'eloquent', table: model === 'self' ? undefined : tableOf(model) };
  }
  if (isBuilderVar(base, s) && (!links.length || links.every((l) => BUILDER_METHOD.test(l.name) || !BUILDER_TERMINAL[l.name]))) return { base: 'var' };
  if (!links.length || !s.eloquent) return null;
  // relation: $user->orders()->where(...)
  const recvName = base ? a.path(base) : '';
  if (!base || !['variable_name', 'member_access_expression', 'nullsafe_member_access_expression'].includes(base.type)) return null;
  if (recvName === '$this' && !s.model) return null;
  if (NOT_RECORD_VAR.test(recvName)) return null;
  if ((first.ci.args?.namedChildren.length ?? 0) > 0 || !/^[a-z]\w*$/.test(first.name) || NOT_RELATION.test(first.name) || BUILDER_TERMINAL[first.name] || INSTANCE_OPS[first.name]) return null;
  if (!links.slice(1).every((l) => BUILDER_METHOD.test(l.name) || (!BUILDER_TERMINAL[l.name] && !ITER_METHODS.has(l.name)))) return null;
  return { base: 'relation', relation: first.name, table: snake(first.name) };
}

/** Does `get(...)` have a non-builder signature (e.g. `$request->get('x')`)? */
function badGetArgs(method: string, args: TSNode[]): boolean {
  if (!['get', 'first', 'pluck', 'value', 'sum', 'avg', 'max', 'min', 'count'].includes(method)) return false;
  const u = unwrap(args[0]);
  if (!u) return false;
  if (method === 'get' || method === 'first') return u.type !== 'array_creation_expression';
  return false;
}

// ------------------------------------------------------------------ classification

function opDef(method: string, receiver: string, args: TSNode[], a: Analyzer, node: TSNode): OpDef | null | undefined {
  const s = state(a);
  const ci = a.callInfo(node);
  const recv = ci?.receiver ?? null;
  if (!ci || !recv) return null;
  const setMeta = (m: Meta) => s.meta.set(node.startIndex, m);

  // bare functions: mysqli_query($conn, 'SQL'), pg_query(...)
  if (node.type === 'function_call_expression') {
    const idx = DB_FUNCS[method];
    if (idx === undefined) return null;
    const sqlArg = args[idx < 0 ? args.length + idx : idx];
    setMeta({ base: 'pdo' });
    const fromStmt = s.stmtSql.get(unwrap(sqlArg)?.text ?? '') ?? s.stmtSql.get(unwrap(args[0])?.text ?? '');
    return mk(sqlKind(fromStmt ?? textOf(sqlArg)), 'sql', method.split('_')[0]);
  }

  // static calls: DB::select('...'), User::all(), User::where(...)
  if (node.type === 'scoped_call_expression') {
    const scope = lastSeg(recv.text);
    if (scope === 'DB') {
      const k = DB_FACADE[method];
      if (!k) return null;
      setMeta({ base: 'db' });
      return mk(k === 'readMany' || k === 'read' ? sqlKind(textOf(args[0]), k) : k, 'sql', 'laravel');
    }
    const model = isModelScope(recv, s);
    if (!model) return null;
    const k = STATIC_TERMINAL[method];
    if (!k || badGetArgs(method, args)) return null;
    if (method === 'each' && !args.some((x) => LAMBDAS.includes(unwrap(x)?.type ?? ''))) return null;
    setMeta({ base: 'eloquent', table: model === 'self' ? undefined : tableOf(model) });
    return mk(k, 'sql', 'eloquent');
  }

  // Doctrine query execution: ->getQuery()->getResult(), $em->createQuery('DQL')->getResult()
  if (DQL_EXEC[method]) {
    const { links, base } = chainOf(recv, a);
    const dqlChain = links.some((l) => /^(getQuery|createQuery|createNativeQuery|createQueryBuilder)$/.test(l.name));
    if (dqlChain || (method !== 'execute' && base && /query|\$qb$/i.test(a.path(base)) && !links.length)) {
      setMeta({ base: 'doctrine' });
      const dql = links.find((l) => /^(createQuery|createNativeQuery)$/.test(l.name));
      return mk(dql ? sqlKind(textOf(dql.ci.args?.namedChildren[0]), DQL_EXEC[method]) : DQL_EXEC[method], 'sql', 'doctrine');
    }
  }

  // PDO statements: $stmt->execute([...]), $pdo->prepare('...')->execute()
  if (method === 'execute' || method === 'execute_query') {
    const { links, base } = chainOf(recv, a);
    const prep = links.find((l) => l.name === 'prepare');
    const name = base ? a.path(base) : '';
    if (prep || (!links.length && STMT_RE.test(name)) || (method === 'execute_query' && CONN_RE.test(name))) {
      setMeta({ base: 'pdo' });
      const sql = prep ? textOf(prep.ci.args?.namedChildren[0]) : method === 'execute_query' ? textOf(args[0]) : s.stmtSql.get(name) ?? '';
      return mk(sqlKind(sql), 'sql', 'pdo');
    }
    return null;
  }

  // Laravel builder chains / relations
  if (BUILDER_TERMINAL[method]) {
    const b = builderBase(recv, a, s);
    if (b) {
      if (badGetArgs(method, args)) return null;
      if ((method === 'each' || method === 'chunk' || method === 'chunkById') && !args.some((x) => LAMBDAS.includes(unwrap(x)?.type ?? ''))) return null;
      if (b.base === 'relation' && method === 'find' && !args.length) return null;
      setMeta(b);
      return mk(BUILDER_TERMINAL[method], 'sql', 'eloquent');
    }
  }

  const rpath = receiver;

  // $wpdb
  if (/(^|\.)\$?wpdb$/.test(rpath) && WPDB[method]) {
    setMeta({ base: 'pdo' });
    return mk(WPDB[method] === 'write' ? 'write' : sqlKind(textOf(args[0]), WPDB[method]), 'sql', 'wpdb');
  }

  // Doctrine EntityManager / repositories
  if (DOCTRINE_EM_RE.test(rpath)) {
    if (method === 'find' && args.length >= 2) return setMeta({ base: 'doctrine' }), mk('read', 'sql', 'doctrine');
    if (method === 'flush') return setMeta({ base: 'doctrine' }), mk('write', 'sql', 'doctrine');
    if (method === 'refresh') return setMeta({ base: 'doctrine' }), mk('read', 'sql', 'doctrine');
  }
  if (DOCTRINE_REPO_RE.test(rpath) && !a.hasMongo) {
    let k: Kind | undefined;
    if (method === 'find' || method === 'findOneBy' || /^findOneBy[A-Z]/.test(method)) k = 'read';
    else if (method === 'findBy' || method === 'findAll' || method === 'matching' || /^findBy[A-Z]/.test(method)) k = 'readMany';
    else if (method === 'count') k = 'count';
    if (k) return setMeta({ base: 'doctrine' }), mk(k, 'sql', 'doctrine');
  }

  // DBAL / PDO / mysqli connections: $pdo->query('SQL'), $conn->executeQuery('SQL'), $mysqli->query(...)
  if (args.length > 0) {
    const first = textOf(args[0]);
    const sqlLike = isLiteralString(args[0]) ? SQL_RE.test(first) : SQL_RE.test(first) || CONN_RE.test(rpath);
    if (/^(query|exec|multi_query|real_query)$/.test(method) && (isLiteralString(args[0]) ? SQL_RE.test(first) : CONN_RE.test(rpath))) {
      setMeta({ base: 'pdo' });
      return mk(sqlKind(s.stmtSql.get(unwrap(args[0])?.text ?? '') ?? first), 'sql', 'pdo');
    }
    if (DBAL_SQL_METHODS.test(method) && sqlLike) {
      setMeta({ base: 'pdo' });
      return mk(/^(executeStatement|executeUpdate)$/.test(method) ? 'write' : sqlKind(first, /^fetch(Associative|One|Numeric)$/.test(method) ? 'read' : 'readMany'), 'sql', 'dbal');
    }
  }

  // MongoDB PHP library
  if (a.hasMongo && MONGO_OPS[method] && !s.eloquent) {
    setMeta({ base: 'mongo' });
    return mk(MONGO_OPS[method], 'mongodb', 'mongodb-php');
  }

  // Eloquent model instance: $user->save(), $order->update([...]), $post->load('comments')
  if (s.eloquent && INSTANCE_OPS[method] && (recv.type === 'variable_name' || recv.type === 'member_access_expression')) {
    if (rpath === '$this' && !s.model) return null;
    if (NOT_RECORD_VAR.test(rpath) || isBuilderVar(recv, s)) return null;
    if (method === 'save' && args.length) return null;
    if (method === 'delete' && args.length) return null;
    if (method === 'update' && (args.length > 1 || (args[0] && unwrap(args[0])?.type !== 'array_creation_expression'))) return null;
    if (/^(load|loadMissing|loadCount|loadSum)$/.test(method) && !args.length) return null;
    setMeta({ base: 'instance' });
    return mk(INSTANCE_OPS[method], 'sql', 'eloquent');
  }
  return null;
}

// ------------------------------------------------------------------ rules

const metaOf = (q: QueryCall, a: Analyzer) => state(a).meta.get(q.node.startIndex);
const methodNodeOf = (n: TSNode, a: Analyzer) => a.callInfo(n)?.methodNode ?? null;

/** Is `top` a direct iteration source (`foreach (X as $v)`) or the receiver of `->each(fn)`? */
function iteration(q: QueryCall, a: Analyzer): 'foreach' | 'callback' | null {
  if (sameNode(q.top, q.node)) {
    const p = q.top.parent;
    if (p?.type === 'foreach_statement' && sameNode(p.namedChildren[0], q.top)) return 'foreach';
    return null;
  }
  const up = upLinks(q);
  if (up.length === 1 && ITER_METHODS.has(up[0].name) && a.argNodes(up[0].node).some((x) => LAMBDAS.includes(unwrap(x)?.type ?? ''))) return 'callback';
  return null;
}

/** Chain links below the query call (where/orderBy/...). */
const downLinks = (q: QueryCall) => q.chain.filter((c) => c.node.endIndex <= q.node.endIndex && !sameNode(c.node, q.node));
/** Chain links above the query call (->count(), ->isEmpty(), ->each()). */
const upLinks = (q: QueryCall) => q.chain.filter((c) => c.node.endIndex > q.node.endIndex);

function loadsWholeTable(q: QueryCall, a: Analyzer): boolean {
  const m = metaOf(q, a);
  if (!m) return false;
  if (q.orm === 'eloquent' && (m.base === 'eloquent' || m.base === 'db' || m.base === 'var') && /^(all|get|pluck)$/.test(q.method)) {
    if (m.base === 'var') return false; // the builder may have been filtered elsewhere
    const links = downLinks(q);
    // the first static link of a model chain may be a local scope (User::active()->get()): treat unknown names as filters
    return links.every((l) => NON_FILTER.test(l.name));
  }
  if (q.orm === 'doctrine') {
    if (q.method === 'findAll') return true;
    if (q.method === 'findBy') return !q.args.length || /^\[\s*\]$/.test(unwrap(q.args[0])?.text ?? '');
  }
  return false;
}

type Exist = 'exists' | 'doesntExist';
/** How a count-like expression is used: as an existence check, and which node to replace. */
function existenceUse(expr: TSNode): { kind: Exist; replace: TSNode } | null {
  const p = expr.parent;
  if (!p) return null;
  if (p.type === 'binary_expression') {
    const left = p.childForFieldName('left');
    const right = p.childForFieldName('right');
    const opTok = p.childForFieldName('operator')?.text ?? p.children.find((c) => !sameNode(c, left) && !sameNode(c, right))?.text ?? '';
    const onLeft = sameNode(left, expr);
    const other = onLeft ? right : left;
    if (other?.type === 'integer') {
      const n = Number(other.text);
      const flip: Record<string, string> = { '>': '<', '<': '>', '>=': '<=', '<=': '>=' };
      const o = onLeft ? opTok : flip[opTok] ?? opTok;
      if ((o === '>' && n === 0) || (o === '>=' && n === 1) || (['!=', '!==', '<>'].includes(o) && n === 0)) return { kind: 'exists', replace: p };
      if ((['==', '==='].includes(o) && n === 0) || (o === '<' && n === 1) || (o === '<=' && n === 0)) return { kind: 'doesntExist', replace: p };
      return null;
    }
    if (['&&', '||', 'and', 'or', 'xor'].includes(opTok)) return { kind: 'exists', replace: expr };
    return null;
  }
  if (p.type === 'unary_op_expression' && p.text.trim().startsWith('!')) return { kind: 'doesntExist', replace: p };
  if (p.type === 'parenthesized_expression' && p.parent && /^(if_statement|while_statement|else_if_clause|do_statement)$/.test(p.parent.type)) return { kind: 'exists', replace: expr };
  if (p.type === 'conditional_expression' && sameNode(p.childForFieldName('condition'), expr)) return { kind: 'exists', replace: expr };
  if (p.type === 'cast_expression' && /bool/.test(p.childForFieldName('type')?.text ?? '')) return { kind: 'exists', replace: p };
  return null;
}

/** `X->` prefix of a call (receiver text including the arrow / `::`). */
function callPrefix(call: TSNode, a: Analyzer): string | null {
  const mn = methodNodeOf(call, a);
  if (!mn) return null;
  return a.src.slice(call.startIndex, mn.startIndex);
}

function replaceWith(node: TSNode, insert: string, description: string): Autofix {
  return { offset: node.startIndex, deleteLength: node.endIndex - node.startIndex, insert, description };
}

function sq009(q: QueryCall, a: Analyzer): void {
  if (q.orm !== 'eloquent' && q.orm !== 'doctrine') return;
  const m = metaOf(q, a);
  if (!m || m.base === 'instance') return;
  const safeForCount = !downLinks(q).some((l) => COUNT_UNSAFE.test(l.name));
  const prefix = callPrefix(q.node, a);
  const up = upLinks(q);

  // X->count() > 0 / !X->count() / if (X->count())
  if (q.method === 'count' && !up.length) {
    if (q.orm === 'doctrine') {
      if (existenceUse(q.top)) a.add('SQ009', q.node, q, { message: `\`${q.receiver}->count()\` is only used to check whether a row exists.`, fix: 'Use findOneBy([...]) !== null (or a DQL query with setMaxResults(1)).' });
      return;
    }
    const use = existenceUse(q.top);
    if (!use) return;
    const emptyArgs = !q.args.length;
    const fix = emptyArgs && safeForCount && prefix !== null
      ? use.replace === q.top
        ? { offset: methodNodeOf(q.node, a)!.startIndex, deleteLength: q.node.endIndex - methodNodeOf(q.node, a)!.startIndex, insert: 'exists()', description: 'count() -> exists()' }
        : replaceWith(use.replace, `${prefix}${use.kind}()`, `count() comparison -> ${use.kind}()`)
      : undefined;
    a.add('SQ009', q.node, q, { message: `\`count()\` is only used as an existence check; use \`->${use.kind}()\` instead.`, autofix: fix });
    return;
  }

  // X->get()->isEmpty() / ->isNotEmpty() / ->count()
  if ((q.method === 'get' || q.method === 'all') && up.length === 1 && !q.args.length) {
    const link = up[0];
    const top = link.node;
    if (/^(isEmpty|isNotEmpty|count)$/.test(link.name) && !a.argNodes(top).length) {
      const mn = methodNodeOf(q.node, a)!;
      const ok = safeForCount && prefix !== null;
      if (link.name === 'count') {
        const use = existenceUse(top);
        if (use) {
          a.add('SQ009', q.node, q, {
            message: `\`${q.method}()->count()\` loads every matching row only to check whether any exist; use \`->${use.kind}()\`.`,
            autofix: ok ? replaceWith(use.replace, `${prefix}${use.kind}()`, `${q.method}()->count() comparison -> ${use.kind}()`) : undefined,
          });
        } else {
          a.add('SQ009', q.node, q, {
            message: `\`${q.method}()->count()\` loads every matching row into memory just to count them; let the database count with \`->count()\`.`,
            fix: 'Call ->count() on the query builder (SELECT COUNT(*)), or ->exists() when you only need to know whether there is a row.',
            autofix: ok ? { offset: mn.startIndex, deleteLength: top.endIndex - mn.startIndex, insert: 'count()', description: `${q.method}()->count() -> count()` } : undefined,
          });
        }
        return;
      }
      const kind: Exist = link.name === 'isEmpty' ? 'doesntExist' : 'exists';
      a.add('SQ009', q.node, q, {
        message: `\`${q.method}()->${link.name}()\` loads every matching row only to check whether any exist; use \`->${kind}()\`.`,
        autofix: ok ? { offset: mn.startIndex, deleteLength: top.endIndex - mn.startIndex, insert: `${kind}()`, description: `${q.method}()->${link.name}() -> ${kind}()` } : undefined,
      });
    }
    return;
  }

  // count(X->get()) / count(User::all())
  if ((q.method === 'get' || q.method === 'all') && !up.length && !q.args.length) {
    const arg = q.top.parent;
    const fn = arg?.type === 'argument' ? arg.parent?.parent : null;
    if (!fn || fn.type !== 'function_call_expression' || !/^(count|sizeof)$/.test(fn.childForFieldName('function')?.text ?? '') || a.argNodes(fn).length !== 1) return;
    const ok = safeForCount && prefix !== null;
    const use = existenceUse(fn);
    if (use) {
      a.add('SQ009', q.node, q, {
        message: `\`count(...->${q.method}())\` loads every matching row only to check whether any exist; use \`->${use.kind}()\`.`,
        autofix: ok ? replaceWith(use.replace, `${prefix}${use.kind}()`, `count(${q.method}()) comparison -> ${use.kind}()`) : undefined,
      });
    } else {
      a.add('SQ009', q.node, q, {
        message: `\`count(...->${q.method}())\` loads every matching row into memory just to count them; use \`->count()\` on the query.`,
        fix: 'Call ->count() on the query builder (SELECT COUNT(*)), or ->exists() when you only need to know whether there is a row.',
        autofix: ok ? replaceWith(fn, `${prefix}count()`, `count(${q.method}()) -> ${q.method === 'all' ? '' : 'query '}count()`) : undefined,
      });
    }
  }
}

/** The enclosing function / method / file. */
function scopeOf(n: TSNode): TSNode {
  let p: TSNode | null = n.parent;
  while (p && !['function_definition', 'method_declaration', 'anonymous_function_creation_expression', 'anonymous_function', 'arrow_function', 'program'].includes(p.type)) p = p.parent;
  return p ?? n;
}

function lazyFix(q: QueryCall, a: Analyzer, foreachNode: TSNode, varToCheck?: string): Autofix | undefined {
  // only the bare `Model::all()` form: Model::lazy() iterates in chunks and yields the same models
  if (q.method !== 'all' || q.node.type !== 'scoped_call_expression' || q.args.length || downLinks(q).length) return undefined;
  const kids = foreachNode.namedChildren.filter((c) => c.type !== 'comment');
  if (kids[1]?.type !== 'variable_name') return undefined; // key => value, by-reference, list() destructuring
  if (varToCheck) {
    const scope = scopeOf(foreachNode);
    const re = new RegExp(`\\${varToCheck}(?![\\w])`, 'g');
    if ((scope.text.match(re) ?? []).length !== 2) return undefined;
  }
  const mn = methodNodeOf(q.node, a);
  if (!mn) return undefined;
  return { offset: mn.startIndex, deleteLength: mn.endIndex - mn.startIndex, insert: 'lazy', description: 'all() -> lazy()' };
}

function sq010Message(q: QueryCall): string {
  return `\`${q.receiverText.replace(/\s+/g, ' ').slice(0, 60)}${q.node.type === 'scoped_call_expression' ? '::' : '->'}${q.method}()\` loads the whole table into memory and then iterates it.`;
}
const SQ010_FIX = 'Iterate in batches: ->lazy() / ->lazyById() / ->cursor() / ->chunk(500, fn) (Laravel), or ->toIterable() (Doctrine).';

function extraRules(q: QueryCall, ctx: Ctx, a: Analyzer): void {
  sq009(q, a);

  if (loadsWholeTable(q, a)) {
    const it = iteration(q, a);
    if (it) {
      const fe = it === 'foreach' ? q.top.parent! : null;
      a.add('SQ010', q.node, q, { message: sq010Message(q), fix: SQ010_FIX, autofix: fe ? lazyFix(q, a, fe) : undefined });
    } else if (sameNode(q.top, q.node) && q.top.parent?.type === 'assignment_expression') {
      const left = q.top.parent.childForFieldName('left');
      const v = varName(left);
      if (v) state(a).loadAll.set(v, q);
    }
  }

  // MongoDB: `find([])` is an empty filter (generic rules only understand `{}`)
  if (q.db === 'mongodb' && q.method === 'find' && /^\[\s*\]$/.test(unwrap(q.args[0])?.text ?? '')) {
    const i = a.findings.findIndex((f) => f.ruleId === 'MQ010' && f.line === q.node.startPosition.row + 1 && f.column === q.node.startPosition.column + 1);
    if (i >= 0) a.findings.splice(i, 1);
    if (!/limit/.test(q.argsText)) a.add('MQ001', q.node, q, { message: `\`${q.receiver}->find([])\` has an empty filter and no limit: it reads the whole collection.` });
  }
  void ctx;
}

function unbounded(q: QueryCall, a: Analyzer): boolean {
  if (!loadsWholeTable(q, a)) return false;
  return !iteration(q, a); // directly iterated: reported as SQ010 instead
}

function filterKeys(q: QueryCall, a: Analyzer): string[] | undefined {
  const m = metaOf(q, a);
  if (m?.table && !q.collection) q.collection = m.table;
  else if (m && (m.base === 'eloquent' || m.base === 'db' || m.base === 'relation')) q.collection = m.table;
  else if (m?.base === 'pdo' || (m?.base === 'doctrine' && q.node.type !== 'scoped_call_expression')) {
    const t = /\b(?:from|into|update)\s+([A-Za-z_][\w.]*)/i.exec(q.argsText + ' ' + q.chain.map((c) => c.args).join(' '))?.[1];
    if (t) q.collection = t.split('.').pop();
  }
  // normalise orderBy links so the generic sort-key parser reads them: ("col", -1)
  for (const c of q.chain) {
    const col = /^\(\s*['"]([\w.]+)['"]/.exec(c.args)?.[1];
    if (c.name === 'orderBy' && col) c.args = `("${col}", ${/['"]desc['"]/i.test(c.args) ? -1 : 1})`;
    else if (c.name === 'orderByDesc' && col) Object.assign(c, { name: 'orderBy', args: `("${col}", -1)` });
    else if (c.name === 'latest' || c.name === 'oldest') Object.assign(c, { name: 'orderBy', args: `("${col ?? 'created_at'}", ${c.name === 'latest' ? -1 : 1})` });
  }
  const keys: string[] = [];
  const push = (k?: string) => { if (k && /^[\w.]+$/.test(k)) keys.push(k.split('.').pop()!); };
  const arrayKeys = (txt: string) => { for (const mm of txt.matchAll(/['"]([\w.$]+)['"]\s*=>/g)) if (!mm[1].startsWith('$')) push(mm[1]); };
  const links = [...downLinks(q), { name: q.method, args: q.argsText }];
  for (const l of links) {
    if (/^(where|orWhere|whereIn|whereNotIn|whereNull|whereNotNull|whereBetween|whereDate|whereColumn|firstWhere|whereLike|whereAny)$/.test(l.name)) {
      const first = /^\(\s*['"]([\w.]+)['"]/.exec(l.args)?.[1];
      if (first) push(first);
      else if (/^\(\s*\[/.test(l.args)) arrayKeys(l.args);
    } else if (/^where[A-Z]\w*$/.test(l.name) && !/^where(Has|Doesnt|Raw|Exists|Not|In|Null|Between|Date|Column|Relation|Morph|Belongs|Json|FullText|Any|All|None|Like)/.test(l.name)) {
      push(snake(l.name.slice(5)));
    } else if (/^(findBy|findOneBy|find|findOne|countDocuments|updateOne|updateMany|deleteOne|deleteMany|count|findOneAndUpdate|findOneAndDelete)$/.test(l.name) && /^\(\s*\[/.test(l.args)) {
      arrayKeys(l.args.replace(/\]\s*,[\s\S]*$/, ']'));
    } else if (/^(find|findOrFail|findOr|findMany)$/.test(l.name) && q.db === 'sql') {
      push('id');
    } else if (/^find(One)?By[A-Z]\w*$/.test(l.name)) {
      push(l.name.replace(/^find(One)?By/, '').replace(/^./, (c) => c.toLowerCase()));
    }
  }
  return [...new Set(keys)];
}

function batchFix(q: QueryCall): string | undefined {
  if (q.orm === 'eloquent') {
    const rel = /->(\w+)\(\)/.exec(q.receiverText)?.[1];
    const relHint = rel && /^[a-z]/.test(rel) && !BUILDER_TERMINAL[rel] ? `'${rel}'` : `'relation'`;
    return `Eager-load on the outer query with \`with(${relHint})\` (or \`$models->load(${relHint})\` / \`loadCount()\`), or fetch everything once with \`whereIn('id', $ids)->get()\` and group it with \`keyBy()\` / \`groupBy()\`.`;
  }
  if (q.orm === 'doctrine') return 'Fetch the association in the outer query with `JOIN FETCH` (DQL) / `->leftJoin(\'u.orders\', \'o\')->addSelect(\'o\')`, or load all rows once with `findBy([\'id\' => $ids])`.';
  if (q.orm === 'mongodb-php') return "Collect the ids first and run one `find(['_id' => ['$in' => $ids]])`, then match the documents in memory; or use `$lookup` in one aggregation.";
  if (q.db === 'sql') return 'Run one query with `WHERE id IN (...)` (build the placeholders from the id list) or a JOIN, and group the rows in memory.';
  return undefined;
}

// ------------------------------------------------------------------ traversal hooks

function visitLoop(node: TSNode, ctx: Ctx, a: Analyzer): boolean {
  if (node.type === 'foreach_statement') {
    const kids = node.namedChildren.filter((c) => c.type !== 'comment');
    const iterable = kids[0];
    if (!iterable) return false;
    const body = node.childForFieldName('body');
    const rest = kids.slice(1).filter((c) => !sameNode(c, body));
    a.visit(iterable, ctx);
    const inner = a.inner(ctx, node, iterable, false, null);
    inner.loopVars = [...(ctx.loopVars ?? []), ...varsIn(rest)];

    // `$users = User::all(); foreach ($users as $u)` -> SQ010
    const v = varName(iterable);
    const s = state(a);
    const q = v ? s.loadAll.get(v) : undefined;
    if (q && v) {
      s.loadAll.delete(v);
      a.add('SQ010', q.node, q, { message: sq010Message(q) + ` (iterated at line ${node.startPosition.row + 1})`, fix: SQ010_FIX, autofix: lazyFix(q, a, node, v) });
    }
    for (const c of rest) a.visit(c, inner);
    if (body) a.visit(body, inner);
    return true;
  }
  if (node.type === 'for_statement') {
    const cond = node.childForFieldName('condition');
    const init = node.childForFieldName('initialize');
    const inner = cond ? a.inner(ctx, node, null) : ctx; // `for (;;)` is a polling loop
    for (const c of node.namedChildren) a.visit(c, sameNode(c, init) ? ctx : inner);
    return true;
  }
  return false; // while / do: generic polling-loop handling
}

function visitCall(node: TSNode, ctx: Ctx, a: Analyzer): boolean {
  const ci = a.callInfo(node);
  if (!ci) return false;
  const args = a.argNodes(node);
  const isLambdaArg = (x: TSNode) => LAMBDAS.includes(unwrap(x)?.type ?? '');

  // `$rows = $stmt->fetchAll()` holds query results
  if (FETCH_ALL.test(ci.method) && node.parent?.type === 'assignment_expression') {
    const v = varName(node.parent.childForFieldName('left'));
    if (v) a.queryVars.add(v);
  }

  if (node.type === 'function_call_expression') {
    const spec = ARRAY_FN[ci.method];
    if (!spec) return false;
    const cb = args[spec[0]];
    const it = unwrap(args[spec[1]]) ?? null;
    if (!cb || !isLambdaArg(cb)) return false;
    for (const x of args) if (!sameNode(x, cb)) a.visit(x, ctx);
    const inner = a.inner(ctx, node, it, false, null);
    inner.loopVars = [...(ctx.loopVars ?? []), ...lambdaParams(unwrap(cb)!)];
    a.visit(cb, inner);
    return true;
  }

  if (!MEMBER_CALLS.includes(node.type) && node.type !== 'scoped_call_expression') return false;
  if (!args.some(isLambdaArg)) return false;
  const recv = ci.receiver;

  if (BATCH_CB.has(ci.method)) {
    // runs once per chunk: not a per-row loop, but the chunk itself holds query results
    if (recv) a.visit(recv, ctx);
    for (const x of args) {
      if (isLambdaArg(x)) for (const p of lambdaParams(unwrap(x)!).slice(0, 1)) a.queryVars.add(p);
      a.visit(x, ctx);
    }
    return true;
  }
  if (!ITER_METHODS.has(ci.method)) return false;
  // `User::where(...)->each(fn)` streams rows from the database: per-row callback over query results
  const forceOver = !!a.classify(node, true);
  if (recv) a.visit(recv, ctx);
  for (const x of args) {
    if (!isLambdaArg(x)) {
      a.visit(x, ctx);
      continue;
    }
    const inner = a.inner(ctx, node, recv, forceOver, null);
    inner.loopVars = [...(ctx.loopVars ?? []), ...lambdaParams(unwrap(x)!)];
    a.visit(x, inner);
  }
  return true;
}

/** SQ002–SQ008 for PHP string literals, with interpolation (`"$x"`, `{$x}`) treated as dynamic. */
function finish(root: TSNode, a: Analyzer): void {
  const stack = [root];
  while (stack.length) {
    const n = stack.pop()!;
    if (n.type === 'comment') continue;
    if (STRINGS.includes(n.type)) {
      checkString(n, a);
      continue;
    }
    for (let i = n.namedChildCount - 1; i >= 0; i--) stack.push(n.namedChild(i)!);
  }
}

function checkString(n: TSNode, a: Analyzer): void {
  let body: string;
  if (n.type === 'string' || n.type === 'nowdoc') {
    body = n.type === 'nowdoc' ? (n.childForFieldName('value')?.text ?? '') : unquote(n.text);
  } else {
    const kids = n.type === 'heredoc' ? (n.childForFieldName('value')?.namedChildren ?? []) : n.namedChildren;
    body = kids.map((c) => (c.type === 'string_content' || c.type === 'string_value' ? c.text : c.type === 'escape_sequence' ? ' ' : '${x}')).join('');
  }
  if (!SQL_RE.test(body)) return;
  // present it to the generic checker as a template string: `${...}` marks dynamic parts
  const fake = {
    type: 'template_string',
    text: '`' + body.replace(/`/g, '"') + '`',
    namedChildren: [],
    parent: n.parent,
    startPosition: n.startPosition,
    endPosition: n.endPosition,
    startIndex: n.startIndex,
    endIndex: n.endIndex,
  } as unknown as TSNode;
  a.checkSqlString(fake);
}

function callInfo(node: TSNode): CallInfo | null {
  switch (node.type) {
    case 'member_call_expression':
    case 'nullsafe_member_call_expression': {
      const name = node.childForFieldName('name');
      return { method: name?.type === 'name' ? name.text : '', methodNode: name, receiver: node.childForFieldName('object'), args: node.childForFieldName('arguments') };
    }
    case 'scoped_call_expression': {
      const name = node.childForFieldName('name');
      return { method: name?.type === 'name' ? name.text : '', methodNode: name, receiver: node.childForFieldName('scope'), args: node.childForFieldName('arguments') };
    }
    case 'function_call_expression': {
      const fn = node.childForFieldName('function');
      const name = fn && (fn.type === 'name' || fn.type === 'qualified_name') ? lastSeg(fn.text) : '';
      // bare DB functions get their own name as receiver so the generic classifier considers them
      return { method: name, methodNode: fn, receiver: name && DB_FUNCS[name] !== undefined ? fn : null, args: node.childForFieldName('arguments') };
    }
    default:
      return null;
  }
}

function assignTarget(top: TSNode): TSNode | null | undefined {
  const p = top.parent;
  if (p?.type !== 'assignment_expression') return undefined;
  const left = p.childForFieldName('left');
  // `$this->users = User::all()`: track `users`, never `$this` (which would mark every `$this->x` loop as query results)
  if (left?.type === 'member_access_expression') return left.childForFieldName('name');
  return undefined;
}

export const php: LangPlugin = {
  extensions: ['.php'],
  spec: {
    id: 'php',
    grammar: 'tree-sitter-php.wasm',
    call: CALLS,
    member: {
      member_access_expression: ['object', 'name'],
      nullsafe_member_access_expression: ['object', 'name'],
      scoped_property_access_expression: ['scope', 'name'],
    },
    loops: ['foreach_statement', 'for_statement', 'while_statement', 'do_statement'],
    functions: ['function_definition', 'method_declaration', 'class_declaration'],
    lambdas: LAMBDAS,
    strings: [], // handled in finish() so interpolation is understood
    iterMethods: [],
  },
  fileHints: {
    sql: /Illuminate\\|\bEloquent\b|extends\s+(Model|Authenticatable|Pivot)\b|App\\Models\\|Doctrine\\|\bPDO\b|mysqli|\$wpdb|\bDB::|\bpg_query/,
    mongo: /MongoDB\\/,
  },
  callInfo,
  opDef,
  visitLoop,
  visitCall,
  filterKeys,
  batchFix,
  unbounded,
  assignTarget,
  extraRules,
  finish,
};
