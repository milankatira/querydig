import { describe, expect, it } from 'vitest';
import { analyzeSource, analyzeSourceFull } from '../src/analyzer.js';
import type { LangId } from '../src/types.js';

const qd004 = async (lang: LangId, relPath: string, src: string) =>
  (await analyzeSource(src, { relPath, lang })).filter((f) => f.ruleId === 'QD004');

describe('QD004 lazy-loaded relation in a loop', () => {
  describe('Django', () => {
    const py = (src: string) => qd004('python', 'app/views.py', src);

    it('flags relation access over a queryset', async () => {
      const f = await py(`from .models import Book
def index(request):
    books = Book.objects.filter(published=True)
    for b in books:
        print(b.author.name)
        print(b.author.email)
`);
      expect(f).toHaveLength(1); // once per relation per loop
      expect(f[0].line).toBe(5);
      expect(f[0].message).toContain('b.author');
      expect(f[0].fix).toContain("select_related('author')");
    });

    it('flags comprehensions over an inline queryset', async () => {
      expect(await py(`def f():\n    return [b.publisher.name for b in Book.objects.all()]\n`)).toHaveLength(1);
    });

    it('is quiet when the relation is eager-loaded', async () => {
      expect(await py(`def f():\n    books = Book.objects.filter(x=1).select_related('author')\n    for b in books:\n        print(b.author.name)\n`)).toHaveLength(0);
      expect(await py(`def f():\n    books = Book.objects.prefetch_related('author__country')\n    return [b.author.name for b in books]\n`)).toHaveLength(0);
    });

    it('still flags a relation that is not the one eager-loaded', async () => {
      const f = await py(`def f():\n    books = Book.objects.select_related('author')\n    for b in books:\n        print(b.publisher.name)\n`);
      expect(f).toHaveLength(1);
      expect(f[0].message).toContain('not this one');
    });

    it('ignores plain columns, values() rows and non-query loops', async () => {
      expect(await py(`def f():\n    for b in Book.objects.all():\n        print(b.created_at.year, b.title.upper(), b.author_id)\n`)).toHaveLength(0);
      expect(await py(`def f():\n    rows = Book.objects.values('author__name')\n    for r in rows:\n        print(r.author.name)\n`)).toHaveLength(0);
      expect(await py(`def f(items):\n    for b in items:\n        print(b.author.name)\n`)).toHaveLength(0);
    });

    it('suggests selectinload for SQLAlchemy', async () => {
      const f = await py(`from sqlalchemy import select\ndef f(session):\n    books = session.scalars(select(Book)).all()\n    for b in books:\n        print(b.author.name)\n`);
      expect(f).toHaveLength(1);
      expect(f[0].fix).toContain('selectinload');
    });
  });

  describe('Rails', () => {
    const rb = (src: string) => qd004('ruby', 'app/controllers/books_controller.rb', src);

    it('flags association access in each blocks', async () => {
      const f = await rb(`class BooksController < ApplicationController
  def index
    @books = Book.where(published: true)
    @books.each { |b| puts b.author.name }
  end
end
`);
      expect(f).toHaveLength(1);
      expect(f[0].fix).toContain('.includes(:author)');
    });

    it('is quiet with includes / preload', async () => {
      expect(await rb(`def index\n  Book.includes(:author).each { |b| puts b.author.name }\nend\n`)).toHaveLength(0);
      expect(await rb(`def index\n  books = Book.preload(:author).where(x: 1)\n  books.each do |b|\n    puts b.author.name\n  end\nend\n`)).toHaveLength(0);
    });
  });

  describe('Laravel', () => {
    const php = (src: string) => qd004('php', 'app/Http/Controllers/BookController.php', `<?php\n${src}`);

    it('flags relation access in foreach', async () => {
      const f = await php(`class BookController {
  public function index() {
    $books = Book::where('published', true)->get();
    foreach ($books as $b) { echo $b->author->name; }
  }
}`);
      expect(f).toHaveLength(1);
      expect(f[0].message).toContain('$b->author');
      expect(f[0].fix).toContain("->with('author')");
    });

    it('is quiet with with() or load()', async () => {
      expect(await php(`function f() {\n  $books = Book::with('author')->get();\n  foreach ($books as $b) { echo $b->author->name; }\n}`)).toHaveLength(0);
      expect(await php(`function f() {\n  $books = Book::all();\n  $books->load('author');\n  foreach ($books as $b) { echo $b->author->name; }\n}`)).toHaveLength(0);
    });

    it('ignores date columns', async () => {
      expect(await php(`function f() {\n  $books = Book::all();\n  foreach ($books as $b) { echo $b->created_at->format('Y'); }\n}`)).toHaveLength(0);
    });
  });

  describe('JPA', () => {
    const java = (src: string) => qd004('java', 'src/main/java/BookService.java', src);

    it('flags getter chains over repository results', async () => {
      const f = await java(`class BookService {
  void list() {
    List<Book> books = bookRepository.findAll();
    for (Book b : books) {
      System.out.println(b.getAuthor().getName());
    }
  }
}`);
      expect(f).toHaveLength(1);
      expect(f[0].fix).toContain('JOIN FETCH author');
    });

    it('is quiet with JOIN FETCH', async () => {
      expect(await java(`class S {
  void list() {
    List<Book> books = em.createQuery("select b from Book b join fetch b.author", Book.class).getResultList();
    for (Book b : books) { System.out.println(b.getAuthor().getName()); }
  }
}`)).toHaveLength(0);
    });
  });
});

describe('QD005 database client created per call', () => {
  const ts = async (src: string, relPath = 'app/api/users/route.ts') =>
    (await analyzeSource(src, { relPath, lang: 'typescript' })).filter((f) => f.ruleId === 'QD005');

  it('flags new PrismaClient() inside a route handler', async () => {
    const f = await ts(`import { PrismaClient } from '@prisma/client';
export async function GET(req: Request) {
  const prisma = new PrismaClient();
  return Response.json(await prisma.user.findMany({ take: 20 }));
}`);
    expect(f).toHaveLength(1);
    expect(f[0].line).toBe(3);
    expect(f[0].message).toContain('`GET`');
  });

  it('flags MongoClient and pg Pool in express handlers', async () => {
    expect(await ts(`import { MongoClient } from 'mongodb';
app.get('/u', async (req, res) => {
  const client = new MongoClient(process.env.URI!);
  res.json(await client.db().collection('u').findOne({}));
});`)).toHaveLength(1);
    expect(await ts(`import { Pool } from 'pg';
export const handler = async (event) => {
  const pool = new Pool();
  return pool.query('select 1');
};`)).toHaveLength(1);
  });

  it('allows module-level clients, singletons and factories', async () => {
    expect(await ts(`import { PrismaClient } from '@prisma/client';\nexport const prisma = new PrismaClient();`)).toHaveLength(0);
    expect(await ts(`import { PrismaClient } from '@prisma/client';
const prismaClientSingleton = () => {
  return new PrismaClient();
};
export const prisma = globalThis.prisma ?? prismaClientSingleton();`)).toHaveLength(0);
    expect(await ts(`import { PrismaClient } from '@prisma/client';
let client: PrismaClient | undefined;
export function db() {
  if (!client) client = new PrismaClient();
  return client;
}`)).toHaveLength(0);
    expect(await ts(`import { PrismaClient } from '@prisma/client';
async function main() {
  const prisma = new PrismaClient();
  await prisma.user.create({ data: {} });
}
main();`, 'prisma/seed.ts')).toHaveLength(0);
    expect(await ts(`import { PrismaClient } from '@prisma/client';
export class PrismaService {
  constructor() { const c = new PrismaClient(); }
}`)).toHaveLength(0);
  });

  it('ignores same-named classes from other libraries', async () => {
    expect(await ts(`import { Pool } from './threads';\nexport function f() { const p = new Pool(4); return p; }`)).toHaveLength(0);
  });
});

describe('prototype method names', () => {
  it('does not crash workers on calls named like Object.prototype members', async () => {
    const src = `<?php
use App\\Models\\Article;
final class CreateArticle {
  public function handle(): void {
    $article = new Article(['uuid' => $this->uuid->toString(), 'title' => $this->title]);
    $article->authoredBy($this->author);
    $article->save();
  }
}`;
    const r = await analyzeSourceFull(src, { relPath: 'app/Jobs/CreateArticle.php', lang: 'php' });
    expect(() => structuredClone(r)).not.toThrow();
    expect(r.shapes.every((s) => typeof s.kind === 'string')).toBe(true);
  });
});
