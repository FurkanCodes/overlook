/**
 * A dashboard built from the data alone, for "make a dashboard of my data"
 * with nothing more said, and for models too small to write a spec.
 *
 * It profiles one table (types, distinct counts, date range), picks a date
 * column, up to three measures and up to two dimensions by name and shape,
 * and writes an ordinary spec: KPIs with trends, a trend chart, breakdowns,
 * and a summary table. The spec then goes through the normal check, so an
 * automatic dashboard is held to the same rules as a hand-written one;
 * panels that fail are dropped rather than saved broken.
 */
import { checkDashboard, type CheckResult } from './check.js';
import type { ColumnInfo, Engine } from './engine/engine.js';
import { humanize, lowerLabel } from './spec/labels.js';
import type { DashboardSpec, FilterSpec, Format, PanelSpec } from './spec/schema.js';

export interface AutoOptions {
  source: string;
  /** For a database source: which table (as describe_data shows it). Default: the best one. */
  table?: string;
  title?: string;
}

export interface AutoResult {
  ok: boolean;
  spec?: DashboardSpec;
  check?: CheckResult;
  /** Why it could not build anything, or what was left out. */
  notes: string[];
}

interface Profile {
  ref: string;
  rows: number;
  cols: (ColumnInfo & { distinct: number; min?: unknown; max?: unknown })[];
}

const q = (name: string) => `"${name.replaceAll('"', '""')}"`;

/** A SQL alias that is also a valid spec column name. */
function alias(name: string, taken: Set<string>): string {
  let a = name.toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '') || 'value';
  if (!/^[a-z_]/.test(a)) a = `c_${a}`;
  let out = a;
  for (let i = 2; taken.has(out); i++) out = `${a}_${i}`;
  taken.add(out);
  return out;
}

const NOT_A_MEASURE = /(^|_)(id|ids|key|uuid|guid|code|zip|zipcode|postal|postcode|phone|year|month|day|week|hour|minute|lat|lon|lng|latitude|longitude|index|idx|rank|seq|version|number|no|num)$/i;
const MONEY = /(revenue|amount|sales|price|cost|profit|mrr|arr|spend|income|fee|fees|gmv|payment|paid|budget|salary|usd|eur|gbp|value|total)/i;
const AVERAGED = /(rate|ratio|pct|percent|share|price|score|rating|age|temp|temperature|avg|average|mean|median|duration|latency|speed|margin)/i;
const RATE = /(rate|ratio|pct|percent|share)/i;
/** Snapshot measures: a day's value is a level, not an amount, so a period shows the average daily total. */
const STOCK = /(^|_)(mrr|arr|balance|balances|inventory|stock|headcount|subscribers|seats|active_users|open_tickets|backlog)($|_)/i;
const PREFERRED = /(revenue|amount|sales|total|mrr|arr|profit|orders|count|qty|quantity|units|users|signups|visits|sessions|spend|cost|value)/i;
const NOT_A_DIMENSION = /(^|_)(id|uuid|guid|email|e_mail|phone|url|link|path|hash|token|password|secret|description|desc|comment|notes?|text|body|message|address|ip)$/i;

async function profile(engine: Engine, ref: string, columns: ColumnInfo[]): Promise<Profile> {
  const parts = ['count(*) AS n'];
  columns.forEach((c, i) => {
    parts.push(`approx_count_distinct(${q(c.name)}) AS d${i}`);
    if (c.kind === 'date' || c.kind === 'number') parts.push(`min(${q(c.name)}) AS lo${i}`, `max(${q(c.name)}) AS hi${i}`);
  });
  const r = await engine.run(`SELECT ${parts.join(', ')} FROM ${ref}`, {}, { limit: 1, timeoutMs: 15_000 });
  const row = r.rows[0] ?? {};
  return {
    ref,
    rows: Number(row.n ?? 0),
    cols: columns.map((c, i) => ({ ...c, distinct: Number(row[`d${i}`] ?? 0), min: row[`lo${i}`], max: row[`hi${i}`] })),
  };
}

function score(p: Profile): number {
  const hasDate = p.cols.some((c) => c.kind === 'date');
  const measures = p.cols.filter((c) => c.kind === 'number' && !NOT_A_MEASURE.test(c.name)).length;
  return (hasDate ? 4 : 0) + Math.min(measures, 3) + Math.log10(p.rows + 1);
}

/** Which measure leads: money that adds up first, then counts and amounts, then averages (price, rate). */
function measureRank(c: ColumnInfo): number {
  if (MONEY.test(c.name) && !AVERAGED.test(c.name)) return 3;
  if (AVERAGED.test(c.name)) return 0;
  if (PREFERRED.test(c.name)) return 2;
  return 1;
}

function formatOf(name: string, max: unknown): Format | undefined {
  if (RATE.test(name) && Number(max) <= 1) return 'percent';
  if (MONEY.test(name)) return 'currency';
  return undefined;
}

function grainOf(lo: unknown, hi: unknown): 'day' | 'week' | 'month' {
  const a = Date.parse(String(lo));
  const b = Date.parse(String(hi));
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 'month';
  const days = (b - a) / 86_400_000;
  if (days <= 62) return 'day';
  if (days <= 2 * 365) return 'week';
  return 'month';
}

/** Build the spec without checking it. Exported for tests. */
export function buildSpec(p: Profile, opts: { source: string; title: string }): { spec: DashboardSpec; notes: string[] } {
  const notes: string[] = [];
  const { source } = opts;
  const date = p.cols.filter((c) => c.kind === 'date' && c.distinct > 1).sort((a, b) => b.distinct - a.distinct)[0];
  const measures = p.cols
    .filter((c) => c.kind === 'number' && !NOT_A_MEASURE.test(c.name) && c.distinct > 1)
    .sort((a, b) => measureRank(b) - measureRank(a))
    .slice(0, 3);
  // Best breakdowns first: a text column with a handful of values (region,
  // channel, plan). Yes/no columns split the data in two and come last.
  const dimRank = (c: ColumnInfo & { distinct: number }) => [c.kind === 'boolean' ? 1 : 0, c.distinct >= 3 && c.distinct <= 12 ? 0 : 1, c.distinct];
  const dims = p.cols
    .filter((c) => (c.kind === 'text' || c.kind === 'boolean') && c.distinct >= 2 && c.distinct <= 50 && !NOT_A_DIMENSION.test(c.name))
    .sort((a, b) => {
      const x = dimRank(a);
      const y = dimRank(b);
      return x[0]! - y[0]! || x[1]! - y[1]! || x[2]! - y[2]!;
    })
    .slice(0, 2);

  const filters: FilterSpec[] = [];
  const conds: string[] = [];
  const params = new Set<string>();
  const dim = dims[0];
  if (dim) {
    const id = alias(dim.name, params);
    filters.push({ id, label: humanize(dim.name), type: 'select', source, options_sql: `SELECT DISTINCT CAST(${q(dim.name)} AS VARCHAR) AS v FROM ${p.ref} WHERE ${q(dim.name)} IS NOT NULL ORDER BY 1` });
    conds.push(`($${id} IS NULL OR CAST(${q(dim.name)} AS VARCHAR) = $${id})`);
  }
  if (date) {
    const id = alias('since', params);
    filters.push({ id, label: 'Since', type: 'date' });
    conds.push(`($${id} IS NULL OR ${q(date.name)} >= CAST($${id} AS DATE))`);
  }
  const where = conds.length ? ` WHERE ${conds.join(' AND ')}` : '';
  const and = (extra: string) => (conds.length ? `${where} AND ${extra}` : ` WHERE ${extra}`);

  const agg = (c: ColumnInfo) =>
    AVERAGED.test(c.name)
      ? `avg(${q(c.name)})`
      : STOCK.test(c.name) && date
        ? `sum(${q(c.name)}) / count(DISTINCT CAST(${q(date.name)} AS DATE))`
        : `sum(${q(c.name)})`;
  const panels: PanelSpec[] = [];
  const grain = date ? grainOf(date.min, date.max) : 'month';
  const period = date ? `date_trunc('${grain}', ${q(date.name)})` : '';
  const periodWord = { day: 'Daily', week: 'Weekly', month: 'Monthly' }[grain];
  // Only whole periods: data that starts or ends mid-week would otherwise
  // show a fake drop at each end. The last period is kept while the data is
  // live (it reaches yesterday or today); the page marks it "so far".
  const lo = date ? `CAST((SELECT min(${q(date.name)}) FROM ${p.ref}) AS DATE)` : '';
  const hi = date ? `CAST((SELECT max(${q(date.name)}) FROM ${p.ref}) AS DATE)` : '';
  const whole = date
    ? `${period} >= CASE WHEN date_trunc('${grain}', ${lo}) = ${lo} THEN ${lo} ELSE date_trunc('${grain}', ${lo}) + INTERVAL 1 ${grain} END` +
      ` AND (${period} + INTERVAL 1 ${grain} <= ${hi} + INTERVAL 1 DAY OR ${hi} >= current_date - INTERVAL 1 DAY)`
    : '';

  // KPIs: each measure (or the row count) per period, so each tile has a trend.
  const kpiMeasures: { expr: string; name: string; label: string; format?: Format }[] = measures.map((m) => ({
    expr: agg(m),
    name: m.name,
    label: `${AVERAGED.test(m.name) ? 'Average ' + lowerLabel(m.name) : humanize(m.name)}`,
    format: formatOf(m.name, m.max),
  }));
  if (kpiMeasures.length < 3) kpiMeasures.push({ expr: 'count(*)', name: 'records', label: 'Records' });
  for (const k of kpiMeasures.slice(0, 3)) {
    const taken = new Set<string>();
    const v = alias(k.name, taken);
    if (date) {
      const x = alias('period', taken);
      panels.push({
        id: alias(`kpi_${k.name}`, new Set(panels.map((pp) => pp.id))),
        type: 'kpi',
        title: k.label,
        source,
        sql: `SELECT ${period} AS ${x}, ${k.expr} AS ${v} FROM ${p.ref}${and(`${q(date.name)} IS NOT NULL AND ${whole}`)} GROUP BY 1 ORDER BY 1`,
        x,
        value: v,
        ...(k.format ? { format: k.format } : {}),
      });
    } else {
      panels.push({ id: alias(`kpi_${k.name}`, new Set(panels.map((pp) => pp.id))), type: 'kpi', title: k.label, source, sql: `SELECT ${k.expr} AS ${v} FROM ${p.ref}${where}`, value: v, ...(k.format ? { format: k.format } : {}) });
    }
  }

  const main = measures[0];
  const mainExpr = main ? agg(main) : 'count(*)';
  const mainName = main ? alias(main.name, new Set(['period'])) : 'rows';
  const mainLabel = main ? humanize(main.name) : 'Rows';
  const mainFormat = main ? formatOf(main.name, main.max) : undefined;
  const fmt = mainFormat ? { format: mainFormat } : {};

  if (date) {
    const second = dims[0] && dims[0].distinct <= 8 ? dims[0] : undefined;
    if (second && !AVERAGED.test(main?.name ?? '')) {
      panels.push({
        id: 'trend',
        type: 'area',
        title: `${periodWord} ${main ? lowerLabel(main.name) : 'rows'} by ${lowerLabel(second.name)}`,
        source,
        sql: `SELECT ${period} AS period, CAST(${q(second.name)} AS VARCHAR) AS ${alias(second.name, new Set(['period', mainName]))}, ${mainExpr} AS ${mainName} FROM ${p.ref}${and(`${q(date.name)} IS NOT NULL AND ${whole}`)} GROUP BY 1, 2 ORDER BY 1`,
        x: 'period',
        y: mainName,
        series: alias(second.name, new Set(['period', mainName])),
        stacked: true,
        width: 'full',
        ...fmt,
      });
    } else {
      panels.push({
        id: 'trend',
        type: 'line',
        title: `${periodWord} ${main ? lowerLabel(main.name) : 'rows'}`,
        source,
        sql: `SELECT ${period} AS period, ${mainExpr} AS ${mainName} FROM ${p.ref}${and(`${q(date.name)} IS NOT NULL AND ${whole}`)} GROUP BY 1 ORDER BY 1`,
        x: 'period',
        y: mainName,
        width: 'full',
        ...fmt,
      });
    }
  } else {
    notes.push('no date column, so there is no trend chart');
  }

  dims.forEach((d) => {
    const label = alias(d.name, new Set([mainName]));
    panels.push({
      id: alias(`by_${d.name}`, new Set(panels.map((pp) => pp.id))),
      type: 'bar',
      title: `${mainLabel} by ${lowerLabel(d.name)}`,
      source,
      sql: `SELECT CAST(${q(d.name)} AS VARCHAR) AS ${label}, ${mainExpr} AS ${mainName} FROM ${p.ref}${where} GROUP BY 1 ORDER BY 2 DESC LIMIT 12`,
      x: label,
      y: mainName,
      horizontal: true,
      width: dims.length === 1 ? 'full' : 'half',
      ...fmt,
    });
  });
  if (dims.length === 0) notes.push('no column with a few repeating values to break the data down by');

  // A summary table by the first dimension, or the latest rows.
  if (dim) {
    const taken = new Set<string>();
    const keys = dims.map((d) => ({ d, a: alias(d.name, taken) }));
    const counted = alias('records', taken);
    const measureCols = measures.map((m) => ({ m, a: alias(m.name, taken) }));
    const cols = [...keys.map((k) => `CAST(${q(k.d.name)} AS VARCHAR) AS ${k.a}`), `count(*) AS ${counted}`, ...measureCols.map((x) => `${agg(x.m)} AS ${x.a}`)];
    const formats: Record<string, Format> = {};
    for (const x of measureCols) {
      const f = formatOf(x.m.name, x.m.max);
      if (f) formats[x.a] = f;
    }
    const sortBy = measureCols[0]?.a ?? counted;
    panels.push({
      id: 'summary',
      type: 'table',
      title: `By ${dims.map((d) => lowerLabel(d.name)).join(' and ')}`,
      source,
      sql: `SELECT ${cols.join(', ')} FROM ${p.ref}${where} GROUP BY ${keys.map((_, i) => i + 1).join(', ')} ORDER BY ${sortBy} DESC LIMIT 50`,
      ...(Object.keys(formats).length ? { formats } : {}),
    });
  } else {
    panels.push({
      id: 'rows',
      type: 'table',
      title: date ? 'Latest rows' : 'Rows',
      source,
      sql: `SELECT * FROM ${p.ref}${where}${date ? ` ORDER BY ${q(date.name)} DESC` : ''} LIMIT 100`,
    });
  }

  const desc = `Built automatically from ${p.rows.toLocaleString('en-US')} rows of ${source}${date ? `, by ${lowerLabel(date.name)}` : ''}. Ask your agent to change any panel.`;
  return { spec: { version: 1, title: opts.title, description: desc, ...(filters.length ? { filters } : {}), panels }, notes };
}


/** Build, check, and repair (by dropping failing panels) an automatic dashboard. */
export async function autoDashboard(engine: Engine, opts: AutoOptions): Promise<AutoResult> {
  const [desc] = await engine.describe(opts.source);
  if (!desc || !desc.ok) return { ok: false, notes: [`source "${opts.source}" is not available${desc?.error ? `: ${desc.error}` : ''}`] };
  const tables = opts.table ? desc.tables.filter((t) => t.ref === opts.table || t.ref.replaceAll('"', '').endsWith(`.${opts.table}`)) : desc.tables;
  if (tables.length === 0) return { ok: false, notes: [opts.table ? `no table "${opts.table}" in ${opts.source}` : `${opts.source} has no tables`] };

  const profiles: Profile[] = [];
  for (const t of tables.slice(0, 12)) {
    try {
      profiles.push(await profile(engine, t.ref, t.columns));
    } catch {
      /* skip a table that cannot be read */
    }
  }
  const best = profiles.filter((p) => p.rows > 0).sort((a, b) => score(b) - score(a))[0];
  if (!best) return { ok: false, notes: [`${opts.source} has no rows to chart`] };

  const tableName = best.ref.split('.').pop()!.replaceAll('"', '');
  const title = opts.title ?? `${humanize(tableName)} overview`;
  const { spec, notes } = buildSpec(best, { source: opts.source, title });
  if (tables.length > 1) notes.push(`used table ${best.ref}; pass "table" for another`);

  let current = spec;
  for (let attempt = 0; attempt < 3; attempt++) {
    const check = await checkDashboard(current, engine);
    if (check.ok && check.spec) return { ok: true, spec: check.spec, check, notes };
    // Drop whatever failed and try again.
    const badPanels = new Set<number>();
    const badFilters = new Set<number>();
    for (const e of check.errors) {
      const m = /^panels\[(\d+)\]/.exec(e.path);
      if (m) badPanels.add(Number(m[1]));
      const f = /^filters\[(\d+)\]/.exec(e.path);
      if (f) badFilters.add(Number(f[1]));
    }
    if (badPanels.size === 0 && badFilters.size === 0) return { ok: false, check, notes: [...notes, ...check.errors.map((e) => `${e.path}: ${e.message}`)] };
    const droppedFilterIds = new Set((current.filters ?? []).filter((_, i) => badFilters.has(i)).map((f) => f.id));
    notes.push(...[...badPanels].map((i) => `left out panel "${current.panels[i]?.id}": it did not run`));
    const panels = current.panels.filter((_, i) => !badPanels.has(i));
    if (panels.length === 0) return { ok: false, check, notes };
    current = {
      ...current,
      filters: (current.filters ?? []).filter((f) => !droppedFilterIds.has(f.id)),
      panels,
    };
  }
  return { ok: false, notes: [...notes, 'the dashboard still had errors after removing failing panels'] };
}
