/** KPI tiles and tables. */
import type { Format } from '../src/spec/schema.js';
import { h, icon, s } from './dom.js';
import { formatCell, formatValue, humanize, parseDate, toNumber, type ColumnInfo } from './format.js';

type Row = Record<string, unknown>;

interface KpiSpec {
  value: string;
  compare?: string;
  x?: string;
  better?: 'up' | 'down';
  format?: Format;
  unit?: string;
}

/**
 * A stat tile: label (the card title), value, a delta chip whose color means
 * "good" or "bad" (with an arrow, so never color alone), and with `x` a
 * sparkline of the series. The current point sits in the accent color.
 */
export function renderKpi(host: HTMLElement, p: KpiSpec, data: { columns: ColumnInfo[]; rows: Row[] }, slot = 1): void {
  const rows = data.rows;
  const row = p.x ? rows[rows.length - 1] : rows[0];
  const prev = p.x && !p.compare ? rows[rows.length - 2] : undefined;
  const v = row ? toNumber(row[p.value]) : null;
  const c = p.compare && row ? toNumber(row[p.compare]) : prev ? toNumber(prev[p.value]) : null;
  const xCol = p.x ? data.columns.find((col) => col.name === p.x) : undefined;

  const parts: Node[] = [h('div', { class: 'kpi-value' }, v === null ? '—' : formatValue(v, p.format, p.unit))];
  const meta: Node[] = [];
  if (v !== null && c !== null) {
    const diff = v - c;
    const pct = c !== 0 ? diff / Math.abs(c) : null;
    const dir = Math.abs(diff) < 1e-12 ? 'flat' : diff > 0 ? 'up' : 'down';
    const good = dir === 'flat' ? 'neutral' : (dir === 'up') === ((p.better ?? 'up') === 'up') ? 'good' : 'bad';
    const sign = diff >= 0 ? '+' : '−';
    const relative = pct === null ? null : `${pct > 0 ? '+' : ''}${(pct * 100).toFixed(Math.abs(pct) < 0.1 ? 1 : 0)}%`;
    // A rate that moves from 5% to 3% fell 2 points, not "-39%": percent
    // KPIs show the change in points, with the relative change on hover.
    const label =
      p.format === 'percent'
        ? `${sign}${Math.abs(diff * 100).toFixed(Math.abs(diff * 100) < 10 ? 1 : 0)} pts`
        : (relative ?? formatValue(diff, p.format, p.unit, true));
    const detail = `${sign}${formatValue(Math.abs(diff), p.format, p.unit)}${relative && p.format === 'percent' ? ` (${relative} relative)` : ''}: ${formatValue(c, p.format, p.unit)} → ${formatValue(v, p.format, p.unit)}`;
    meta.push(h('span', { class: `delta ${good}`, title: detail }, icon(dir, 13), label));
    const when = prev && xCol ? ` in ${formatCell(prev[p.x!], xCol, undefined, undefined)}` : '';
    // Same precision as the value above, so the two read as a pair.
    meta.push(h('span', { class: 'kpi-vs' }, `vs ${formatValue(c, p.format, p.unit)}${when}`));
  } else if (p.x && row && xCol) {
    meta.push(h('span', { class: 'kpi-vs' }, formatCell(row[p.x], xCol, undefined, undefined)));
  }
  const partial = p.x && xCol?.kind === 'date' ? partialPeriod(rows.map((r) => r[p.x!])) : null;
  if (partial) meta.push(h('span', { class: 'kpi-partial', title: `The latest ${partial} is not over yet, so its value can still grow.` }, `${partial} so far`));
  if (meta.length) parts.push(h('div', { class: 'kpi-compare' }, ...meta));

  const tile = h('div', { class: 'kpi' }, h('div', { class: 'kpi-main' }, ...parts));
  if (p.x && rows.length >= 2) tile.append(sparkline(rows.map((r) => toNumber(r[p.value])), slot, p, xCol ? rows.map((r) => formatCell(r[p.x!], xCol, undefined, undefined)) : undefined));
  host.replaceChildren(tile);
}

/**
 * "month", "week" or "day" when the last period in a date series has not
 * ended yet (it contains today), or null. The period length comes from the
 * spacing of the last two points.
 */
export function partialPeriod(xs: unknown[], now = new Date()): string | null {
  const dates = xs.map(parseDate).filter((d): d is Date => d !== null);
  if (dates.length < 2) return null;
  const last = dates[dates.length - 1]!;
  const prev = dates[dates.length - 2]!;
  const days = (last.getTime() - prev.getTime()) / 86_400_000;
  let end: Date;
  let name: string;
  if (days >= 27 && days <= 32) {
    end = new Date(last.getFullYear(), last.getMonth() + 1, 1);
    name = 'month';
  } else if (days >= 6.5 && days <= 7.5) {
    end = new Date(last.getTime() + 7 * 86_400_000);
    name = 'week';
  } else if (days >= 0.9 && days <= 1.1) {
    end = new Date(last.getTime() + 86_400_000);
    name = 'day';
  } else {
    return null;
  }
  return now >= last && now < end ? name : null;
}

function sparkline(values: (number | null)[], slot: number, p: KpiSpec, labels?: string[]): HTMLElement {
  const W = 120;
  const H = 40;
  const pts = values.map((v, i) => ({ i, v })).filter((q): q is { i: number; v: number } => q.v !== null);
  const lo = Math.min(...pts.map((q) => q.v));
  const hi = Math.max(...pts.map((q) => q.v));
  const span = hi - lo || 1;
  const x = (i: number) => 2 + (i / Math.max(1, values.length - 1)) * (W - 4);
  const y = (v: number) => 4 + (1 - (v - lo) / span) * (H - 10);
  const d = pts.map((q, k) => `${k ? 'L' : 'M'}${x(q.i).toFixed(1)},${y(q.v).toFixed(1)}`).join('');
  const area = `${d}L${x(pts[pts.length - 1]!.i).toFixed(1)},${H}L${x(pts[0]!.i).toFixed(1)},${H}Z`;
  const last = pts[pts.length - 1]!;
  const gid = `spark-${Math.random().toString(36).slice(2, 9)}`;
  const svg = s(
    'svg',
    {
      class: 'spark',
      viewBox: `0 0 ${W} ${H}`,
      width: W,
      height: H,
      // A tall tile stretches the sparkline to fill it; strokes do not scale.
      preserveAspectRatio: 'none',
      role: 'img',
      'aria-label': `trend of ${values.length} points, last ${formatValue(last.v, p.format, p.unit)}`,
    },
    s('defs', {}, s('linearGradient', { id: gid, x1: 0, x2: 0, y1: 0, y2: 1 }, s('stop', { offset: '0%', class: `stop-a s${slot}` }), s('stop', { offset: '100%', class: `stop-b s${slot}` }))),
    s('path', { d: area, fill: `url(#${gid})` }),
    s('path', { d, class: `spark-line k${slot}` }),
    // The current point: a zero-length round-capped stroke stays a circle when stretched.
    s('path', { d: `M${x(last.i).toFixed(1)},${y(last.v).toFixed(1)}h0`, class: `spark-dot k${slot}` }),
  );
  const wrap = h('div', { class: 'spark-wrap' }, svg);
  if (labels) {
    const first = labels[pts[0]!.i];
    const lastL = labels[last.i];
    if (first && lastL) wrap.append(h('div', { class: 'spark-range' }, h('span', {}, first), h('span', {}, lastL)));
  }
  return wrap;
}

const RATE_NAME = /(^|_)(rate|pct|percent|share|ratio)$/i;

/**
 * The format for one table column: a numeric column named like a rate whose
 * values all sit within [-1, 1] reads as a percent; others use the panel's.
 */
function columnFormat(c: ColumnInfo, rows: Row[], fallback: Format | undefined, explicit?: Record<string, Format>): Format | undefined {
  const set = explicit?.[c.name];
  if (set) return set;
  if (c.kind !== 'number' || !RATE_NAME.test(c.name)) return fallback;
  const fits = rows.every((r) => {
    const n = toNumber(r[c.name]);
    return n === null || (n >= -1 && n <= 1);
  });
  return fits ? 'percent' : fallback;
}

export function renderTable(
  host: HTMLElement,
  p: { columns?: string[]; format?: Format; unit?: string; formats?: Record<string, Format> },
  data: { columns: ColumnInfo[]; rows: Row[] },
  label = 'Data table',
  maxRows = 500,
): void {
  const cols = p.columns ? p.columns.map((n) => data.columns.find((c) => c.name === n)).filter((c): c is ColumnInfo => Boolean(c)) : data.columns;
  const formats = new Map(cols.map((c) => [c.name, columnFormat(c, data.rows, p.format, p.formats)]));
  let sortCol: string | undefined;
  let desc = false;

  const table = h('table', { class: 'table' });
  const thead = h('thead');
  const tbody = h('tbody');
  table.append(thead, tbody);

  const draw = () => {
    const rows = [...data.rows];
    if (sortCol) {
      const col = cols.find((c) => c.name === sortCol);
      rows.sort((a, b) => {
        const x = a[sortCol!];
        const y = b[sortCol!];
        if (x === y) return 0;
        if (x === null || x === undefined) return 1;
        if (y === null || y === undefined) return -1;
        const r = col?.kind === 'number' ? Number(x) - Number(y) : String(x).localeCompare(String(y));
        return desc ? -r : r;
      });
    }
    thead.replaceChildren(
      h(
        'tr',
        {},
        ...cols.map((c) => {
          const th = h(
            'th',
            { class: c.kind === 'number' ? 'num' : '', scope: 'col', 'aria-sort': sortCol === c.name ? (desc ? 'descending' : 'ascending') : 'none' },
            h('button', { type: 'button', class: 'th-btn', title: c.name }, humanize(c.name), sortCol === c.name ? icon(desc ? 'down' : 'up', 12) : null),
          );
          th.querySelector('button')!.addEventListener('click', () => {
            if (sortCol === c.name) desc = !desc;
            else {
              sortCol = c.name;
              desc = c.kind === 'number';
            }
            draw();
          });
          return th;
        }),
      ),
    );
    tbody.replaceChildren(
      ...rows.slice(0, maxRows).map((r) =>
        h('tr', {}, ...cols.map((c) => h('td', { class: c.kind === 'number' ? 'num' : '' }, formatCell(r[c.name], c, formats.get(c.name), p.unit)))),
      ),
    );
  };
  draw();
  const wrap = h('div', { class: 'table-wrap', tabindex: 0, role: 'region', 'aria-label': label }, table);
  const nodes: Node[] = [wrap];
  if (data.rows.length > maxRows) nodes.push(h('div', { class: 'table-more' }, `Showing ${maxRows} of ${data.rows.length} rows. Copy CSV for all.`));
  host.replaceChildren(...nodes);
}

/**
 * CSV for the clipboard or a download. A text cell that starts with = + - @
 * (or a tab or carriage return) gets a leading apostrophe, so a spreadsheet
 * that opens the file never runs data as a formula. Numbers are left alone.
 */
export function toCsv(data: { columns: ColumnInfo[]; rows: Row[] }): string {
  const esc = (v: unknown) => {
    if (v === null || v === undefined) return '';
    let s = typeof v === 'object' ? JSON.stringify(v) : String(v);
    if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
  };
  return [data.columns.map((c) => esc(c.name)).join(','), ...data.rows.map((r) => data.columns.map((c) => esc(r[c.name])).join(','))].join('\n');
}

/**
 * Grid spans that leave no row part-empty: a third next to a half, or two
 * lone thirds, grow to fill their row. Cards wrap as CSS grid would place
 * them; the leftover columns go, two at a time, to the narrowest card in the
 * row (all of it to a card alone in its row).
 */
export function rowSpans(widths: readonly string[], spans: Record<string, number>, cols = 12): number[] {
  const out = widths.map((w) => spans[w] ?? cols / 2);
  let start = 0;
  let used = 0;
  const close = (end: number) => {
    let left = cols - used;
    while (left > 0 && end > start) {
      let k = start;
      for (let i = start; i < end; i++) if (out[i]! < out[k]!) k = i;
      const add = end - start === 1 ? left : Math.min(left, 2);
      out[k] = out[k]! + add;
      left -= add;
    }
  };
  out.forEach((s, i) => {
    if (used + s > cols) {
      close(i);
      start = i;
      used = 0;
    }
    used += s;
  });
  close(out.length);
  return out;
}
