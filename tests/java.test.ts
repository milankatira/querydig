import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { analyzeSource, analyzeSourceFull } from '../src/analyzer.js';
import { applyFixes } from '../src/fix.js';
import { langForFile } from '../src/languages.js';
import { scan } from '../src/scan.js';

const JPA = 'import org.springframework.data.jpa.repository.JpaRepository;\n';
const MONGO = 'import com.mongodb.client.MongoCollection;\nimport org.springframework.data.mongodb.core.MongoTemplate;\n';
const SPRING_MONGO = 'import org.springframework.data.mongodb.repository.MongoRepository;\n';

/** wrap statements in a class + method */
const m = (body: string, header = JPA) => `${header}class S {\n  void run(List<Long> ids) {\n${body}\n  }\n}\n`;
const run = (src: string) => analyzeSource(src, { relPath: 'S.java', lang: 'java' });
const ids = async (src: string) => (await run(src)).map((f) => f.ruleId).sort();

describe('Java — language wiring', () => {
  it('maps .java files to the java plugin', () => {
    expect(langForFile('src/main/java/com/x/OrderService.java')).toBe('java');
  });
});

describe('Java — N+1 (Spring Data / JPA / Hibernate / JDBC)', () => {
  it('flags a derived-query repository call in an enhanced for', async () => {
    const f = await run(m('for (Long id : ids) { userRepository.findById(id); }'));
    const q = f.find((x) => x.ruleId === 'QD001');
    expect(q?.severity).toBe('high');
    expect(q?.db).toBe('sql');
    expect(q?.fix).toMatch(/findAllById|JOIN FETCH|@EntityGraph/);
  });

  it('flags queries per row of another query (QD002), for variables and inline calls', async () => {
    const viaVar = await run(m(`List<User> users = this.userRepository.findByStatus("A");
    for (User u : users) { orderRepository.findAllByUserId(u.getId()); }`));
    expect(viaVar.find((x) => x.ruleId === 'QD002')?.severity).toBe('critical');
    expect(await ids(m('for (User u : userRepo.findByActiveTrue()) { orderRepo.countByUserId(u.getId()); }'))).toContain('QD002');
  });

  it('flags queries inside forEach / stream lambdas and method references', async () => {
    expect(await ids(m('ids.forEach(id -> userRepository.findById(id));'))).toContain('QD001');
    expect(await ids(m('ids.stream().map(id -> repo.findById(id).orElseThrow()).toList();'))).toContain('QD001');
    expect(await ids(m('ids.stream().map(this.userRepository::findById).toList();'))).toContain('QD001');
    const nested = await run(m('for (Long a : ids) { for (Long b : ids) { em.find(User.class, b); } }'));
    expect(nested.find((x) => x.ruleId === 'QD001')?.severity).toBe('critical');
  });

  it('flags classic for loops but not polling while/do/for(;;)', async () => {
    expect(await ids(m('for (int i = 0; i < n; i++) { userRepository.findById((long) i); }'))).toContain('QD001');
    expect(await ids(m('while (running) { jobRepository.findFirstByStatus("NEW"); }'))).toEqual([]);
    expect(await ids(m('do { jobRepository.findFirstByStatus("NEW"); } while (more);'))).toEqual([]);
    expect(await ids(m('for (;;) { jobRepository.findFirstByStatus("NEW"); }'))).toEqual([]);
  });

  it('flags writes in loops (QD003) across repository, EntityManager, Hibernate and JDBC', async () => {
    expect(await ids(m('for (User u : users) { userRepository.save(u); }'))).toContain('QD003');
    expect(await ids(m('users.forEach(u -> em.persist(u));'))).toContain('QD003');
    expect(await ids(m('for (User u : users) { session.saveOrUpdate(u); }', 'import org.hibernate.Session;\n'))).toContain('QD003');
    expect(await ids(m('for (User u : users) { jdbcTemplate.update("UPDATE users SET a = 1 WHERE id = ?", u.getId()); }'))).toContain('QD003');
    const batch = await run(m('for (List<User> chunk : chunks) { userRepository.saveAll(chunk); }'));
    expect(batch.find((x) => x.ruleId === 'QD003')?.severity).toBe('medium');
  });

  it('flags raw JDBC / JPQL queries in loops and per-row queries over a ResultSet', async () => {
    expect(await ids(m('for (Long id : ids) { jdbcTemplate.queryForObject("SELECT name FROM users WHERE id = ?", String.class, id); }'))).toContain('QD001');
    expect(await ids(m('for (Long id : ids) { em.createQuery("select u from User u where u.id = :id").setParameter("id", id).getSingleResult(); }'))).toContain('QD001');
    expect(await ids(m('for (Long id : ids) { conn.prepareStatement(sql).executeQuery(); }', 'import java.sql.*;\n'))).toContain('QD001');
    const rs = await run(m(`ResultSet rs = stmt.executeQuery("SELECT id FROM users WHERE active");
    while (rs.next()) { orderRepository.findByUserId(rs.getLong(1)); }`, 'import java.sql.*;\n'));
    expect(rs.find((x) => x.ruleId === 'QD002')?.message).toContain('`rs`');
  });

  it('flags jOOQ queries in loops', async () => {
    expect(await ids(m('for (Long id : ids) { dsl.selectFrom(USERS).where(USERS.ID.eq(id)).fetchOne(); }', 'import org.jooq.DSLContext;\n'))).toContain('QD001');
  });
});

describe('Java — SQL ORM rules', () => {
  it('SQ001: findAll() / findAll(Sort) without a Pageable or Specification', async () => {
    expect(await ids(m('List<User> all = userRepository.findAll();'))).toContain('SQ001');
    expect(await ids(m('userRepository.findAll(Sort.by("name"));'))).toContain('SQ001');
    expect(await ids(m('userRepository.findAll(PageRequest.of(0, 20));'))).not.toContain('SQ001');
    expect(await ids(m('userRepository.findAll(spec);'))).not.toContain('SQ001');
    expect(await ids(m('userRepository.findAllById(ids);'))).not.toContain('SQ001');
    expect(await ids(m('dsl.selectFrom(USERS).fetch();', 'import org.jooq.DSLContext;\n'))).toContain('SQ001');
    expect(await ids(m('dsl.selectFrom(USERS).where(USERS.ACTIVE.isTrue()).fetch();', 'import org.jooq.DSLContext;\n'))).not.toContain('SQ001');
  });

  it('SQ010: iterating a whole-table findAll()', async () => {
    expect(await ids(m('for (User u : userRepository.findAll()) { mail(u); }'))).toContain('SQ010');
    expect(await ids(m('List<User> all = userRepository.findAll();\n    all.forEach(u -> mail(u));'))).toContain('SQ010');
    expect(await ids(m('List<User> all = userRepository.findAll();\n    all.stream().map(User::getEmail).toList();'))).toContain('SQ010');
    expect(await ids(m('for (User u : userRepository.findAll(PageRequest.of(0, 100))) { mail(u); }'))).not.toContain('SQ010');
  });

  it('SQ009: count compared with zero, with a safe autofix only when existsBy... is known', async () => {
    const decl = 'interface R { long countByEmail(String e); boolean existsByEmail(String e); }\n';
    const f = await run(decl + m('if (userRepository.countByEmail(e) > 0) { throw new X(); }\n    boolean none = userRepository.countByEmail(e) == 0;'));
    const sq = f.filter((x) => x.ruleId === 'SQ009');
    expect(sq).toHaveLength(2);
    expect(sq[0].autofix?.insert).toBe('userRepository.existsByEmail(e)');
    expect(sq[1].autofix?.insert).toBe('!userRepository.existsByEmail(e)');

    const noDecl = await run(m('if (userRepository.countByEmail(e) > 0) {}'));
    expect(noDecl.find((x) => x.ruleId === 'SQ009')?.autofix).toBeUndefined();
    expect(await ids(m('if (0 < repo.count()) {}'))).toContain('SQ009');
    expect(await ids(m('Integer n = jdbcTemplate.queryForObject("SELECT COUNT(*) FROM users WHERE email = ?", Integer.class, e);\n    if (jdbcTemplate.queryForObject("SELECT COUNT(*) FROM t WHERE a = ?", Integer.class, a) > 0) {}'))).toContain('SQ009');
    // real counts are fine
    expect(await ids(m('long n = userRepository.countByStatus("A");\n    if (userRepository.countByStatus("A") > 10) {}'))).not.toContain('SQ009');
  });

  it('SQ009 autofix applies via --fix', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'querydig-java-fix-'));
    const src = 'interface R { long countByEmail(String e); boolean existsByEmail(String e); }\n' + m('if (userRepository.countByEmail(e) > 0) { throw new X(); }');
    writeFileSync(join(dir, 'S.java'), src);
    const s = await scan({ root: dir, threads: 1 });
    applyFixes(dir, s.findings);
    const out = readFileSync(join(dir, 'S.java'), 'utf8');
    expect(out).toContain('if (userRepository.existsByEmail(e)) { throw new X(); }');
    expect((await scan({ root: dir, threads: 1 })).findings.filter((x) => x.ruleId === 'SQ009')).toHaveLength(0);
  });
});

describe('Java — raw SQL strings', () => {
  it('checks string literals, text blocks and @Query values', async () => {
    expect(await ids(m('String q = "SELECT * FROM users WHERE id = ?";'))).toContain('SQ002');
    expect(await ids(m('String q = """\n      SELECT id FROM users WHERE name LIKE \'%x\'\n      """;'))).toContain('SQ003');
    expect(await ids(m('jdbcTemplate.update("DELETE FROM sessions");'))).toContain('SQ004');
    expect(await ids(`${JPA}interface R { @Query(value = "SELECT * FROM users ORDER BY RAND() LIMIT 1", nativeQuery = true) User random(); }`)).toEqual(['SQ002', 'SQ007']);
    expect(await ids(`${JPA}interface R { @Query("select u from User u where lower(u.email) = ?1") User f(String e); }`)).toContain('SQ006');
    expect(await ids(m('String q = "SELECT id FROM a WHERE id NOT IN (SELECT a_id FROM b) LIMIT 10 OFFSET ?";'))).toEqual(['SQ005', 'SQ008']);
  });

  it('records SQL shapes for live mode', async () => {
    const r = await analyzeSourceFull(m('jdbcTemplate.query("SELECT id FROM orders WHERE user_id = ? ORDER BY created_at DESC", mapper, id);'), { relPath: 'S.java', lang: 'java' });
    expect(r.shapes.find((s) => s.sql)?.collection).toBe('orders');
    const d = await analyzeSourceFull(m('orderRepository.findByUserIdAndStatusIn(id, statuses);'), { relPath: 'S.java', lang: 'java' });
    expect(d.shapes[0].filterKeys).toEqual(['userId', 'status']);
  });
});

describe('Java — MongoDB (driver, MongoTemplate, MongoRepository)', () => {
  it('driver: unbounded find, regex, sort without limit, skip', async () => {
    expect(await ids(m('usersCollection.find().into(new ArrayList<>());', MONGO))).toContain('MQ001');
    expect(await ids(m('MongoCollection<Document> users = db.getCollection("users");\n    users.find(new Document()).into(list);', MONGO))).toContain('MQ001');
    expect(await ids(m('usersCollection.find().limit(10);', MONGO))).not.toContain('MQ001');
    expect(await ids(m('usersCollection.find(Filters.regex("name", "john")).limit(5);', MONGO))).toContain('MQ002');
    expect(await ids(m('usersCollection.find(Filters.regex("name", "^john")).limit(5);', MONGO))).not.toContain('MQ002');
    expect(await ids(m('usersCollection.find(Filters.eq("a", 1)).sort(Sorts.descending("createdAt"));', MONGO))).toContain('MQ005');
    expect(await ids(m('usersCollection.find(Filters.eq("a", 1)).skip(page * 20).limit(20);', MONGO))).toContain('MQ004');
    expect(await ids(m('if (ordersCollection.countDocuments(Filters.eq("u", id)) > 0) {}', MONGO))).toContain('MQ008');
  });

  it('driver + template: N+1 and writes in loops', async () => {
    const f = await run(m('for (String id : ids) { db.getCollection("orders").find(Filters.eq("userId", id)).first(); }', MONGO));
    const q = f.find((x) => x.ruleId === 'QD001');
    expect(q?.db).toBe('mongodb');
    expect(q?.fix).toContain('Filters.in("userId"');
    expect(await ids(m('for (User u : users) { mongoTemplate.save(u); }', MONGO))).toContain('QD003');
    expect(await ids(m('for (User u : users) { usersCollection.insertOne(u); }', MONGO))).toContain('QD003');
  });

  it('MongoTemplate / MongoRepository: findAll is a full collection read; no projection noise on template find', async () => {
    expect(await ids(m('mongoTemplate.findAll(User.class);', MONGO))).toContain('MQ001');
    expect(await ids(m('mongoTemplate.find(new Query(Criteria.where("status").is("A")), User.class);', MONGO))).toEqual([]);
    const repo = await run(m('userRepository.findAll();\n    if (userRepository.countByStatus("A") > 0) {}', SPRING_MONGO));
    expect(repo.map((x) => x.ruleId).sort()).toEqual(['MQ001', 'MQ008']);
    expect(repo.every((x) => x.db === 'mongodb')).toBe(true);
  });
});

describe('Java — false-positive guards', () => {
  it('does not flag collections, streams, Optional, maps and strings', async () => {
    expect(await ids(m(`for (Item it : items) {
      items.stream().filter(x -> x.ok()).findFirst();
      map.get(it.key());
      it.name().contains("a");
      Optional.ofNullable(it).map(x -> x.name()).orElse(null);
      list.add(it); set.remove(it); cache.get(it.id()); builder.append("x");
      sb.append("Select a user from the list");
      log.info("update the cache");
    }`))).toEqual([]);
  });

  it('does not flag Optional.map / async lambdas / services / HttpSession / lazy references', async () => {
    expect(await ids(m('userRepository.findById(id).map(u -> orderRepository.findByUserId(u.getId()));'))).toEqual([]);
    expect(await ids(m('CompletableFuture.supplyAsync(() -> repo.findById(1L));'))).toEqual([]);
    expect(await ids(m('for (Long id : ids) { userService.findById(id); }'))).toEqual([]);
    expect(await ids(m('for (Long id : ids) { session.getAttribute("u"); session.get("k"); }'))).toEqual([]);
    expect(await ids(m('for (Long id : ids) { order.setUser(userRepository.getReferenceById(id)); em.getReference(User.class, id); }'))).toEqual([]);
    expect(await ids(m('for (Long id : ids) { userRepository.flush(); }'))).toEqual([]);
  });

  it('does not flag loops over repositories or existence checks that are already exists*', async () => {
    expect(await ids(m('for (CrudRepository<?, ?> r : repos) { r.deleteAll(); }'))).toEqual([]);
    expect(await ids(m('if (!userRepository.existsByEmail(e)) {}\n    if (userRepository.existsByEmail(e)) {}', SPRING_MONGO))).toEqual([]);
  });

  it('respects suppressions', async () => {
    expect(await ids(m('for (Long id : ids) {\n      userRepository.findById(id); // querydig-ignore QD001\n    }'))).toEqual([]);
  });
});

describe('Java — scan', () => {
  it('picks up .java files and the sample app', async () => {
    const root = mkdtempSync(join(tmpdir(), 'querydig-java-'));
    mkdirSync(join(root, 'src', 'main', 'java'), { recursive: true });
    writeFileSync(join(root, 'src', 'main', 'java', 'A.java'), m('for (Long id : ids) { userRepository.findById(id); }'));
    const s = await scan({ root, threads: 1 });
    expect(s.filesScanned).toBe(1);
    expect(s.findings.map((f) => [f.file, f.ruleId, f.lang])).toEqual([['src/main/java/A.java', 'QD001', 'java']]);

    const sample = await scan({ root: new URL('../examples/sample-app/java', import.meta.url).pathname, threads: 1 });
    const rules = new Set(sample.findings.map((f) => f.ruleId));
    for (const r of ['QD001', 'QD002', 'QD003', 'SQ001', 'SQ009', 'SQ010', 'SQ002', 'SQ003', 'SQ005', 'SQ006']) expect(rules).toContain(r);
  });
});
