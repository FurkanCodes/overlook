/**
 * The MCP tools. Each is a thin call into the core library and returns plain
 * text, which every agent can show to its model.
 */
import { z } from 'zod';
import { checkDashboard, summarizeCheck, type CheckResult } from '../check.js';
import { basename, extname } from 'node:path';
import {
  addSource,
  inferSource,
  isDbSource,
  loadConfig,
  normalizePath,
  removeSource,
  samplesEnabled,
  sourceLocation,
  type Config,
  type SourceDef,
} from '../config.js';
import { extensionFor, installExtensions, type EngineHolder, type QueryResult, type SourceDescription } from '../engine/engine.js';
import { findDataFiles, findDatabaseUrls, nameFor, projectFileSource, projectRoot } from '../project.js';
import { autoDashboard } from '../auto.js';
import type { Engine } from '../engine/engine.js';
import { SPEC_REFERENCE } from '../spec/reference.js';
import { listDashboards, loadDashboard, loadRaw, removedPanelIds, saveDashboard, slugify } from '../store.js';
import { baseUrl, ensureServer, openInBrowser } from '../server/control.js';

export interface ToolText {
  text: string;
  isError?: boolean;
}

/**
 * The one definition of every tool's name, description and input. The MCP
 * server registers these, and the eval runner sends the same ones to the
 * model, so both test the same tool surface.
 */
export const TOOL_SPECS = {
  describe_data: {
    title: 'Describe data sources',
    description: 'List the registered data sources with their tables, columns, types and row counts. Pass "source" to see one source with a few sample rows. Call this first.',
    input: { source: z.string().optional().describe('one source name; omit for all') },
    readOnly: true,
  },
  auto_dashboard: {
    title: 'Build a dashboard automatically',
    description:
      'Build, check, save and open a dashboard from the data in one step: KPIs with trends, a trend chart, breakdowns and a summary table, chosen from the columns. Use it when the user asks for a dashboard without saying exactly what to show. With no arguments it uses the registered source, or the largest data file in this project. Refine the result afterwards with get_dashboard and save_dashboard.',
    input: {
      source: z.string().optional().describe('a registered source name'),
      path: z.string().optional().describe('or: a data file in this project to add and use'),
      table: z.string().optional().describe('for a database source: which table'),
      title: z.string().optional().describe('dashboard title'),
      name: z.string().optional().describe('dashboard name for the URL'),
    },
    readOnly: false,
  },
  add_source: {
    title: 'Add a data source from this project',
    description:
      'Register a data file in this project (CSV, TSV, Parquet, JSONL, SQLite, DuckDB; a glob like "data/*.parquet" works) or a Postgres/MySQL database whose URL is in the project\'s .env file, so dashboards can query it. Only paths inside the project are accepted. describe_data lists what it found. A SQLite or database source downloads a DuckDB extension once.',
    input: {
      name: z.string().describe('source name used in SQL, e.g. "sales" (letters, digits, _)'),
      path: z.string().optional().describe('file path or glob, relative to the project'),
      env: z.string().optional().describe('instead of path: the .env variable holding a postgres:// or mysql:// URL, e.g. "DATABASE_URL"'),
    },
    readOnly: false,
  },
  preview_query: {
    title: 'Preview a query',
    description:
      'Run one read-only SQL query (SELECT/WITH/FROM, DuckDB dialect) and see its columns, types and first 20 rows. Use it to check a panel query before saving. Filter values go in "params" as {"region": "EMEA"} for $region.',
    input: {
      sql: z.string().describe('one SELECT query'),
      source: z.string().optional().describe('the source the query reads (optional)'),
      params: z.record(z.string(), z.string().nullable()).optional().describe('values for $parameters'),
    },
    readOnly: true,
  },
  save_dashboard: {
    title: 'Save a dashboard',
    description:
      'Check and save a dashboard spec. Every query is run and every chart column is checked; if anything is wrong nothing is saved and you get a numbered list of fixes. Saving with an existing name replaces that dashboard. Returns the URL to give the user. Call get_spec_reference for the format.',
    input: {
      name: z.string().describe('short name; becomes the URL, e.g. "sales-overview"'),
      spec: z.union([z.record(z.string(), z.unknown()), z.string()]).describe('the dashboard spec object: {"version":1,"title":...,"panels":[...]}'),
    },
    readOnly: false,
  },
  get_dashboard: {
    title: 'Get a dashboard',
    description: "Return a saved dashboard's spec and the current status of each panel (queries are re-run now). Use before editing.",
    input: { name: z.string().describe('dashboard name') },
    readOnly: true,
  },
  list_dashboards: {
    title: 'List dashboards',
    description: 'List saved dashboards with their titles and URLs.',
    input: {},
    readOnly: true,
  },
  get_spec_reference: {
    title: 'Dashboard spec reference',
    description: 'The dashboard spec format: panel types, fields, filters and a full example. Read once before writing a spec.',
    input: {},
    readOnly: true,
  },
} as const;

export type ToolName = keyof typeof TOOL_SPECS;

/** The tools as JSON Schema function definitions (OpenAI-compatible shape). */
export function toolJsonSchemas(): { type: 'function'; function: { name: string; description: string; parameters: unknown } }[] {
  return (Object.keys(TOOL_SPECS) as ToolName[]).map((name) => ({
    type: 'function',
    function: { name, description: TOOL_SPECS[name].description, parameters: z.toJSONSchema(z.object(TOOL_SPECS[name].input)) },
  }));
}

function cell(v: unknown): string {
  if (v === null || v === undefined) return '∅';
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  const one = s.replace(/\s+/g, ' ');
  return one.length > 40 ? `${one.slice(0, 39)}…` : one;
}

export function textTable(r: Pick<QueryResult, 'columns' | 'rows'>, max = 20): string {
  if (r.columns.length === 0) return '(no columns)';
  const head = r.columns.map((c) => c.name).join(' | ');
  const rows = r.rows.slice(0, max).map((row) => r.columns.map((c) => cell(row[c.name])).join(' | '));
  return [head, ...rows].join('\n');
}

/** What the project holds that is not registered yet, for describe_data. */
function projectText(config: Config): string {
  if (!agentSourcesEnabled()) return '';
  const root = projectRoot();
  if (!root) return '';
  const taken = new Set(Object.keys(config.sources));
  const registered = new Set(Object.values(config.sources).flatMap((d) => (isDbSource(d) ? [] : [normalizePath(d.path).toLowerCase()])));
  const registeredEnv = new Set(Object.values(config.sources).flatMap((d) => (isDbSource(d) && d.env ? [d.env] : [])));
  const files = findDataFiles(root, taken).filter((f) => !registered.has(f.path.toLowerCase()));
  const dbs = findDatabaseUrls(root, taken).filter((d) => !registeredEnv.has(d.env));
  if (files.length === 0 && dbs.length === 0) return '';
  const lines = [`\n## Not added yet, in this project (${normalizePath(root)})`];
  for (const f of files) lines.push(`- ${f.rel} (${f.kind === 'file' ? extname(f.rel).slice(1) : f.kind}, ${humanBytes(f.bytes)}) → add_source {"name": "${f.suggested}", "path": "${f.rel}"}`);
  for (const d of dbs) lines.push(`- ${d.kind} database in ${basename(d.envFile)} as ${d.env} → add_source {"name": "${d.suggested}", "env": "${d.env}"}`);
  lines.push('Add the ones the user wants with add_source, then call describe_data again.');
  return lines.join('\n');
}

function humanBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(1)} GB`;
}

export function agentSourcesEnabled(): boolean {
  return process.env.OVERLOOK_AGENT_SOURCES !== '0';
}

function describeText(sources: SourceDescription[], showSamples: boolean, project = ''): string {
  if (sources.length === 0) {
    if (project) return `No data sources are registered yet.${project}`;
    return 'No data sources are registered, and no data files were found in this project. Ask the user where the data is, then call add_source with a path inside the project, or ask them to run:\n  npx overlook-dash source add <name> <path or postgres:// URL>';
  }
  const parts: string[] = [];
  for (const s of sources) {
    if (!s.ok) {
      parts.push(`## ${s.alias} (${s.type}) — NOT AVAILABLE: ${s.error ?? 'unknown error'}`);
      continue;
    }
    parts.push(`## ${s.alias} (${s.type})`);
    for (const t of s.tables) {
      parts.push(`table ${t.ref}${t.rowCount !== null ? ` — ${t.rowCount.toLocaleString('en-US')} rows` : ''}`);
      parts.push(t.columns.map((c) => `  ${c.name} ${c.type}`).join('\n'));
      if (showSamples && t.sample && t.sample.length > 0) {
        parts.push('  sample rows:');
        parts.push(textTable({ columns: t.columns, rows: t.sample }, 3).split('\n').map((l) => `  ${l}`).join('\n'));
      }
    }
    if (s.tables.length === 0) parts.push('(no tables)');
  }
  parts.push('\nUse a source name as the panel "source". A file source is queried as one table named after it (FROM sales).');
  if (project) parts.push(project);
  return parts.join('\n');
}

/** Stage reached by the last check, for the tool-call log. */
export function checkStage(r: CheckResult | undefined): string | undefined {
  if (!r) return undefined;
  if (r.ok) return 'saved';
  const paths = r.errors.map((e) => e.path);
  if (paths.some((p) => /\.(x|y|series|value|compare|columns)/.test(p) && !/sql/.test(p))) return 'fields';
  if (paths.some((p) => /\.sql|options_sql/.test(p))) return 'query';
  return 'schema';
}

let lastCheck: CheckResult | undefined;

/** Take (and clear) the check result of the last save, for logging. */
export function takeLastCheck(): CheckResult | undefined {
  const r = lastCheck;
  lastCheck = undefined;
  return r;
}

/** Register a file or .env database from the project. Shared by add_source and auto_dashboard. */
async function addFromProject(engines: EngineHolder, args: { name: string; path?: string; env?: string }): Promise<{ error: ToolText } | { def: SourceDef; engine: Engine }> {
  if (!agentSourcesEnabled()) {
    return { error: { text: 'Adding sources from the agent is turned off (OVERLOOK_AGENT_SOURCES=0). Ask the user to run: npx overlook-dash source add <name> <path>', isError: true } };
  }
  const root = projectRoot();
  if (!root) {
    return { error: {
      text: `There is no project folder to add from (Overlook is running in ${normalizePath(process.cwd())}). Ask the user to run: npx overlook-dash source add ${args.name || '<name>'} <path>, or to set OVERLOOK_PROJECT.`,
      isError: true,
    } };
  }
  if (!args.path === !args.env) return { error: { text: 'Pass exactly one of "path" (a data file) or "env" (a .env variable holding a database URL).', isError: true } };
  const config = loadConfig();
  let def: SourceDef;
  const had = args.name in config.sources;
  try {
    if (args.env) {
      const found = findDatabaseUrls(root).find((d) => d.env === args.env);
      if (!found) {
        const known = findDatabaseUrls(root).map((d) => d.env);
        return { error: { text: `No postgres:// or mysql:// URL named ${args.env} in this project's .env files.${known.length ? ` Found: ${known.join(', ')}` : ''}`, isError: true } };
      }
      def = { type: found.kind, env: found.env, envFile: found.envFile };
    } else {
      def = projectFileSource(root, args.path!, inferSource);
    }
    const existing = config.sources[args.name];
    if (existing && JSON.stringify(existing) !== JSON.stringify(def)) {
      return { error: { text: `A source named "${args.name}" already exists (${sourceLocation(existing)}). Pick another name.`, isError: true } };
    }
    const ext = extensionFor(def);
    if (ext) {
      const r = await installExtensions([ext]);
      if (r[ext] !== 'installed') return { error: { text: `Could not install DuckDB's ${ext} extension (needs internet once): ${r[ext]}`, isError: true } };
    }
    addSource(args.name, def);
  } catch (e) {
    return { error: { text: `Could not add the source: ${(e as Error).message}`, isError: true } };
  }
  const engine = await engines.get();
  if (engine.sourceErrors[args.name]) {
    if (!had) removeSource(args.name);
    return { error: { text: `"${args.name}" does not open, so it was not added: ${engine.sourceErrors[args.name]}`, isError: true } };
  }
  return { def, engine };
}

/** Dashboards this process has opened in the browser, so a revision never opens a second tab. */
const opened = new Set<string>();

/**
 * Open a new dashboard in the user's browser (an open page reloads itself
 * when the dashboard is saved again), and say what happened.
 */
function showDashboard(running: boolean, url: string, slug: string, replaced: boolean): string {
  if (!running) return 'Give the user the link above.';
  if (replaced || opened.has(slug)) return 'An open page updates by itself within a few seconds. Give the user the link above.';
  if (openInBrowser(url)) {
    opened.add(slug);
    return "Opened it in the user's browser. Also give the user the link above.";
  }
  return 'Give the user the link above.';
}

/** The source auto_dashboard should use when the user named none. */
function pickSource(config: Config): string | undefined {
  const names = Object.keys(config.sources);
  if (names.length <= 1) return names[0];
  const root = projectRoot();
  if (root) {
    const inProject = names.filter((n) => {
      const d = config.sources[n]!;
      return (!isDbSource(d) && normalizePath(d.path).toLowerCase().startsWith(normalizePath(root).toLowerCase() + '/')) || (isDbSource(d) && d.envFile?.toLowerCase().startsWith(normalizePath(root).toLowerCase() + '/'));
    });
    if (inProject.length > 0) return inProject[inProject.length - 1];
  }
  return names[names.length - 1];
}

export function createTools(engines: EngineHolder) {
  return {
    async auto_dashboard(args: { source?: string; path?: string; table?: string; title?: string; name?: string }): Promise<ToolText> {
      const notes: string[] = [];
      let source = args.source;
      let engine = await engines.get();
      if (source && !engine.aliases().includes(source)) {
        return { text: `No source named "${source}". Sources: ${engine.aliases().join(', ') || '(none)'}. Pass "path" to use a file in this project.`, isError: true };
      }
      if (!source && args.path) {
        const root = projectRoot();
        const name = nameFor(args.path, new Set(engine.aliases()));
        const existing = root ? findDataFiles(root).find((f) => f.rel === normalizePath(args.path!)) : undefined;
        const r = await addFromProject(engines, { name: existing?.suggested ?? name, path: args.path });
        if ('error' in r) return r.error;
        source = existing?.suggested ?? name;
        engine = r.engine;
        notes.push(`added ${args.path} as source "${source}"`);
      }
      if (!source) source = pickSource(engine.config);
      if (!source) {
        // Nothing registered: take the largest data file in the project.
        const root = projectRoot();
        const files = root && agentSourcesEnabled() ? findDataFiles(root).filter((f) => f.kind === 'file' || f.kind === 'duckdb') : [];
        const pick = [...files].sort((a, b) => b.bytes - a.bytes)[0];
        if (!pick) {
          const dbs = root ? findDatabaseUrls(root) : [];
          const hint = dbs.length ? ` This project's .env names a database (${dbs.map((d) => d.env).join(', ')}): call add_source with "env", then auto_dashboard with its source name.` : '';
          return {
            text: `No data found. No sources are registered and there are no data files in ${root ? normalizePath(root) : 'this folder'}.${hint} Ask the user which file or database to use, then pass it as "path".`,
            isError: true,
          };
        }
        const r = await addFromProject(engines, { name: pick.suggested, path: pick.rel });
        if ('error' in r) return r.error;
        source = pick.suggested;
        engine = r.engine;
        notes.push(`added ${pick.rel} as source "${source}"${files.length > 1 ? ` (the largest of ${files.length} data files here; others: ${files.filter((f) => f !== pick).slice(0, 5).map((f) => f.rel).join(', ')})` : ''}`);
      }

      const built = await autoDashboard(engine, { source, ...(args.table ? { table: args.table } : {}), ...(args.title ? { title: args.title } : {}) });
      lastCheck = built.check;
      if (!built.ok || !built.spec) {
        return { text: `Could not build a dashboard from "${source}": ${built.notes.join('; ')}. Call describe_data and write one with save_dashboard instead.`, isError: true };
      }
      const slug = slugify(args.name ?? built.spec.title);
      let old: unknown;
      try {
        old = loadRaw(slug);
      } catch {
        old = undefined;
      }
      try {
        saveDashboard(slug, built.spec);
      } catch (e) {
        return { text: `Could not save: ${(e as Error).message}`, isError: true };
      }
      const server = await ensureServer();
      const url = `${server.url}/d/${slug}`;
      const lines = [`${old ? 'Replaced' : 'Created'} dashboard "${built.spec.title}" from ${source}.`, `Open: ${url}`, showDashboard(server.running, url, slug, Boolean(old))];
      if (server.note) lines.push(`Note: ${server.note}`);
      lines.push('', 'Panels:', ...built.spec.panels.map((p) => `- ${p.id} (${p.type})${'title' in p && p.title ? `: ${p.title}` : ''}`));
      const allNotes = [...notes, ...built.notes];
      if (allNotes.length) lines.push('', 'Notes:', ...allNotes.map((n) => `- ${n}`));
      lines.push('', `To change it: get_dashboard "${slug}", edit the spec, save_dashboard with the same name.`);
      return { text: lines.join('\n') };
    },

    async describe_data(args: { source?: string }): Promise<ToolText> {
      const engine = await engines.get();
      if (args.source && !engine.aliases().includes(args.source)) {
        return { text: `No source named "${args.source}". Sources: ${engine.aliases().join(', ') || '(none)'}`, isError: true };
      }
      const samples = Boolean(args.source) && samplesEnabled(engine.config);
      const d = await engine.describe(args.source, { samples });
      return { text: describeText(d, samples, args.source ? '' : projectText(engine.config)) };
    },

    async add_source(args: { name: string; path?: string; env?: string }): Promise<ToolText> {
      const r = await addFromProject(engines, args);
      if ('error' in r) return r.error;
      const [d] = await r.engine.describe(args.name);
      return { text: `Added source "${args.name}" (${r.def.type}, ${sourceLocation(r.def)}).\n\n${describeText(d ? [d] : [], false)}` };
    },

    async preview_query(args: { sql: string; source?: string; params?: Record<string, string | null> }): Promise<ToolText> {
      const engine = await engines.get();
      if (args.source && !engine.aliases().includes(args.source)) {
        return { text: `No source named "${args.source}". Sources: ${engine.aliases().join(', ') || '(none)'}`, isError: true };
      }
      try {
        const r = await engine.run(args.sql, args.params ?? {}, { limit: 20, timeoutMs: 15_000 });
        const types = r.columns.map((c) => `${c.name} ${c.type}`).join(', ');
        let total = '';
        if (r.truncated) {
          try {
            const inner = args.sql.trim().replace(/;\s*$/, '');
            const c = await engine.run(`SELECT count(*) AS n FROM (\n${inner}\n)`, args.params ?? {}, { limit: 1, timeoutMs: 5_000 });
            total = ` of ${Number(c.rows[0]?.n ?? 0).toLocaleString('en-US')}`;
          } catch {
            total = ' of more';
          }
        }
        return { text: `${r.rows.length}${total} rows in ${r.ms} ms\ncolumns: ${types}\n\n${textTable(r)}` };
      } catch (e) {
        return { text: `Query failed: ${(e as Error).message}`, isError: true };
      }
    },

    async save_dashboard(args: { name: string; spec: unknown }): Promise<ToolText> {
      const engine = await engines.get();
      const slug = slugify(args.name ?? '');
      const result: CheckResult = await checkDashboard(args.spec, engine);
      lastCheck = result;
      if (!result.ok || !result.spec) {
        return { text: summarizeCheck(result), isError: true };
      }
      let old: unknown;
      try {
        old = loadRaw(slug);
      } catch {
        old = undefined;
      }
      const extra: string[] = [];
      const removed = old ? removedPanelIds(old, result.spec) : [];
      if (removed.length > 0) extra.push(`- panels removed compared with the previous version: ${removed.join(', ')} (if that was not intended, call get_dashboard and save again with them)`);
      const oldTitle = (old as { title?: unknown } | undefined)?.title;
      if (typeof oldTitle === 'string' && oldTitle !== result.spec.title) extra.push(`- replaced the dashboard previously titled "${oldTitle}"`);
      try {
        saveDashboard(slug, result.spec);
      } catch (e) {
        return { text: `Could not save: ${(e as Error).message}`, isError: true };
      }
      const server = await ensureServer();
      const url = `${server.url}/d/${slug}`;
      const shown = showDashboard(server.running, url, slug, Boolean(old));
      const lines = [`${old ? 'Replaced' : 'Created'} dashboard "${result.spec.title}".`, `Open: ${url}`, shown];
      if (server.note) lines.push(`Note: ${server.note}`);
      lines.push('', 'Panels:', ...result.panels.map((p) => `- ${p.id} (${p.type})${p.rows !== undefined ? `: ${p.rows} rows, ${p.ms} ms` : ''}`));
      const summary = summarizeCheck(result);
      if (summary) lines.push('', summary);
      if (extra.length) lines.push('', 'Also:', ...extra);
      return { text: lines.join('\n') };
    },

    async get_dashboard(args: { name: string }): Promise<ToolText> {
      const slug = slugify(args.name ?? '');
      let raw: unknown;
      try {
        // loadDashboard applies the version guard (a newer spec is refused).
        loadDashboard(slug);
        raw = loadRaw(slug);
      } catch (e) {
        return { text: `Dashboard "${slug}" could not be read: ${(e as Error).message}`, isError: true };
      }
      if (raw === undefined) {
        const names = listDashboards().map((d) => d.slug);
        return { text: `No dashboard named "${slug}". Dashboards: ${names.join(', ') || '(none)'}`, isError: true };
      }
      const engine = await engines.get();
      const r = await checkDashboard(raw, engine);
      const status = r.ok
        ? r.panels.map((p) => `- ${p.id} (${p.type}): ok${p.rows !== undefined ? `, ${p.rows} rows` : ''}`).join('\n')
        : summarizeCheck(r, 'This dashboard currently has problems.');
      return {
        text: [`Dashboard "${slug}" — ${baseUrl()}/d/${slug}`, '', 'Current status:', status, '', 'Spec:', JSON.stringify(raw, null, 2)].join('\n'),
      };
    },

    async list_dashboards(): Promise<ToolText> {
      const list = listDashboards();
      if (list.length === 0) return { text: 'No dashboards yet. Create one with save_dashboard.' };
      return {
        text: list
          .map((d) => `- ${d.slug}: "${d.title}" (${d.panels} panels, updated ${d.mtimeMs ? new Date(d.mtimeMs).toISOString().slice(0, 16).replace('T', ' ') : '?'}) ${baseUrl()}/d/${d.slug}${d.error ? ` — ERROR: ${d.error}` : ''}`)
          .join('\n'),
      };
    },

    async get_spec_reference(): Promise<ToolText> {
      return { text: SPEC_REFERENCE };
    },
  };
}
