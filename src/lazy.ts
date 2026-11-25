import type { Analyzer, Ctx, QueryCall } from './analyzer.js';
import type { TSNode } from './parser.js';

/**
 * QD004: lazy-loaded relation inside a loop over query results.
 *
 *   for b in Book.objects.filter(...):  b.author.name          (Django / SQLAlchemy)
 *   @books.each { |b| b.author.name }                           (Rails)
 *   foreach ($books as $b) { $b->author->name; }                (Laravel)
 *   for (Book b : repo.findAll()) b.getAuthor().getName();      (JPA / Hibernate)
 *
 * Reading `row.relation.field` makes the ORM run one query per row unless the outer query
 * eager-loads that relation (select_related / prefetch_related / includes / with / JOIN FETCH ...).
 * Only the two-level form `row.rel.field` is flagged: `row.field` is usually a plain column.
 */

/** Names that are almost always plain columns (or values), not relations. */
const SCALAR_NAME = /^(id|pk|uuid|name|title|slug|email|phone|status|state|type|kind|price|amount|total|count|data|meta|metadata|json|config|settings|options|attributes|fields|errors|description|body|text|content|value|key|code|url|path|created|updated|deleted|date|time|timestamp|objects|pivot|attrs|properties|extra|payload|address|location|score|first|last|decorate|presenter|presence|to_a|to_h|try|dup|clone|reload|class|size|length|errors|object|model)$|^cached_|_(at|on|date|time|id|ids|uuid|count|json|data|url|path|type|status|name|ts|markdown|html|text|summary|body|list|array|hash|instructions|string|str|number|score)$/;
/** Methods/properties of plain values (dates, strings, dicts): `row.created_at.year` is not a relation. */
const VALUE_MEMBER = /^(strftime|isoformat|year|month|day|hour|minute|second|date|lower|upper|strip|split|replace|startswith|endswith|keys|values|items|get|to_s|to_i|to_f|to_date|iso8601|strip|downcase|upcase|present\?|blank\?|nil\?|empty\?|format|toString|toISOString|getTime|equals|hashCode|length|isEmpty|toLowerCase|toUpperCase|trim|diffForHumans|toDateString|isoFormat|presence|squish|sub|sub!|gsub|gsub!|negative\?|positive\?|zero\?|round|abs|html_safe|truncate|titleize|humanize|parameterize|include\?|start_with\?|end_with\?|starts_with\?|ends_with\?|index|scan|match|match\?|to_sym|to_json|as_json|sort|uniq|flatten|compact|join|map|reverse|in_time_zone|to_datetime|utc|localtime|beginning_of_day|end_of_day)$/;
/** Eager-loading calls on the outer query (or anywhere for that variable). */
const EAGER = /select_related|prefetch_related|prefetch_related_objects|\bincludes\b|\bpreload\b|eager_load|\bwith\s*\(|->load(Missing)?\s*\(|joinedload|selectinload|subqueryload|contains_eager|lazy\s*=\s*["'](joined|selectin|subquery)|join\s+fetch|EntityGraph|fetchJoin|\.Preload\(/i;

interface LazyHit { row: string; rel: string; field: string; node: TSNode }

function snake(s: string): string {
  return s.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
}

/** Match `row.rel.field` for the current language; `row` must be a loop variable. */
function match(node: TSNode, a: Analyzer, loopVars: string[]): LazyHit | null {
  const lang = a.spec.id;
  const isVar = (n: TSNode | null): string | null => {
    if (!n) return null;
    const t = n.text.replace(/^\$/, '');
    return (n.type === 'identifier' || n.type === 'variable_name') && loopVars.some((v) => v.replace(/^\$/, '') === t) ? t : null;
  };

  if (lang === 'python' && node.type === 'attribute') {
    const inner = node.childForFieldName('object');
    if (inner?.type !== 'attribute') return null;
    const row = isVar(inner.childForFieldName('object'));
    const rel = inner.childForFieldName('attribute')?.text;
    const field = node.childForFieldName('attribute')?.text;
    return row && rel && field ? { row, rel, field, node } : null;
  }

  if (lang === 'php' && (node.type === 'member_access_expression' || node.type === 'nullsafe_member_access_expression')) {
    const inner = node.childForFieldName('object');
    if (inner?.type !== 'member_access_expression' && inner?.type !== 'nullsafe_member_access_expression') return null;
    const row = isVar(inner.childForFieldName('object'));
    const rel = inner.childForFieldName('name')?.text;
    const field = node.childForFieldName('name')?.text;
    return row && rel && field ? { row, rel, field, node } : null;
  }

  if (lang === 'ruby' && node.type === 'call') {
    const inner = node.childForFieldName('receiver');
    if (inner?.type !== 'call' || inner.childForFieldName('arguments') || inner.childForFieldName('block')) return null;
    const row = isVar(inner.childForFieldName('receiver'));
    const rel = inner.childForFieldName('method')?.text;
    const field = node.childForFieldName('method')?.text;
    return row && rel && field ? { row, rel, field, node } : null;
  }

  if (lang === 'java' && node.type === 'method_invocation') {
    const inner = node.childForFieldName('object');
    if (inner?.type !== 'method_invocation' || (inner.childForFieldName('arguments')?.namedChildCount ?? 0) > 0) return null;
    const row = isVar(inner.childForFieldName('object'));
    const getter = inner.childForFieldName('name')?.text ?? '';
    const field = node.childForFieldName('name')?.text ?? '';
    if (!/^get[A-Z]/.test(getter) || !/^(get|is)[A-Z]/.test(field)) return null;
    const rel = getter.slice(3, 4).toLowerCase() + getter.slice(4);
    return row ? { row, rel, field: field.replace(/^(get|is)/, ''), node } : null;
  }
  return null;
}

/** Source of the query the loop iterates: the inline call, or the statement that assigned the variable. */
function querySource(a: Analyzer, overVar: string, loopLine: number): string {
  if (/[(\s]/.test(overVar)) return overVar;
  const name = overVar.replace(/^[@$]/, '').replace(/[^\w].*$/, '');
  if (!name) return overVar;
  const re = new RegExp(`(?:^|[^\\w.>])[@$]?(?:self\\.|this\\.|\\$this->)?${name}\\s*(?::[^=]+)?=(?!=)`);
  const out: string[] = [];
  for (let i = 0; i < Math.min(loopLine, a.lines.length); i++) {
    if (!re.test(a.lines[i])) continue;
    // the assignment and its continuation lines (chained calls)
    out.push(a.lines.slice(i, Math.max(i + 1, Math.min(i + 6, loopLine - 1))).join('\n'));
  }
  // `$books->load('author')`, `prefetch_related_objects(books, ...)` anywhere before the loop
  const later = a.lines.slice(0, loopLine).filter((l) => l.includes(name) && /->load(Missing)?\(|prefetch_related_objects|Preloader/.test(l));
  return [...out, ...later].join('\n');
}

function relIn(src: string, rel: string): boolean {
  const variants = new Set([rel, snake(rel), rel.replace(/_set$/, '')]);
  return [...variants].some((v) => new RegExp(`['":.\\s(]${v}(?=__|[^\\w]|$)`).test(src));
}

function fixFor(a: Analyzer, rel: string): string {
  switch (a.spec.id) {
    case 'python':
      return /sqlalchemy/i.test(a.src)
        ? `Eager-load it in the query: .options(selectinload(Model.${rel})) (or joinedload for many-to-one).`
        : `Eager-load it in the query: .select_related('${rel}') for a ForeignKey / OneToOne, or .prefetch_related('${rel}') for many-to-many and reverse relations.`;
    case 'ruby':
      return `Eager-load it in the query: .includes(:${rel}) (or .preload / .eager_load). Turn on strict_loading to catch the rest at runtime.`;
    case 'php':
      return `Eager-load it in the query: ->with('${rel}') (or $models->load('${rel}')). Model::preventLazyLoading() catches the rest at runtime.`;
    case 'java':
      return `Fetch it with the query: JOIN FETCH ${rel} in JPQL, or @EntityGraph(attributePaths = "${rel}") on the repository method. Map to-one associations with fetch = FetchType.LAZY.`;
    default:
      return 'Eager-load the relation in the original query instead of loading it per row.';
  }
}

/** ORM reads that return model objects (used when the language plugin didn't mark the loop as over results). */
const ORM_READ = /::(where|all|query|with|latest|oldest|orderBy|whereIn|whereHas|has|cursor|lazy|get|findMany)\b|->(get|paginate|simplePaginate|cursorPaginate|cursor|lazy|all)\(\)|\.objects\.|\.query\(|session\.(scalars|execute)\(|\.(where|all|order|joins|limit|find_by_sql)\b|\bfind(All|By\w*)\(|Repository|createQuery\(/;

export function checkLazyAccess(a: Analyzer, node: TSNode, ctx: Ctx, seen: Set<string>): void {
  if (!ctx.depth || !ctx.loopVars?.length) return;
  const hit = match(node, a, ctx.loopVars);
  if (!hit) return;
  const over = ctx.over && ctx.overVar ? ctx.overVar : ctx.iterName && ORM_READ.test(querySource(a, ctx.iterName, ctx.loopLine ?? a.lines.length)) ? ctx.iterName : undefined;
  if (!over) return;
  ctx = { ...ctx, overVar: over };
  const relSnake = snake(hit.rel);
  if (SCALAR_NAME.test(relSnake) || VALUE_MEMBER.test(hit.field)) return;
  // the relation itself being called (`b.author_set.all()`, `$b->posts()->...`) is QD001's job
  const key = `${ctx.loopLine}:${hit.row}.${hit.rel}`;
  if (seen.has(key)) return;
  seen.add(key);

  const loopLine = ctx.loopLine ?? a.lines.length;
  // the query plus the chained lines right before the loop (`Model.includes(:x)\n  .where(...)\n  .each do`)
  const src = [querySource(a, ctx.overVar!, loopLine), ...a.lines.slice(Math.max(0, loopLine - 6), Math.max(loopLine, node.startPosition.row))].join('\n');
  if (EAGER.test(src) && relIn(src, hit.rel)) return;
  // aggregates / dict rows: `.values()`, `.pluck`, `->toArray()` don't return model objects
  if (/\.values(_list)?\(|\.pluck\(|->toArray\(\)|\.raw\(|fetchall|fetch_all|->pluck\(/i.test(src)) return;

  const accessor = a.spec.id === 'php' ? `$${hit.row}->${hit.rel}` : a.spec.id === 'java' ? `${hit.row}.get${hit.rel[0].toUpperCase()}${hit.rel.slice(1)}()` : `${hit.row}.${hit.rel}`;
  const q: QueryCall = {
    node, top: node, method: hit.rel, kind: 'read', db: 'sql', receiver: hit.row, receiverText: hit.row,
    args: [], argsText: '', chain: [], confidence: 'medium',
  };
  const partial = EAGER.test(src) ? ' The query eager-loads other relations, but not this one.' : '';
  a.add('QD004', node, q, {
    message: `\`${accessor}\` is lazy-loaded for every row of \`${ctx.overVar}\` (loop at line ${ctx.loopLine}): one extra query per row.${partial}`,
    fix: fixFor(a, hit.rel),
  });
}

// ---------------------------------------------------------------------------------------------
// QD005: database client / pool created inside a function (per request).

/** `new X(...)` constructors that open a connection pool. */
const CLIENT_CTORS: Record<string, { lib: RegExp; label: string; fix: string }> = {
  PrismaClient: { lib: /prisma/i, label: 'PrismaClient', fix: 'Create one PrismaClient per process at module level (for Next.js / serverless dev reloads: `export const prisma = globalThis.prisma ?? new PrismaClient(); if (process.env.NODE_ENV !== "production") globalThis.prisma = prisma;`) and import it everywhere.' },
  MongoClient: { lib: /mongodb/, label: 'MongoClient', fix: 'Create the MongoClient once at module level (or cache the connect() promise in a module variable) and reuse it; the driver pools connections for you.' },
  Pool: { lib: /['"](pg|mysql2?(\/promise)?|pg-pool)['"]/, label: 'connection Pool', fix: 'Create the Pool once at module level and reuse it for every request; call pool.query() or pool.connect()/release() per request.' },
  Sequelize: { lib: /sequelize/, label: 'Sequelize instance', fix: 'Create the Sequelize instance once at module level and import it; each instance opens its own pool.' },
  DataSource: { lib: /typeorm/, label: 'TypeORM DataSource', fix: 'Create and initialize the DataSource once at startup and reuse it.' },
};
/** Functions that legitimately create the client: singletons, factories, startup and scripts. */
const FACTORY_NAME = /singleton|factory|^(create|make|build|new|init|initialize|setup|bootstrap|connect|get\w*(client|pool|db|prisma|connection|instance)|main|run|seed|migrate|start)|constructor|onModuleInit|beforeAll|beforeEach/i;

function enclosingFunction(a: Analyzer, node: TSNode): TSNode | null {
  for (let p = node.parent; p; p = p.parent) {
    if (a.spec.functions.includes(p.type) || a.spec.lambdas.includes(p.type)) return p;
  }
  return null;
}

function functionName(fn: TSNode): string {
  const own = fn.childForFieldName('name')?.text;
  if (own) return own;
  const p = fn.parent;
  if (p?.type === 'variable_declarator') return p.childForFieldName('name')?.text ?? '';
  if (p?.type === 'pair') return p.childForFieldName('key')?.text ?? '';
  if (p?.type === 'assignment_expression') return p.childForFieldName('left')?.text.split('.').pop() ?? '';
  if (p?.type === 'arguments') {
    // export const GET = handler(async () => …) / app.get('/x', async (req) => …): a request handler
    return '';
  }
  return '';
}

export function checkClientPerCall(a: Analyzer, node: TSNode): void {
  if (!a.isJs || node.type !== 'new_expression') return;
  const ctor = node.childForFieldName('constructor')?.text.split('.').pop() ?? '';
  const spec = Object.prototype.hasOwnProperty.call(CLIENT_CTORS, ctor) ? CLIENT_CTORS[ctor] : undefined;
  if (!spec || !spec.lib.test(a.src)) return;
  const fn = enclosingFunction(a, node);
  if (!fn) return; // module level: the right place
  // only `const db = new X()` local to the function; `cache = cache ?? new X()`, `return new X()` are factories
  let decl: TSNode | null = node.parent;
  while (decl && ['await_expression', 'parenthesized_expression', 'as_expression'].includes(decl.type)) decl = decl.parent;
  if (decl?.type !== 'variable_declarator') return;
  // every enclosing function must look like a request path, not a factory / startup function
  for (let f: TSNode | null = fn; f; f = enclosingFunction(a, f)) {
    if (FACTORY_NAME.test(functionName(f))) return;
    if (f.type === 'method_definition' && /^(constructor|onModuleInit)$/.test(f.childForFieldName('name')?.text ?? '')) return;
  }
  const name = functionName(fn) || 'this function';
  const q: QueryCall = {
    node, top: node, method: ctor, kind: 'read', db: ctor === 'MongoClient' ? 'mongodb' : 'sql', receiver: ctor, receiverText: ctor,
    args: [], argsText: '', chain: [], confidence: 'high',
  };
  a.add('QD005', node, q, {
    message: `A new ${spec.label} is created every time \`${name}\` runs. Each instance opens its own connection pool, so under load (and on serverless) the database runs out of connections.`,
    fix: spec.fix,
  });
}
