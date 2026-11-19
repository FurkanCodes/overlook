/**
 * SVG chart renderers: bar, line, area, scatter.
 *
 * Mark specs follow one system: bars at most 24px thick with a 4px rounded
 * data end and a square baseline end, 2px lines, 8px end dots with a 2px
 * surface ring, 10% area washes, hairline gridlines, a 2px surface gap
 * between stacked segments, a legend for two or more series, and a hover
 * tooltip on every chart. Colors are CSS classes (the page CSP blocks inline
 * style attributes), assigned per series name in a fixed order.
 */
import { bisector, extent, max, min } from 'd3-array';
import { scaleBand, scaleLinear, scalePoint, scaleTime, type ScaleBand, type ScaleLinear, type ScalePoint, type ScaleTime } from 'd3-scale';
import { area as d3area, curveMonotoneX, line as d3line } from 'd3-shape';
import type { Format } from '../src/spec/schema.js';
import { h, s } from './dom.js';
import { dateFormatter, formatValue, parseDate, toNumber, type ColumnInfo } from './format.js';

export type Row = Record<string, unknown>;

export interface ChartPanel {
  type: 'bar' | 'line' | 'area' | 'scatter';
  x: string;
  y: string | string[];
  series?: string;
  stacked?: boolean;
  horizontal?: boolean;
  format?: Format;
  unit?: string;
}

export interface ChartData {
  columns: ColumnInfo[];
  rows: Row[];
}

/**
 * Gives each series a color slot (1–8). Every chart starts at slot 1, and a
 * series keeps its slot, so a filter that hides one series never repaints
 * the others. Slots are remembered across reloads in this browser, and new
 * names are handed out in sorted order, never in SQL row order (which DuckDB
 * does not fix for tied rows), so the same data always gets the same colors.
 */
export class ColorBook {
  private charts = new Map<string, Map<string, number>>();
  constructor(private storageKey?: string) {
    if (!storageKey) return;
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey) ?? '{}') as Record<string, Record<string, number>>;
      for (const [chart, slots] of Object.entries(saved)) this.charts.set(chart, new Map(Object.entries(slots)));
    } catch {
      /* storage blocked or corrupt: start fresh */
    }
  }
  /** Assign slots to any new names, in sorted order. */
  register(chart: string, names: readonly string[]): void {
    const slots = this.slots(chart);
    const fresh = names.filter((n) => !slots.has(n)).sort((a, b) => a.localeCompare(b));
    if (fresh.length === 0) return;
    for (const n of fresh) slots.set(n, (slots.size % 8) + 1);
    this.save();
  }
  slot(chart: string, name: string): number {
    const slots = this.slots(chart);
    let n = slots.get(name);
    if (n === undefined) {
      n = (slots.size % 8) + 1;
      slots.set(name, n);
      this.save();
    }
    return n;
  }
  private slots(chart: string): Map<string, number> {
    let slots = this.charts.get(chart);
    if (!slots) {
      slots = new Map();
      this.charts.set(chart, slots);
    }
    return slots;
  }
  private save(): void {
    if (!this.storageKey) return;
    try {
      const out: Record<string, Record<string, number>> = {};
      for (const [chart, slots] of this.charts) out[chart] = Object.fromEntries(slots);
      localStorage.setItem(this.storageKey, JSON.stringify(out));
    } catch {
      /* storage blocked: colors still hold for this page */
    }
  }
}

type XKind = 'time' | 'number' | 'category';

interface Point {
  x: unknown;
  /** Numeric/time position for continuous x. */
  xv: number;
  /** Category key for band/point x. */
  xk: string;
  y: number | null;
}

interface Series {
  name: string;
  slot: number;
  points: Point[];
}

interface Prepared {
  xKind: XKind;
  series: Series[];
  /** Ordered category keys (category x) or sorted numeric x values. */
  xKeys: string[];
  xLabel: (p: Point) => string;
  hidden: number;
}

const MAX_SERIES = 8;
const SCATTER_MAX_SERIES = 3;
const OTHER = 'Other';

function xKindOf(col: ColumnInfo | undefined, chart: ChartPanel['type']): XKind {
  if (chart === 'bar') return 'category';
  if (col?.kind === 'date') return 'time';
  if (col?.kind === 'number') return 'number';
  return 'category';
}

function prepare(panel: ChartPanel, data: ChartData, colors: ColorBook, colorKey: string): Prepared {
  const xCol = data.columns.find((c) => c.name === panel.x);
  const xKind = xKindOf(xCol, panel.type);
  const ys = Array.isArray(panel.y) ? panel.y : [panel.y];
  const dates: Date[] = [];

  const keyOf = (v: unknown): string => {
    if (v === null || v === undefined) return '∅';
    return String(v);
  };
  const posOf = (v: unknown): number => {
    if (xKind === 'time') {
      const d = parseDate(v);
      if (d) dates.push(d);
      return d ? d.getTime() : NaN;
    }
    if (xKind === 'number') return toNumber(v) ?? NaN;
    return NaN;
  };

  // Build raw series.
  const map = new Map<string, Point[]>();
  const order: string[] = [];
  const push = (name: string, p: Point) => {
    let arr = map.get(name);
    if (!arr) {
      arr = [];
      map.set(name, arr);
      order.push(name);
    }
    arr.push(p);
  };
  for (const row of data.rows) {
    const xv = posOf(row[panel.x]);
    const xk = keyOf(row[panel.x]);
    if (xKind !== 'category' && Number.isNaN(xv)) continue;
    if (panel.series) {
      push(keyOf(row[panel.series]), { x: row[panel.x], xv, xk, y: toNumber(row[ys[0]!]) });
    } else {
      for (const y of ys) push(y, { x: row[panel.x], xv, xk, y: toNumber(row[y]) });
    }
  }

  // Fold extra series so no generated hue is ever needed.
  const cap = panel.type === 'scatter' ? SCATTER_MAX_SERIES : MAX_SERIES;
  let names = order;
  let hidden = 0;
  if (order.length > cap) {
    const totals = order.map((n) => ({ n, t: (map.get(n) ?? []).reduce((a, p) => a + Math.abs(p.y ?? 0), 0) })).sort((a, b) => b.t - a.t);
    const keep = new Set(totals.slice(0, cap - 1).map((t) => t.n));
    const rest = order.filter((n) => !keep.has(n));
    hidden = rest.length;
    if (panel.type === 'line') {
      names = order.filter((n) => keep.has(n));
    } else if (panel.type === 'scatter') {
      // Scatter points are individual rows: "Other" collects them, it never
      // sums points from different series into points that do not exist.
      map.set(OTHER, rest.flatMap((n) => map.get(n) ?? []));
      names = [...order.filter((n) => keep.has(n)), OTHER];
      hidden = 0;
    } else {
      const other = new Map<string, Point>();
      for (const n of rest) {
        for (const p of map.get(n) ?? []) {
          const k = xKind === 'category' ? p.xk : String(p.xv);
          const prev = other.get(k);
          if (prev) prev.y = (prev.y ?? 0) + (p.y ?? 0);
          else other.set(k, { ...p });
        }
      }
      map.set(OTHER, [...other.values()]);
      names = [...order.filter((n) => keep.has(n)), OTHER];
      hidden = 0;
    }
  }

  if (panel.series) {
    // Series named by a column come back in no fixed order: give them slots
    // by name and list them by slot, so legend, stacking and colors are the
    // same on every load. "Other" stays last.
    const named = names.filter((n) => n !== OTHER);
    colors.register(colorKey, named);
    const bySlot = (n: string) => colors.slot(colorKey, n);
    names = [...named.sort((a, b) => bySlot(a) - bySlot(b) || a.localeCompare(b)), ...(names.includes(OTHER) ? [OTHER] : [])];
  }

  const series: Series[] = names.map((name) => ({
    name,
    slot: colors.slot(colorKey, name),
    points: (map.get(name) ?? []).slice().sort((a, b) => (xKind === 'category' ? 0 : a.xv - b.xv)),
  }));

  // x keys in first-seen order for categories, sorted for continuous.
  const seen = new Set<string>();
  const xKeys: string[] = [];
  for (const row of data.rows) {
    const k = xKind === 'category' ? keyOf(row[panel.x]) : String(posOf(row[panel.x]));
    if (!seen.has(k) && k !== 'NaN') {
      seen.add(k);
      xKeys.push(k);
    }
  }
  if (xKind !== 'category') xKeys.sort((a, b) => Number(a) - Number(b));

  const dfmt = dateFormatter(dates);
  const isDateCol = xCol?.kind === 'date';
  const xLabel = (p: Point): string => {
    if (xKind === 'time' || (isDateCol && xKind === 'category')) {
      const d = parseDate(p.x);
      return d ? dfmt(d) : String(p.x);
    }
    if (xKind === 'number') return formatValue(p.x, undefined, undefined);
    return p.xk;
  };
  // Category date labels need the formatter built from all dates.
  if (isDateCol && xKind === 'category') {
    for (const row of data.rows) {
      const d = parseDate(row[panel.x]);
      if (d) dates.push(d);
    }
  }
  return { xKind, series, xKeys, xLabel, hidden };
}

/* ---------------------------------------------------------------- layout */

interface Frame {
  width: number;
  height: number;
  m: { top: number; right: number; bottom: number; left: number };
}

function textWidth(text: string, px = 11): number {
  // Close enough for tick labels in the UI sans; avoids layout reads.
  return text.length * px * 0.58 + 2;
}

function truncate(text: string, maxPx: number, px = 11): string {
  if (textWidth(text, px) <= maxPx) return text;
  const n = Math.max(1, Math.floor((maxPx - 8) / (px * 0.58)));
  return `${text.slice(0, n)}…`;
}

/* --------------------------------------------------------------- tooltip */

export interface TooltipRow {
  slot?: number;
  label: string;
  value: string;
  strong?: boolean;
}

export class Tooltip {
  readonly el: HTMLDivElement;
  constructor(private host: HTMLElement) {
    // Not a live region: it changes on every pointer move. Focusable chart
    // marks carry their own aria-label instead.
    this.el = h('div', { class: 'tooltip', 'aria-hidden': 'true' });
    host.append(this.el);
  }
  show(title: string, rows: TooltipRow[], px: number, py: number): void {
    this.el.replaceChildren(
      h('div', { class: 'tooltip-title' }, title),
      ...rows.map((r) =>
        h(
          'div',
          { class: `tooltip-row${r.strong ? ' strong' : ''}` },
          r.slot ? h('span', { class: `swatch b${r.slot}` }) : null,
          h('span', { class: 'tooltip-label' }, r.label),
          h('span', { class: 'tooltip-value' }, r.value),
        ),
      ),
    );
    this.el.classList.add('visible');
    const hw = this.host.clientWidth;
    const hh = this.host.clientHeight;
    const tw = this.el.offsetWidth;
    const th = this.el.offsetHeight;
    let left = px + 14;
    if (left + tw > hw - 4) left = px - tw - 14;
    left = Math.max(4, Math.min(left, hw - tw - 4));
    let top = py - th / 2;
    top = Math.max(4, Math.min(top, hh - th - 4));
    this.el.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
  }
  hide(): void {
    this.el.classList.remove('visible');
  }
}

/* ---------------------------------------------------------------- render */

export interface RenderResult {
  /** Extra note to show under the chart (e.g. hidden series). */
  note?: string;
}

/** Path for a bar with a 4px rounded data end and a square baseline end. */
function barPath(x: number, y: number, w: number, hgt: number, end: 'top' | 'bottom' | 'right' | 'left'): string {
  const r = Math.min(4, w / 2, hgt / 2);
  if (hgt <= 0 || w <= 0) return '';
  switch (end) {
    case 'top':
      return `M${x},${y + hgt}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + hgt}Z`;
    case 'bottom':
      return `M${x},${y}V${y + hgt - r}Q${x},${y + hgt} ${x + r},${y + hgt}H${x + w - r}Q${x + w},${y + hgt} ${x + w},${y + hgt - r}V${y}Z`;
    case 'right':
      return `M${x},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + hgt - r}Q${x + w},${y + hgt} ${x + w - r},${y + hgt}H${x}Z`;
    case 'left':
      return `M${x + w},${y}H${x + r}Q${x},${y} ${x},${y + r}V${y + hgt - r}Q${x},${y + hgt} ${x + r},${y + hgt}H${x + w}Z`;
  }
}

/**
 * The legend doubles as a series spotlight: hovering or focusing an item
 * fades every other series, so tangled lines can be read one at a time.
 */
function legend(series: Series[], getSvg: () => SVGSVGElement | null): HTMLElement | null {
  if (series.length < 2) return null;
  const spotlight = (slot: number | null) => {
    const svg = getSvg();
    if (!svg) return;
    svg.classList.toggle('spotlight', slot !== null);
    for (const el of svg.querySelectorAll<SVGElement>('.marks > *, .end-labels > *')) {
      const cls = el.getAttribute('class') ?? '';
      const mine = slot !== null && new RegExp(`\\b[fke]${slot}\\b`).test(cls);
      el.classList.toggle('lit', mine);
    }
  };
  return h(
    'div',
    { class: 'legend' },
    ...series.map((sr) => {
      const item = h('button', { type: 'button', class: 'legend-item', title: `Highlight ${sr.name}` }, h('span', { class: `swatch b${sr.slot}` }), sr.name);
      item.addEventListener('pointerenter', () => spotlight(sr.slot));
      item.addEventListener('pointerleave', () => spotlight(null));
      item.addEventListener('focus', () => spotlight(sr.slot));
      item.addEventListener('blur', () => spotlight(null));
      return item;
    }),
  );
}

export function renderChart(host: HTMLElement, panel: ChartPanel, data: ChartData, colors: ColorBook, colorKey: string, opts: { animate?: boolean } = {}): RenderResult {
  const prep = prepare(panel, data, colors, colorKey);
  host.replaceChildren();
  const lg = legend(prep.series, () => host.querySelector('svg.chart'));
  if (lg) host.append(lg);
  const plot = h('div', { class: 'plot' });
  host.append(plot);
  const width = Math.max(120, plot.clientWidth || host.clientWidth || 400);
  const height = Math.max(140, plot.clientHeight || 240);
  const tooltip = new Tooltip(plot);
  const svg = s('svg', { class: `chart${opts.animate ? ' animate' : ''}`, width, height, viewBox: `0 0 ${width} ${height}`, role: 'img' });
  plot.prepend(svg);

  const fmtY = (v: number, short = false) => formatValue(v, panel.format, panel.unit, short);
  const note = prep.hidden > 0 ? `${prep.hidden} more series not shown (only the ${MAX_SERIES - 1} largest are drawn)` : undefined;

  if (panel.type === 'bar' && panel.horizontal) drawHorizontalBars(svg, plot, tooltip, prep, panel, width, height, fmtY);
  else if (panel.type === 'bar') drawBars(svg, plot, tooltip, prep, panel, width, height, fmtY);
  else if (panel.type === 'scatter') drawScatter(svg, plot, tooltip, prep, panel, data, width, height, fmtY);
  else drawLines(svg, plot, tooltip, prep, panel, width, height, fmtY);

  svg.setAttribute('aria-label', `${panel.type} chart of ${prep.series.map((x) => x.name).join(', ')} by ${panel.x}`);
  return note ? { note } : {};
}

type Fmt = (v: number, short?: boolean) => string;

function yDomain(prep: Prepared, stacked: boolean): [number, number] {
  let lo = 0;
  let hi = 0;
  if (stacked) {
    const pos = new Map<string, number>();
    const neg = new Map<string, number>();
    for (const sr of prep.series)
      for (const p of sr.points) {
        const k = prep.xKind === 'category' ? p.xk : String(p.xv);
        const v = p.y ?? 0;
        if (v >= 0) pos.set(k, (pos.get(k) ?? 0) + v);
        else neg.set(k, (neg.get(k) ?? 0) + v);
      }
    hi = max([...pos.values()]) ?? 0;
    lo = min([...neg.values()]) ?? 0;
  } else {
    for (const sr of prep.series)
      for (const p of sr.points) {
        if (p.y === null) continue;
        hi = Math.max(hi, p.y);
        lo = Math.min(lo, p.y);
      }
  }
  if (hi === lo) hi = lo + 1;
  return [lo, hi];
}

function drawYGrid(svg: SVGSVGElement, y: ScaleLinear<number, number>, f: Frame, fmt: Fmt): void {
  const g = s('g', { class: 'grid' });
  for (const t of y.ticks(Math.max(2, Math.floor((f.height - f.m.top - f.m.bottom) / 48)))) {
    const yy = Math.round(y(t)) + 0.5;
    g.append(s('line', { x1: f.m.left, x2: f.width - f.m.right, y1: yy, y2: yy, class: t === 0 ? 'baseline' : 'gridline' }));
    g.append(s('text', { x: f.m.left - 8, y: yy, class: 'tick y', 'text-anchor': 'end', 'dominant-baseline': 'middle' }, fmt(t, true)));
  }
  svg.append(g);
}

function leftMargin(y: ScaleLinear<number, number>, fmt: Fmt, plotH: number): number {
  const ticks = y.ticks(Math.max(2, Math.floor(plotH / 48)));
  return Math.min(90, Math.max(28, ...ticks.map((t) => textWidth(fmt(t, true)) + 12)));
}

function drawBars(svg: SVGSVGElement, plot: HTMLElement, tip: Tooltip, prep: Prepared, panel: ChartPanel, width: number, height: number, fmt: Fmt): void {
  const stacked = Boolean(panel.stacked) && prep.series.length > 1;
  const f: Frame = { width, height, m: { top: 10, right: 8, bottom: 26, left: 40 } };
  const y = scaleLinear().domain(yDomain(prep, stacked)).nice().range([height - f.m.bottom, f.m.top]);
  f.m.left = leftMargin(y, fmt, height - f.m.top - f.m.bottom);
  drawYGrid(svg, y, f, fmt);
  const x = scaleBand<string>().domain(prep.xKeys).range([f.m.left, width - f.m.right]).paddingInner(0.25).paddingOuter(0.15);
  const inner = scaleBand<string>().domain(prep.series.map((x2) => x2.name)).range([0, x.bandwidth()]).paddingInner(0.12);
  const bars = s('g', { class: 'marks' });
  const byKey = new Map<string, Map<string, Point>>();
  for (const sr of prep.series) {
    const m = new Map<string, Point>();
    for (const p of sr.points) m.set(p.xk, p);
    byKey.set(sr.name, m);
  }
  const zero = y(0);
  for (const k of prep.xKeys) {
    let posAcc = 0;
    let negAcc = 0;
    const lastPos = stacked ? [...prep.series].reverse().find((sr) => (byKey.get(sr.name)?.get(k)?.y ?? 0) > 0)?.name : undefined;
    const lastNeg = stacked ? [...prep.series].reverse().find((sr) => (byKey.get(sr.name)?.get(k)?.y ?? 0) < 0)?.name : undefined;
    for (const sr of prep.series) {
      const p = byKey.get(sr.name)?.get(k);
      if (!p || p.y === null || p.y === 0) continue;
      const v = p.y;
      let bx: number;
      let bw: number;
      if (stacked) {
        bw = Math.min(24, x.bandwidth());
        bx = (x(k) ?? 0) + (x.bandwidth() - bw) / 2;
      } else {
        bw = Math.min(24, inner.bandwidth());
        bx = (x(k) ?? 0) + (inner(sr.name) ?? 0) + (inner.bandwidth() - bw) / 2;
      }
      let y0: number;
      let y1: number;
      if (stacked) {
        if (v >= 0) {
          y0 = y(posAcc);
          posAcc += v;
          y1 = y(posAcc);
        } else {
          y0 = y(negAcc);
          negAcc += v;
          y1 = y(negAcc);
        }
      } else {
        y0 = zero;
        y1 = y(v);
      }
      let top = Math.min(y0, y1);
      let hgt = Math.abs(y1 - y0);
      // 2px surface gap between stacked segments.
      if (stacked && hgt > 3) {
        if (v >= 0 && posAcc - v !== 0) hgt -= 2;
        if (v < 0 && negAcc - v !== 0) {
          top += 2;
          hgt -= 2;
        }
      }
      const rounded = !stacked || sr.name === (v >= 0 ? lastPos : lastNeg);
      const d = rounded ? barPath(bx, top, bw, hgt, v >= 0 ? 'top' : 'bottom') : `M${bx},${top}h${bw}v${hgt}h${-bw}Z`;
      if (d) bars.append(s('path', { d, class: `bar f${sr.slot}`, 'data-x': k }));
    }
  }
  svg.append(bars);
  // x labels.
  const labels = s('g', { class: 'axis' });
  const every = Math.max(1, Math.ceil(prep.xKeys.length / Math.max(1, Math.floor((width - f.m.left) / 64))));
  prep.xKeys.forEach((k, i) => {
    if (i % every !== 0) return;
    const p = prep.series.map((sr) => byKey.get(sr.name)?.get(k)).find(Boolean) ?? { x: k, xk: k, xv: NaN, y: null };
    labels.append(s('text', { x: (x(k) ?? 0) + x.bandwidth() / 2, y: height - f.m.bottom + 16, class: 'tick x', 'text-anchor': 'middle' }, truncate(prep.xLabel(p), x.step() * every - 4)));
  });
  svg.append(labels);
  hoverBands(svg, plot, tip, prep, byKey, (k) => [x(k) ?? 0, x.step()], f, fmt, stacked, 'vertical');
}

function drawHorizontalBars(svg: SVGSVGElement, plot: HTMLElement, tip: Tooltip, prep: Prepared, panel: ChartPanel, width: number, _height: number, fmt: Fmt): void {
  const stacked = Boolean(panel.stacked) && prep.series.length > 1;
  const byKey = new Map<string, Map<string, Point>>();
  for (const sr of prep.series) {
    const m = new Map<string, Point>();
    for (const p of sr.points) m.set(p.xk, p);
    byKey.set(sr.name, m);
  }
  const labelOf = (k: string) => {
    const p = prep.series.map((sr) => byKey.get(sr.name)?.get(k)).find(Boolean);
    return p ? prep.xLabel(p) : k;
  };
  const labelW = Math.min(Math.max(60, width * 0.42), Math.max(...prep.xKeys.map((k) => textWidth(labelOf(k), 12.5))) + 16);
  const showValues = !stacked && prep.series.length === 1;
  const valueW = showValues ? Math.max(...prep.series[0]!.points.map((p) => textWidth(fmt(p.y ?? 0, true), 11))) + 10 : 12;
  const rowH = prep.series.length > 1 && !stacked ? Math.max(28, prep.series.length * 12 + 10) : 30;
  // Fill the same height as neighbouring charts when there are few bars;
  // grow past it when there are many.
  const height = Math.max(_height, 120, prep.xKeys.length * rowH + 30);
  svg.setAttribute('height', String(height));
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  plot.classList.add('auto-height');
  const f: Frame = { width, height, m: { top: 4, right: valueW, bottom: 22, left: labelW } };
  const [lo, hi] = yDomain(prep, stacked);
  const x = scaleLinear().domain([lo, hi]).nice().range([f.m.left, width - f.m.right]);
  const y = scaleBand<string>().domain(prep.xKeys).range([f.m.top, height - f.m.bottom]).paddingInner(0.3).paddingOuter(0.1);
  const inner = scaleBand<string>().domain(prep.series.map((q) => q.name)).range([0, y.bandwidth()]).paddingInner(0.15);
  // Vertical gridlines.
  const g = s('g', { class: 'grid' });
  for (const t of x.ticks(Math.max(2, Math.floor((width - f.m.left - f.m.right) / 80)))) {
    const xx = Math.round(x(t)) + 0.5;
    g.append(s('line', { x1: xx, x2: xx, y1: f.m.top, y2: height - f.m.bottom, class: t === 0 ? 'baseline' : 'gridline' }));
    g.append(s('text', { x: xx, y: height - f.m.bottom + 15, class: 'tick x', 'text-anchor': 'middle' }, fmt(t, true)));
  }
  svg.append(g);
  const marks = s('g', { class: 'marks' });
  const zero = x(0);
  for (const k of prep.xKeys) {
    marks.append(s('text', { x: f.m.left - 10, y: (y(k) ?? 0) + y.bandwidth() / 2, class: 'tick cat', 'text-anchor': 'end', 'dominant-baseline': 'middle' }, truncate(labelOf(k), f.m.left - 14, 12)));
    let acc = 0;
    const last = stacked ? [...prep.series].reverse().find((sr) => (byKey.get(sr.name)?.get(k)?.y ?? 0) !== 0)?.name : undefined;
    for (const sr of prep.series) {
      const p = byKey.get(sr.name)?.get(k);
      if (!p || p.y === null || p.y === 0) continue;
      const v = p.y;
      const bh = Math.min(24, stacked ? y.bandwidth() : inner.bandwidth());
      const by = (y(k) ?? 0) + (stacked ? (y.bandwidth() - bh) / 2 : (inner(sr.name) ?? 0) + (inner.bandwidth() - bh) / 2);
      let x0 = stacked ? x(acc) : zero;
      if (stacked) acc += v;
      let x1 = stacked ? x(acc) : x(v);
      if (stacked && acc - v !== 0 && Math.abs(x1 - x0) > 3) x0 += v >= 0 ? 2 : -2;
      const left = Math.min(x0, x1);
      const w = Math.abs(x1 - x0);
      const rounded = !stacked || sr.name === last;
      const d = rounded ? barPath(left, by, w, bh, v >= 0 ? 'right' : 'left') : `M${left},${by}h${w}v${bh}h${-w}Z`;
      if (d) marks.append(s('path', { d, class: `bar hbar f${sr.slot}` }));
      if (showValues) {
        marks.append(s('text', { x: v >= 0 ? x1 + 6 : x1 - 6, y: by + bh / 2, class: 'value-label', 'text-anchor': v >= 0 ? 'start' : 'end', 'dominant-baseline': 'middle' }, fmt(v, true)));
      }
      x1 = 0;
    }
  }
  svg.append(marks);
  hoverBands(svg, plot, tip, prep, byKey, (k) => [y(k) ?? 0, y.step()], f, fmt, stacked, 'horizontal');
}

function hoverBands(
  svg: SVGSVGElement,
  plot: HTMLElement,
  tip: Tooltip,
  prep: Prepared,
  byKey: Map<string, Map<string, Point>>,
  band: (k: string) => [number, number],
  f: Frame,
  fmt: Fmt,
  stacked: boolean,
  dir: 'vertical' | 'horizontal',
): void {
  const layer = s('g', { class: 'hover' });
  const hl = s('rect', { class: 'hover-band' });
  layer.append(hl);
  for (const k of prep.xKeys) {
    const [start, step] = band(k);
    const pad = dir === 'vertical' ? (step - (step * 0.75)) / 2 : 0;
    const rect =
      dir === 'vertical'
        ? s('rect', { x: start - pad, y: f.m.top, width: step, height: f.height - f.m.top - f.m.bottom, class: 'hit' })
        : s('rect', { x: 0, y: start - (step * 0.3) / 2, width: f.width, height: step, class: 'hit' });
    const pts = prep.series.map((sr) => ({ sr, p: byKey.get(sr.name)?.get(k) }));
    const first = pts.find((q) => q.p)?.p;
    const rows: TooltipRow[] = pts.filter((q) => q.p && q.p.y !== null).map((q) => ({ slot: prep.series.length > 1 ? q.sr.slot : undefined, label: q.sr.name, value: fmt(q.p!.y!) }));
    // A stack reads top-down, so its tooltip lists the top segment first.
    if (stacked) rows.reverse();
    if (stacked && rows.length > 1) {
      const total = pts.reduce((a, q) => a + (q.p?.y ?? 0), 0);
      rows.push({ label: 'Total', value: fmt(total), strong: true });
    }
    const title = first ? prep.xLabel(first) : k;
    // Keyboard and screen-reader path: each band is a focusable stop that
    // names its values, and focus shows the same tooltip as hover.
    rect.setAttribute('tabindex', '0');
    rect.setAttribute('role', 'img');
    rect.setAttribute('aria-label', `${title}: ${rows.map((r) => `${r.label} ${r.value}`).join(', ')}`);
    const show = (ev: PointerEvent | FocusEvent) => {
      for (const a of ['x', 'y', 'width', 'height']) hl.setAttribute(a, rect.getAttribute(a) ?? '0');
      hl.classList.add('visible');
      const box = plot.getBoundingClientRect();
      const px = ev instanceof PointerEvent ? ev.clientX - box.left : Number(rect.getAttribute('x')) + Number(rect.getAttribute('width')) / 2;
      const py = ev instanceof PointerEvent ? ev.clientY - box.top : f.height / 2;
      tip.show(title, rows, px, py);
    };
    const hide = () => {
      tip.hide();
      hl.classList.remove('visible');
    };
    rect.addEventListener('pointermove', show);
    rect.addEventListener('pointerenter', show);
    rect.addEventListener('pointerleave', hide);
    rect.addEventListener('focus', show);
    rect.addEventListener('blur', hide);
    layer.append(rect);
  }
  svg.append(layer);
}

function drawLines(svg: SVGSVGElement, plot: HTMLElement, tip: Tooltip, prep: Prepared, panel: ChartPanel, width: number, height: number, fmt: Fmt): void {
  const isArea = panel.type === 'area';
  const stacked = isArea && Boolean(panel.stacked) && prep.series.length > 1;
  const f: Frame = { width, height, m: { top: 12, right: 12, bottom: 26, left: 40 } };
  const directLabels = prep.series.length >= 2 && prep.series.length <= 4 && width >= 480;
  if (directLabels) f.m.right = Math.min(120, Math.max(...prep.series.map((sr) => textWidth(sr.name))) + 14);

  let yLo: number;
  let yHi: number;
  if (stacked) [yLo, yHi] = yDomain(prep, true);
  else {
    const vals = prep.series.flatMap((sr) => sr.points.map((p) => p.y).filter((v): v is number => v !== null));
    yLo = Math.min(0, min(vals) ?? 0);
    yHi = max(vals) ?? 1;
    if (!isArea && yLo === 0 && (min(vals) ?? 0) > 0 && (max(vals) ?? 0) > 0) {
      // Lines keep the zero baseline unless values are far from it.
      const lo = min(vals) ?? 0;
      if (lo > (yHi - lo) * 3) yLo = lo - (yHi - lo) * 0.1;
    }
    if (yHi === yLo) yHi = yLo + 1;
  }
  const y = scaleLinear().domain([yLo, yHi]).nice().range([height - f.m.bottom, f.m.top]);
  f.m.left = leftMargin(y, fmt, height - f.m.top - f.m.bottom);
  drawYGrid(svg, y, f, fmt);

  let xPos: (p: Point) => number;
  let xKeysPos: number[];
  let xScale: ScaleTime<number, number> | ScaleLinear<number, number> | ScalePoint<string>;
  if (prep.xKind === 'time') {
    const ext = extent(prep.series.flatMap((sr) => sr.points.map((p) => p.xv))) as [number, number];
    const sc = scaleTime().domain([new Date(ext[0]), new Date(ext[1] === ext[0] ? ext[0] + 86_400_000 : ext[1])]).range([f.m.left, width - f.m.right]);
    xScale = sc;
    xPos = (p) => sc(new Date(p.xv));
    xKeysPos = prep.xKeys.map((k) => sc(new Date(Number(k))));
  } else if (prep.xKind === 'number') {
    const ext = extent(prep.series.flatMap((sr) => sr.points.map((p) => p.xv))) as [number, number];
    const sc = scaleLinear().domain(ext[0] === ext[1] ? [ext[0] - 1, ext[1] + 1] : ext).range([f.m.left, width - f.m.right]);
    xScale = sc;
    xPos = (p) => sc(p.xv);
    xKeysPos = prep.xKeys.map((k) => sc(Number(k)));
  } else {
    const sc = scalePoint<string>().domain(prep.xKeys).range([f.m.left, width - f.m.right]).padding(0.3);
    xScale = sc;
    xPos = (p) => sc(p.xk) ?? 0;
    xKeysPos = prep.xKeys.map((k) => sc(k) ?? 0);
  }
  const keyOf = (p: Point) => (prep.xKind === 'category' ? p.xk : String(p.xv));

  // X axis ticks.
  const axis = s('g', { class: 'axis' });
  if (prep.xKind === 'category') {
    const sc = xScale as ScalePoint<string>;
    const every = Math.max(1, Math.ceil(prep.xKeys.length / Math.max(1, Math.floor((width - f.m.left - f.m.right) / 70))));
    prep.xKeys.forEach((k, i) => {
      if (i % every !== 0) return;
      const p = prep.series.flatMap((sr) => sr.points).find((q) => q.xk === k);
      axis.append(s('text', { x: sc(k) ?? 0, y: height - f.m.bottom + 16, class: 'tick x', 'text-anchor': 'middle' }, truncate(p ? prep.xLabel(p) : k, sc.step() * every - 4)));
    });
  } else {
    const sc = xScale as ScaleTime<number, number> | ScaleLinear<number, number>;
    const ticks = (sc.ticks as (n: number) => (Date | number)[])(Math.max(2, Math.floor((width - f.m.left - f.m.right) / 90)));
    const dates = ticks.filter((t): t is Date => t instanceof Date);
    const dfmt = dateFormatter(dates);
    for (const t of ticks) {
      const xx = (sc as (v: Date | number) => number)(t);
      axis.append(s('text', { x: xx, y: height - f.m.bottom + 16, class: 'tick x', 'text-anchor': 'middle' }, t instanceof Date ? dfmt(t) : formatValue(t, undefined, undefined, true)));
    }
  }
  svg.append(axis);

  // Stacking.
  const stackBase = new Map<string, Map<string, number>>();
  if (stacked) {
    const acc = new Map<string, number>();
    for (const sr of prep.series) {
      const base = new Map<string, number>();
      for (const p of sr.points) {
        const k = keyOf(p);
        const b = acc.get(k) ?? 0;
        base.set(k, b);
        acc.set(k, b + (p.y ?? 0));
      }
      stackBase.set(sr.name, base);
    }
  }
  const top = (sr: Series, p: Point) => (stacked ? (stackBase.get(sr.name)?.get(keyOf(p)) ?? 0) + (p.y ?? 0) : (p.y ?? 0));
  const bottom = (sr: Series, p: Point) => (stacked ? (stackBase.get(sr.name)?.get(keyOf(p)) ?? 0) : Math.max(yLo, 0));

  const marks = s('g', { class: 'marks' });
  const defs = s('defs', {});
  svg.append(defs);
  const endLabels: { y: number; name: string; slot: number }[] = [];
  for (const sr of prep.series) {
    const pts = sr.points.filter((p) => p.y !== null);
    if (pts.length === 0) continue;
    if (isArea) {
      const a = d3area<Point>()
        .x(xPos)
        .y0((p) => y(bottom(sr, p)))
        .y1((p) => y(top(sr, p)))
        .curve(curveMonotoneX);
      const gid = `g${Math.random().toString(36).slice(2, 9)}`;
      defs.append(s('linearGradient', { id: gid, x1: 0, x2: 0, y1: 0, y2: 1 }, s('stop', { offset: '0%', class: `stop-a s${sr.slot}` }), s('stop', { offset: '100%', class: `stop-b s${sr.slot}` })));
      marks.append(s('path', { d: a(pts) ?? '', class: 'area', fill: `url(#${gid})` }));
    }
    const l = d3line<Point>()
      .x(xPos)
      .y((p) => y(top(sr, p)))
      .curve(curveMonotoneX);
    marks.append(s('path', { d: l(pts) ?? '', class: `line k${sr.slot}`, pathLength: 1 }));
    const last = pts[pts.length - 1]!;
    const ex = xPos(last);
    const ey = y(top(sr, last));
    marks.append(s('circle', { cx: ex, cy: ey, r: 4, class: `dot f${sr.slot}` }));
    if (pts.length === 1) continue;
    endLabels.push({ y: ey, name: sr.name, slot: sr.slot });
  }
  svg.append(marks);

  if (directLabels && endLabels.length >= 2) {
    const sorted = [...endLabels].sort((a, b) => a.y - b.y);
    const collide = sorted.some((l, i) => i > 0 && l.y - sorted[i - 1]!.y < 13);
    if (!collide) {
      const g = s('g', { class: 'end-labels' });
      for (const l of sorted) g.append(s('text', { x: width - f.m.right + 8, y: l.y, class: `end-label e${l.slot}`, 'dominant-baseline': 'middle' }, truncate(l.name, f.m.right - 10)));
      svg.append(g);
    }
  }

  // Crosshair hover.
  const layer = s('g', { class: 'hover' });
  const cross = s('line', { class: 'crosshair', y1: f.m.top, y2: height - f.m.bottom });
  const dots = s('g', {});
  layer.append(cross, dots);
  const overlay = s('rect', { x: f.m.left, y: f.m.top, width: Math.max(0, width - f.m.left - f.m.right), height: Math.max(0, height - f.m.top - f.m.bottom), class: 'hit' });
  layer.append(overlay);
  svg.append(layer);
  const order = xKeysPos.map((px, i) => ({ px, key: prep.xKeys[i]! })).sort((a, b) => a.px - b.px);
  const bis = bisector<{ px: number }, number>((d) => d.px).center;
  const index = new Map<string, Map<string, Point>>();
  for (const sr of prep.series) {
    const m = new Map<string, Point>();
    for (const p of sr.points) m.set(keyOf(p), p);
    index.set(sr.name, m);
  }
  /** Show the crosshair, dots and tooltip at one x position. */
  const showAt = (i: number, py: number | undefined, scaleX: number): void => {
    const hit = order[i];
    if (!hit) return;
    cross.setAttribute('x1', String(hit.px));
    cross.setAttribute('x2', String(hit.px));
    cross.classList.add('visible');
    dots.replaceChildren();
    const rows: TooltipRow[] = [];
    let title = '';
    let firstY = f.m.top;
    for (const sr of prep.series) {
      const p = index.get(sr.name)?.get(hit.key);
      if (!p || p.y === null) continue;
      if (!title) {
        title = prep.xLabel(p);
        firstY = y(top(sr, p));
      }
      dots.append(s('circle', { cx: hit.px, cy: y(top(sr, p)), r: 4, class: `dot f${sr.slot}` }));
      rows.push({ slot: prep.series.length > 1 ? sr.slot : undefined, label: sr.name, value: fmt(p.y) });
    }
    // A stack reads top-down, so its tooltip lists the top layer first.
    if (stacked) rows.reverse();
    if (stacked && rows.length > 1) {
      const total = prep.series.reduce((a, sr) => a + (index.get(sr.name)?.get(hit.key)?.y ?? 0), 0);
      rows.push({ label: 'Total', value: fmt(total), strong: true });
    }
    overlay.setAttribute('aria-label', `${title}: ${rows.map((r) => `${r.label} ${r.value}`).join(', ')}. Use the arrow keys to move along the chart.`);
    tip.show(title, rows, hit.px / scaleX, py ?? firstY / scaleX);
  };
  const hideAll = () => {
    cross.classList.remove('visible');
    dots.replaceChildren();
    tip.hide();
  };
  overlay.addEventListener('pointermove', (ev) => {
    const box = plot.getBoundingClientRect();
    const scaleX = width / (box.width || width);
    const px = (ev.clientX - box.left) * scaleX;
    if (order.length === 0) return;
    focusIndex = bis(order, px);
    showAt(focusIndex, ev.clientY - box.top, scaleX);
  });
  overlay.addEventListener('pointerleave', hideAll);
  // Keyboard path: focus the plot, then step through points with the arrows.
  let focusIndex = order.length - 1;
  overlay.setAttribute('tabindex', '0');
  overlay.setAttribute('role', 'img');
  overlay.setAttribute('aria-label', 'Chart. Use the arrow keys to read each point.');
  const scaleNow = () => {
    const box = plot.getBoundingClientRect();
    return width / (box.width || width);
  };
  overlay.addEventListener('focus', () => showAt(focusIndex, undefined, scaleNow()));
  overlay.addEventListener('blur', hideAll);
  overlay.addEventListener('keydown', (ev) => {
    const step = ev.key === 'ArrowRight' || ev.key === 'ArrowUp' ? 1 : ev.key === 'ArrowLeft' || ev.key === 'ArrowDown' ? -1 : 0;
    if (ev.key === 'Home') focusIndex = 0;
    else if (ev.key === 'End') focusIndex = order.length - 1;
    else if (step) focusIndex = Math.max(0, Math.min(order.length - 1, focusIndex + step));
    else return;
    ev.preventDefault();
    showAt(focusIndex, undefined, scaleNow());
  });
}

function drawScatter(svg: SVGSVGElement, plot: HTMLElement, tip: Tooltip, prep: Prepared, panel: ChartPanel, data: ChartData, width: number, height: number, fmt: Fmt): void {
  const f: Frame = { width, height, m: { top: 12, right: 14, bottom: 26, left: 40 } };
  const all = prep.series.flatMap((sr) => sr.points.filter((p) => p.y !== null).map((p) => ({ sr, p })));
  const yv = all.map((q) => q.p.y!);
  const lo = min(yv) ?? 0;
  const hi = max(yv) ?? 1;
  const pad = (hi - lo) * 0.06 || 1;
  const y = scaleLinear().domain([Math.min(lo - pad, lo >= 0 && lo < (hi - lo) ? 0 : lo - pad), hi + pad]).nice().range([height - f.m.bottom, f.m.top]);
  f.m.left = leftMargin(y, fmt, height - f.m.top - f.m.bottom);
  drawYGrid(svg, y, f, fmt);
  const xv = all.map((q) => q.p.xv);
  const xlo = min(xv) ?? 0;
  const xhi = max(xv) ?? 1;
  const xpad = (xhi - xlo) * 0.04 || 1;
  const x = prep.xKind === 'time'
    ? scaleTime().domain([new Date(xlo - xpad), new Date(xhi + xpad)]).range([f.m.left, width - f.m.right])
    : scaleLinear().domain([xlo - xpad, xhi + xpad]).nice().range([f.m.left, width - f.m.right]);
  const xAt = (v: number) => (x as (v: number | Date) => number)(prep.xKind === 'time' ? new Date(v) : v);
  const axis = s('g', { class: 'axis' });
  const ticks = (x.ticks as (n: number) => (number | Date)[])(Math.max(2, Math.floor((width - f.m.left) / 90)));
  const dfmt = dateFormatter(ticks.filter((t): t is Date => t instanceof Date));
  for (const t of ticks) {
    axis.append(s('text', { x: (x as (v: number | Date) => number)(t), y: height - f.m.bottom + 16, class: 'tick x', 'text-anchor': 'middle' }, t instanceof Date ? dfmt(t) : formatValue(t, undefined, undefined, true)));
  }
  svg.append(axis);
  const marks = s('g', { class: 'marks' });
  const placed = all.map((q) => ({ ...q, cx: xAt(q.p.xv), cy: y(q.p.y!) }));
  for (const q of placed) marks.append(s('circle', { cx: q.cx, cy: q.cy, r: 4, class: `dot scatter-dot f${q.sr.slot}` }));
  svg.append(marks);
  const ring = s('circle', { r: 6, class: 'hover-ring' });
  const overlay = s('rect', { x: f.m.left, y: f.m.top, width: Math.max(0, width - f.m.left - f.m.right), height: Math.max(0, height - f.m.top - f.m.bottom), class: 'hit' });
  svg.append(ring, overlay);
  const xName = panel.x;
  const yName = Array.isArray(panel.y) ? panel.y[0]! : panel.y;
  const xCol = data.columns.find((c) => c.name === xName);
  overlay.addEventListener('pointermove', (ev) => {
    const box = plot.getBoundingClientRect();
    const sx = width / (box.width || width);
    const px = (ev.clientX - box.left) * sx;
    const py = (ev.clientY - box.top) * sx;
    let best: (typeof placed)[number] | undefined;
    let bestD = 24 * 24;
    for (const q of placed) {
      const d = (q.cx - px) ** 2 + (q.cy - py) ** 2;
      if (d < bestD) {
        bestD = d;
        best = q;
      }
    }
    if (!best) {
      ring.classList.remove('visible');
      tip.hide();
      return;
    }
    ring.setAttribute('cx', String(best.cx));
    ring.setAttribute('cy', String(best.cy));
    ring.setAttribute('class', `hover-ring visible k${best.sr.slot}`);
    const rows: TooltipRow[] = [
      { label: xName, value: xCol?.kind === 'date' ? prep.xLabel(best.p) : formatValue(best.p.x, undefined, undefined) },
      { label: yName, value: fmt(best.p.y!) },
    ];
    tip.show(prep.series.length > 1 ? best.sr.name : `${yName} vs ${xName}`, rows, best.cx / sx, best.cy / sx);
  });
  overlay.addEventListener('pointerleave', () => {
    ring.classList.remove('visible');
    tip.hide();
  });
}

export type { ScaleBand };
