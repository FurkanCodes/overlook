/**
 * The checking pipeline. A dashboard is saved only when every panel is
 * valid (schema), executable (its query runs) and fits its chart (every
 * referenced column exists with a usable type).
 */
import { z } from 'zod';
import type { ColumnInfo, Engine, QueryResult } from './engine/engine.js';
import { QueryError } from './engine/engine.js';
import {
  formatErrors,
  fromZodIssues,
  suggestions,
  caseOnlyMatch,
  type SpecError,
  type SpecRepair,
  type SpecWarning,
} from './spec/errors.js';
import { repairInput } from './spec/repair.js';
import {
  DashboardShape,
  Filter,
  PANEL_SCHEMAS,
  PANEL_TYPES,
  isQueryPanel,
  panelColumnRefs,
  type DashboardSpec,
  type FilterSpec,
  type PanelSpec,
  type PanelType,
  type QueryPanelSpec,
} from './spec/schema.js';

export interface PanelCheck {
  id: string;
  type: string;
  ok: boolean;
  rows?: number;
  columns?: ColumnInfo[];
  ms?: number;
  error?: string;
}

export interface CheckResult {
  ok: boolean;
  /** The repaired, validated spec (present when ok). */
  spec?: DashboardSpec;
  errors: SpecError[];
  warnings: SpecWarning[];
  repairs: SpecRepair[];
  panels: PanelCheck[];
}

export interface CheckOptions {
  /** Total time budget for running every query (default 30 s). */
  budgetMs?: number;
  /** Per-query timeout (default 10 s). */
  perQueryMs?: number;
  /** Queries run at once (default 4). */
  concurrency?: number;
  /** Skip running queries (schema and reference checks only). */
  skipQueries?: boolean;
}

export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isObj(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function unknownKeys(obj: Record<string, unknown>, schema: z.ZodObject): string[] {
  const known = new Set(Object.keys(schema.shape));
  return Object.keys(obj).filter((k) => !known.has(k));
}

/** Default values filters bind while checking: the default, or NULL. */
export function filterDefaults(filters: readonly FilterSpec[] | undefined): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const f of filters ?? []) out[f.id] = f.default ?? null;
  return out;
}

async function runLimited<T>(items: readonly T[], concurrency: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      await fn(items[i]!);
    }
  });
  await Promise.all(workers);
}

/** Merge identical errors that only differ in path. */
export function mergeErrors(errors: readonly SpecError[]): SpecError[] {
  const byKey = new Map<string, SpecError>();
  const order: string[] = [];
  for (const e of errors) {
    const key = `${e.message}\u0000${e.fix ?? ''}`;
    const prev = byKey.get(key);
    if (prev) {
      if (!prev.path.split(', ').includes(e.path)) prev.path = prev.path ? `${prev.path}, ${e.path}` : e.path;
    } else {
      byKey.set(key, { ...e });
      order.push(key);
    }
  }
  return order.map((k) => byKey.get(k)!);
}

export async function checkDashboard(input: unknown, engine: Engine, opts: CheckOptions = {}): Promise<CheckResult> {
  // A save gives each query the same 15 s the page does, so anything that
  // works on the page can be saved. 40 s total stays under agents' usual
  // 60 s tool timeout.
  const budgetMs = opts.budgetMs ?? 40_000;
  const perQueryMs = opts.perQueryMs ?? 15_000;
  const concurrency = opts.concurrency ?? 4;
  const started = Date.now();

  const repaired = repairInput(input);
  const repairs = [...repaired.repairs];
  const errors: SpecError[] = [...repaired.errors];
  const warnings: SpecWarning[] = [];
  const panelChecks: PanelCheck[] = [];
  const value = repaired.value;

  const finish = (spec?: DashboardSpec): CheckResult => {
    const merged = mergeErrors(errors);
    return { ok: merged.length === 0 && spec !== undefined, spec: merged.length === 0 ? spec : undefined, errors: merged, warnings, repairs, panels: panelChecks };
  };

  if (!isObj(value)) {
    if (errors.length === 0) errors.push({ path: '', message: 'spec must be a JSON object' });
    return finish();
  }

  // 1. Top-level shape.
  const top = DashboardShape.safeParse(value);
  if (!top.success) {
    errors.push(...fromZodIssues(top.error.issues, value));
  }
  for (const k of unknownKeys(value, DashboardShape)) {
    warnings.push({ path: k, message: `unknown field "${k}" was ignored` });
  }
  const rawPanels = Array.isArray(value.panels) ? value.panels : [];
  const rawFilters = Array.isArray(value.filters) ? value.filters : [];

  // 2. Filters.
  const filters: FilterSpec[] = [];
  const filterIds = new Set<string>();
  const aliases = new Set(engine.aliases());
  rawFilters.forEach((raw, i) => {
    const at = `filters[${i}]`;
    const r = Filter.safeParse(raw);
    if (!r.success) {
      errors.push(...fromZodIssues(r.error.issues, raw, at));
      return;
    }
    const f = r.data;
    if (isObj(raw)) for (const k of unknownKeys(raw, Filter)) warnings.push({ path: `${at}.${k}`, message: `unknown field "${k}" was ignored` });
    if (filterIds.has(f.id)) errors.push({ path: `${at}.id`, message: `duplicate filter id "${f.id}"`, fix: 'give every filter a different id' });
    filterIds.add(f.id);
    if (f.type === 'select') {
      const hasList = f.options !== undefined;
      const hasSql = f.options_sql !== undefined;
      if (hasList === hasSql) {
        errors.push({ path: at, message: 'a select filter needs exactly one of "options" or "options_sql"', fix: 'add "options": ["A","B"], or "options_sql" with "source"' });
      } else if (hasSql && !f.source) {
        errors.push({ path: `${at}.source`, message: '"options_sql" needs "source"', fix: `set "source" to one of: ${[...aliases].join(', ') || '(no sources registered)'}` });
      } else if (hasSql && f.source && !aliases.has(f.source)) {
        errors.push(sourceError(`${at}.source`, f.source, aliases));
      }
    } else if (f.options !== undefined || f.options_sql !== undefined) {
      warnings.push({ path: at, message: `"options" only apply to select filters; ignored for a ${f.type} filter` });
    }
    if (f.type === 'date' && f.default !== undefined && !DATE_RE.test(f.default)) {
      errors.push({ path: `${at}.default`, message: `"${f.default}" is not a date`, fix: 'use YYYY-MM-DD, e.g. "2026-01-31"' });
    }
    filters.push(f);
  });

  // 3. Panels: shape and references.
  const panels: (PanelSpec | undefined)[] = [];
  const panelIds = new Set<string>();
  const panelHasError = new Set<number>();
  rawPanels.forEach((raw, i) => {
    const at = `panels[${i}]`;
    const before = errors.length;
    if (!isObj(raw)) {
      errors.push({ path: at, message: 'each panel must be an object' });
      panels.push(undefined);
      panelHasError.add(i);
      return;
    }
    const type = raw.type;
    if (typeof type !== 'string' || !(PANEL_TYPES as readonly string[]).includes(type)) {
      if (!errors.some((e) => e.path === `${at}.type`)) {
        errors.push({
          path: `${at}.type`,
          message: type === undefined ? 'panel type is missing' : `"${String(type)}" is not a panel type`,
          fix: `use one of: ${PANEL_TYPES.join(', ')}`,
        });
      }
      panels.push(undefined);
      panelHasError.add(i);
      panelChecks.push({ id: String(raw.id ?? at), type: String(type), ok: false, error: 'invalid panel type' });
      return;
    }
    const schema = PANEL_SCHEMAS[type as PanelType];
    const r = schema.safeParse(raw);
    if (!r.success) {
      errors.push(...fromZodIssues(r.error.issues, raw, at));
      panels.push(undefined);
    } else {
      for (const k of unknownKeys(raw, schema)) warnings.push({ path: `${at}.${k}`, message: `field "${k}" does not apply to a ${type} panel and was ignored` });
      const p = r.data as PanelSpec;
      if (panelIds.has(p.id)) errors.push({ path: `${at}.id`, message: `duplicate panel id "${p.id}"`, fix: 'give every panel a different id' });
      panelIds.add(p.id);
      if (isQueryPanel(p)) {
        if (!aliases.has(p.source)) errors.push(sourceError(`${at}.source`, p.source, aliases));
        else if (engine.sourceErrors[p.source]) {
          errors.push({ path: `${at}.source`, message: `source "${p.source}" could not be opened: ${engine.sourceErrors[p.source]}`, fix: 'ask the user to fix the source (overlook doctor)' });
        }
        if ((p.type === 'bar' || p.type === 'line' || p.type === 'area') && Array.isArray(p.y) && p.series) {
          errors.push({ path: `${at}.series`, message: 'use either several "y" columns or one "y" with "series", not both', fix: 'remove "series", or make "y" a single column' });
        }
      }
      panels.push(p);
    }
    if (errors.length > before) panelHasError.add(i);
  });

  // 4–5. Run queries and check fields, per panel.
  if (!opts.skipQueries) {
    const defaults = filterDefaults(filters);
    const jobs: { i: number; p: QueryPanelSpec }[] = [];
    panels.forEach((p, i) => {
      if (p && isQueryPanel(p) && !panelHasError.has(i)) jobs.push({ i, p });
      else if (p && !isQueryPanel(p)) panelChecks.push({ id: p.id, type: p.type, ok: true });
      else if (p) panelChecks.push({ id: p.id, type: p.type, ok: false, error: 'not run: fix the errors above first' });
    });
    const results = new Map<number, PanelCheck>();

    await runLimited(jobs, concurrency, async ({ i, p }) => {
      const at = `panels[${i}]`;
      const remaining = budgetMs - (Date.now() - started);
      if (remaining <= 250) {
        errors.push({ path: `${at}.sql`, message: `not checked in time: the save check has a ${Math.round(budgetMs / 1000)} s budget for all panels`, fix: 'make slow queries faster (aggregate, filter early), or save fewer panels at once' });
        results.set(i, { id: p.id, type: p.type, ok: false, error: 'not checked in time' });
        return;
      }
      let res: QueryResult;
      try {
        const names = await engine.parameters(p.sql);
        const undeclared = names.filter((n) => !filterIds.has(n));
        if (undeclared.length > 0) {
          errors.push({
            path: `${at}.sql`,
            message: `uses ${undeclared.map((n) => `$${n}`).join(', ')} but no filter with that id is declared`,
            fix: filterIds.size ? `declared filters: ${[...filterIds].join(', ')}` : 'add a filter to "filters", or remove the parameter',
          });
          results.set(i, { id: p.id, type: p.type, ok: false, error: 'undeclared parameter' });
          return;
        }
        for (const n of names) {
          if (defaults[n] === null && !new RegExp(`\\$${n}\\s+IS\\s+NULL`, 'i').test(p.sql)) {
            warnings.push({
              path: `${at}.sql`,
              message: `$${n} has no default and the query has no "$${n} IS NULL" guard, so the panel is empty until a value is picked; write WHERE ($${n} IS NULL OR ...)`,
            });
          }
        }
        res = await engine.run(p.sql, defaults, { limit: 5000, timeoutMs: Math.min(perQueryMs, remaining) });
      } catch (e) {
        const msg = e instanceof QueryError || e instanceof Error ? e.message : String(e);
        errors.push({ path: `${at}.sql`, message: msg, fix: e instanceof QueryError && e.kind === 'duckdb' ? 'fix the SQL; call describe_data or preview_query to check table and column names' : undefined });
        results.set(i, { id: p.id, type: p.type, ok: false, error: msg });
        return;
      }
      const before = errors.length;
      checkFields(p, i, res, errors, warnings, repairs);
      results.set(i, { id: p.id, type: p.type, ok: errors.length === before, rows: res.rows.length, columns: res.columns, ms: res.ms });
    });

    // Keep panel order stable.
    const ordered: PanelCheck[] = [];
    panels.forEach((p, i) => {
      const r = results.get(i);
      if (r) ordered.push(r);
      else {
        const existing = panelChecks.find((c) => c.id === (p?.id ?? `panels[${i}]`));
        if (existing) ordered.push(existing);
      }
    });
    panelChecks.splice(0, panelChecks.length, ...ordered);

    // Filter options.
    for (const [i, f] of filters.entries()) {
      if (f.type !== 'select' || !f.options_sql || !f.source || !aliases.has(f.source)) continue;
      const remaining = budgetMs - (Date.now() - started);
      if (remaining <= 250) {
        errors.push({ path: `filters[${i}].options_sql`, message: `not checked in time: the save check has a ${Math.round(budgetMs / 1000)} s budget` });
        continue;
      }
      try {
        const r = await engine.run(f.options_sql, {}, { limit: 500, timeoutMs: Math.min(perQueryMs, remaining) });
        if (r.columns.length !== 1) {
          errors.push({ path: `filters[${i}].options_sql`, message: `must return exactly one column; it returned ${r.columns.length}`, fix: 'SELECT DISTINCT <column> FROM ... ORDER BY 1' });
        }
        if (r.rows.length === 0) warnings.push({ path: `filters[${i}].options_sql`, message: 'returned no options' });
      } catch (e) {
        errors.push({ path: `filters[${i}].options_sql`, message: (e as Error).message });
      }
    }
  }

  // Sort errors by where they occur in the spec.
  errors.sort((a, b) => pathOrder(a.path) - pathOrder(b.path));

  if (errors.length > 0 || !top.success) return finish();
  const spec: DashboardSpec = {
    version: 1,
    title: top.data.title,
    ...(top.data.description !== undefined ? { description: top.data.description } : {}),
    ...(filters.length > 0 ? { filters } : {}),
    panels: panels as PanelSpec[],
  };
  return finish(spec);
}

function pathOrder(path: string): number {
  const m = /^(filters|panels)\[(\d+)\]/.exec(path);
  if (!m) return -1;
  return (m[1] === 'filters' ? 0 : 1000) + Number(m[2]);
}

function sourceError(path: string, source: string, aliases: Set<string>): SpecError {
  const list = [...aliases];
  if (list.length === 0) {
    return { path, message: `no data sources are registered, so "${source}" cannot be used`, fix: 'ask the user to run: overlook source add <name> <file>' };
  }
  const close = suggestions(source, list, 1)[0];
  return { path, message: `"${source}" is not a registered source`, fix: close ? `did you mean "${close}"? sources: ${list.join(', ')}` : `sources: ${list.join(', ')}` };
}

const NEEDS_NUMBER = new Set(['y', 'value', 'compare']);

function setField(p: QueryPanelSpec, field: string, value: string): void {
  if (p.type === 'table' && p.formats && field.startsWith('formats.')) {
    // A key of the formats map: rename it, keeping the order.
    const old = field.slice('formats.'.length);
    p.formats = Object.fromEntries(Object.entries(p.formats).map(([k, v]) => [k === old ? value : k, v]));
    return;
  }
  const m = /^(\w+)(?:\[(\d+)\])?$/.exec(field);
  if (!m) return;
  const key = m[1]!;
  const rec = p as unknown as Record<string, unknown>;
  if (m[2] !== undefined) {
    const arr = rec[key];
    if (Array.isArray(arr)) arr[Number(m[2])] = value;
  } else {
    rec[key] = value;
  }
}

function checkFields(
  p: QueryPanelSpec,
  i: number,
  res: QueryResult,
  errors: SpecError[],
  warnings: SpecWarning[],
  repairs: SpecRepair[],
): void {
  const at = `panels[${i}]`;
  const names = res.columns.map((c) => c.name);
  const byName = new Map(res.columns.map((c) => [c.name, c]));

  for (const ref of panelColumnRefs(p)) {
    let col = byName.get(ref.column);
    if (!col) {
      const fixName = caseOnlyMatch(ref.column, names);
      if (fixName) {
        setField(p, ref.field, fixName);
        repairs.push({ path: `${at}.${ref.field}`, from: ref.column, to: fixName, reason: `column names are case-sensitive; the result has "${fixName}"` });
        col = byName.get(fixName);
      } else {
        const close = suggestions(ref.column, names);
        errors.push({
          path: `${at}.${ref.field}`,
          message: `column "${ref.column}" is not in the query result`,
          fix: `${close.length ? `did you mean ${close.map((c) => `"${c}"`).join(' or ')}? ` : ''}result columns: ${names.join(', ')}`,
        });
        continue;
      }
    }
    if (!col) continue;
    const baseField = ref.field.replace(/\[\d+\]$/, '');
    if (NEEDS_NUMBER.has(baseField) && col.kind !== 'number') {
      errors.push({
        path: `${at}.${ref.field}`,
        message: `"${col.name}" is ${col.type}, but ${baseField} must be a number`,
        fix: `cast it in SQL, e.g. CAST(${col.name} AS DOUBLE), or plot a numeric column`,
      });
    }
    if (baseField === 'x' && (p.type === 'line' || p.type === 'area') && col.kind === 'text') {
      warnings.push({ path: `${at}.x`, message: `"${col.name}" is text; line and area charts read best with a date or number on x (cast it, e.g. CAST(${col.name} AS DATE))` });
    }
    if (baseField === 'x' && p.type === 'scatter' && col.kind !== 'number' && col.kind !== 'date') {
      errors.push({ path: `${at}.x`, message: `"${col.name}" is ${col.type}; a scatter chart needs a number or date on x`, fix: 'use a "bar" chart for categories' });
    }
  }

  // Warnings that do not block saving.
  if (res.rows.length === 0) {
    warnings.push({ path: at, message: 'the query returned no rows with the default filter values; the panel will be empty' });
  }
  if (res.truncated) {
    warnings.push({ path: at, message: 'the query returned more than 5000 rows; only the first 5000 are shown. Aggregate in SQL (GROUP BY) instead' });
  }
  if (p.type === 'kpi' && !p.x && res.rows.length > 1) {
    warnings.push({ path: at, message: `a KPI shows only the first row, but the query returned ${res.rows.length}; aggregate to one row, or set "x" to show a trend` });
  }
  if (p.type === 'kpi' && p.x && res.rows.length < 2) {
    warnings.push({ path: at, message: 'a KPI with "x" needs at least 2 rows to draw a trend' });
  }
  if ((p.type === 'bar' || p.type === 'line' || p.type === 'area') && p.x) {
    const xs = new Set(res.rows.map((r) => String(r[p.x])));
    if (p.type === 'bar' && xs.size > 50) {
      warnings.push({ path: `${at}.x`, message: `${xs.size} bars is too many to read; keep the top 20 with ORDER BY ... LIMIT 20` });
    }
    if (p.series && byName.has(p.series)) {
      const series = new Set(res.rows.map((r) => String(r[p.series!])));
      if (series.size > 12) warnings.push({ path: `${at}.series`, message: `${series.size} series is too many to tell apart; keep the top 8 and group the rest as "Other"` });
    }
  }
}

/** Short text for tool replies. `verdict` opens the error list. */
export function summarizeCheck(r: CheckResult, verdict = 'The dashboard was NOT saved.'): string {
  const parts: string[] = [];
  if (r.errors.length > 0) {
    parts.push(`${verdict} ${r.errors.length} problem${r.errors.length === 1 ? '' : 's'} to fix:`);
    parts.push(formatErrors(r.errors));
  }
  if (r.repairs.length > 0) {
    parts.push('Automatic fixes applied:');
    parts.push(r.repairs.map((x) => `- ${x.path || 'spec'}: ${x.reason}`).join('\n'));
  }
  if (r.warnings.length > 0) {
    parts.push('Warnings (saved anyway):');
    parts.push(r.warnings.slice(0, 8).map((w) => `- ${w.path ? `${w.path}: ` : ''}${w.message}`).join('\n'));
  }
  return parts.join('\n');
}
