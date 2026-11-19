/**
 * The dashboard page. It fetches the spec, runs each panel through the local
 * API, and redraws when the agent saves a new version.
 */
import type { DashboardSpec, FilterSpec, PanelSpec } from '../src/spec/schema.js';
import { ColorBook, renderChart, type ChartPanel } from './charts.js';
import { clear, h, icon, s, type IconName } from './dom.js';
import { humanize, timeAgo, type ColumnInfo } from './format.js';
import { renderMarkdown } from './markdown.js';
import { renderKpi, renderTable, rowSpans, toCsv } from './panels.js';

type Row = Record<string, unknown>;

interface PanelResult {
  columns: ColumnInfo[];
  rows: Row[];
  truncated: boolean;
  ms: number;
  ranAt: string;
}

interface PanelError {
  error: string;
  kind?: string;
}

const app = document.getElementById('app')!;
const colors = new ColorBook('overlook.colors.v1');
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** The SQL drawer floating over the grid (narrow KPI cards), if one is open. */
let openFloat: { card: HTMLElement; close: (focus: boolean) => void } | null = null;
document.addEventListener('pointerdown', (e) => {
  if (openFloat && !openFloat.card.contains(e.target as Node)) openFloat.close(false);
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && openFloat) {
    e.preventDefault();
    openFloat.close(true);
  }
});

/* ----------------------------------------------------------------- theme */

type Theme = 'light' | 'dark' | 'system';

function storedTheme(): Theme {
  try {
    const t = localStorage.getItem('overlook-theme');
    return t === 'light' || t === 'dark' ? t : 'system';
  } catch {
    return 'system';
  }
}

function applyTheme(t: Theme): void {
  if (t === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
}

function effectiveDark(): boolean {
  const t = storedTheme();
  if (t !== 'system') return t === 'dark';
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

const themeListeners = new Set<() => void>();

function toggleTheme(): void {
  const next: Theme = effectiveDark() ? 'light' : 'dark';
  try {
    localStorage.setItem('overlook-theme', next);
  } catch {
    /* private mode */
  }
  applyTheme(next);
  for (const fn of themeListeners) fn();
}

function themeButton(): HTMLButtonElement {
  const btn = h('button', { type: 'button', class: 'icon-btn', title: 'Light or dark (T)' });
  const paint = () => {
    btn.replaceChildren(icon(effectiveDark() ? 'sun' : 'moon'));
    btn.setAttribute('aria-label', effectiveDark() ? 'Switch to light theme' : 'Switch to dark theme');
  };
  paint();
  themeListeners.add(paint);
  btn.addEventListener('click', toggleTheme);
  return btn;
}

applyTheme(storedTheme());

/* ----------------------------------------------------------------- toast */

const toastHost = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' });
document.body.append(toastHost);

function toast(text: string, ico: IconName = 'check'): void {
  const t = h('div', { class: 'toast' }, icon(ico, 15), h('span', {}, text));
  toastHost.append(t);
  requestAnimationFrame(() => t.classList.add('in'));
  setTimeout(() => {
    t.classList.remove('in');
    setTimeout(() => t.remove(), 220);
  }, 2400);
}

/* ------------------------------------------------------------------ menu */

let openMenu: { el: HTMLElement; trigger: HTMLElement } | undefined;

function closeMenu(focusTrigger = false): void {
  if (!openMenu) return;
  openMenu.el.remove();
  openMenu.trigger.setAttribute('aria-expanded', 'false');
  if (focusTrigger) openMenu.trigger.focus();
  openMenu = undefined;
}

interface MenuItem {
  label: string;
  icon: IconName;
  run: () => void;
  disabled?: boolean;
}

function menuButton(items: () => MenuItem[], label: string): HTMLButtonElement {
  const btn = h('button', { type: 'button', class: 'icon-btn ghost', 'aria-haspopup': 'menu', 'aria-expanded': 'false', 'aria-label': label, title: label });
  btn.append(icon('more'));
  btn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    if (openMenu?.trigger === btn) return closeMenu();
    closeMenu();
    const menu = h('div', { class: 'menu', role: 'menu' });
    for (const it of items()) {
      const mi = h('button', { type: 'button', role: 'menuitem', class: 'menu-item', disabled: it.disabled }, icon(it.icon, 15), h('span', {}, it.label));
      mi.addEventListener('click', () => {
        closeMenu();
        it.run();
      });
      menu.append(mi);
    }
    btn.parentElement!.append(menu);
    btn.setAttribute('aria-expanded', 'true');
    openMenu = { el: menu, trigger: btn };
    (menu.querySelector('.menu-item:not([disabled])') as HTMLElement | null)?.focus();
  });
  return btn;
}

document.addEventListener('click', (ev) => {
  if (openMenu && !openMenu.el.contains(ev.target as Node)) closeMenu();
});

document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape') closeMenu(true);
  if (openMenu && (ev.key === 'ArrowDown' || ev.key === 'ArrowUp')) {
    const items = [...openMenu.el.querySelectorAll<HTMLElement>('.menu-item:not([disabled])')];
    const i = items.indexOf(document.activeElement as HTMLElement);
    const next = items[(i + (ev.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length];
    next?.focus();
    ev.preventDefault();
  }
});

/* ------------------------------------------------------------------- api */

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(body.error ?? `request failed (${res.status})`);
  return body;
}

/* ---------------------------------------------------------------- shared */

function brandMark(): SVGSVGElement {
  return s(
    'svg',
    { viewBox: '0 0 24 24', width: 22, height: 22, class: 'brand-mark', 'aria-hidden': 'true' },
    s('rect', { x: 2, y: 2, width: 20, height: 20, rx: 6, class: 'brand-bg' }),
    s('rect', { x: 6, y: 12.5, width: 2.6, height: 5.5, rx: 1.3, class: 'brand-bar' }),
    s('rect', { x: 10.7, y: 9, width: 2.6, height: 9, rx: 1.3, class: 'brand-bar' }),
    s('rect', { x: 15.4, y: 6, width: 2.6, height: 12, rx: 1.3, class: 'brand-bar' }),
  );
}

function topBar(crumb: string | undefined, right: Node[]): HTMLElement {
  return h(
    'header',
    { class: 'topbar' },
    h(
      'div',
      { class: 'topbar-inner' },
      h(
        'nav',
        { class: 'crumbs', 'aria-label': 'Breadcrumb' },
        h('a', { class: 'brand', href: '/' }, brandMark(), h('span', {}, 'Overlook')),
        crumb ? icon('chevron', 14) : null,
        crumb ? h('span', { class: 'crumb', 'aria-current': 'page' }, crumb) : null,
      ),
      h('div', { class: 'actions' }, ...right),
    ),
  );
}

function errorBox(title: string, message: string, retry?: () => void): HTMLElement {
  const box = h('div', { class: 'error-box', role: 'alert' }, h('div', { class: 'error-title' }, icon('alert', 15), title), h('pre', { class: 'error-msg' }, message));
  if (retry) {
    const b = h('button', { type: 'button', class: 'btn small' }, icon('refresh', 14), 'Retry');
    b.addEventListener('click', retry);
    box.append(h('div', { class: 'error-actions' }, b));
  }
  return box;
}

/* ------------------------------------------------------------ list page */

interface Listing {
  slug: string;
  title: string;
  panels: number;
  mtimeMs: number;
  error?: string;
}

async function listPage(): Promise<void> {
  document.title = 'Dashboards · Overlook';
  const grid = h('div', { class: 'list-grid' }, ...[0, 1, 2].map(() => h('div', { class: 'list-card skeleton-card' })));
  app.replaceChildren(
    topBar(undefined, [themeButton()]),
    h(
      'main',
      { class: 'page' },
      h('div', { class: 'hero' }, h('h1', {}, 'Dashboards'), h('p', { class: 'lede' }, 'Live dashboards your coding agent built from data on this machine.')),
      grid,
    ),
  );
  try {
    const { dashboards } = await api<{ dashboards: Listing[] }>('/api/dashboards');
    if (dashboards.length === 0) {
      grid.replaceWith(
        h(
          'section',
          { class: 'empty-state' },
          h('div', { class: 'empty-icon' }, icon('layout', 22)),
          h('h2', {}, 'No dashboards yet'),
          h('p', {}, 'Register a data file, connect your agent, then ask it for a dashboard. It appears here as soon as it is saved.'),
          h('ol', { class: 'steps' },
            h('li', {}, h('span', {}, 'Add data'), h('code', {}, 'npx overlook-dash source add sales ./sales.csv')),
            h('li', {}, h('span', {}, 'Connect your agent'), h('code', {}, 'claude mcp add overlook -- npx -y overlook-dash mcp')),
            h('li', {}, h('span', {}, 'Ask'), h('code', {}, 'Make a dashboard of monthly revenue by region')),
          ),
        ),
      );
      return;
    }
    grid.replaceChildren(
      ...dashboards.map((d, i) => {
        const health = h('span', { class: 'list-health checking' }, h('span', { class: 'pulse' }), 'Checking queries…');
        const card = h(
          'a',
          { class: `list-card${d.error ? ' broken' : ''}`, href: `/d/${encodeURIComponent(d.slug)}`, 'data-i': i },
          h('div', { class: 'list-head' }, h('span', { class: 'list-icon' }, icon(d.error ? 'alert' : 'chart', 16)), h('span', { class: 'list-title' }, d.title)),
          h('div', { class: 'list-meta' }, d.error ? h('span', { class: 'bad-text' }, 'Cannot be read') : h('span', {}, `${d.panels} panel${d.panels === 1 ? '' : 's'}`), h('span', { class: 'dot-sep' }), h('span', { title: d.mtimeMs ? new Date(d.mtimeMs).toLocaleString() : '' }, d.mtimeMs ? `updated ${timeAgo(d.mtimeMs)}` : '')),
          d.error ? null : health,
          h('div', { class: 'list-slug' }, `/d/${d.slug}`),
        );
        if (!d.error) {
          // Each dashboard runs its queries once on the server, so a broken
          // one is visible here before anyone opens it.
          api<{ panels: number; failed: { id: string; error: string }[] }>(`/api/d/${encodeURIComponent(d.slug)}/health`)
            .then((r) => {
              if (r.failed.length === 0) {
                health.className = 'list-health ok';
                health.replaceChildren(h('span', { class: 'pulse live' }), 'All queries run');
              } else {
                health.className = 'list-health bad';
                health.replaceChildren(icon('alert', 13), `${r.failed.length} of ${r.panels} panel${r.panels === 1 ? '' : 's'} failing`);
                health.title = r.failed.map((f) => `${f.id}: ${f.error.split('\n')[0]}`).join('\n');
                card.classList.add('broken');
                const ic = card.querySelector('.list-icon');
                ic?.replaceChildren(icon('alert', 16));
              }
            })
            .catch(() => {
              health.className = 'list-health';
              health.replaceChildren('Health unknown');
            });
        }
        return card;
      }),
    );
  } catch (e) {
    grid.replaceWith(errorBox('Could not load dashboards', (e as Error).message, () => void listPage()));
  }
}

/* ------------------------------------------------------- dashboard page */

interface PanelView {
  spec: PanelSpec;
  index: number;
  card: HTMLElement;
  body: HTMLElement;
  status: HTMLElement;
  drawer: HTMLElement;
  result?: PanelResult;
  error?: PanelError;
  showTable: boolean;
  abort?: AbortController;
  observer?: ResizeObserver;
  lastWidth: number;
  /** True until the first data for this view has been drawn. */
  fresh: boolean;
  /** Filter ids this panel's SQL actually uses ($name). */
  uses: Set<string>;
  /** "Not filtered by …" note in the card head. */
  scopeEl?: HTMLElement;
  /** Bound parameter values shown in the SQL drawer. */
  paramsEl?: HTMLElement;
  sourceBtn?: HTMLButtonElement;
}

/** The $parameters a panel's SQL references, read on the client. */
function usedParams(sql: string): Set<string> {
  return new Set([...sql.matchAll(/\$([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]!));
}

/** Text a person can paste to their agent to get a failing panel fixed. */
function agentPrompt(slug: string, p: { id: string; source: string; sql: string }, error: string): string {
  return [
    `The Overlook dashboard "${slug}" has a panel that fails. Please fix it with get_dashboard and save_dashboard.`,
    `Panel: ${p.id} (source "${p.source}")`,
    `Error: ${error}`,
    'SQL:',
    p.sql,
  ].join('\n');
}

const DEFAULT_WIDTH: Record<string, string> = { kpi: 'third', bar: 'half', line: 'half', area: 'half', scatter: 'half', table: 'full', text: 'full' };

/**
 * Widen cards in rows the spec leaves part-empty, for the 12-column desktop
 * grid and the tablet grid (where a third is a half).
 */
function fillRows(cards: HTMLElement[]): void {
  const widths = cards.map((c) => /\bw-(\w+)/.exec(c.className)?.[1] ?? 'half');
  const desk = rowSpans(widths, { full: 12, half: 6, third: 4 });
  const tab = rowSpans(widths, { full: 12, half: 6, third: 6 });
  // Desktop rows, to find KPIs that share a row with a taller chart.
  const rowOf: number[] = [];
  let row = 0;
  let used = 0;
  desk.forEach((s, i) => {
    if (used + s > 12) {
      row++;
      used = 0;
    }
    used += s;
    rowOf[i] = row;
  });
  const isKpi = (c: HTMLElement) => c.classList.contains('type-kpi');
  const isText = (c: HTMLElement) => c.classList.contains('type-text');
  cards.forEach((c, i) => {
    const mates = cards.filter((_, j) => j !== i && rowOf[j] === rowOf[i]);
    c.classList.toggle('kpi-tall', isKpi(c) && mates.some((m) => !isKpi(m) && !isText(m)));
    c.classList.add('filled');
    c.style.setProperty('--span-d', String(desk[i]));
    c.style.setProperty('--span-t', String(tab[i]));
  });
}

function isChart(p: PanelSpec): p is Extract<PanelSpec, { type: 'bar' | 'line' | 'area' | 'scatter' }> {
  return p.type === 'bar' || p.type === 'line' || p.type === 'area' || p.type === 'scatter';
}

class DashboardPage {
  private spec!: DashboardSpec;
  private mtime = 0;
  private views: PanelView[] = [];
  private params: Record<string, string | null> = {};
  private grid = h('div', { class: 'grid' });
  private filterBar = h('div', { class: 'filters', role: 'group', 'aria-label': 'Filters' });
  private freshness = h('span', { class: 'freshness' });
  private lastRun = 0;
  private running = 0;
  private sources: Record<string, string> = {};
  private sourceNames: Record<string, string> = {};
  private firstRender = true;

  constructor(private slug: string) {}

  async start(): Promise<void> {
    app.replaceChildren(topBar(undefined, [themeButton()]), h('main', { class: 'page' }, h('div', { class: 'hero' }, h('div', { class: 'sk-line w40' }), h('div', { class: 'sk-line w60' }))));
    try {
      await this.load();
    } catch (e) {
      app.replaceChildren(topBar(this.slug, [themeButton()]), h('main', { class: 'page' }, errorBox('This dashboard could not be loaded', (e as Error).message, () => void this.start())));
      return;
    }
    this.poll();
    setInterval(() => this.tick(), 15_000);
    document.addEventListener('keydown', (ev) => {
      const tag = (ev.target as HTMLElement | null)?.tagName;
      if (ev.metaKey || ev.ctrlKey || ev.altKey || tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
      if (ev.key === 'r' || ev.key === 'R') this.runAll();
      if (ev.key === 't' || ev.key === 'T') toggleTheme();
      if (ev.key === '/' || ev.key === 'f' || ev.key === 'F') {
        const first = this.filterBar.querySelector<HTMLElement>('select, input');
        if (first) {
          ev.preventDefault();
          first.focus();
        }
      }
    });
    themeListeners.add(() => {
      for (const v of this.views) if (v.result) this.draw(v);
    });
  }

  private async load(): Promise<void> {
    const r = await api<{ spec: DashboardSpec; mtimeMs: number; sources: Record<string, string>; sourceNames?: Record<string, string> }>(`/api/d/${encodeURIComponent(this.slug)}`);
    this.spec = r.spec;
    this.mtime = r.mtimeMs;
    this.sources = r.sources;
    this.sourceNames = r.sourceNames ?? {};
    this.params = this.paramsFromUrl();
    this.render();
    this.runAll();
  }

  private paramsFromUrl(): Record<string, string | null> {
    const q = new URLSearchParams(location.search);
    const out: Record<string, string | null> = {};
    for (const f of this.spec.filters ?? []) {
      const v = q.get(f.id);
      out[f.id] = v !== null ? (v === '' ? null : v) : (f.default ?? null);
    }
    return out;
  }

  private filtersDirty(): boolean {
    return (this.spec.filters ?? []).some((f) => (this.params[f.id] ?? null) !== (f.default ?? null));
  }

  private resetFilters(): void {
    for (const f of this.spec.filters ?? []) this.params[f.id] = f.default ?? null;
    this.syncUrl();
    this.renderFilters();
    this.updateScope();
    this.runAll();
  }

  private syncUrl(): void {
    const q = new URLSearchParams();
    for (const f of this.spec.filters ?? []) {
      const v = this.params[f.id] ?? null;
      const d = f.default ?? null;
      if (v !== d) q.set(f.id, v ?? '');
    }
    const str = q.toString();
    history.replaceState(null, '', str ? `?${str}` : location.pathname);
  }

  private render(): void {
    document.title = `${this.spec.title} · Overlook`;
    for (const v of this.views) v.observer?.disconnect();
    this.views = this.spec.panels.map((p, i) => this.makeView(p, i));
    this.grid.replaceChildren(...this.views.map((v) => v.card));
    fillRows(this.views.map((v) => v.card));
    if (this.firstRender && !reducedMotion) this.grid.classList.add('enter');
    this.firstRender = false;
    this.renderFilters();

    const refresh = h('button', { type: 'button', class: 'btn', title: 'Run every query again (R)' }, icon('refresh', 15), h('span', { class: 'hide-sm' }, 'Refresh'));
    refresh.addEventListener('click', () => this.runAll());

    const aliases = [...new Set(this.spec.panels.flatMap((p) => (p.type === 'text' ? [] : [p.source])))];
    const queryPanels = this.spec.panels.filter((p) => p.type !== 'text').length;
    app.replaceChildren(
      topBar(this.spec.title, [this.freshness, refresh, themeButton()]),
      h(
        'main',
        { class: 'page' },
        h(
          'div',
          { class: 'hero' },
          h('h1', {}, this.spec.title),
          this.spec.description ? h('p', { class: 'lede' }, this.spec.description) : null,
          h(
            'div',
            { class: 'hero-meta' },
            h('span', { class: 'meta-item' }, icon('chart', 14), `${queryPanels} panel${queryPanels === 1 ? '' : 's'}`),
            ...aliases.map((a) => h('span', { class: 'meta-item src', title: `Data source "${a}"${this.sourceNames[a] ? `: ${this.sourceNames[a]}` : ''}` }, icon('database', 13), a)),
          ),
        ),
        (this.spec.filters ?? []).length ? this.filterBar : null,
        this.grid,
        h('footer', { class: 'page-foot' }, h('span', {}, 'Every number comes from the SQL behind its panel: open a panel’s source to see it. Data is read from this machine each time the page loads.'), h('span', { class: 'kbd-hint' }, h('kbd', {}, 'R'), ' refresh ', h('kbd', {}, 'F'), ' filters ', h('kbd', {}, 'T'), ' theme')),
      ),
    );
    this.updateScope();
    this.tick();
  }

  /**
   * Mark panels that an applied filter does not affect, so an unfiltered
   * number never passes for a filtered one, and show each panel's bound
   * parameter values in its SQL drawer.
   */
  private updateScope(): void {
    const filters = this.spec.filters ?? [];
    for (const v of this.views) {
      if (v.spec.type === 'text') continue;
      const ignored = filters.filter((f) => (this.params[f.id] ?? null) !== null && !v.uses.has(f.id));
      if (v.scopeEl) {
        v.scopeEl.hidden = ignored.length === 0;
        v.scopeEl.replaceChildren(icon('filter', 12), h('span', { class: 'scope-text' }, `Ignores ${ignored.map((f) => f.label).join(', ')}`));
        v.scopeEl.title = `This panel's query does not use ${ignored.map((f) => `$${f.id}`).join(', ')}, so it shows all data for ${ignored.length === 1 ? 'that filter' : 'those filters'}.`;      }
      v.card.classList.toggle('unscoped', ignored.length > 0);
      if (v.paramsEl) {
        const used = filters.filter((f) => v.uses.has(f.id));
        v.paramsEl.hidden = used.length === 0;
        v.paramsEl.replaceChildren(
          h('span', { class: 'params-label' }, 'Ran with'),
          ...used.map((f) => {
            const val = this.params[f.id] ?? null;
            return h('code', { class: 'param' }, `$${f.id} = `, val === null ? h('span', { class: 'param-null' }, 'NULL (all)') : `'${val}'`);
          }),
        );
      }
    }
  }

  private renderFilters(): void {
    clear(this.filterBar);
    const filters = this.spec.filters ?? [];
    this.filterBar.append(h('span', { class: 'filters-icon', 'aria-hidden': 'true' }, icon('filter', 15)));
    for (const f of filters) this.filterBar.append(this.filterControl(f));
    if (this.filtersDirty()) {
      const reset = h('button', { type: 'button', class: 'btn ghost small' }, icon('x', 14), 'Reset filters');
      reset.addEventListener('click', () => this.resetFilters());
      this.filterBar.append(reset);
    }
  }

  private setParam(id: string, value: string | null): void {
    this.params[id] = value;
    this.syncUrl();
    this.renderFilters();
    this.updateScope();
    this.runAll();
  }

  private filterControl(f: FilterSpec): HTMLElement {
    const id = `filter-${f.id}`;
    const label = h('label', { for: id, class: 'filter-label' }, f.label);
    const current = this.params[f.id] ?? '';
    const active = (this.params[f.id] ?? null) !== (f.default ?? null);
    let control: HTMLElement;
    if (f.type === 'select') {
      const sel = h('select', { id, class: 'input' }, h('option', { value: '' }, 'All'));
      const fill = (opts: string[]) => {
        for (const o of opts) sel.append(h('option', { value: o, selected: o === current }, o));
        if (current && !opts.includes(current)) sel.append(h('option', { value: current, selected: true }, current));
        sel.value = current;
      };
      const unavailable = () => {
        sel.append(h('option', { value: '__unavailable', disabled: true }, 'Options could not be loaded'));
        sel.title = 'The query that lists these options failed; only "All" is available.';
      };
      if (f.options) fill(f.options);
      else
        api<{ options: string[]; error?: string }>(`/api/d/${encodeURIComponent(this.slug)}/options/${encodeURIComponent(f.id)}`)
          .then((r) => {
            fill(r.options);
            if (r.error) unavailable();
          })
          .catch(() => {
            fill([]);
            unavailable();
          });
      sel.value = current;
      sel.addEventListener('change', () => this.setParam(f.id, sel.value || null));
      control = sel;
    } else if (f.type === 'date') {
      const inp = h('input', { id, type: 'date', class: 'input', value: current });
      inp.addEventListener('change', () => this.setParam(f.id, inp.value || null));
      control = inp;
    } else {
      const inp = h('input', { id, type: 'search', class: 'input', value: current, placeholder: 'Any', autocomplete: 'off', spellcheck: 'false' });
      let t: number | undefined;
      inp.addEventListener('input', () => {
        window.clearTimeout(t);
        t = window.setTimeout(() => {
          this.params[f.id] = inp.value || null;
          this.syncUrl();
          this.runAll();
        }, 400);
      });
      control = inp;
    }
    // A date after today is legal (data can hold future rows) but usually a
    // slip that empties every panel, so it is called out, not blocked.
    const today = new Date();
    const todayIso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    const future = f.type === 'date' && current !== '' && current > todayIso;
    const hint = future ? h('span', { class: 'filter-hint', id: `${id}-hint` }, icon('alert', 12), 'After today') : null;
    if (hint) control.setAttribute('aria-describedby', `${id}-hint`);
    return h('div', { class: `filter${active ? ' active' : ''}${future ? ' warn' : ''}` }, label, control, hint);
  }

  private makeView(p: PanelSpec, index: number): PanelView {
    const width = p.width ?? DEFAULT_WIDTH[p.type] ?? 'half';
    const title = p.title ?? (p.type === 'text' ? '' : humanize(p.id));
    const body = h('div', { class: `panel-body type-${p.type}` });
    const status = h('span', { class: 'panel-status' });
    const drawer = h('div', { class: 'source', id: `source-${p.id}`, hidden: true });
    const titleId = `title-${p.id}`;
    const card = h('article', { class: `card w-${width} type-${p.type}`, id: `panel-${p.id}`, ...(title ? { 'aria-labelledby': titleId } : { 'aria-label': p.id }) });
    card.style.setProperty('--i', String(index));
    const view: PanelView = { spec: p, index, card, body, status, drawer, showTable: false, lastWidth: 0, fresh: true, uses: p.type === 'text' ? new Set() : usedParams(p.sql) };

    if (p.type === 'text') {
      card.append(body);
      body.append(renderMarkdown(p.markdown));
      return view;
    }

    const toggleSource = () => {
      const opening = drawer.hidden !== false;
      // Only one floating drawer at a time: it covers the panels below it.
      if (openFloat && openFloat.card !== card) openFloat.close(false);
      drawer.hidden = !opening;
      card.classList.toggle('source-open', opening);
      view.sourceBtn?.setAttribute('aria-expanded', String(opening));
      if (!opening) {
        if (openFloat?.card === card) openFloat = null;
        return;
      }
      if (getComputedStyle(drawer).position === 'absolute') {
        openFloat = {
          card,
          close: (focus: boolean) => {
            if (!drawer.hidden) toggleSource();
            if (focus) view.sourceBtn?.focus();
          },
        };
      }
      drawer.scrollIntoView({ block: 'nearest', behavior: reducedMotion ? 'auto' : 'smooth' });
    };
    const copyCsv = async (download: boolean) => {
      if (!view.result) return;
      const text = toCsv(view.result);
      if (!download) {
        try {
          await navigator.clipboard.writeText(text);
          toast(`Copied ${view.result.rows.length.toLocaleString()} rows as CSV`);
          return;
        } catch {
          /* fall back to a download */
        }
      }
      const a = h('a', { href: URL.createObjectURL(new Blob([text], { type: 'text/csv' })), download: `${this.slug}-${p.id}.csv` });
      a.click();
      toast(`Downloaded ${this.slug}-${p.id}.csv`, 'download');
    };
    const menu = menuButton(
      () => [
        ...(isChart(p) ? [{ label: view.showTable ? 'Show chart' : 'Show as table', icon: (view.showTable ? 'chart' : 'table') as IconName, run: () => { view.showTable = !view.showTable; this.draw(view); } }] : []),
        { label: drawer.hidden ? 'View source SQL' : 'Hide source SQL', icon: 'code', run: toggleSource },
        { label: 'Copy as CSV', icon: 'copy', run: () => void copyCsv(false), disabled: !view.result },
        { label: 'Download CSV', icon: 'download', run: () => void copyCsv(true), disabled: !view.result },
      ],
      `Options for ${title || p.id}`,
    );
    const scopeEl = h('span', { class: 'scope-note', hidden: true });
    view.scopeEl = scopeEl;
    card.append(h('div', { class: 'card-head' }, h('h2', { class: 'card-title', id: titleId }, title), scopeEl, h('div', { class: 'card-tools' }, menu)));
    if (p.note) card.append(h('p', { class: 'note' }, p.note));
    card.append(body);

    const sourceBtn = h(
      'button',
      { type: 'button', class: 'source-btn', title: `Show the SQL behind ${title || p.id}`, 'aria-expanded': 'false', 'aria-controls': drawer.id },
      icon('code', 13),
      h('span', {}, p.source),
      h('span', { class: 'source-btn-sql' }, 'SQL'),
    );
    sourceBtn.addEventListener('click', toggleSource);
    view.sourceBtn = sourceBtn;
    const copySql = h('button', { type: 'button', class: 'btn ghost small' }, icon('copy', 13), 'Copy SQL');
    copySql.addEventListener('click', () => {
      void navigator.clipboard.writeText(p.sql).then(
        () => toast('SQL copied'),
        () => toast('Could not copy the SQL', 'alert'),
      );
    });
    const fileName = this.sourceNames[p.source];
    const paramsEl = h('div', { class: 'source-params', hidden: true });
    view.paramsEl = paramsEl;
    drawer.append(
      h(
        'div',
        { class: 'source-meta' },
        h('span', { class: 'pill' }, icon('database', 12), p.source),
        h('span', { class: 'source-file', title: fileName ?? '' }, fileName ?? this.sources[p.source] ?? ''),
        h('span', { class: 'grow' }),
        copySql,
      ),
      paramsEl,
      h('pre', { class: 'code' }, p.sql),
    );
    card.append(h('footer', { class: 'card-foot' }, status, sourceBtn), drawer);

    if (isChart(p)) {
      view.observer = new ResizeObserver(() => {
        const w = body.clientWidth;
        if (Math.abs(w - view.lastWidth) > 2 && view.result && !view.showTable) {
          view.lastWidth = w;
          requestAnimationFrame(() => this.draw(view, false));
        }
      });
      view.observer.observe(body);
    }
    return view;
  }

  runAll(): void {
    this.lastRun = Date.now();
    for (const v of this.views) if (v.spec.type !== 'text') void this.run(v);
    this.tick();
  }

  private async run(v: PanelView): Promise<void> {
    v.abort?.abort();
    const ctrl = new AbortController();
    v.abort = ctrl;
    if (!v.result && !v.error) this.skeleton(v);
    else v.card.classList.add('refreshing');
    this.running++;
    this.tick();
    try {
      const res = await api<PanelResult | PanelError>(`/api/d/${encodeURIComponent(this.slug)}/panels/${encodeURIComponent(v.spec.id)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ params: this.params }),
        signal: ctrl.signal,
      });
      if (ctrl.signal.aborted) return;
      if ('error' in res) {
        v.error = res;
        v.result = undefined;
      } else {
        v.result = res;
        v.error = undefined;
      }
    } catch (e) {
      if ((e as Error).name === 'AbortError') return;
      v.error = { error: (e as Error).message };
      v.result = undefined;
    } finally {
      this.running--;
      if (!ctrl.signal.aborted) this.tick();
    }
    v.card.classList.remove('refreshing');
    this.draw(v);
  }

  private skeleton(v: PanelView): void {
    const t = v.spec.type;
    let sk: HTMLElement;
    if (t === 'kpi') sk = h('div', { class: 'sk-kpi' }, h('div', { class: 'sk-line w50 tall' }), h('div', { class: 'sk-line w30' }));
    else if (t === 'table') sk = h('div', { class: 'sk-table' }, ...[0, 1, 2, 3, 4, 5].map(() => h('div', { class: 'sk-line' })));
    else sk = h('div', { class: 'sk-chart' }, ...[38, 62, 48, 80, 56, 70, 44, 66].map((n) => h('div', { class: 'sk-bar', 'data-h': n })));
    for (const bar of sk.querySelectorAll<HTMLElement>('.sk-bar')) bar.style.height = `${bar.dataset.h}%`;
    v.body.replaceChildren(sk);
    v.status.textContent = 'Running…';
  }

  private statusText(r: PanelResult): string {
    return `${r.rows.length.toLocaleString()}${r.truncated ? '+' : ''} row${r.rows.length === 1 ? '' : 's'} · ${r.ms} ms · ${timeAgo(r.ranAt)}`;
  }

  private draw(v: PanelView, animate = true): void {
    const p = v.spec;
    if (p.type === 'text') return;
    if (v.error) {
      v.card.classList.add('has-error');
      if (v.error.kind === 'source' || v.error.kind === 'timeout') {
        // A missing file or a slow query can succeed on a second try.
        v.body.replaceChildren(errorBox(v.error.kind === 'source' ? 'The data source is not available' : 'The query took too long', v.error.error, () => void this.run(v)));
      } else {
        // A SQL error fails the same way every time: hand it to the agent.
        const err = v.error.error;
        const box = errorBox('This panel’s query fails', err);
        const handOff = h('button', { type: 'button', class: 'btn small' }, icon('copy', 14), 'Copy for your agent');
        handOff.addEventListener('click', () => {
          void navigator.clipboard.writeText(agentPrompt(this.slug, p, err)).then(
            () => toast('Copied. Paste it to your agent to fix this panel'),
            () => toast('Could not copy', 'alert'),
          );
        });
        box.append(h('div', { class: 'error-actions' }, handOff, h('span', { class: 'error-hint' }, 'Your agent wrote this SQL and can fix it.')));
        v.body.replaceChildren(box);
      }
      v.status.textContent = 'Failed';
      this.tick();
      return;
    }
    v.card.classList.remove('has-error');
    const r = v.result;
    if (!r) return;
    v.status.textContent = this.statusText(r);
    v.status.title = `Ran at ${new Date(r.ranAt).toLocaleString()}${r.truncated ? `. Only the first ${r.rows.length.toLocaleString()} rows are shown; aggregate in SQL to see everything.` : ''}`;
    v.card.querySelector('.chart-note')?.remove();
    if (r.rows.length === 0) {
      const dirty = this.filtersDirty();
      const empty = h('div', { class: 'empty' }, icon('search', 18), h('div', {}, dirty ? 'No rows match these filters' : 'The query returned no rows'));
      if (dirty) {
        const b = h('button', { type: 'button', class: 'btn small' }, 'Reset filters');
        b.addEventListener('click', () => this.resetFilters());
        empty.append(b);
      }
      v.body.replaceChildren(empty);
      return;
    }
    const doAnimate = animate && v.fresh && !reducedMotion;
    v.fresh = false;
    switch (p.type) {
      case 'kpi':
        renderKpi(v.body, p, r, colors.slot(`${this.slug}/${p.id}`, p.value));
        break;
      case 'table':
        renderTable(v.body, p, r, p.title ?? humanize(p.id));
        break;
      default: {
        if (v.showTable) {
          renderTable(v.body, p, r, p.title ?? humanize(p.id));
          break;
        }
        const out = renderChart(v.body, p as ChartPanel, r, colors, `${this.slug}/${p.id}`, { animate: doAnimate });
        v.lastWidth = v.body.clientWidth;
        if (out.note) v.body.after(h('p', { class: 'chart-note' }, out.note));
      }
    }
  }

  private tick(): void {
    const failed = this.views.filter((v) => v.error);
    if (this.running > 0) {
      this.freshness.className = 'freshness busy';
      this.freshness.replaceChildren(h('span', { class: 'pulse' }), 'Updating…');
    } else if (failed.length > 0) {
      // The status light is where a scanning eye goes: it must not say
      // "all good" while a panel is broken. It jumps to the first failure.
      const jump = h('button', { type: 'button', class: 'freshness warn', title: 'Go to the first panel that failed' }, icon('alert', 14), `${failed.length} panel${failed.length === 1 ? '' : 's'} failed`);
      jump.addEventListener('click', () => {
        const first = failed[0]!.card;
        first.scrollIntoView({ block: 'center', behavior: reducedMotion ? 'auto' : 'smooth' });
        first.querySelector<HTMLElement>('.error-box button')?.focus({ preventScroll: true });
      });
      this.freshness.className = 'freshness-slot';
      this.freshness.replaceChildren(jump);
    } else if (this.lastRun) {
      this.freshness.className = 'freshness';
      this.freshness.replaceChildren(h('span', { class: 'pulse live' }), `Updated ${timeAgo(this.lastRun)}`);
      this.freshness.title = `Every query last ran at ${new Date(this.lastRun).toLocaleTimeString()}. Press R to run them again.`;
    }
    for (const v of this.views) if (v.result && !v.error) v.status.textContent = this.statusText(v.result);
  }

  private poll(): void {
    const loop = async () => {
      if (document.visibilityState === 'visible') {
        try {
          const r = await api<{ mtimeMs: number | null }>(`/api/d/${encodeURIComponent(this.slug)}/mtime`);
          if (r.mtimeMs && r.mtimeMs !== this.mtime) {
            await this.load();
            toast('Dashboard updated by your agent', 'refresh');
          }
        } catch {
          /* server restarting; try again next tick */
        }
      }
      setTimeout(loop, 2000);
    };
    setTimeout(loop, 2000);
  }
}

/* ----------------------------------------------------------------- route */

const m = /^\/d\/([a-z0-9-]+)\/?$/.exec(location.pathname);
if (m) void new DashboardPage(m[1]!).start();
else void listPage();
