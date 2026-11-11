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

- **Live mode** (`--uri`, read-only): MongoDB profiler + `explain()` (COLLSCAN, docs-examined ratio, in-memory SORT), missing/unused indexes; Postgres `pg_stat_statements` + `EXPLAIN`; MySQL `performance_schema`. Live evidence will be merged with static findings to promote severity.
- Java/Kotlin (Hibernate/Spring Data), Ruby (ActiveRecord), PHP (Eloquent).
- An official GitHub Action and incremental cache.

## License

MIT
