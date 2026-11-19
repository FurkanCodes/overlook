/**
 * Lenient front door: fix the mistakes models make most often, and record
 * every change so nothing is silently rewritten.
 */
import { PANEL_TYPES, SPEC_VERSION, WIDTHS } from './schema.js';
import type { SpecError, SpecRepair } from './errors.js';

const TYPE_ALIASES: Record<string, string> = {
  column: 'bar',
  columns: 'bar',
  bars: 'bar',
  barchart: 'bar',
  bar_chart: 'bar',
  histogram: 'bar',
  lines: 'line',
  linechart: 'line',
  line_chart: 'line',
  timeseries: 'line',
  time_series: 'line',
  areachart: 'area',
  area_chart: 'area',
  points: 'scatter',
  point: 'scatter',
  scatterplot: 'scatter',
  scatter_plot: 'scatter',
  number: 'kpi',
  metric: 'kpi',
  stat: 'kpi',
  big_number: 'kpi',
  card: 'kpi',
  grid: 'table',
  datatable: 'table',
  data_table: 'table',
  markdown: 'text',
  note: 'text',
  heading: 'text',
};

const UNSUPPORTED_TYPES: Record<string, string> = {
  pie: 'pie charts are not supported; use "bar" (sorted, horizontal: true) to compare shares',
  donut: 'donut charts are not supported; use "bar" with horizontal: true',
  doughnut: 'donut charts are not supported; use "bar" with horizontal: true',
  map: 'maps are not supported; use "bar" or "table" grouped by region',
  heatmap: 'heatmaps are not supported; use "table" or a "bar" with series',
  gauge: 'gauges are not supported; use "kpi" with compare',
};

const WIDTH_ALIASES: Record<string, string> = {
  wide: 'full',
  '100%': 'full',
  '1': 'full',
  '50%': 'half',
  '1/2': 'half',
  narrow: 'third',
  '33%': 'third',
  '1/3': 'third',
};

const BOOL_FIELDS = ['stacked', 'horizontal'];

export interface RepairResult {
  value: unknown;
  repairs: SpecRepair[];
  errors: SpecError[];
}

function isObj(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Parse a spec that may arrive as a JSON string (some clients send that). */
export function parseSpecInput(raw: unknown): { value: unknown; error?: SpecError; repaired?: SpecRepair } {
  if (typeof raw !== 'string') return { value: raw };
  const text = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    return {
      value: JSON.parse(text),
      repaired: { path: '', from: 'string', to: 'object', reason: 'spec was sent as a JSON string; parsed it' },
    };
  } catch (e) {
    return {
      value: undefined,
      error: { path: '', message: `spec is a string but not valid JSON: ${(e as Error).message}`, fix: 'send the spec as a JSON object' },
    };
  }
}

export function repairInput(raw: unknown): RepairResult {
  const repairs: SpecRepair[] = [];
  const errors: SpecError[] = [];
  const parsed = parseSpecInput(raw);
  if (parsed.error) return { value: undefined, repairs, errors: [parsed.error] };
  if (parsed.repaired) repairs.push(parsed.repaired);
  let spec = parsed.value;

  // A bare array of panels.
  if (Array.isArray(spec)) {
    repairs.push({ path: '', from: 'array', to: 'object', reason: 'spec was a bare array; treated it as "panels"' });
    spec = { panels: spec };
  }
  if (!isObj(spec)) {
    return { value: spec, repairs, errors: [{ path: '', message: 'spec must be a JSON object', fix: 'send {"version": 1, "title": "...", "panels": [...]}' }] };
  }
  const out: Record<string, unknown> = { ...spec };

  // Some models wrap the spec: {"dashboard": {...}}.
  if (out.panels === undefined && isObj(out.dashboard)) {
    repairs.push({ path: 'dashboard', from: 'wrapped', to: 'unwrapped', reason: 'spec was wrapped in "dashboard"; unwrapped it' });
    Object.assign(out, out.dashboard);
    delete out.dashboard;
  }

  if (out.version === undefined) {
    out.version = SPEC_VERSION;
    repairs.push({ path: 'version', from: undefined, to: SPEC_VERSION, reason: 'version was missing; set to 1' });
  } else if (out.version === '1' || out.version === 1.0) {
    if (out.version !== SPEC_VERSION) repairs.push({ path: 'version', from: out.version, to: SPEC_VERSION, reason: 'version must be the number 1' });
    out.version = SPEC_VERSION;
  }

  if (typeof out.panels === 'string') {
    try {
      out.panels = JSON.parse(out.panels);
      repairs.push({ path: 'panels', from: 'string', to: 'array', reason: 'panels was a JSON string; parsed it' });
    } catch {
      /* the schema check will report it */
    }
  }

  if (Array.isArray(out.panels)) {
    const usedIds = new Set<string>();
    out.panels = out.panels.map((p, i) => {
      if (!isObj(p)) return p;
      const panel: Record<string, unknown> = { ...p };
      const at = `panels[${i}]`;

      if (typeof panel.type === 'string') {
        const t = panel.type.trim().toLowerCase().replace(/[\s-]+/g, '_');
        const mapped = TYPE_ALIASES[t] ?? t;
        if (UNSUPPORTED_TYPES[t]) {
          errors.push({ path: `${at}.type`, message: `"${panel.type}" is not a supported panel type`, fix: UNSUPPORTED_TYPES[t] });
        } else if (mapped !== panel.type) {
          if ((PANEL_TYPES as readonly string[]).includes(mapped)) {
            repairs.push({ path: `${at}.type`, from: panel.type, to: mapped, reason: `"${panel.type}" means "${mapped}"` });
          }
          panel.type = mapped;
        }
      }

      if (typeof panel.width === 'string' && !(WIDTHS as readonly string[]).includes(panel.width)) {
        const w = WIDTH_ALIASES[panel.width.trim().toLowerCase()];
        if (w) {
          repairs.push({ path: `${at}.width`, from: panel.width, to: w, reason: `"${panel.width}" means "${w}"` });
          panel.width = w;
        }
      }

      for (const f of BOOL_FIELDS) {
        if (panel[f] === 'true' || panel[f] === 'false') {
          const b = panel[f] === 'true';
          repairs.push({ path: `${at}.${f}`, from: panel[f], to: b, reason: `${f} must be a boolean` });
          panel[f] = b;
        }
      }

      // A missing id gets a stable one from the title or type.
      if (panel.id === undefined || panel.id === '') {
        const baseId =
          (typeof panel.title === 'string' ? panel.title : String(panel.type ?? 'panel'))
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '_')
            .replace(/^_+|_+$/g, '')
            .replace(/^(\d)/, 'p_$1')
            .slice(0, 40) || 'panel';
        let id = baseId;
        for (let n = 2; usedIds.has(id); n++) id = `${baseId}_${n}`;
        panel.id = id;
        repairs.push({ path: `${at}.id`, from: undefined, to: id, reason: 'id was missing; generated one' });
      }
      if (typeof panel.id === 'string') usedIds.add(panel.id);

      // `query` is a common synonym for `sql`.
      if (panel.sql === undefined && typeof panel.query === 'string') {
        panel.sql = panel.query;
        delete panel.query;
        repairs.push({ path: `${at}.sql`, from: 'query', to: 'sql', reason: '"query" renamed to "sql"' });
      }
      if (typeof panel.sql === 'string') {
        const trimmed = panel.sql.trim();
        const noSemi = trimmed.replace(/;\s*$/, '');
        if (noSemi !== trimmed) {
          repairs.push({ path: `${at}.sql`, from: 'trailing ;', to: 'removed', reason: 'removed the trailing semicolon' });
        }
        if (noSemi !== panel.sql) panel.sql = noSemi;
      }
      return panel;
    });
  }

  return { value: out, repairs, errors };
}
