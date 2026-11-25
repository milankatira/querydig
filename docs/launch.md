# Launch kit

Drafts and a checklist for announcing querydig. Post them yourself, one channel per day, all pointing at the GitHub repo.

## Before launch

- [ ] Release a new version with `mcpName` in package.json (tag `vX.Y.Z`). The release workflow publishes to npm, then to the MCP Registry, then moves the `v0` tag for the GitHub Action.
- [ ] Check the server is listed: `curl "https://registry.modelcontextprotocol.io/v0/servers?search=querydig"`.
- [ ] Publish the Action to the GitHub Marketplace: open the release on GitHub → "Publish this Action to the GitHub Marketplace" (needs 2FA and accepting the Marketplace agreement once). Category: Code quality.
- [ ] Record a 20-second terminal GIF (e.g. with [vhs](https://github.com/charmbracelet/vhs)) of `npx querydig` on the sample app and put it at the top of the README.
- [ ] Run querydig on 2–3 popular open-source apps. Write down real findings, and send a PR fixing one. That result is the hook for every post below.
- [ ] Mention the ESLint plugin (`querydig/eslint`) and the PR comment in every post: they are the easiest ways to adopt it.
- [ ] Submit to MCP directories: mcp.so, Smithery, PulseMCP, Glama (they mostly read the MCP Registry or a GitHub URL).

## Show HN

**Title:** Show HN: Querydig – find N+1 and slow DB queries in your code, no database needed

> I kept shipping N+1 queries that looked fine in review and only showed up as slow pages in production. Existing detectors (Bullet, nplusone) catch them at runtime, for one framework, on the code paths your tests happen to hit.
>
> querydig is a static analyzer: `npx querydig` parses your code with tree-sitter and flags queries inside loops, queries over another query's results (N²), writes in loops, unbounded reads, unanchored regexes, OFFSET pagination and 20+ more patterns. It works across JS/TS, Python, Go, Java, Ruby and PHP, with Prisma, TypeORM, Sequelize, Mongoose, Django, SQLAlchemy, GORM, Spring Data, Hibernate, ActiveRecord, Laravel and Doctrine.
>
> Optionally, point it at a read-only replica and it checks findings against real query plans (it plans, never executes): "this N+1 does a full scan of 4.2M rows on every iteration, add this index".
>
> It also runs as a GitHub Action (PR-only scans, SARIF) and as an MCP server, so Claude Code, Cursor or Copilot can find a slow query, rewrite it, and have querydig verify the rewrite.
>
> On [popular repo X] it found [N] N+1s, including [one concrete example]. MIT, runs locally, no account. Feedback on false positives very welcome.

Stay on the thread for the first few hours and answer every question, especially about false positives.

## Reddit

Post as a person, not an ad: lead with the problem and a real example from that ecosystem. Read each subreddit's self-promotion rules first.

| Subreddit | Angle |
|---|---|
| r/node, r/javascript | Prisma/TypeORM/Mongoose N+1 caught in a PR, with the GitHub Action |
| r/django, r/Python | Django ORM `for a in Author.objects.all(): a.books.all()` caught statically, plus the `count() > 0` → `exists()` auto-fix |
| r/rails, r/ruby | "Bullet at runtime + querydig at PR time": `User.all.each` → `find_each` auto-fix |
| r/laravel, r/PHP | Eloquent N+1 and `foreach (Model::all())` → `lazy()` |
| r/golang | GORM / `database/sql` queries in loops |
| r/mongodb | Unanchored `$regex`, `skip()` pagination, live COLLSCAN evidence |
| r/ClaudeAI, r/cursor | MCP loop: scan → AI rewrite → querydig verifies |

## Newsletters

Send a short pitch to JavaScript Weekly / Node Weekly (Cooperpress), Console.dev, TLDR (Web Dev), Python Weekly, Ruby Weekly, Golang Weekly:

> querydig (MIT) is a zero-config CLI that statically finds N+1 and slow MongoDB/SQL queries in JS/TS, Python, Go, Java, Ruby and PHP, with optional read-only query-plan evidence, a GitHub Action and an MCP server for AI assistants. `npx querydig`. https://github.com/milankatira/querydig

## Product Hunt

- **Tagline:** Catch N+1 and slow database queries before they ship
- **Topics:** Developer Tools, Open Source, GitHub, Artificial Intelligence
- **First comment:** the Show HN text, shortened, plus the GIF.

## Blog posts (one per ecosystem)

1. "Finding N+1 queries in a Prisma/Next.js app in 30 seconds"
2. "Bullet vs static analysis: catching Rails N+1s before review"
3. "Let Claude Code fix your slow queries and verify every rewrite" (MCP)
4. "What `EXPLAIN` says about your N+1: live evidence from a Postgres replica"

Cross-post to dev.to and Hashnode, with a canonical link to the original.
