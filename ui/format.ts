import { format as d3format } from 'd3-format';
import { timeFormat } from 'd3-time-format';
import type { Format } from '../src/spec/schema.js';

export interface ColumnInfo {
  name: string;
  type: string;
  kind: 'number' | 'date' | 'text' | 'boolean' | 'other';
}

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Parse DuckDB date output; date-only values are local midnight, not UTC. */
export function parseDate(v: unknown): Date | null {
  if (v instanceof Date) return v;
  if (typeof v !== 'string') return null;
  const m = DATE_ONLY.exec(v);
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function toNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

const fullNumber = d3format(',.2~f');
const bigNumber = d3format(',.0f');
const compactSi = d3format('.3~s');

export function compact(n: number): string {
  if (Math.abs(n) < 1000) return fullNumber(n);
  return compactSi(n).replace('G', 'B').replace('k', 'K');
}

function currencyCode(unit: string | undefined): string | undefined {
  return unit && /^[A-Za-z]{3}$/.test(unit) ? unit.toUpperCase() : undefined;
}

/** Format a value for display. `short` is used on axes and in tight spots. */
export function formatValue(v: unknown, fmt: Format | undefined, unit: string | undefined, short = false): string {
  const n = toNumber(v);
  if (n === null) return v === null || v === undefined ? '—' : String(v);
  switch (fmt) {
    case 'percent':
      return `${d3format(short ? '.0~%' : '.1~%')(n)}`;
    case 'currency': {
      const code = currencyCode(unit) ?? 'USD';
      const abs = Math.abs(n);
      if (short || abs >= 1e6) {
        const sym = currencySymbol(code);
        return `${n < 0 ? '−' : ''}${sym}${compact(abs)}`;
      }
      try {
        return new Intl.NumberFormat(undefined, { style: 'currency', currency: code, maximumFractionDigits: abs >= 1000 ? 0 : 2 }).format(n);
      } catch {
        return `${fullNumber(n)} ${code}`;
      }
    }
    case 'compact':
      return withUnit(compact(n), unit);
    case 'number':
    default: {
      if (short) return withUnit(Math.abs(n) >= 10_000 ? compact(n) : fullNumber(n), unit);
      return withUnit(Math.abs(n) >= 1e6 ? compact(n) : Math.abs(n) >= 1000 ? bigNumber(n) : fullNumber(n), unit);
    }
  }
}

function withUnit(s: string, unit: string | undefined): string {
  return unit ? `${s} ${unit}` : s;
}

const symbols = new Map<string, string>();
function currencySymbol(code: string): string {
  let s = symbols.get(code);
  if (s === undefined) {
    try {
      s =
        new Intl.NumberFormat(undefined, { style: 'currency', currency: code, currencyDisplay: 'narrowSymbol' })
          .formatToParts(0)
          .find((p) => p.type === 'currency')?.value ?? `${code} `;
    } catch {
      s = `${code} `;
    }
    symbols.set(code, s);
  }
  return s;
}

const fmtMonth = timeFormat('%b %Y');
const fmtDay = timeFormat('%b %-d, %Y');
const fmtDateTime = timeFormat('%b %-d, %Y %H:%M');

/** Pick one date format for a whole set of dates. */
export function dateFormatter(dates: readonly Date[]): (d: Date) => string {
  const allMidnight = dates.every((d) => d.getHours() === 0 && d.getMinutes() === 0 && d.getSeconds() === 0);
  if (!allMidnight) return fmtDateTime;
  const allFirst = dates.every((d) => d.getDate() === 1);
  if (allFirst) {
    const allJan = dates.every((d) => d.getMonth() === 0);
    return allJan && dates.length > 1 ? timeFormat('%Y') : fmtMonth;
  }
  return fmtDay;
}

export function formatCell(v: unknown, col: ColumnInfo | undefined, fmt: Format | undefined, unit: string | undefined): string {
  if (v === null || v === undefined) return '—';
  if (col?.kind === 'number') {
    // A table column must read as one scale: never abbreviate one cell to
    // "1.21M" beside "758,346". Explicit compact/currency/percent still apply.
    const n = toNumber(v);
    if ((fmt === undefined || fmt === 'number') && n !== null) return withUnit(Math.abs(n) >= 1000 ? bigNumber(n) : fullNumber(n), unit);
    if (fmt === 'currency' && n !== null) {
      const code = currencyCode(unit) ?? 'USD';
      try {
        return new Intl.NumberFormat(undefined, { style: 'currency', currency: code, maximumFractionDigits: Math.abs(n) >= 1000 ? 0 : 2 }).format(n);
      } catch {
        return `${bigNumber(n)} ${code}`;
      }
    }
    return formatValue(v, fmt, unit);
  }
  if (col?.kind === 'date') {
    const d = parseDate(v);
    if (d) return dateFormatter([d])(d);
  }
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

export function timeAgo(iso: string | number | undefined, now = Date.now()): string {
  if (iso === undefined) return '';
  const t = typeof iso === 'number' ? iso : Date.parse(iso);
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 10) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  return new Date(t).toLocaleDateString();
}

export { humanize } from '../src/spec/labels.js';
