import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { analyzeSource, analyzeSourceFull } from '../src/analyzer.js';
import { applyFixes } from '../src/fix.js';
import { langForFile } from '../src/languages.js';
import { scan } from '../src/scan.js';

const run = async (src: string, relPath = 'x.rb') => analyzeSource(src, { relPath, lang: 'ruby' });
const ids = async (src: string, relPath?: string) => (await run(src, relPath)).map((f) => f.ruleId).sort();
const rails = (src: string) => run(src, 'app/controllers/users_controller.rb');

function project(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), 'querydig-rb-'));
  for (const [f, c] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, f)), { recursive: true });
    writeFileSync(join(dir, f), c);
  }
  return dir;
}

async function fixed(src: string, file = 'app/jobs/job.rb') {
  const root = project({ [file]: src });
  const s = await scan({ root, threads: 1 });
  applyFixes(root, s.findings);
  return readFileSync(join(root, file), 'utf8');
}

describe('Ruby — files', () => {
  it('maps .rb and .rake to ruby', () => {
    expect(langForFile('app/models/user.rb')).toBe('ruby');
    expect(langForFile('lib/tasks/backfill.rake')).toBe('ruby');
  });
});

describe('Ruby — N+1 (QD001 / QD002 / QD003)', () => {
  it('flags a model query inside an each block', async () => {
    const f = await run('ids.each do |id|\n  User.find(id)\nend\n');
    expect(f.map((x) => x.ruleId)).toEqual(['QD001']);
    expect(f[0].db).toBe('sql');
    expect(f[0].fix).toMatch(/where\(id: ids\)/);
  });

  it('flags queries in brace blocks, map, times and for loops', async () => {
    expect(await ids('ids.map { |id| Order.find_by(id: id) }')).toEqual(['QD001']);
    expect(await ids('5.times { |i| Order.where(n: i).to_a }')).toEqual(['QD001']);
    expect(await ids('for x in xs\n  Foo.find(x)\nend')).toEqual(['QD001']);
    expect(await ids('names.each_with_object({}) { |n, h| h[n] = User.find_by(name: n) }')).toEqual(['QD001']);
  });

  it('flags queries per row of another query (QD002), including assigned vars and ivars', async () => {
    const direct = await run('User.where(active: true).each do |u|\n  Order.where(user_id: u.id).to_a\nend\n');
    expect(direct.find((x) => x.ruleId === 'QD002')?.severity).toBe('critical');
    expect(await ids('users = User.where(a: 1)\nusers.each { |u| Order.find_by(user_id: u.id) }')).toContain('QD002');
    expect(await ids('@users ||= User.where(a: 1)\n@users.each { |u| Order.find_by(user_id: u.id) }')).toContain('QD002');
    expect(await ids('@users = User.where(a: 1)\nfor u in @users\n  Order.find_by(user_id: u.id)\nend')).toContain('QD002');
  });

  it('flags association queries on the loop row', async () => {
    const src = 'User.where(active: true).each do |u|\n  u.orders.where(status: 1).count\n  u.orders.count\n  u.orders.first\nend\n';
    const f = (await run(src)).filter((x) => x.ruleId === 'QD002');
    expect(f.map((x) => x.line)).toEqual([2, 3, 4]);
    expect(f[1].fix).toMatch(/counter_cache|group/);
    expect(f[2].fix).toMatch(/includes\(:orders\)/);
  });

  it('flags iterating an association inside a loop over DB rows', async () => {
    const f = await run('Post.where(published: true).each do |p|\n  p.comments.each { |c| puts c }\nend\n');
    const q = f.find((x) => x.ruleId === 'QD002');
    expect(q?.line).toBe(2);
    expect(q?.fix).toMatch(/includes\(:comments\)/);
  });

  it('does not flag bare association access or unknown loops outside Rails files', async () => {
    expect(await ids('User.where(a: 1).each do |u|\n  puts u.orders\nend')).not.toContain('QD002');
    expect(await ids('items.each { |item| item.variants.first }')).toEqual([]);
  });

  it('treats ambiguous association calls in Rails files as medium confidence', async () => {
    const f = await rails('items.each { |item| item.variants.first }');
    expect(f.map((x) => x.ruleId)).toEqual(['QD001']);
    expect(f[0].confidence).toBe('medium');
  });

  it('flags writes in loops (QD003)', async () => {
    expect(await ids('users.each { |u| u.update(active: true) }')).toEqual(['QD003']);
    expect(await ids('users.each { |u| u.save! }')).toEqual(['QD003']);
    expect(await ids('rows.each { |r| Order.create!(r) }')).toEqual(['QD003']);
    expect(await ids('users.each { |u| u.update(user_params) }')).toEqual(['QD003']);
  });

  it('treats find_each bodies as per-row loops but batch iterators as batching', async () => {
    expect(await ids('User.find_each { |u| Order.where(user_id: u.id).to_a }')).toEqual(['QD002']);
    expect(await ids('User.where(a: 1).in_batches { |rel| rel.update_all(a: 2) }')).toEqual([]);
    expect(await ids('User.find_in_batches { |batch| Order.where(user_id: batch.map(&:id)).to_a }')).toEqual([]);
    expect(await ids('User.find_in_batches { |batch| batch.each { |u| Order.where(user_id: u.id).count } }')).toContain('QD002');
    expect(await ids('ids.each_slice(500) { |s| User.where(id: s).update_all(a: 1) }')).toEqual([]);
  });

  it('does not count while/until/loop polling loops', async () => {
    expect(await ids('while running\n  Job.find_by(state: "new")\nend')).toEqual([]);
    expect(await ids('until done\n  Job.where(state: "new").first\nend')).toEqual([]);
    expect(await ids('loop do\n  Job.find_by(state: "new")\nend')).toEqual([]);
  });

  it('does not flag Enumerable / Hash / String look-alikes', async () => {
    expect(await ids('arr.each { |x| x.to_s }')).toEqual([]);
    expect(await ids('rows.each { |r| hash.find { |k, v| v == r } }')).toEqual([]);
    expect(await ids('lines.each { |l| str.count("a") }')).toEqual([]);
    expect(await ids('xs.each { |x| [1, 2].first }')).toEqual([]);
    expect(await ids('xs.each { |x| STATUSES.first }')).toEqual([]);
    expect(await ids('xs.each { |x| h.update(other) ; arr.delete(x) }')).toEqual([]);
    expect(await ids('xs.each { |x| File.exists?(x) ; Rails.cache.delete(x) }')).toEqual([]);
    expect(await ids('xs.each { |x| Stripe::Customer.create(email: x) }')).toEqual([]);
    expect(await ids('xs.each { |x| x.items.count { |i| i.ok } }')).toEqual([]);
  });

  it('honours querydig-ignore comments', async () => {
    expect(await ids('ids.each do |id|\n  User.find(id) # querydig-ignore QD001\nend')).toEqual([]);
  });
});

describe('Ruby — SQ001 unbounded Model.all', () => {
  it('flags Model.all as an unbounded read', async () => {
    const f = await rails('def index\n  @users = User.all\nend');
    expect(f.map((x) => x.ruleId)).toEqual(['SQ001']);
    expect(await ids('render json: User.all')).toEqual(['SQ001']);
  });

  it('does not flag bounded, paginated or scope uses', async () => {
    expect(await ids('User.all.limit(10).to_a')).toEqual([]);
    expect(await ids('User.all.where(a: 1).to_a')).toEqual([]);
    expect(await ids('User.all.find_each { |u| puts u }')).toEqual([]);
    expect(await ids('User.all.pluck(:id)')).toEqual([]);
    expect(await ids('@pagy, @users = pagy(User.all)')).toEqual([]);
    expect(await ids('@users = User.all.page(params[:page])')).toEqual([]);
    expect(await ids('class User < ApplicationRecord\n  scope :everyone, -> { User.all }\nend')).toEqual([]);
  });
});

describe('Ruby — SQ010 whole table iterated', () => {
  it('flags Model.all.each / Model.where(...).each with find_each advice', async () => {
    const f = await run('User.all.each do |u|\n  notify(u)\nend');
    expect(f.map((x) => x.ruleId)).toEqual(['SQ010']);
    expect(f[0].autofix).toBeDefined();
    const w = await run('User.where(active: true).each { |u| notify(u) }');
    expect(w.map((x) => x.ruleId)).toEqual(['SQ010']);
    expect(w[0].confidence).toBe('low');
    expect(await ids('User.order(:name).map { |u| u.name }')).toEqual(['SQ010']);
  });

  it('does not flag bounded or id-list relations', async () => {
    expect(await ids('User.where(id: ids).each { |u| notify(u) }')).toEqual([]);
    expect(await ids('User.limit(10).each { |u| notify(u) }')).toEqual([]);
    expect(await ids('User.where(a: 1).limit(5).each { |u| notify(u) }')).toEqual([]);
    expect(await ids('User.find_each { |u| notify(u) }')).toEqual([]);
  });

  it('only offers the autofix when find_each is equivalent', async () => {
    const fix = async (src: string) => (await run(src)).find((x) => x.ruleId === 'SQ010')?.autofix;
    expect(await fix('User.order(:name).each { |u| notify(u) }')).toBeUndefined();
    expect(await fix('User.where(a: 1).limit(5).select(:id).each { |u| notify(u) }')).toBeUndefined();
    expect(await fix('User.where(a: 1).each_with_index { |u, i| notify(u) }')).toBeUndefined();
    expect(await fix('User.where(a: 1).each { |u, i| notify(u) }')).toBeUndefined();
    expect(await fix('x = User.where(a: 1).each { |u| notify(u) }')).toBeUndefined();
    expect(await fix('User.all.each(&:touch)')).toBeUndefined();
  });
});

describe('Ruby — SQ009 count as existence check', () => {
  it('flags count comparisons and predicates', async () => {
    expect(await ids('if User.where(a: 1).count > 0\n  1\nend')).toEqual(['SQ009']);
    expect(await ids('x = Order.where(b: 2).count.zero?')).toEqual(['SQ009']);
    expect(await ids('x = Order.where(b: 2).count.positive?')).toEqual(['SQ009']);
    expect(await ids('x = 0 < Order.where(b: 2).count')).toEqual(['SQ009']);
    expect(await ids('x = User.count == 0')).toEqual(['SQ009']);
    expect(await ids('x = User.where(a: 1).present?')).toEqual(['SQ009']);
    expect(await rails('return if current_user.orders.count == 0')).toHaveLength(1);
  });

  it('does not flag real counts, block forms, loaded arrays or EXISTS-backed predicates', async () => {
    expect(await ids('n = User.where(a: 1).count')).toEqual([]);
    expect(await ids('x = User.where(a: 1).count > 5')).toEqual([]);
    expect(await ids('x = User.where(a: 1).pluck(:id).count > 0')).toEqual([]);
    expect(await ids('x = User.where(a: 1).any?')).toEqual([]);
    expect(await ids('x = User.where(a: 1).any? { |u| u.admin? }')).toEqual([]);
    expect(await ids('x = items.count > 0')).toEqual([]);
    expect(await ids('x = name.present?')).toEqual([]);
  });
});

describe('Ruby — raw SQL and fragments (SQ002–SQ008)', () => {
  it('checks SQL strings, heredocs and interpolation', async () => {
    expect(await ids('sql = "SELECT * FROM users WHERE id = 1"')).toEqual(['SQ002']);
    expect(await ids('sql = "SELECT id FROM users WHERE name LIKE \'%#{q}%\'"')).toEqual(['SQ003']);
    expect(await ids('ActiveRecord::Base.connection.execute(<<~SQL)\n  DELETE FROM users\nSQL\n')).toEqual(['SQ004']);
    // interpolated: the WHERE may be in the interpolation, so no SQ004
    expect(await ids('sql = "UPDATE users SET a = 1 #{where}"')).toEqual([]);
    expect(await ids('q = "SELECT id FROM orders WHERE user_id NOT IN (SELECT id FROM users)"')).toEqual(['SQ008']);
  });

  it('captures heredoc SQL for live mode without the terminator', async () => {
    const r = await analyzeSourceFull('rows = ActiveRecord::Base.connection.select_all(<<~SQL)\n  SELECT id FROM users WHERE email = \'a\'\nSQL\n', { relPath: 'x.rb', lang: 'ruby' });
    expect(r.shapes.find((s) => s.method === 'sql')?.sql).toBe("SELECT id FROM users WHERE email = 'a'");
  });

  it('checks ActiveRecord string fragments', async () => {
    expect(await ids('User.where("name LIKE ?", "%#{q}%").to_a')).toEqual(['SQ003']);
    expect(await ids('User.where("LOWER(email) = ?", e).first')).toEqual(['SQ006']);
    expect(await ids('User.where(a: 1).order("RANDOM()").first')).toEqual(['SQ007']);
    expect(await ids('User.where(a: 1).offset(params[:page] * 20).limit(20).to_a')).toEqual(['SQ005']);
    expect(await ids('User.where("name LIKE ?", "#{q}%").to_a')).toEqual([]);
  });

  it('flags raw connection queries and find_by_sql in loops', async () => {
    expect(await ids('ids.each { |id| ActiveRecord::Base.connection.execute("UPDATE users SET a = 1 WHERE id = #{id}") }')).toEqual(['QD003']);
    expect(await ids('ids.each { |id| User.find_by_sql(["SELECT id FROM users WHERE id = ?", id]) }')).toEqual(['QD001']);
  });
});

describe('Ruby — live shapes, Mongoid, Sequel', () => {
  it('records Rails table names and filter keys', async () => {
    const r = await analyzeSourceFull('Admin::OrderItem.where(status: 1, "user_id" => 2).order(:id).first\nUser.find(5)\n', { relPath: 'x.rb', lang: 'ruby' });
    expect(r.shapes[0]).toMatchObject({ collection: 'order_items', filterKeys: ['status', 'user_id'], db: 'sql', orm: 'activerecord' });
    expect(r.shapes[1]).toMatchObject({ collection: 'users', filterKeys: ['id'] });
  });

  it('labels Mongoid models as MongoDB and keeps find(id) quiet', async () => {
    const f = await run('class Post\n  include Mongoid::Document\n  def self.x(ids)\n    ids.each { |i| Post.find(i) }\n  end\nend\n');
    expect(f.map((x) => x.ruleId)).toEqual(['QD001']);
    expect(f[0].db).toBe('mongodb');
  });

  it('handles Sequel datasets', async () => {
    expect(await ids('DB[:users].where(a: 1).each { |u| DB[:orders].where(user_id: u[:id]).all }')).toEqual(['QD002']);
  });
});

describe('Ruby — --fix', () => {
  it('rewrites .all.each to .find_each and .where(..).each to .where(..).find_each', async () => {
    const src = [
      'class NotifyJob < ApplicationJob',
      '  def perform',
      '    User.all.each do |u|',
      '      notify(u)',
      '    end',
      '    User.where(active: true).includes(:orders).each { |u| notify(u) }',
      '    User.order(:name).each { |u| notify(u) }',
      '  end',
      'end',
      '',
    ].join('\n');
    const out = await fixed(src);
    expect(out).toContain('    User.find_each do |u|');
    expect(out).toContain('User.where(active: true).includes(:orders).find_each { |u| notify(u) }');
    expect(out).toContain('User.order(:name).each { |u| notify(u) }');
  });

  it('rewrites count checks and present? to exists?, and is idempotent', async () => {
    const src = [
      'class ReportService',
      '  def call(user)',
      '    return 1 if Order.where(user_id: user.id).count > 0',
      '    return 2 if Order.where(state: "x").count.zero?',
      '    return 3 if user.orders.count == 0',
      '    return 4 if Order.where(state: "y").present?',
      '    n = Order.where(state: "z").count',
      '  end',
      'end',
      '',
    ].join('\n');
    const file = 'app/services/report_service.rb';
    const root = project({ [file]: src });
    applyFixes(root, (await scan({ root, threads: 1 })).findings);
    const out = readFileSync(join(root, file), 'utf8');
    expect(out).toContain('return 1 if Order.where(user_id: user.id).exists?');
    expect(out).toContain('return 2 if !Order.where(state: "x").exists?');
    expect(out).toContain('return 3 if !user.orders.exists?');
    expect(out).toContain('return 4 if Order.where(state: "y").exists?');
    expect(out).toContain('n = Order.where(state: "z").count');
    const again = await scan({ root, threads: 1 });
    expect(again.findings.filter((f) => f.ruleId === 'SQ009')).toHaveLength(0);
  });
});
