import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { analyzeSource, analyzeSourceFull } from '../src/analyzer.js';
import { applyFixes } from '../src/fix.js';
import { langForFile } from '../src/languages.js';
import { scan } from '../src/scan.js';

const run = async (src: string) => analyzeSource(src, { relPath: 'x.php', lang: 'php' });
const ids = async (src: string) => (await run(src)).map((f) => f.ruleId).sort();

const LARAVEL = '<?php\nuse App\\Models\\User;\nuse Illuminate\\Support\\Facades\\DB;\n';
const DOCTRINE = '<?php\nuse Doctrine\\ORM\\EntityManagerInterface;\n';
const PDO = '<?php\n$pdo = new PDO($dsn);\n';
const MONGO = '<?php\nuse MongoDB\\Client;\n';

describe('PHP — registration', () => {
  it('maps .php files to the php plugin', () => {
    expect(langForFile('app/Http/Controllers/UserController.php')).toBe('php');
  });
});

describe('PHP — Laravel N+1', () => {
  it('flags a relation query per row of a query result (QD002)', async () => {
    const f = await run(LARAVEL + `
      $users = User::where('active', 1)->get();
      foreach ($users as $u) { $u->orders()->where('status', 'paid')->get(); }`);
    const q = f.find((x) => x.ruleId === 'QD002');
    expect(q?.severity).toBe('critical');
    expect(q?.db).toBe('sql');
    expect(q?.fix).toContain("with('orders')");
  });

  it('flags queries when iterating a query directly', async () => {
    expect(await ids(LARAVEL + 'foreach (User::where("a", 1)->get() as $u) { $u->posts()->count(); }')).toContain('QD002');
  });

  it('flags static finds inside loops over plain arrays (QD001)', async () => {
    const f = await run(LARAVEL + 'foreach ($ids as $id) { $u = User::find($id); }');
    expect(f.map((x) => x.ruleId)).toEqual(['QD001']);
  });

  it('flags nested loops as critical and C-style for loops', async () => {
    const f = await run(LARAVEL + 'foreach ($a as $x) { foreach ($b as $y) { User::firstWhere("email", $y); } }');
    expect(f.find((x) => x.ruleId === 'QD001')?.severity).toBe('critical');
    expect(await ids(LARAVEL + 'for ($i = 0; $i < count($ids); $i++) { User::findOrFail($ids[$i]); }')).toContain('QD001');
  });

  it('flags writes and model saves inside loops (QD003)', async () => {
    expect(await ids(LARAVEL + 'foreach ($rows as $r) { User::create(["name" => $r]); }')).toContain('QD003');
    expect(await ids(LARAVEL + 'foreach ($users as $u) { $u->name = "x"; $u->save(); }')).toContain('QD003');
    expect(await ids(LARAVEL + 'foreach ($rows as $r) { DB::table("logs")->insert(["m" => $r]); }')).toContain('QD003');
    expect(await ids(LARAVEL + 'foreach ($rows as $r) { DB::insert("INSERT INTO logs (m) VALUES (?)", [$r]); }')).toContain('QD003');
  });

  it('flags lazy loading through load() in a loop', async () => {
    expect(await ids(LARAVEL + 'foreach ($posts as $p) { $p->load("comments"); }')).toContain('QD001');
  });

  it('treats collection callbacks as loops', async () => {
    expect(await ids(LARAVEL + 'collect($ids)->map(fn ($id) => User::find($id));')).toContain('QD001');
    expect(await ids(LARAVEL + '$users = User::where("a", 1)->get();\n$users->each(function ($u) { $u->orders()->get(); });')).toContain('QD002');
    expect(await ids(LARAVEL + 'User::where("a", 1)->each(function ($u) { $u->roles()->get(); });')).toContain('QD002');
    expect(await ids(LARAVEL + 'array_map(fn ($id) => User::find($id), $ids);')).toContain('QD001');
  });

  it('does not treat chunk callbacks as per-row loops, but rows inside a chunk are query results', async () => {
    expect(await ids(LARAVEL + 'User::where("a", 1)->chunk(100, function ($users) { DB::table("audit")->insert(["n" => 1]); });')).toEqual([]);
    expect(await ids(LARAVEL + 'User::where("a", 1)->chunk(100, function ($users) { foreach ($users as $u) { $u->orders()->get(); } });')).toContain('QD002');
  });

  it('ignores polling while loops and for(;;)', async () => {
    expect(await ids(LARAVEL + 'while (true) { $job = Job::where("s", 1)->first(); }')).toEqual([]);
    expect(await ids(LARAVEL + 'for (;;) { User::find(1); }')).toEqual([]);
  });

  it('respects suppressions', async () => {
    expect(await ids(LARAVEL + 'foreach ($ids as $id) {\n  User::find($id); // querydig-ignore QD001\n}')).toEqual([]);
  });
});

describe('PHP — Laravel unbounded reads (SQ001 / SQ010)', () => {
  it('flags Model::all() and unfiltered get()', async () => {
    expect(await ids(LARAVEL + '$users = User::all();')).toEqual(['SQ001']);
    expect(await ids(LARAVEL + '$users = User::orderBy("name")->get();')).toEqual(['SQ001']);
    expect(await ids(LARAVEL + '$rows = DB::table("users")->get();')).toEqual(['SQ001']);
  });

  it('does not flag filtered, limited, paginated, scoped or relation reads', async () => {
    expect(await ids(LARAVEL + '$u = User::where("a", 1)->get();')).toEqual([]);
    expect(await ids(LARAVEL + '$u = User::latest()->limit(10)->get();')).toEqual([]);
    expect(await ids(LARAVEL + '$u = User::paginate(20);')).toEqual([]);
    expect(await ids(LARAVEL + '$u = User::active()->get();')).toEqual([]);
    expect(await ids(LARAVEL + '$o = $user->orders()->get();')).toEqual([]);
    expect(await ids(LARAVEL + 'User::lazy()->each(fn ($u) => notify($u));')).toEqual([]);
    expect(await ids(LARAVEL + 'foreach (User::cursor() as $u) { notify($u); }')).toEqual([]);
  });

  it('flags iterating the whole table (SQ010) instead of SQ001', async () => {
    expect(await ids(LARAVEL + 'foreach (User::all() as $u) { notify($u); }')).toEqual(['SQ010']);
    expect(await ids(LARAVEL + 'User::all()->each(function ($u) { notify($u); });')).toEqual(['SQ010']);
    const f = await run(LARAVEL + '$users = User::all();\nforeach ($users as $u) { notify($u); }');
    expect(f.map((x) => x.ruleId).sort()).toEqual(['SQ001', 'SQ010']);
  });

  it('offers the lazy() autofix only when it is mechanical', async () => {
    const direct = (await run(LARAVEL + 'foreach (User::all() as $u) { notify($u); }')).find((x) => x.ruleId === 'SQ010');
    expect(direct?.autofix?.insert).toBe('lazy');
    const each = (await run(LARAVEL + 'User::all()->each(fn ($u) => notify($u));')).find((x) => x.ruleId === 'SQ010');
    expect(each?.autofix).toBeUndefined();
    const byRef = (await run(LARAVEL + 'foreach (User::all() as &$u) { $u->x = 1; }')).find((x) => x.ruleId === 'SQ010');
    expect(byRef?.autofix).toBeUndefined();
    const reused = (await run(LARAVEL + 'function f() { $users = User::all();\nforeach ($users as $u) { notify($u); }\nreturn $users->count(); }')).find((x) => x.ruleId === 'SQ010');
    expect(reused?.autofix).toBeUndefined();
  });
});

describe('PHP — COUNT as existence check (SQ009)', () => {
  it('flags count() compared with 0 and boolean uses', async () => {
    expect(await ids(LARAVEL + 'if (User::where("a", 1)->count() > 0) {}')).toEqual(['SQ009']);
    expect(await ids(LARAVEL + 'if ($user->posts()->count() === 0) {}')).toEqual(['SQ009']);
    expect(await ids(LARAVEL + 'if (!User::where("a", 1)->count()) {}')).toEqual(['SQ009']);
    expect(await ids(LARAVEL + '$has = User::where("a", 1)->get()->isNotEmpty();')).toEqual(['SQ009']);
    expect(await ids(LARAVEL + '$n = User::where("a", 1)->get()->count();')).toEqual(['SQ009']);
    expect(await ids(LARAVEL + 'if (count(User::where("a", 1)->get()) > 0) {}')).toEqual(['SQ009']);
  });

  it('builds mechanical rewrites', async () => {
    const fix = async (src: string) => {
      const f = (await run(LARAVEL + src)).find((x) => x.ruleId === 'SQ009')!;
      const s = LARAVEL + src;
      const a = f.autofix!;
      return s.slice(0, a.offset) + a.insert + s.slice(a.offset + (a.deleteLength ?? 0));
    };
    expect(await fix('if (User::where("a", 1)->count() > 0) {}')).toContain('if (User::where("a", 1)->exists()) {}');
    expect(await fix('if (User::where("a", 1)->count() == 0) {}')).toContain('if (User::where("a", 1)->doesntExist()) {}');
    expect(await fix('if (0 < $u->posts()->count()) {}')).toContain('if ($u->posts()->exists()) {}');
    expect(await fix('if ($u->posts()->count()) {}')).toContain('if ($u->posts()->exists()) {}');
    expect(await fix('$e = User::where("a", 1)->get()->isEmpty();')).toContain('$e = User::where("a", 1)->doesntExist();');
    expect(await fix('$e = User::where("a", 1)->get()->isNotEmpty();')).toContain('$e = User::where("a", 1)->exists();');
    expect(await fix('$n = User::where("a", 1)->get()->count();')).toContain('$n = User::where("a", 1)->count();');
    expect(await fix('if (count(User::where("a", 1)->get()) === 0) {}')).toContain('if (User::where("a", 1)->doesntExist()) {}');
  });

  it('does not autofix when limit/groupBy change the meaning', async () => {
    const f = (await run(LARAVEL + '$n = User::where("a", 1)->limit(5)->get()->count();')).find((x) => x.ruleId === 'SQ009');
    expect(f).toBeDefined();
    expect(f?.autofix).toBeUndefined();
  });

  it('does not flag counts that are real numbers or non-query objects', async () => {
    expect(await ids(LARAVEL + '$n = User::where("a", 1)->count();')).toEqual([]);
    expect(await ids(LARAVEL + 'if (User::where("a", 1)->count() > 5) {}')).toEqual([]);
    expect(await ids(LARAVEL + 'if ($cart->count() > 0) {}')).toEqual([]);
    expect(await ids(LARAVEL + 'if ($collection->count() > 0) {}')).toEqual([]);
    expect(await ids(LARAVEL + 'if (count($items) > 0) {}')).toEqual([]);
    expect(await ids(LARAVEL + 'if (Collection::make($a)->count() > 0) {}')).toEqual([]);
    expect(await ids(LARAVEL + 'if ($users->isEmpty()) {}')).toEqual([]);
  });
});

describe('PHP — false-positive guards', () => {
  it('ignores request/cache/config getters, facades and array helpers in loops', async () => {
    const src = LARAVEL + `foreach ($items as $i) {
      $a = $request->get('x');
      $b = $cache->get('k');
      $c = $config->get('app.name');
      $d = Cache::get('k');
      $e = Config::get('x');
      $f = array_filter($i, fn ($x) => $x > 1);
      $g = str_contains($i, 'a');
      $h = Collection::make($i)->count();
      $j = Arr::first($i);
      $k = count($i);
      $l = $i->count();
      $m = Route::get('/x', fn () => 1);
      $n = Carbon::create(2020, 1, 1);
      $o = $session->get('cart');
    }`;
    expect(await ids(src)).toEqual([]);
  });

  it('does not classify model-looking calls without any Laravel hint', async () => {
    expect(await ids('<?php\nforeach ($ids as $id) { Thing::find($id); }')).toEqual([]);
  });
});

describe('PHP — Doctrine', () => {
  it('flags repository / EntityManager reads in loops and flush in loops', async () => {
    expect(await ids(DOCTRINE + 'foreach ($ids as $id) { $this->userRepository->find($id); }')).toContain('QD001');
    expect(await ids(DOCTRINE + 'foreach ($ids as $id) { $em->find(User::class, $id); }')).toContain('QD001');
    expect(await ids(DOCTRINE + 'foreach ($users as $u) { $em->persist($u); $em->flush(); }')).toEqual(['QD003']);
    expect(await ids(DOCTRINE + 'foreach ($users as $u) { $em->persist($u); }\n$em->flush();')).toEqual([]);
  });

  it('flags findAll() and DQL executed per row', async () => {
    expect(await ids(DOCTRINE + '$all = $repo->findAll();')).toEqual(['SQ001']);
    const f = await run(DOCTRINE + `$users = $repo->findBy(['active' => true]);
      foreach ($users as $u) { $em->createQuery('SELECT o FROM App\\\\Entity\\\\Order o WHERE o.user = :u')->setParameter('u', $u)->getResult(); }`);
    const q = f.find((x) => x.ruleId === 'QD002');
    expect(q).toBeDefined();
    expect(q?.fix).toContain('JOIN FETCH');
  });

  it('flags COUNT-as-existence on repositories', async () => {
    expect(await ids(DOCTRINE + 'if ($repo->count(["email" => $e]) > 0) {}')).toEqual(['SQ009']);
  });
});

describe('PHP — PDO / mysqli', () => {
  it('flags raw queries in loops', async () => {
    expect(await ids(PDO + 'foreach ($ids as $id) { $pdo->query("SELECT name FROM users WHERE id = $id"); }')).toContain('QD001');
    expect(await ids(PDO + 'foreach ($ids as $id) { mysqli_query($conn, "SELECT name FROM users WHERE id = " . $id); }')).toContain('QD001');
    expect(await ids(PDO + 'foreach ($ids as $id) { $mysqli->query($sql); }')).toContain('QD001');
  });

  it('flags prepared statements executed per row and classifies writes', async () => {
    const f = await run(PDO + `$stmt = $pdo->prepare('INSERT INTO logs (m) VALUES (?)');
      foreach ($rows as $r) { $stmt->execute([$r]); }`);
    expect(f.map((x) => x.ruleId)).toContain('QD003');
    const g = await run(PDO + `$stmt = $pdo->prepare('SELECT name FROM users WHERE id = ?');
      $rows = $pdo->query('SELECT id FROM users WHERE active = 1')->fetchAll();
      foreach ($rows as $r) { $stmt->execute([$r['id']]); }`);
    expect(g.map((x) => x.ruleId)).toContain('QD002');
  });

  it('ignores non-database query()/execute() calls', async () => {
    expect(await ids(PDO + 'foreach ($a as $x) { $request->query("page"); $command->execute(); $http->get("/x"); }')).toEqual([]);
  });
});

describe('PHP — raw SQL strings', () => {
  it('applies SQ002–SQ008 to PHP string literals', async () => {
    expect(await ids("<?php\n$sql = 'SELECT * FROM users WHERE id = ?';")).toEqual(['SQ002']);
    expect(await ids('<?php\n$sql = "SELECT id FROM users WHERE name LIKE \'%a\'";')).toEqual(['SQ003']);
    expect(await ids('<?php\n$sql = "DELETE FROM users";')).toEqual(['SQ004']);
    expect(await ids('<?php\n$sql = "SELECT id FROM users ORDER BY RAND() LIMIT 1";')).toEqual(['SQ007']);
    expect(await ids("<?php\n$sql = <<<SQL\nSELECT id FROM users WHERE id NOT IN (SELECT user_id FROM bans)\nSQL;\n")).toEqual(['SQ008']);
    expect(await ids("<?php\n$sql = <<<'SQL'\nSELECT id FROM users WHERE LOWER(email) = ?\nSQL;\n")).toEqual(['SQ006']);
  });

  it('treats interpolated strings as dynamic', async () => {
    expect(await ids('<?php\n$sql = "SELECT id FROM users {$where}";')).toEqual([]);
    expect(await ids('<?php\n$sql = "UPDATE users SET a = 1 $where";')).toEqual([]);
  });

  it('records a live-mode shape for static SQL', async () => {
    const r = await analyzeSourceFull("<?php\n$r = DB::select('SELECT id FROM orders WHERE status = ? ORDER BY created_at DESC');", { relPath: 'x.php', lang: 'php' });
    const sh = r.shapes.find((s) => s.sql);
    expect(sh?.collection).toBe('orders');
    expect(sh?.filterKeys).toEqual(['status']);
  });

  it('ignores prose that starts with an SQL keyword', async () => {
    expect(await ids("<?php\n$msg = 'Select a user from the list';\n$k = 'update';")).toEqual([]);
  });
});

describe('PHP — live-mode shapes', () => {
  it('extracts table, filter and sort keys from Eloquent chains', async () => {
    const r = await analyzeSourceFull(LARAVEL + "$o = User::where('status', 'active')->where(['team_id' => 1])->orderBy('created_at', 'desc')->get();", { relPath: 'x.php', lang: 'php' });
    const sh = r.shapes[0];
    expect(sh.collection).toBe('users');
    expect(sh.filterKeys).toEqual(['status', 'team_id']);
    expect(sh.sortKeys).toEqual([{ key: 'created_at', dir: -1 }]);
  });
});

describe('PHP — MongoDB', () => {
  it('flags finds in loops and empty filters', async () => {
    expect(await ids(MONGO + 'foreach ($ids as $id) { $collection->findOne(["_id" => $id]); }')).toContain('QD001');
    expect(await ids(MONGO + '$all = $collection->find([]);')).toContain('MQ001');
  });
});

function project(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), 'querydig-php-'));
  for (const [f, c] of Object.entries(files)) writeFileSync(join(dir, f), c);
  return dir;
}

describe('PHP — --fix', () => {
  it('rewrites count()/get() existence checks and foreach over all(), idempotently', async () => {
    const src = LARAVEL + `class C {
  public function a($user) {
    if (User::where('active', 1)->count() > 0) { return 1; }
    if ($user->posts()->count() === 0) { return 2; }
    $empty = User::where('x', 2)->get()->isEmpty();
    foreach (User::all() as $u) { notify($u); }
    $n = count($rows);
    return $empty;
  }
}
`;
    const root = project({ 'C.php': src });
    const s = await scan({ root, threads: 1 });
    const res = applyFixes(root, s.findings);
    expect(res.changes).toHaveLength(4);
    const out = readFileSync(join(root, 'C.php'), 'utf8');
    expect(out).toContain("if (User::where('active', 1)->exists()) { return 1; }");
    expect(out).toContain('if ($user->posts()->doesntExist()) { return 2; }');
    expect(out).toContain("$empty = User::where('x', 2)->doesntExist();");
    expect(out).toContain('foreach (User::lazy() as $u) { notify($u); }');
    expect(out).toContain('$n = count($rows);');

    const again = await scan({ root, threads: 1 });
    expect(again.findings.filter((f) => f.ruleId === 'SQ009' || f.ruleId === 'SQ010')).toHaveLength(0);
  });

  it('rewrites an all() variable only used by one foreach', async () => {
    // note: `count` keeps the file past fileAnalyzer's QUICK_FILTER, which does not know Eloquent verbs like all()/get()
    const src = LARAVEL + 'function f($rows) {\n  $users = User::all();\n  foreach ($users as $u) { notify($u); }\n  return count($rows);\n}\n';
    const root = project({ 'F.php': src });
    const s = await scan({ root, threads: 1 });
    applyFixes(root, s.findings);
    expect(readFileSync(join(root, 'F.php'), 'utf8')).toContain('$users = User::lazy();');
  });
});
