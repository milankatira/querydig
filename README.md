# querydig

[![npm](https://img.shields.io/npm/v/querydig)](https://www.npmjs.com/package/querydig)
[![npm downloads](https://img.shields.io/npm/dm/querydig)](https://www.npmjs.com/package/querydig)
[![license](https://img.shields.io/npm/l/querydig)](LICENSE)
[![GitHub Action](https://img.shields.io/badge/GitHub_Action-querydig-2088FF?logo=githubactions&logoColor=white)](#github-action)
[![MCP](https://img.shields.io/badge/MCP-server-8A2BE2)](#ai-assistants-mcp-server)

**Find slow, N+1 and unoptimized database queries before they reach production.**

querydig is a zero-config CLI that statically scans your code for MongoDB and SQL query anti-patterns: N+1 queries, nested queries over results (N²), writes in loops, unbounded reads, unanchored regexes, `skip()`/`OFFSET` pagination, non-sargable SQL and more. Each finding gets a severity (**critical / high / medium / low**), the exact location, why it's slow and how to fix it.

```bash
npx querydig            # scan the current directory
```

- **Runs locally.** No account, no server, your code never leaves the machine.
- **Fast.** Tree-sitter (WASM) parsing in a worker pool: about 2,000 files in under 1 second.
- **Multi-language.** JavaScript, TypeScript, Python, Go, Java, Ruby and PHP.
- **Multi-database.** MongoDB (Mongoose, native driver, PyMongo/Motor, mongo-go-driver) and SQL (Prisma, Drizzle, Kysely, Supabase, TypeORM, Sequelize, pg/mysql2/knex raw, Django ORM, SQLAlchemy, DB-API cursors, GORM/xorm, `database/sql`, Spring Data JPA, Hibernate, JDBC/JdbcTemplate, jOOQ, ActiveRecord, Sequel, Laravel Eloquent/Query Builder, Doctrine, PDO/mysqli). MongoDB also via the Java driver, Spring Data MongoDB, Mongoid and the MongoDB PHP library.
- **Live evidence (optional).** Point `--uri` at a MongoDB or Postgres replica to confirm full scans, missing and unused indexes, and slow queries.
- **CI-ready.** [GitHub Action](#github-action) with PR comments, `--fail-on`, baselines, `--diff`, SARIF for GitHub code scanning, HTML report.
- **In your editor.** [ESLint plugin](#eslint-plugin) for JS/TS, and an [MCP server](#ai-assistants-mcp-server) so AI assistants can fix and verify queries.

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
npx querydig --fix                          # apply safe automatic fixes (see Auto-fix)
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
| QD004 | high | SQL | Lazy-loaded relation in a loop (`b.author.name` without `select_related` / `includes` / `with()` / `JOIN FETCH`): Django, SQLAlchemy, Rails, Laravel, JPA |
| QD005 | high | any | `new PrismaClient()` / `MongoClient` / `Pool` / `Sequelize` / `DataSource` created inside a handler: a new connection pool per call |
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
| SQ001 | high | SQL | `findMany()` / `findAll()` / `objects.all()` / `db.Find()` / `db.select().from(t)` / `supabase.from(t).select()` with no where/limit |
| SQ002 | low | SQL | `SELECT *` |
| SQ003 | high | SQL | `LIKE '%term'` |
| SQ004 | high/medium | SQL | `UPDATE`/`DELETE` without `WHERE`, `SELECT` without `WHERE`/`LIMIT` |
| SQ005 | medium | SQL | `OFFSET` pagination |
| SQ006 | medium | SQL | `WHERE LOWER(col) = …` (non-sargable) |
| SQ007 | high | SQL | `ORDER BY RAND()` |
| SQ008 | medium | SQL | `NOT IN (SELECT …)` |
| SQ009 | low | SQL | `count()` used only as an existence check (use `exists()` / `exists?` / `existsBy…`) |
| SQ010 | medium | SQL | Whole table loaded to iterate (`User.all.each`, `foreach (User::all() …)`, `for (… : repo.findAll())`) |
| SQ011 | medium | SQL | `include` (Prisma) / `with` (Drizzle) nested 3+ levels deep on a list query |

Built-in noise control: `while`/`for {}` polling loops, batching loops (`skip`/`offset` in the loop), loops over collections or model classes, and array helpers like `arr.find(x => …)` or Python `str.find()` are not flagged.

## ESLint plugin

See findings in your editor as you type, and in any `eslint` CI run (JS/TS only; the CLI covers every language).

```bash
npm i -D querydig
```

```js
// eslint.config.js (ESLint 9+)
import querydig from 'querydig/eslint';

export default [
  querydig.configs.recommended,
  // optional:
  { rules: { 'querydig/no-slow-queries': ['error', { minSeverity: 'high', disable: ['MQ010'] }] } },
];
```

Options: `minSeverity`, `disable` (rule ids), `includeTests` (tests, fixtures, migrations and seeds are skipped by default) and `useConfigFile` (default `true`: rule overrides and `ignore` from `querydig.config.json` apply). `eslint --fix` applies the same safe fixes as `querydig --fix`.

## AI assistants (MCP server)

`querydig mcp` starts a [Model Context Protocol](https://modelcontextprotocol.io) server, so Claude Code, Claude Desktop, Cursor, VS Code and other MCP clients can find slow queries, rewrite them and check their own fixes. querydig does the detection and verification; the assistant does the rewrite. No API key is needed and your code stays local.

[![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_querydig-0098FF?logo=visualstudiocode&logoColor=white)](https://insiders.vscode.dev/redirect/mcp/install?name=querydig&config=%7B%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22querydig%22%2C%22mcp%22%5D%7D)
[![Install in Cursor](https://img.shields.io/badge/Cursor-Install_querydig-000000?logo=cursor&logoColor=white)](https://cursor.com/en/install-mcp?name=querydig&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsInF1ZXJ5ZGlnIiwibWNwIl19)

```bash
claude mcp add querydig -- npx -y querydig mcp
```

querydig is also listed in the [MCP Registry](https://registry.modelcontextprotocol.io) as `io.github.milankatira/querydig`.

Or in any client's MCP config:

```json
{
  "mcpServers": {
    "querydig": {
      "command": "npx",
      "args": ["-y", "querydig", "mcp"],
      "env": { "QUERYDIG_DB_URI": "postgres://reader:***@replica-host/shop" }
    }
  }
}
```

`QUERYDIG_DB_URI` is optional. Set it to give the assistant live evidence (row counts, query plans, slow queries, missing indexes) without putting the secret in the chat.

| Tool | What it does |
|---|---|
| `scan_queries` | Scan a project (or just `files`, to verify an edit) and return findings by severity |
| `get_finding_context` | Code around a finding with line numbers, nearby findings and the rule's before/after example |
| `analyze_snippet` | Check a proposed rewrite before it is written to disk |
| `apply_safe_fixes` | Mechanical fixes like `--fix`; dry run unless `dryRun: false` |
| `suggest_indexes` | Read-only index plan from live query plans (needs a database) |
| `explain_rule`, `list_rules` | Rule docs |

The `optimize_queries` prompt runs the whole loop: scan → safe fixes → rewrite the worst findings one by one → verify each with querydig → summary table. In Claude Code, type `/mcp__querydig__optimize_queries`.

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

| Rule | Language / library | Before → after |
|---|---|---|
| MQ011 | Mongoose | `Model.find(f)` → `Model.find(f).lean()` (skipped in files that `.save()`, `.toObject()`, `.markModified()`… documents) |
| MQ008 | Mongoose / Node driver / PyMongo / Go driver | `countDocuments(f) > 0` → `countDocuments(f).limit(1)` / `(f, { limit: 1 })` / `(f, limit=1)` / `options.Count().SetLimit(1)` (Go: only if `options` is already imported) |
| SQ009 | Django | `qs.count() > 0` → `qs.exists()`, `qs.count() == 0` → `not qs.exists()` |
| SQ009 | Rails | `rel.count > 0` / `.present?` → `rel.exists?`, `rel.count == 0` / `.zero?` → `!rel.exists?` |
| SQ009 | Laravel | `->count() > 0` → `->exists()`, `->count() === 0` / `->get()->isEmpty()` → `->doesntExist()` |
| SQ009 | Spring Data | `repo.countByX(..) > 0` → `repo.existsByX(..)` (only when `existsByX` is already declared) |
| SQ010 | Rails | `Model.all.each do \|x\|` → `Model.find_each do \|x\|` (only without `order`/`limit`/`select`…, result unused) |
| SQ010 | Laravel | `foreach (Model::all() as $m)` → `foreach (Model::lazy() as $m)` |

A fix is only applied when the rewrite keeps the same behaviour: count fixes only fire when the result is compared with 0 (not `> 1` or stored), and are skipped on grouped, limited or combined queries. querydig never rewrites N+1 loops, adds result limits or changes projections on its own. Each of those findings comes with a fix to apply by hand, or with an AI assistant.

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

### GitHub Action

```yaml
name: querydig
on: [pull_request]
jobs:
  querydig:
    runs-on: ubuntu-latest
    permissions: { contents: read, security-events: write, pull-requests: write }
    steps:
      - uses: actions/checkout@v7
      - uses: milankatira/querydig@v0
        with:
          fail-on: high          # critical | high | medium | low | none
```

On pull requests it scans only the changed files (vs the base branch), annotates the diff, posts one PR comment with the report (updated on every push), uploads findings to code scanning and fails on `fail-on`. Code scanning on private repos needs GitHub Advanced Security; without it the upload is skipped and everything else still works.

| Input | Default | |
|---|---|---|
| `path` | `.` | Project root to scan |
| `fail-on` | `high` | Fail the job at or above this severity (`none` = never) |
| `min-severity` | `low` | Hide findings below this severity |
| `diff` | `auto` | `auto` = PR base branch on pull requests, `''` = full scan, or any git ref |
| `baseline` | | Baseline file; only new findings count |
| `sarif` | `true` | Upload to GitHub code scanning (needs `security-events: write`) |
| `summary` | `true` | Markdown report in the job summary |
| `comment` | `true` | PR comment with the report (needs `pull-requests: write`); only posted when there are findings, then kept up to date |
| `uri` | | Read-only DB URI for live evidence, from a secret: `${{ secrets.QUERYDIG_DB_URI }}` |
| `version` | `latest` | querydig version from npm |
| `args` | | Extra CLI arguments |

Outputs: `total`, `critical`, `high`, `grade`, `score`, `sarif-file`.

**Without the action** (plain workflow, with code-scanning annotations):

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

**Any CI**

```bash
npx -y querydig --baseline .querydig-baseline.json --fail-on high
```

### Pre-commit hooks

[pre-commit](https://pre-commit.com) (`.pre-commit-config.yaml`), checks files changed since `HEAD`:

```yaml
repos:
  - repo: https://github.com/milankatira/querydig
    rev: v0.5.0
    hooks:
      - id: querydig
```

Husky (`.husky/pre-commit`) or lefthook (`lefthook.yml`):

```bash
npx -y querydig --diff HEAD --fail-on high
```

```yaml
pre-commit:
  commands:
    querydig:
      run: npx -y querydig --diff HEAD --fail-on high
```

More templates in [`examples/ci`](examples/ci).

## How querydig compares

| | How it works | Languages / ORMs | N+1 | MongoDB | Live DB evidence | Auto-fix | MCP |
|---|---|---|---|---|---|---|---|
| **querydig** | Static, no app or DB needed (DB optional) | JS/TS, Python, Go, Java, Ruby, PHP; 20+ ORMs and drivers | ✅ incl. N² | ✅ | ✅ Mongo, Postgres | ✅ | ✅ |
| [Bullet](https://github.com/flyerhzm/bullet) | Runtime, while the app or tests run | Rails (ActiveRecord, Mongoid) | ✅ | ✅ | | | |
| [nplusone](https://github.com/jmcarp/nplusone) | Runtime | Django, SQLAlchemy | ✅ | | | | |
| [EagerEye](https://rubygems.org/gems/eager_eye) | Static | Rails | ✅ | | | | |
| [valk-guard](https://github.com/valkdb/valk-guard) | Static | Postgres: raw SQL, Go, SQLAlchemy, EF Core | | | | | |
| [squawk](https://github.com/sbdchd/squawk) | Static | Postgres migrations (schema safety) | | | | | |
| [sqlfluff](https://github.com/sqlfluff/sqlfluff) | Static | `.sql` files (style and lint) | | | | ✅ | |

Runtime detectors and querydig work well together: querydig catches patterns at PR time across the whole codebase, and runtime tools confirm them on the code paths your tests exercise.

## Programmatic API

```ts
import { scan, renderHtml } from 'querydig';
const summary = await scan({ root: '.', minSeverity: 'medium' });
console.log(summary.bySeverity, summary.grade);
```

## Roadmap

- Live mode for MySQL (`performance_schema` + `EXPLAIN`).
- Repo-wide index recommendations and PR comments.
- Kotlin and C#.
- Test-runner mode (Vitest/Jest) to confirm static findings at runtime.
- Incremental cache.

## License

MIT
