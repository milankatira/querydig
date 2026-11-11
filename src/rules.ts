import type { Db, Severity } from './types.js';

export interface RuleMeta {
  id: string;
  name: string;
  title: string;
  severity: Severity;
  db: Db | 'any';
  why: string;
  fix: string;
  example?: { bad: string; good: string };
}

const r = (m: RuleMeta) => m;

export const RULES: RuleMeta[] = [
  // ---------- generic (any database) ----------
  r({
    id: 'QD001', name: 'n-plus-one', title: 'Query inside a loop (N+1)', severity: 'high', db: 'any',
    why: 'Each iteration sends a separate round-trip to the database. With N items you run N+1 queries; latency grows linearly with data size and connection pools get exhausted.',
    fix: 'Fetch everything in one query ($in / WHERE id IN (...) / include / populate / select_related / Preload) and join in memory with a Map keyed by id.',
    example: {
      bad: 'for (const o of orders) {\n  o.user = await User.findById(o.userId);\n}',
      good: 'const users = await User.find({ _id: { $in: orders.map(o => o.userId) } }).lean();\nconst byId = new Map(users.map(u => [String(u._id), u]));\nfor (const o of orders) o.user = byId.get(String(o.userId));',
    },
  }),
  r({
    id: 'QD002', name: 'nested-query-over-results', title: 'Nested query over another query\'s results (N² risk)', severity: 'critical', db: 'any',
    why: 'The loop iterates the rows returned by an earlier query and issues another query per row. Cost multiplies with every level of nesting and is usually the #1 cause of slow endpoints.',
    fix: 'Replace with a single aggregation ($lookup) / JOIN, or batch the inner query with $in / IN (...) using the ids collected from the outer result.',
    example: {
      bad: 'const users = await User.find({ active: true });\nfor (const u of users) {\n  u.orders = await Order.find({ userId: u._id });\n}',
      good: 'const users = await User.find({ active: true }).lean();\nconst orders = await Order.find({ userId: { $in: users.map(u => u._id) } }).lean();\n// group orders by userId in memory',
    },
  }),
  r({
    id: 'QD003', name: 'write-in-loop', title: 'Write operation inside a loop', severity: 'high', db: 'any',
    why: 'One insert/update/delete per iteration means N round-trips and N separate index updates/journal flushes.',
    fix: 'Use bulk APIs: bulkWrite / insertMany / updateMany (MongoDB), createMany / bulkCreate / multi-row INSERT / executemany / CreateInBatches (SQL).',
    example: {
      bad: 'for (const item of items) {\n  await Item.updateOne({ _id: item.id }, { $set: { price: item.price } });\n}',
      good: 'await Item.bulkWrite(items.map(i => ({\n  updateOne: { filter: { _id: i.id }, update: { $set: { price: i.price } } },\n})));',
    },
  }),

  // ---------- MongoDB ----------
  r({
    id: 'MQ001', name: 'unbounded-find', title: 'Unbounded find with empty filter', severity: 'high', db: 'mongodb',
    why: 'find({}) without limit reads the entire collection (COLLSCAN) and transfers every document to the app. It gets slower every day the collection grows.',
    fix: 'Add a selective filter backed by an index, a .limit(), and paginate with a range query on an indexed field (e.g. _id > lastId).',
    example: { bad: 'const all = await Product.find({});', good: 'const page = await Product.find({ _id: { $gt: lastId } }).sort({ _id: 1 }).limit(50).lean();' },
  }),
  r({
    id: 'MQ002', name: 'unanchored-regex', title: 'Unanchored or case-insensitive $regex', severity: 'high', db: 'mongodb',
    why: 'Only prefix-anchored, case-sensitive regexes (/^abc/) can use an index efficiently. /abc/ or /abc/i scans every index key or document.',
    fix: 'Anchor the pattern with ^, store a lower-cased copy of the field for case-insensitive matching, or use a text / Atlas Search index.',
    example: { bad: "User.find({ name: { $regex: search, $options: 'i' } })", good: "User.find({ nameLower: { $regex: '^' + escape(search.toLowerCase()) } })" },
  }),
  r({
    id: 'MQ003', name: 'server-side-js', title: '$where / $function / mapReduce (JavaScript execution)', severity: 'high', db: 'mongodb',
    why: 'Server-side JavaScript cannot use indexes, runs per document and is deprecated in recent MongoDB versions.',
    fix: 'Rewrite with standard query operators ($expr) or the aggregation pipeline.',
  }),
  r({
    id: 'MQ004', name: 'skip-pagination', title: 'Pagination with skip()', severity: 'medium', db: 'mongodb',
    why: 'skip(n) still walks n documents/index keys before returning results; deep pages get linearly slower.',
    fix: 'Use range (keyset) pagination: filter on an indexed field greater than the last seen value and .limit(pageSize).',
  }),
  r({
    id: 'MQ005', name: 'sort-without-limit', title: 'sort() without limit()', severity: 'medium', db: 'mongodb',
    why: 'Sorting a large result without a limit (and without a matching index) triggers a blocking in-memory SORT that can hit the 100MB limit.',
    fix: 'Add .limit() and create an index whose key order matches the sort (ESR rule: Equality, Sort, Range).',
  }),
  r({
    id: 'MQ006', name: 'lookup-before-match', title: 'Aggregation: $lookup/$unwind/$group before $match', severity: 'medium', db: 'mongodb',
    why: 'Stages before the first $match process every document in the collection. $match placed first can use an index and shrinks the working set.',
    fix: 'Move $match (and $limit when possible) to the start of the pipeline; filter before $lookup and $unwind.',
  }),
  r({
    id: 'MQ007', name: 'deep-populate', title: 'Deep or chained populate()', severity: 'medium', db: 'mongodb',
    why: 'Every populate path is an extra query; nested populate multiplies them and loads full referenced documents.',
    fix: 'Populate only needed paths with select, or replace with a single $lookup aggregation.',
  }),
  r({
    id: 'MQ008', name: 'count-for-existence', title: 'countDocuments() used as existence check', severity: 'low', db: 'mongodb',
    why: 'countDocuments counts all matches; you only need to know whether one exists.',
    fix: 'Use findOne(filter, { _id: 1 }) / exists() / find(filter).limit(1).',
  }),
  r({
    id: 'MQ009', name: 'negation-operators', title: 'Negation operators ($ne / $nin / $not)', severity: 'low', db: 'mongodb',
    why: 'Negations are not selective; the planner usually has to scan most of the index or collection.',
    fix: 'Rewrite as a positive match ($in of allowed values) or combine with a selective equality filter.',
  }),
  r({
    id: 'MQ010', name: 'no-projection', title: 'find() without projection', severity: 'low', db: 'mongodb',
    why: 'Fetching whole documents increases network transfer, memory and deserialization cost, and prevents covered queries.',
    fix: 'Select only the fields you need: .select("a b") / { projection: { a: 1, b: 1 } } / SetProjection().',
  }),
  r({
    id: 'MQ011', name: 'missing-lean', title: 'Mongoose read without .lean()', severity: 'low', db: 'mongodb',
    why: 'Hydrating full Mongoose documents is 3-5x slower and uses more memory than plain objects for read-only paths.',
    fix: 'Append .lean() to read-only queries.',
  }),

  // ---------- SQL ----------
  r({
    id: 'SQ001', name: 'unbounded-orm-read', title: 'Unbounded ORM read (no where / limit)', severity: 'high', db: 'sql',
    why: 'findMany()/findAll()/objects.all() without a filter or limit loads the whole table into memory.',
    fix: 'Add a where clause and take/limit with cursor-based pagination.',
  }),
  r({
    id: 'SQ002', name: 'select-star', title: 'SELECT *', severity: 'low', db: 'sql',
    why: 'Reads every column (including large TEXT/JSON), prevents index-only scans and breaks when columns change.',
    fix: 'List only the columns you need.',
  }),
  r({
    id: 'SQ003', name: 'leading-wildcard-like', title: "LIKE with leading wildcard ('%...')", severity: 'high', db: 'sql',
    why: "A B-tree index cannot be used for LIKE '%term'; the database scans the whole table.",
    fix: 'Use prefix match (LIKE \'term%\'), a trigram (pg_trgm) / FULLTEXT index, or a search engine.',
  }),
  r({
    id: 'SQ004', name: 'missing-where', title: 'UPDATE/DELETE without WHERE or unbounded SELECT', severity: 'high', db: 'sql',
    why: 'Touches every row in the table: full scan, heavy locking and replication lag.',
    fix: 'Add a WHERE clause on an indexed column, a LIMIT, or batch the operation.',
  }),
  r({
    id: 'SQ005', name: 'offset-pagination', title: 'OFFSET pagination', severity: 'medium', db: 'sql',
    why: 'OFFSET n reads and discards n rows; deep pages get linearly slower.',
    fix: 'Use keyset pagination: WHERE id > :lastId ORDER BY id LIMIT :n.',
  }),
  r({
    id: 'SQ006', name: 'function-on-column', title: 'Function applied to column in WHERE', severity: 'medium', db: 'sql',
    why: 'WHERE LOWER(col) = ... or DATE(col) = ... makes the condition non-sargable; a normal index on col cannot be used.',
    fix: 'Compare the raw column against a transformed value/range, or create an expression index.',
  }),
  r({
    id: 'SQ007', name: 'order-by-random', title: 'ORDER BY RAND()/RANDOM()', severity: 'high', db: 'sql',
    why: 'Generates a random value for every row and sorts the whole table.',
    fix: 'Pick random ids in the app, use TABLESAMPLE, or a precomputed random column with an index.',
  }),
  r({
    id: 'SQ008', name: 'not-in-subquery', title: 'NOT IN (subquery)', severity: 'medium', db: 'sql',
    why: 'NOT IN with a subquery is often executed as a nested loop and has surprising NULL semantics.',
    fix: 'Rewrite as NOT EXISTS or a LEFT JOIN ... WHERE x IS NULL.',
  }),
];

export const RULE_MAP = new Map(RULES.map((x) => [x.id, x]));

export function findRule(idOrName: string): RuleMeta | undefined {
  const q = idOrName.toUpperCase();
  return RULE_MAP.get(q) ?? RULES.find((x) => x.name === idOrName.toLowerCase());
}
