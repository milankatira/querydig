# querydig

**Find slow, N+1 and unoptimized database queries before they reach production.**

querydig is a zero-config CLI that statically scans your code for MongoDB and SQL query anti-patterns: N+1 queries, nested queries over results (N²), writes in loops, unbounded reads, unanchored regexes, `skip()`/`OFFSET` pagination, non-sargable SQL and more. Each finding gets a severity (**critical / high / medium / low**), the exact location, why it's slow and how to fix it.

```bash
npx querydig            # scan the current directory
```

- **Runs locally.** No account, no server, your code never leaves the machine.
- **Fast.** Tree-sitter (WASM) parsing in a worker pool: about 2,000 files in under 1 second.
- **Multi-language.** JavaScript, TypeScript, Python and Go.
- **Multi-database.** MongoDB (Mongoose, native driver, PyMongo/Motor, mongo-go-driver) and SQL (Prisma, TypeORM, Sequelize, pg/mysql2/knex raw, Django ORM, SQLAlchemy, DB-API cursors, GORM/xorm, `database/sql`).
- **Live evidence (optional).** Point `--uri` at a MongoDB or Postgres replica to confirm full scans, missing and unused indexes, and slow queries.
- **CI-ready.** `--fail-on`, baselines, `--diff`, SARIF for GitHub code scanning, Markdown for PR comments, HTML report.

> Requires Node.js 22.12+.

## Example

```text
 CRITICAL  QD002 Nested query over another query's results (N² risk) [mongodb]
  src/orders.service.ts:7:20
  │ o.user = await User.findById(o.userId);
  `User.findById()` is executed for every row of `orders`, which itself came from the database (loop at line 6).
  fix: Collect the _id values first and run a single `User.find({ _id: { $in: values } })`, then match results in memory with a Map.

 MEDIUM  MQ005 sort() without limit() [mongodb]
  src/search.ts:25:10
  │ return User.find({ status }).sort({ createdAt: -1 }).lean();
  fix: Add .limit(n) and an index matching filter + sort (ESR order), e.g. createIndex({ status: 1, createdAt: -1 }).

Summary
   CRITICAL  6    HIGH  16    MEDIUM  7    LOW  12
  Query health: F (0/100)
```

## Usage

```bash
npx querydig [path]                         # terminal report
npx querydig --format html                  # writes querydig-report.html (filterable, self-contained)
npx querydig --format json -o report.json
npx querydig --format sarif -o querydig.sarif
npx querydig --format md > querydig.md      # for PR comments

npx querydig --fail-on high                 # exit 1 if any high/critical issue (CI gate)
npx querydig --min-severity medium          # hide low findings
npx querydig --diff origin/main             # only files changed vs a branch
npx querydig --update-baseline              # record existing issues in .querydig-baseline.json
npx querydig --baseline .querydig-baseline.json --fail-on high   # only NEW issues fail

npx querydig rules                          # list rules
npx querydig explain QD001                  # why + before/after example
npx querydig init                           # create querydig.config.json
npx querydig --fix                          # apply safe automatic fixes (.lean())
npx querydig --uri … --emit-indexes         # write missing indexes to a script
```

Add it to a project:

```bash
npm i -D querydig
# package.json → "scripts": { "querydig": "querydig --fail-on high" }
```

## Rules

| ID | Severity | DB | Detects |
|---|---|---|---|
| QD001 | high (critical when nested) | any | Query inside a loop / `.map` / comprehension (N+1) |
| QD002 | critical | any | Query per row of another query's results (N²) |
| QD003 | high | any | insert/update/delete inside a loop. Use bulk APIs |
| MQ001 | high | MongoDB | `find({})` with no limit (full collection scan) |
| MQ002 | high | MongoDB | Unanchored or case-insensitive `$regex` |
| MQ003 | high | MongoDB | `$where`, `$function`, `mapReduce` |
| MQ004 | medium | MongoDB | `skip()` pagination |
| MQ005 | medium | MongoDB | `sort()` without `limit()` (suggests an ESR index) |
| MQ006 | medium | MongoDB | `$lookup`/`$unwind`/`$group` before `$match` |
| MQ007 | medium | MongoDB | Nested or many `populate()` calls |
| MQ008 | low | MongoDB | `countDocuments()` used only as an existence check |
| MQ009 | low | MongoDB | `$ne` / `$nin` / `$not` filters |
| MQ010 | low | MongoDB | `find()` without projection |
| MQ011 | low | MongoDB | Mongoose read without `.lean()` |
| SQ001 | high | SQL | `findMany()` / `findAll()` / `objects.all()` / `db.Find()` with no where/limit |
| SQ002 | low | SQL | `SELECT *` |
| SQ003 | high | SQL | `LIKE '%term'` |
| SQ004 | high/medium | SQL | `UPDATE`/`DELETE` without `WHERE`, `SELECT` without `WHERE`/`LIMIT` |
| SQ005 | medium | SQL | `OFFSET` pagination |
| SQ006 | medium | SQL | `WHERE LOWER(col) = …` (non-sargable) |
| SQ007 | high | SQL | `ORDER BY RAND()` |
| SQ008 | medium | SQL | `NOT IN (SELECT …)` |

Built-in noise control: `while`/`for {}` polling loops, batching loops (`skip`/`offset` in the loop), loops over collections or model classes, and array helpers like `arr.find(x => …)` or Python `str.find()` are not flagged.

## Live mode: evidence from your database

Static analysis finds the patterns. Live mode connects **read-only** to MongoDB or Postgres and checks them against reality: how big each collection is, which indexes exist, and what the query planner actually does.

```bash
npx querydig --uri "mongodb://reader:***@replica-host/shop"
QUERYDIG_DB_URI="postgres://reader:***@replica-host/shop" npx querydig   # keeps the secret out of shell history
```

What changes:

- **Promotes** an N+1 whose inner query is a full scan of a large table to critical ("N × full scan of 4.2M docs") and adds the missing index.
- **Demotes** unbounded reads on tiny lookup tables to low.
- **Adds live-only findings:**

| ID | Severity | Finds |
|---|---|---|
| LV001 | high / critical | Queries in your code that do a COLLSCAN / Seq Scan on 10k+ rows, with the exact index to create |
| LV002 | medium | Queries that sort in memory |
| LV003 | high / critical | Slow queries from the MongoDB profiler or `pg_stat_statements`, traced back to the line of code when possible |
| LV004 | low | Indexes that are never used |
| LV005 | medium | Postgres foreign keys without an index that your code filters on |

Every live finding shows its evidence:

```text
 CRITICAL  QD002 Nested query over another query's results (N² risk) [mongodb]
  src/reports.ts:15:25
  live: Each iteration does a full scan of orders (300k docs): N × 300k docs read. (high → critical)
  fix: … Until then, at least add an index: db.orders.createIndex({ userId: 1 })
```

**Safety model**

- Only metadata and query plans are read by default: collection stats, index lists, `explain('queryPlanner')`, and `EXPLAIN (GENERIC_PLAN)` (PostgreSQL 16+). Queries are **planned, never executed**.
- `--explain-execute` opts into execution stats (`executionStats` / `EXPLAIN ANALYZE`, SELECTs only), which do run the query. Use it on a replica.
- Postgres: every statement runs in a read-only transaction (`default_transaction_read_only = on`) with a 5s statement timeout. MongoDB: `secondaryPreferred` reads with `maxTimeMS: 5000`.
- Passwords are redacted from all output. If the database can't be reached, querydig warns and still reports static findings (`--live-required` makes that an error).

**Recommended read-only users**

```js
// MongoDB
db.createUser({ user: 'querydig', pwd: '…', roles: [{ role: 'read', db: 'shop' }, { role: 'clusterMonitor', db: 'admin' }] })
```

```sql
-- Postgres
CREATE ROLE querydig LOGIN PASSWORD '…';
GRANT pg_read_all_stats TO querydig;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO querydig;
```

Slow-query detection needs the MongoDB profiler (`db.setProfilingLevel(1, { slowms: 100 })`) or the `pg_stat_statements` extension. querydig tells you when either is missing.

| Option | Default | |
|---|---|---|
| `--uri <uri>` / `QUERYDIG_DB_URI` | | `mongodb://`, `mongodb+srv://`, `postgres://`, `postgresql://` |
| `--db <name>` | from URI | MongoDB database when the URI has none |
| `--slow-ms <n>` | 100 | Slow-query threshold |
| `--explain-execute` | off | Execute explain (replicas only) |
| `--max-explain <n>` | 200 | Cap on query shapes explained |
| `--live-required` | off | Exit 2 if the database can't be reached |

## Auto-fix and index scripts

**`--fix`** applies only edits that are safe to make mechanically, and shows each change:

```bash
npx querydig --fix --dry-run   # preview
npx querydig --fix             # write the changes, then review with git diff
```

Today that means adding `.lean()` to read-only Mongoose queries (MQ011), placed before `.exec()` / `.then()`. Files that call `.save()`, `.toObject()`, `.markModified()` and similar on documents are skipped. querydig never rewrites N+1 loops, adds limits or changes projections on its own, because those change behaviour. Each of those findings comes with a fix to apply by hand, or with an AI assistant.

**`--emit-indexes [file]`** (with `--uri`) writes every missing index found in the query plans to one reviewed script. Indexes are de-duplicated, and an index that's a prefix of another is folded into it:

```bash
npx querydig --uri "$QUERYDIG_DB_URI" --emit-indexes          # querydig-indexes.js (MongoDB) or .sql (Postgres)
mongosh "$QUERYDIG_DB_URI" querydig-indexes.js                # after review, on a replica first
```

```js
// orders: fixes LV001 src/orders.ts:5, LV003 src/orders.ts:5, QD002 src/report.ts:15
db.orders.createIndex({ status: 1, createdAt: -1 });
```

## Suppressing findings

```ts
await User.findById(id); // querydig-ignore QD001 -- bounded to 3 items
// querydig-ignore            ← suppresses every rule on the next line
// querydig-ignore-file       ← in the first lines of a file, skips the whole file
```

## Configuration

`querydig.config.json` (or `.querydigrc.json`) in the project root:

```json
{
  "ignore": ["scripts/**"],
  "includeTests": false,
  "failOn": "high",
  "minSeverity": "low",
  "rules": { "MQ010": "off", "SQ002": "off", "QD003": "critical" }
}
```

By default querydig skips `node_modules`, build output, vendored code, `.gitignore`d files, tests, specs, fixtures, benchmarks, migrations and seeds. Pass `--include-tests` to scan them too.

## CI

**GitHub Actions** (with code-scanning annotations):

```yaml
name: querydig
on: [pull_request]
jobs:
  querydig:
    runs-on: ubuntu-latest
    permissions: { contents: read, security-events: write }
    steps:
      - uses: actions/checkout@v7
        with: { fetch-depth: 0 }
      - uses: actions/setup-node@v7
        with: { node-version: 22 }
      - run: npx -y querydig --format sarif -o querydig.sarif || true
      - uses: github/codeql-action/upload-sarif@v4
        with: { sarif_file: querydig.sarif }
      - run: npx -y querydig --diff origin/${{ github.base_ref }} --fail-on high
```

**GitLab CI**

```yaml
querydig:
  image: node:22
  script:
    - npx -y querydig --fail-on high --format md > querydig.md
  artifacts: { when: always, paths: [querydig.md] }
```

**Any CI / pre-commit**

```bash
npx -y querydig --baseline .querydig-baseline.json --fail-on high
```

More templates in [`examples/ci`](examples/ci).

## Programmatic API

```ts
import { scan, renderHtml } from 'querydig';
const summary = await scan({ root: '.', minSeverity: 'medium' });
console.log(summary.bySeverity, summary.grade);
```

## Roadmap

- Live mode for MySQL (`performance_schema` + `EXPLAIN`).
- Repo-wide index recommendations and PR comments.
- Java/Kotlin (Hibernate/Spring Data), Ruby (ActiveRecord), PHP (Eloquent).
- An official GitHub Action and incremental cache.

## License

MIT
