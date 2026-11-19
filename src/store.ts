/**
 * Dashboards are plain JSON files. The folder is the only shared record
 * between the MCP process and the web server.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homePath, readJsonFile, writeFileAtomic } from './config.js';
import { SPEC_VERSION, type DashboardSpec } from './spec/schema.js';

const HISTORY_KEEP = 20;

export function slugify(name: string): string {
  const slug = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/, '');
  if (!slug) return 'dashboard';
  // Windows cannot create files with these names, whatever the extension.
  if (/^(con|prn|aux|nul|com\d|lpt\d)$/.test(slug)) return `${slug}-dashboard`;
  return slug;
}

export const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

export function dashboardPath(slug: string): string {
  if (!SLUG_RE.test(slug)) throw new Error(`invalid dashboard name "${slug}"`);
  return homePath('dashboards', `${slug}.json`);
}

export interface StoredDashboard {
  slug: string;
  spec: DashboardSpec;
  mtimeMs: number;
}

export class StoreError extends Error {}

export function loadDashboard(slug: string): StoredDashboard | undefined {
  const p = dashboardPath(slug);
  if (!existsSync(p)) return undefined;
  let spec: unknown;
  try {
    spec = readJsonFile(p);
  } catch (e) {
    throw new StoreError(`${p} is not valid JSON: ${(e as Error).message}`);
  }
  const version = (spec as { version?: unknown })?.version;
  if (typeof version === 'number' && version > SPEC_VERSION) {
    throw new StoreError(`dashboard "${slug}" uses spec version ${version}; this build of Overlook supports version ${SPEC_VERSION}. Upgrade overlook-dash.`);
  }
  return { slug, spec: spec as DashboardSpec, mtimeMs: statSync(p).mtimeMs };
}

/** Raw spec as stored, without trusting its shape. */
export function loadRaw(slug: string): unknown {
  const p = dashboardPath(slug);
  if (!existsSync(p)) return undefined;
  return readJsonFile(p);
}

export function dashboardMtime(slug: string): number | undefined {
  try {
    return statSync(dashboardPath(slug)).mtimeMs;
  } catch {
    return undefined;
  }
}

export function saveDashboard(slug: string, spec: DashboardSpec): StoredDashboard {
  const p = dashboardPath(slug);
  const existing = loadRawVersion(p);
  if (existing !== undefined && existing > SPEC_VERSION) {
    throw new StoreError(`refusing to overwrite "${slug}": it uses newer spec version ${existing}`);
  }
  if (existsSync(p)) {
    const histDir = homePath('history', slug);
    mkdirSync(histDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    copyFileSync(p, join(histDir, `${stamp}.json`));
    pruneHistory(histDir);
  }
  writeFileAtomic(p, JSON.stringify(spec, null, 2) + '\n');
  return { slug, spec, mtimeMs: statSync(p).mtimeMs };
}

function loadRawVersion(p: string): number | undefined {
  if (!existsSync(p)) return undefined;
  try {
    const v = (readJsonFile(p) as { version?: unknown }).version;
    return typeof v === 'number' ? v : undefined;
  } catch {
    return undefined;
  }
}

function pruneHistory(dir: string): void {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort();
  for (const f of files.slice(0, Math.max(0, files.length - HISTORY_KEEP))) {
    rmSync(join(dir, f), { force: true });
  }
}

export interface DashboardListing {
  slug: string;
  title: string;
  panels: number;
  mtimeMs: number;
  error?: string;
}

export function listDashboards(): DashboardListing[] {
  const dir = homePath('dashboards');
  if (!existsSync(dir)) return [];
  const out: DashboardListing[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    const slug = f.slice(0, -5);
    if (!SLUG_RE.test(slug)) continue;
    try {
      const d = loadDashboard(slug);
      if (!d) continue;
      out.push({
        slug,
        title: typeof d.spec.title === 'string' ? d.spec.title : slug,
        // Text blocks are not data panels; count only the ones that run a query.
        panels: Array.isArray(d.spec.panels) ? d.spec.panels.filter((p) => (p as { type?: unknown })?.type !== 'text').length : 0,
        mtimeMs: d.mtimeMs,
      });
    } catch (e) {
      out.push({ slug, title: slug, panels: 0, mtimeMs: 0, error: (e as Error).message });
    }
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

export function removedPanelIds(oldSpec: unknown, next: DashboardSpec): string[] {
  const oldPanels = (oldSpec as { panels?: unknown })?.panels;
  if (!Array.isArray(oldPanels)) return [];
  const nextIds = new Set(next.panels.map((p) => p.id));
  return oldPanels
    .map((p) => (p && typeof p === 'object' ? (p as { id?: unknown }).id : undefined))
    .filter((id): id is string => typeof id === 'string' && !nextIds.has(id));
}
