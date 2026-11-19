/** Tiny DOM helpers. All text goes in as text nodes, never as HTML. */
import {
  ArrowDownRight,
  ArrowRight,
  ArrowUpRight,
  ChartColumn,
  ChartLine,
  ChartScatter,
  CircleHelp,
  Folder,
  Gauge,
  Info,
  Link2,
  Plus,
  Text,
  Check,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Code2,
  Copy,
  Database,
  Download,
  Ellipsis,
  Filter,
  LayoutDashboard,
  Moon,
  RefreshCw,
  Search,
  Sun,
  Table2,
  Terminal,
  TriangleAlert,
  Unplug,
  X,
  createElement,
  type IconNode,
} from 'lucide';

type Attrs = Record<string, string | number | boolean | undefined | null>;
type Child = Node | string | null | undefined | false;

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = String(v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    el.append(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return el;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

export function s<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: Child[]): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    el.setAttribute(k, String(v));
  }
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    el.append(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return el;
}

/** Icons come from Lucide (ISC): one set, one stroke weight. */
const ICONS = {
  refresh: RefreshCw,
  sun: Sun,
  moon: Moon,
  code: Code2,
  copy: Copy,
  check: Check,
  alert: TriangleAlert,
  up: ArrowUpRight,
  down: ArrowDownRight,
  flat: ArrowRight,
  back: ChevronLeft,
  chevron: ChevronRight,
  more: Ellipsis,
  table: Table2,
  chart: ChartColumn,
  download: Download,
  database: Database,
  clock: Clock3,
  layout: LayoutDashboard,
  filter: Filter,
  x: X,
  terminal: Terminal,
  search: Search,
  unplug: Unplug,
  info: Info,
  help: CircleHelp,
  folder: Folder,
  plus: Plus,
  trend: ChartLine,
  scatter: ChartScatter,
  gauge: Gauge,
  text: Text,
  link: Link2,
} satisfies Record<string, IconNode>;

export type IconName = keyof typeof ICONS;

export function icon(name: IconName, size = 16): SVGElement {
  const el = createElement(ICONS[name], { width: size, height: size, 'stroke-width': 1.75, 'aria-hidden': 'true' });
  el.setAttribute('class', `icon icon-${name}`);
  return el;
}

export function clear(el: Element): void {
  while (el.firstChild) el.removeChild(el.firstChild);
}
