import { op, SQL_TEXT_RE, stripQuotes, type Analyzer, type Ctx, type OpDef, type QueryCall } from '../analyzer.js';
import type { TSNode } from '../parser.js';
import type { Db } from '../types.js';
import type { CallInfo, LangPlugin } from './plugin.js';

// ---------------------------------------------------------------------------
// Java: Spring Data (JPA + MongoDB), JPA EntityManager, Hibernate Session, JDBC (JdbcTemplate,
// JdbcClient, Statement/PreparedStatement), jOOQ, Quarkus Panache and the MongoDB Java driver.
// ---------------------------------------------------------------------------

const SQL_HINT = /\b(org\.springframework\.data\.(jpa|jdbc|r2dbc|repository)|javax\.persistence|jakarta\.persistence|java\.sql|javax\.sql|org\.hibernate|org\.jooq|org\.springframework\.jdbc|io\.quarkus\.hibernate|JpaRepository|CrudRepository|PagingAndSortingRepository|JpaSpecificationExecutor|EntityManager|JdbcTemplate)\b/;
const MONGO_HINT = /\b(com\.mongodb|org\.springframework\.data\.mongodb|org\.bson|MongoRepository|MongoTemplate|MongoCollection)\b/;

/** last dotted segment of a receiver path, without `this.` */
const lastSeg = (receiver: string) => receiver.replace(/^this\./, '').split('.').pop() ?? '';

const REPO_RE = /(repository|repo|dao)(\(\))?$/i;
const EM_RE = /^(em|\w*[eE]ntityManager|get[eE]ntityManager\(\))$/;
const SESSION_RE = /^(session|\w*Session|getCurrentSession\(\)|openSession\(\)|unwrap\(\))$/;
const JDBC_RE = /^(jdbc|\w*[jJ]dbcTemplate|\w*[jJ]dbcOperations|\w*[jJ]dbcClient|jdbcClient)$/;
const STMT_RE = /^(stmt|statement|ps|pst|pstmt|\w*Statement|\w*Stmt|prepareStatement\(\)|createStatement\(\)|prepareCall\(\))$/;
const MONGO_TPL_RE = /^(\w*[mM]ongoTemplate|\w*[mM]ongoOperations)$/;
const MONGO_COLL_RE = /^(\w*[cC]ollection|coll|getCollection\(\))$/;
const JOOQ_RE = /^(dsl|ctx|create|dslContext|jooq|context|\w*DslContext|\w*DSLContext)$/;

const isSqlLiteral = (n: TSNode | undefined) => !!n && n.type === 'string_literal' && SQL_TEXT_RE.test(stripQuotes(n.text).trim());

/** `raw` when the SQL text is right there (so the string-level rules and raw-write detection apply), else `fallback`. */
const rawOr = (args: TSNode[], fallback: OpDef['kind'], orm: string): OpDef =>
  isSqlLiteral(args[0]) ? op('raw', 'sql', 'none', orm) : op(fallback, 'sql', 'none', orm);

const DERIVED_RE = /^(find|read|get|query|search|stream|count|exists|delete|remove)(First|Top)?\d*(Distinct)?(All)?\w*?By[A-Z_]\w*$/;

/** Spring Data repository method (JPA, JDBC, MongoDB) or Panache. */
function repoOp(method: string, args: TSNode[], db: Db): OpDef | null {
  const orm = db === 'mongodb' ? 'spring-data-mongodb' : 'spring-data-jpa';
  const o = (k: OpDef['kind']) => op(k, db, 'none', orm);
  if (/^(findAll|listAll|streamAll|findAllById)$/.test(method)) return o('readMany');
  // getReferenceById / getOne / getReference / Session.load return lazy proxies without touching the database
  if (/^(getReferenceById|getOne|getReference|getReferenceByIds)$/.test(method)) return null;
  if (/^(findById|findByIdOptional|getById|findOne|existsById|exists)$/.test(method)) return o('read');
  if (/^count$/.test(method)) return o('count');
  if (/^(saveAll|saveAllAndFlush|insertAll|deleteAllInBatch|deleteAllById|deleteAllByIdInBatch|deleteInBatch|persistAll)$/.test(method)) return o('batchWrite');
  if (/^(deleteAll)$/.test(method)) return args.length ? o('batchWrite') : o('write');
  if (/^(save|saveAndFlush|insert|persist|persistAndFlush|merge|update|delete|deleteById|remove)$/.test(method)) return o('write');
  if (/^(find|list|stream)$/.test(method) && args.length) return o('readMany'); // Panache find("status", s)
  const d = DERIVED_RE.exec(method);
  if (d) {
    if (d[1] === 'count') return o('count');
    if (d[1] === 'exists') return o('read');
    if (d[1] === 'delete' || d[1] === 'remove') return o('write');
    if (d[2]) return o('read');
    return d[4] || d[1] === 'stream' || d[1] === 'search' ? o('readMany') : o('read');
  }
  // custom repository methods: findActiveUsers(), loadWithOrders(), updateStatus() (@Query/@Modifying)
  if (/^(find|get|load|search|query|fetch|list|stream|read)[A-Z]\w*$/.test(method)) return o('readMany');
  if (/^(update|delete|remove|mark|increment|decrement|bulk)[A-Z]\w*$/.test(method)) return o('write');
  return null;
}

const MONGO_DRIVER: Record<string, OpDef['kind']> = {
  find: 'readMany', countDocuments: 'count', estimatedDocumentCount: 'count', aggregate: 'aggregate', distinct: 'readMany',
  mapReduce: 'aggregate', watch: 'readMany',
  insertOne: 'write', updateOne: 'write', updateMany: 'write', deleteOne: 'write', deleteMany: 'write', replaceOne: 'write',
  findOneAndUpdate: 'write', findOneAndDelete: 'write', findOneAndReplace: 'write',
  insertMany: 'batchWrite', bulkWrite: 'batchWrite',
};

const MONGO_TEMPLATE: Record<string, OpDef['kind']> = {
  find: 'readMany', findAll: 'readMany', findDistinct: 'readMany', stream: 'readMany', findOne: 'read', findById: 'read', exists: 'read',
  count: 'count', estimatedCount: 'count', exactCount: 'count', aggregate: 'aggregate', aggregateStream: 'aggregate', mapReduce: 'aggregate',
  insert: 'write', save: 'write', updateFirst: 'write', updateMulti: 'write', upsert: 'write', remove: 'write',
  findAndModify: 'write', findAndRemove: 'write', findAndReplace: 'write', findAllAndRemove: 'write',
  insertAll: 'batchWrite', bulkOps: 'batchWrite',
};

const HIBERNATE: Record<string, OpDef['kind']> = {
  get: 'read', find: 'read',
  save: 'write', persist: 'write', update: 'write', saveOrUpdate: 'write', merge: 'write', delete: 'write', remove: 'write', refresh: 'read',
};
const QUERY_FACTORIES = /^(createQuery|createNativeQuery|createNamedQuery|createSQLQuery|createSelectionQuery|createMutationQuery|createNativeMutationQuery|createStoredProcedureQuery)$/;

const JOOQ: Record<string, OpDef['kind']> = {
  selectFrom: 'readMany', select: 'readMany', selectDistinct: 'readMany', fetch: 'readMany', fetchOne: 'read', fetchOptional: 'read',
  fetchSingle: 'read', fetchAny: 'read', fetchExists: 'read', fetchCount: 'count', selectCount: 'count',
  insertInto: 'write', update: 'write', deleteFrom: 'write', mergeInto: 'write', executeInsert: 'write', executeUpdate: 'write', executeDelete: 'write',
  batch: 'batchWrite', batchInsert: 'batchWrite', batchUpdate: 'batchWrite', batchStore: 'batchWrite', batchDelete: 'batchWrite', loadInto: 'batchWrite',
};

/** Names declared as `MongoCollection<...> name` in this file (fields, locals, parameters). */
const collVarCache = new WeakMap<Analyzer, Set<string>>();
function mongoCollectionVars(a: Analyzer): Set<string> {
  let s = collVarCache.get(a);
  if (!s) {
    s = new Set([...a.src.matchAll(/\b(?:Reactive)?MongoCollection\s*(?:<[^;=(){}]*>)?\s+(\w+)/g)].map((m) => m[1]));
    collVarCache.set(a, s);
  }
  return s;
}

function javaOpDef(method: string, receiver: string, args: TSNode[], a: Analyzer): OpDef | null | undefined {
  const seg = lastSeg(receiver);
  const src = a.src;
  const mongoFile = a.hasMongo && !a.hasSql;

  if (MONGO_TPL_RE.test(seg)) {
    const k = MONGO_TEMPLATE[method];
    return k ? op(k, 'mongodb', 'none', 'spring-data-mongodb') : null;
  }
  if (a.hasMongo && (MONGO_COLL_RE.test(seg) || /\.getCollection\(\)$/.test(receiver) || mongoCollectionVars(a).has(seg))) {
    const k = MONGO_DRIVER[method];
    return k ? op(k, 'mongodb', 'none', 'mongodb-java-driver') : null;
  }
  if (EM_RE.test(seg)) {
    if (QUERY_FACTORIES.test(method)) return rawOr(args, 'readMany', 'jpa');
    if (method === 'find' || method === 'refresh') return op('read', 'sql', 'none', 'jpa');
    if (method === 'persist' || method === 'merge' || method === 'remove') return op('write', 'sql', 'none', 'jpa');
    return null;
  }
  if (SESSION_RE.test(seg) && /org\.hibernate/.test(src)) {
    if (QUERY_FACTORIES.test(method)) return rawOr(args, 'readMany', 'hibernate');
    const k = HIBERNATE[method];
    return k ? op(k, 'sql', 'none', 'hibernate') : null;
  }
  if (JDBC_RE.test(seg)) {
    if (/^(query|queryForObject|queryForList|queryForMap|queryForRowSet|queryForStream|queryForLong|queryForInt|sql)$/.test(method)) {
      return rawOr(args, /^(queryForObject|queryForMap|queryForLong|queryForInt)$/.test(method) ? 'read' : 'readMany', 'jdbc');
    }
    if (method === 'update' || method === 'execute') return rawOr(args, 'write', 'jdbc');
    if (method === 'batchUpdate') return op('batchWrite', 'sql', 'none', 'jdbc');
    return null;
  }
  if (STMT_RE.test(seg) && a.hasSql) {
    if (method === 'executeQuery') return rawOr(args, 'readMany', 'jdbc');
    if (/^(executeUpdate|executeLargeUpdate|execute)$/.test(method)) return rawOr(args, 'write', 'jdbc');
    if (/^(executeBatch|executeLargeBatch)$/.test(method)) return op('batchWrite', 'sql', 'none', 'jdbc');
    return null;
  }
  if (JOOQ_RE.test(seg) && /org\.jooq/.test(src)) {
    const k = JOOQ[method];
    return k ? op(k, 'sql', 'none', 'jooq') : null;
  }
  if (REPO_RE.test(seg)) {
    const db: Db = /mongo/i.test(seg) || mongoFile ? 'mongodb' : 'sql';
    return repoOp(method, args, db);
  }
  // Quarkus Panache active record: User.findById(id), User.listAll()
  if (/^[A-Z]\w*$/.test(seg) && /io\.quarkus\.(hibernate|mongodb)\.\w*\.?panache/.test(src)) {
    const db: Db = /io\.quarkus\.mongodb/.test(src) ? 'mongodb' : 'sql';
    const d = repoOp(method, args, db);
    return d ? { ...d, orm: 'panache' } : null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const callInfo = (node: TSNode): CallInfo | null => {
  if (node.type !== 'method_invocation') return null;
  const name = node.childForFieldName('name');
  return { method: name?.text ?? '', methodNode: name, receiver: node.childForFieldName('object'), args: node.childForFieldName('arguments') };
};

const skipParens = (n: TSNode | null): TSNode | null => {
  while (n && n.type === 'parenthesized_expression') n = n.parent;
  return n;
};

/** Comparison of a count against zero: `x > 0`, `x != 0`, `x >= 1`, `0 < x` (-> 'some') or `x == 0`, `x < 1`, `x <= 0` (-> 'none'). */
function zeroComparison(bin: TSNode, call: TSNode): 'some' | 'none' | null {
  if (bin.type !== 'binary_expression') return null;
  const left = bin.childForFieldName('left');
  const right = bin.childForFieldName('right');
  if (!left || !right) return null;
  const opText = bin.text.slice(left.endIndex - bin.startIndex, right.startIndex - bin.startIndex).trim();
  const callOnLeft = left.startIndex <= call.startIndex && left.endIndex >= call.endIndex;
  const other = (callOnLeft ? right : left).text.replace(/[lL]$/, '');
  const flip: Record<string, string> = { '>': '<', '<': '>', '>=': '<=', '<=': '>=', '==': '==', '!=': '!=' };
  const o = callOnLeft ? opText : flip[opText];
  if (other === '0') {
    if (o === '>' || o === '!=') return 'some';
    if (o === '==' || o === '<=') return 'none';
  }
  if (other === '1') {
    if (o === '>=') return 'some';
    if (o === '<') return 'none';
  }
  return null;
}

/** Variables assigned from an unbounded `findAll()` per analyzed file (for SQ010). */
const loadAllVars = new WeakMap<Analyzer, Map<string, QueryCall>>();

function isUnboundedFindAll(q: QueryCall): boolean {
  if (q.orm === 'jooq') {
    const hasFilter = q.chain.some((c) => /^(where|limit|fetchOne|fetchAny|fetchOptional|fetchSingle|seek|offset|join|\w+Join|groupBy)$/.test(c.name));
    return q.kind === 'readMany' && q.method !== 'fetch' && !hasFilter && q.chain.some((c) => /^(fetch\w*|stream|collect|forEach)$/.test(c.name));
  }
  if (!/^(findAll|listAll|streamAll)$/.test(q.method)) return false;
  // mongoTemplate.findAll(User.class) has no filter parameter at all
  if (MONGO_TPL_RE.test(lastSeg(q.receiver))) return true;
  if (q.args.length === 0) return true;
  // findAll(Sort.by("name")) still loads everything; Pageable / Specification / Example filter or bound it
  return q.args.length === 1 && /^(Sort\.|sort$|\w*[sS]ort$|new Sort\b)/.test(q.args[0].text.trim());
}

/** Iterating a variable or call that loaded a whole table: SQ010. */
function checkLoadAll(iterable: TSNode | null, loopNode: TSNode, a: Analyzer): void {
  if (!iterable) return;
  const seen = loadAllVars.get(a);
  let q: QueryCall | undefined;
  // direct call: for (User u : repo.findAll()) / repo.findAll().forEach(...) / repo.findAll().stream().map(...)
  for (let n: TSNode | null = iterable, i = 0; n && i < 6; i++) {
    if (n.type !== 'method_invocation') break;
    const ci = callInfo(n);
    if (!ci) break;
    if (/^(findAll|listAll|streamAll)$/.test(ci.method)) {
      const c = a.classify(n);
      if (c && isUnboundedFindAll(c)) q = c;
      break;
    }
    if (!/^(stream|parallelStream|iterator|spliterator)$/.test(ci.method)) break;
    n = ci.receiver;
  }
  if (!q && iterable.type === 'identifier' && seen) q = seen.get(iterable.text);
  if (!q && seen) {
    const root = a.rootIdent(iterable);
    if (root && /^\w+\.(stream|parallelStream)\(\)$/.test(a.path(iterable))) q = seen.get(root);
  }
  if (!q) return;
  a.add('SQ010', loopNode, q, {
    message: `Iterates every row returned by \`${q.receiver}.${q.method}()\` (line ${q.node.startPosition.row + 1}): the whole table is held in memory.`,
    fix: q.db === 'mongodb'
      ? 'Stream with a cursor (MongoTemplate.stream(), find().batchSize()) or page through with Slice/Pageable.'
      : 'Page through it with findAll(PageRequest.of(page, size)) / Slice, or stream with a Stream<T> repository method + @QueryHints(fetch size) inside a read-only transaction.',
  });
}

const ITER_ALWAYS = /^(forEach|forEachOrdered|removeIf|replaceAll|forEachRemaining)$/;
const ITER_STREAM = /^(map|flatMap|filter|peek|anyMatch|allMatch|noneMatch|mapToInt|mapToLong|mapToDouble|mapToObj|takeWhile|dropWhile|mapMulti|collect)$/;

/** Is this lambda-taking call iterating (List.forEach, stream().map) rather than Optional.map / CompletableFuture.thenApply? */
function isIterating(method: string, receiver: TSNode | null, a: Analyzer): boolean {
  if (!receiver) return false;
  if (ITER_ALWAYS.test(method)) return true;
  if (!ITER_STREAM.test(method)) return false;
  const p = a.path(receiver);
  return /(^|\.)(stream|parallelStream)\(\)|^(Stream|IntStream|LongStream|Arrays)\.|(^|\.)(boxed|range|rangeClosed)\(\)/.test(p);
}

function visitIterCall(node: TSNode, ctx: Ctx, a: Analyzer): boolean {
  const ci = callInfo(node);
  if (!ci || !ci.args) return false;
  const args = a.argNodes(node);
  const fnArgs = args.filter((x) => x.type === 'lambda_expression' || x.type === 'method_reference');
  if (!fnArgs.length || !isIterating(ci.method, ci.receiver, a)) return false;
  const recv = ci.receiver!;
  a.visit(recv, ctx);
  checkLoadAll(recv, node, a);
  for (const arg of args) {
    if (arg.type === 'lambda_expression') {
      a.visit(arg, a.inner(ctx, node, recv, false, arg.childForFieldName('parameters')));
    } else if (arg.type === 'method_reference') {
      methodRefQuery(arg, a.inner(ctx, node, recv), a);
    } else a.visit(arg, ctx);
  }
  return true;
}

/** `ids.stream().map(userRepository::findById)`: a query per element through a method reference. */
function methodRefQuery(ref: TSNode, ctx: Ctx, a: Analyzer): void {
  const kids = ref.namedChildren;
  if (kids.length < 2) return;
  const recvNode = kids[0];
  const method = kids[kids.length - 1].text;
  const receiver = a.path(recvNode);
  const def = javaOpDef(method, receiver, [], a);
  if (!def) return;
  const db: Db = def.db === 'any' ? 'sql' : def.db;
  const q: QueryCall = {
    node: ref, top: ref, method, kind: def.kind, db, orm: def.orm, receiver, receiverText: recvNode.text,
    collection: receiver.replace(/^this\./, '').replace(/(Repository|Repo|Dao)$/i, '') || receiver,
    args: [], argsText: '', chain: [], confidence: 'high',
  };
  a.evaluate(q, ctx);
}

/** Field names from a derived query (`findByEmailAndStatusIn` -> email, status) or Mongo filter builders. */
function javaFilterKeys(q: QueryCall): string[] | undefined {
  const by = /By([A-Z_]\w*)$/.exec(q.method);
  if (by && q.orm?.startsWith('spring-data')) {
    const body = by[1].replace(/OrderBy\w*$/, '');
    const OPS = /(IgnoreCase|IgnoringCase|AllIgnoreCase|IsNotNull|IsNull|NotNull|Null|IsNotIn|NotIn|IsIn|In|IsNotLike|NotLike|IsLike|Like|IsStartingWith|StartingWith|StartsWith|IsEndingWith|EndingWith|EndsWith|IsContaining|Containing|Contains|NotContaining|IsBetween|Between|IsLessThanEqual|LessThanEqual|IsLessThan|LessThan|IsGreaterThanEqual|GreaterThanEqual|IsGreaterThan|GreaterThan|IsBefore|Before|IsAfter|After|IsTrue|True|IsFalse|False|IsNot|Not|IsEmpty|Empty|IsNotEmpty|NotEmpty|Regex|MatchesRegex|Matches|Exists|Near|Within|Is|Equals)$/;
    return body.split(/And(?=[A-Z])|Or(?=[A-Z])/).map((p) => {
      let s = p;
      for (let i = 0; i < 3; i++) s = s.replace(OPS, '');
      return s ? s[0].toLowerCase() + s.slice(1) : '';
    }).filter(Boolean);
  }
  if (/^(findById|getById|getReferenceById|existsById|findByIdOptional)$/.test(q.method) || (q.orm === 'jpa' && q.method === 'find')) {
    return [q.db === 'mongodb' ? '_id' : 'id'];
  }
  if (q.db === 'mongodb') {
    const keys = [...q.argsText.matchAll(/(?:\b(?:eq|ne|gt|gte|lt|lte|in|nin|regex|exists|where|and|is|elemMatch|all|size|type|text|near)\(\s*|new (?:Document|BasicDBObject)\(\s*|\.append\(\s*)"([\w.]+)"/g)].map((m) => m[1]);
    return [...new Set(keys.filter((k) => !k.startsWith('$')))];
  }
  return undefined;
}

function javaBatchFix(q: QueryCall): string | undefined {
  if (q.db === 'mongodb') {
    const keys = javaFilterKeys(q) ?? [];
    const k = keys[0] ?? '_id';
    return `Collect the ${k} values first and run one query: \`collection.find(Filters.in("${k}", values))\`, \`mongoTemplate.find(query(where("${k}").in(values)), ...)\` or \`repository.findAllById(ids)\` / \`findBy...In(values)\`, then match the results in memory with a Map.`;
  }
  if (q.db === 'sql') {
    return 'Load the rows in one query: `findAllById(ids)` or a derived `findBy...In(Collection)` / `@Query("... WHERE x IN (:ids)")`; for associations fetch them with the parent via `@EntityGraph(attributePaths = ...)` or `JOIN FETCH`, or set `@BatchSize` / `hibernate.default_batch_fetch_size`.';
  }
  return undefined;
}

function regexRule(q: QueryCall, a: Analyzer): void {
  const t = q.argsText + ' ' + q.chain.map((c) => `${c.name}${c.args}`).join(' ');
  const m = /\bregex\(\s*(?:"[\w.]+"\s*,\s*)?([^,)]+)(?:,\s*"([^"]*)")?/.exec(t);
  if (!m) return;
  const v = m[1].trim();
  const caseI = !!m[2]?.includes('i') || /Pattern\.CASE_INSENSITIVE/.test(t);
  if (/^"/.test(v)) {
    if (!/^"\^/.test(v)) a.add('MQ002', q.node, q, { message: `Regex ${v} is not anchored with ^ — it scans every key.` });
    else if (caseI) a.add('MQ002', q.node, q, { message: 'Case-insensitive regex cannot use the index efficiently (anchored but case-insensitive).', severity: 'medium' });
  } else if (!/^Pattern\.compile\(\s*"\^/.test(v)) {
    a.add('MQ002', q.node, q, { message: `Regex built from \`${v.slice(0, 40)}\` — usually unanchored${caseI ? ' and case-insensitive' : ''}; this scans every key.` });
  }
}

function javaExtraRules(q: QueryCall, ctx: Ctx, a: Analyzer): void {
  const isCall = q.node.type === 'method_invocation';

  // remember `List<User> all = repo.findAll();` for SQ010
  if (isCall && isUnboundedFindAll(q) && q.chain.every((c) => /^(stream|toList|iterator)$/.test(c.name))) {
    const decl = skipParens(q.top.parent);
    const name = decl?.type === 'variable_declarator' ? decl.childForFieldName('name')?.text
      : decl?.type === 'assignment_expression' ? decl.childForFieldName('left')?.text : undefined;
    if (name) {
      let m = loadAllVars.get(a);
      if (!m) loadAllVars.set(a, (m = new Map()));
      m.set(name.replace(/^this\./, ''), q);
    }
  }

  if (q.db === 'mongodb') {
    // full collection reads that the generic find({}) check cannot see
    const emptyDriverFilter = q.method === 'find' && q.orm === 'mongodb-java-driver' && q.args[0]
      && /^(new(Document|BasicDBObject)\(\)|Filters\.empty\(\)|empty\(\))$/.test(q.args[0].text.replace(/\s+/g, ''));
    const hasLimit = q.chain.some((c) => /^(limit|first|batchSize|cursor|iterator)$/.test(c.name));
    if ((emptyDriverFilter && !hasLimit) || isUnboundedFindAll(q)) {
      a.add('MQ001', q.node, q, { message: `\`${q.receiver}.${q.method}()\` reads the whole collection (no filter, no limit).` });
    }
    // MongoTemplate builds projections on the Query object (query.fields()), which we cannot see here;
    // an empty driver filter is already reported as MQ001
    if ((q.orm === 'spring-data-mongodb' && q.method === 'find') || emptyDriverFilter) {
      const line = q.node.startPosition.row + 1;
      const col = q.node.startPosition.column + 1;
      a.findings = a.findings.filter((f) => !(f.ruleId === 'MQ010' && f.line === line && f.column === col));
    }
    regexRule(q, a);
    if (/\bFilters\.where\(/.test(q.argsText)) {
      a.add('MQ003', q.node, q, { message: 'Executes JavaScript ($where) on the server for each document; indexes cannot be used.' });
    }
  }

  // SQ009: COUNT used as an existence check
  if (q.db === 'sql') {
    const isCountCall = q.kind === 'count' && /^count/.test(q.method);
    const sqlCount = (q.kind === 'raw' || q.kind === 'read') && q.args[0]?.type === 'string_literal' && /^\s*select\s+count\s*\(/i.test(stripQuotes(q.args[0].text));
    if (isCountCall || sqlCount) {
      const parent = skipParens(q.top.parent);
      const cmp = parent ? zeroComparison(parent, q.top) : null;
      if (cmp && parent) {
        let autofix;
        const exists = q.method.replace(/^count/, 'exists');
        if (isCountCall && /^countBy[A-Z]\w*$/.test(q.method) && q.top === q.node && q.node.childForFieldName('name')
          && new RegExp(`\\b${exists}\\s*\\(`).test(a.src)) {
          const nameNode = q.node.childForFieldName('name')!;
          const call = a.src.slice(q.node.startIndex, nameNode.startIndex) + exists + a.src.slice(nameNode.endIndex, q.node.endIndex);
          autofix = {
            offset: parent.startIndex, deleteLength: parent.endIndex - parent.startIndex,
            insert: (cmp === 'none' ? '!' : '') + call, description: `replace ${q.method}(...) comparison with ${exists}(...)`,
          };
        }
        a.add('SQ009', q.node, q, {
          message: `\`${q.receiver}.${q.method}()\` counts every matching row, but the result is only used as an existence check (\`${parent.text.replace(/\s+/g, ' ').slice(0, 80)}\`).`,
          fix: isCountCall && /^countBy/.test(q.method)
            ? `Use \`${exists}(...)\` (declare \`boolean ${exists}(...)\` in the repository): Spring Data turns it into a LIMIT 1 / EXISTS query.`
            : isCountCall ? 'Use an existsBy...() derived query, `exists(Specification)` or `findFirstBy...()`; they stop at the first match.'
              : 'Use `SELECT EXISTS (SELECT 1 FROM ... WHERE ...)` or `SELECT 1 ... LIMIT 1` instead of COUNT(*).',
          autofix,
        });
      }
    }
  }
}

function javaVisitLoop(node: TSNode, ctx: Ctx, a: Analyzer): boolean {
  if (node.type === 'enhanced_for_statement') {
    const value = node.childForFieldName('value');
    if (value) a.visit(value, ctx);
    checkLoadAll(value, node, a);
    const inner = a.inner(ctx, node, value, false, node.childForFieldName('name'));
    const body = node.childForFieldName('body');
    if (body) a.visit(body, inner);
    return true;
  }
  if (node.type === 'while_statement') {
    // while (rs.next()) / while (cursor.hasNext()): one iteration per row of a result set
    const cond = node.childForFieldName('condition');
    const m = cond ? /^\(?\s*(\w+)\.(next|hasNext)\(\)\s*\)?$/.exec(cond.text) : null;
    if (!cond || !m) return false;
    const v = m[1];
    const fromQuery = a.queryVars.has(v);
    if (!fromQuery && !/^(rs|resultSet|\w*ResultSet|\w*Rs|cursor|\w*Cursor|it|iter|iterator|\w*Iterator)$/.test(v)) return false;
    a.visit(cond, ctx);
    const body = node.childForFieldName('body');
    const rv = cond.namedChildren[0]?.childForFieldName('object') ?? cond;
    if (body) a.visit(body, a.inner(ctx, node, rv, fromQuery));
    return true;
  }
  return false; // classic for / do-while: generic handling
}

export const java: LangPlugin = {
  extensions: ['.java'],
  spec: {
    id: 'java',
    grammar: 'tree-sitter-java.wasm',
    call: ['method_invocation'],
    member: { field_access: ['object', 'field'] },
    loops: ['enhanced_for_statement', 'for_statement', 'while_statement', 'do_statement'],
    functions: ['method_declaration', 'constructor_declaration', 'class_declaration', 'interface_declaration', 'enum_declaration', 'record_declaration', 'static_initializer'],
    lambdas: ['lambda_expression'],
    strings: ['string_literal'],
    iterMethods: [],
  },
  fileHints: { sql: SQL_HINT, mongo: MONGO_HINT },
  callInfo,
  opDef: (method, receiver, args, a) => javaOpDef(method, receiver, args, a),
  visitLoop: javaVisitLoop,
  visitCall: visitIterCall,
  filterKeys: (q) => javaFilterKeys(q),
  batchFix: javaBatchFix,
  unbounded: (q) => isUnboundedFindAll(q),
  extraRules: javaExtraRules,
};
