/**
 * Dashboard spec, version 1.
 *
 * The spec is deliberately small: SQL does all the analysis, and a panel only
 * maps result columns to a chart. Every panel type has its own schema so that
 * an error names one panel type rather than every possible shape.
 */
import { z } from 'zod';

export const SPEC_VERSION = 1;

export const PANEL_TYPES = ['kpi', 'bar', 'line', 'area', 'scatter', 'table', 'text'] as const;
export type PanelType = (typeof PANEL_TYPES)[number];

export const WIDTHS = ['full', 'half', 'third'] as const;
export type Width = (typeof WIDTHS)[number];

export const FORMATS = ['number', 'compact', 'currency', 'percent'] as const;
export type Format = (typeof FORMATS)[number];

export const FILTER_TYPES = ['select', 'text', 'date'] as const;

export const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

const ident = (what: string) =>
  z
    .string()
    .regex(IDENT_RE, `${what} must start with a letter or _ and contain only letters, digits and _ (max 64)`);

const column = z.string().min(1, 'column name must not be empty');
const sql = z.string().min(1, 'sql must not be empty').max(20_000);

const base = {
  id: ident('id'),
  title: z.string().max(120).optional(),
  width: z.enum(WIDTHS).optional(),
  note: z.string().max(300).optional(),
};

const query = {
  source: ident('source'),
  sql,
};

const look = {
  format: z.enum(FORMATS).optional(),
  unit: z.string().max(12).optional(),
};

export const KpiPanel = z.object({
  type: z.literal('kpi'),
  ...base,
  ...query,
  ...look,
  value: column,
  compare: column.optional(),
  /**
   * Optional time or order column. With `x`, the query returns a series: the
   * tile shows the last row's value, a sparkline of the whole series, and
   * (unless `compare` is set) the change from the row before.
   */
  x: column.optional(),
  /** "up" means a higher value is good (default); "down" flips the delta colour. */
  better: z.enum(['up', 'down']).optional(),
});

export const BarPanel = z.object({
  type: z.literal('bar'),
  ...base,
  ...query,
  ...look,
  x: column,
  y: z.union([column, z.array(column).min(1).max(12)]),
  series: column.optional(),
  stacked: z.boolean().optional(),
  horizontal: z.boolean().optional(),
});

export const LinePanel = z.object({
  type: z.literal('line'),
  ...base,
  ...query,
  ...look,
  x: column,
  y: z.union([column, z.array(column).min(1).max(12)]),
  series: column.optional(),
});

export const AreaPanel = z.object({
  type: z.literal('area'),
  ...base,
  ...query,
  ...look,
  x: column,
  y: z.union([column, z.array(column).min(1).max(12)]),
  series: column.optional(),
  stacked: z.boolean().optional(),
});

export const ScatterPanel = z.object({
  type: z.literal('scatter'),
  ...base,
  ...query,
  ...look,
  x: column,
  y: column,
  series: column.optional(),
});

export const TablePanel = z.object({
  type: z.literal('table'),
  ...base,
  ...query,
  ...look,
  /** Optional subset and order of columns to show. */
  columns: z.array(column).min(1).max(40).optional(),
  /** Per-column formats, e.g. { "revenue": "currency" }; `format` covers the rest. */
  formats: z.record(z.string().min(1).max(64), z.enum(FORMATS)).optional(),
});

export const TextPanel = z.object({
  type: z.literal('text'),
  ...base,
  markdown: z.string().min(1).max(5_000),
});

export const PANEL_SCHEMAS = {
  kpi: KpiPanel,
  bar: BarPanel,
  line: LinePanel,
  area: AreaPanel,
  scatter: ScatterPanel,
  table: TablePanel,
  text: TextPanel,
} as const;

export const Panel = z.discriminatedUnion('type', [
  KpiPanel,
  BarPanel,
  LinePanel,
  AreaPanel,
  ScatterPanel,
  TablePanel,
  TextPanel,
]);

export const Filter = z.object({
  id: ident('filter id'),
  label: z.string().min(1).max(60),
  type: z.enum(FILTER_TYPES),
  /** select only: options come from this source + query (first column). */
  source: ident('source').optional(),
  options_sql: sql.optional(),
  /** select only: a fixed list of options. */
  options: z.array(z.string().max(200)).max(500).optional(),
  default: z.string().max(200).optional(),
});

/** Top-level shape; panels are checked one by one with their own schema. */
export const DashboardShape = z.object({
  version: z.literal(SPEC_VERSION),
  title: z.string().min(1).max(120),
  description: z.string().max(500).optional(),
  filters: z.array(z.unknown()).max(6).optional(),
  panels: z.array(z.unknown()).min(1, 'a dashboard needs at least one panel').max(24),
});

/** The full schema, used for documentation and the JSON Schema. */
export const Dashboard = z.object({
  version: z.literal(SPEC_VERSION),
  title: z.string().min(1).max(120),
  description: z.string().max(500).optional(),
  filters: z.array(Filter).max(6).optional(),
  panels: z.array(Panel).min(1).max(24),
});

export type DashboardSpec = z.infer<typeof Dashboard>;
export type PanelSpec = z.infer<typeof Panel>;
export type FilterSpec = z.infer<typeof Filter>;
export type QueryPanelSpec = Exclude<PanelSpec, { type: 'text' }>;

export const DEFAULT_WIDTH: Record<PanelType, Width> = {
  kpi: 'third',
  bar: 'half',
  line: 'half',
  area: 'half',
  scatter: 'half',
  table: 'full',
  text: 'full',
};

export function isQueryPanel(p: PanelSpec): p is QueryPanelSpec {
  return p.type !== 'text';
}

/** The column references a panel makes, with the field each came from. */
export function panelColumnRefs(p: PanelSpec): { field: string; column: string }[] {
  const refs: { field: string; column: string }[] = [];
  const add = (field: string, v: string | string[] | undefined) => {
    if (v === undefined) return;
    if (Array.isArray(v)) v.forEach((c, i) => refs.push({ field: `${field}[${i}]`, column: c }));
    else refs.push({ field, column: v });
  };
  switch (p.type) {
    case 'kpi':
      add('value', p.value);
      add('compare', p.compare);
      add('x', p.x);
      break;
    case 'bar':
    case 'line':
    case 'area':
    case 'scatter':
      add('x', p.x);
      add('y', p.y);
      add('series', p.series);
      break;
    case 'table':
      add('columns', p.columns);
      for (const k of Object.keys(p.formats ?? {})) refs.push({ field: `formats.${k}`, column: k });
      break;
    case 'text':
      break;
  }
  return refs;
}

export function dashboardJsonSchema(): unknown {
  return z.toJSONSchema(Dashboard, { target: 'draft-7' });
}
