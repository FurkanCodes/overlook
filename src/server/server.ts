/**
 * `overlook serve`: the local web server that draws dashboards.
 *
 * It answers only on 127.0.0.1, checks the Host header (DNS rebinding), sends
 * no CORS headers, requires a JSON body on every POST (no cross-site forms),
 * and only ever runs SQL that is stored in a saved dashboard.
 */
import { existsSync, readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { basename, join } from 'node:path';
import { DATE_RE } from '../check.js';
import { configMtime, isDbSource } from '../config.js';
import { EngineHolder, QueryError } from '../engine/engine.js';
import { log } from '../log.js';
import { Dashboard, type DashboardSpec } from '../spec/schema.js';
import { SLUG_RE, dashboardMtime, listDashboards, loadDashboard } from '../store.js';
import { PACKAGE_ROOT, VERSION } from '../version.js';
import { probe } from './control.js';

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

const MAX_BODY = 64 * 1024;
const PARAM_MAX = 200;

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function uiDir(): string {
  return process.env.OVERLOOK_UI_DIR ?? join(PACKAGE_ROOT, 'dist', 'ui');
}

const ASSETS: Record<string, string> = {
  'app.js': 'text/javascript; charset=utf-8',
  'app.css': 'text/css; charset=utf-8',
  'favicon.svg': 'image/svg+xml',
  'inter.woff2': 'font/woff2',
};

function securityHeaders(res: ServerResponse): void {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(text);
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

function pageHtml(title: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${escapeHtml(title)}</title>
<link rel="icon" href="/assets/favicon.svg" type="image/svg+xml">
<link rel="preload" href="/assets/inter.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="/assets/app.css">
<script src="/assets/app.js" defer></script>
</head>
<body>
<div id="app" aria-live="polite"></div>
<noscript>Overlook needs JavaScript to draw dashboards.</noscript>
</body>
</html>`;
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const type = (req.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
  if (type !== 'application/json') throw new HttpError(415, 'POST requests must send Content-Type: application/json');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, 'request body too large');
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8') || '{}';
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, 'request body is not valid JSON');
  }
}

/** Load a dashboard and validate its shape (files can be edited by hand). */
function loadValid(slug: string): { spec: DashboardSpec; mtimeMs: number } {
  if (!SLUG_RE.test(slug)) throw new HttpError(404, 'no such dashboard');
  let stored;
  try {
    stored = loadDashboard(slug);
  } catch (e) {
    throw new HttpError(422, (e as Error).message);
  }
  if (!stored) throw new HttpError(404, `no dashboard named "${slug}"`);
  const parsed = Dashboard.safeParse(stored.spec);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new HttpError(422, `the dashboard file is not a valid spec (${first ? `${first.path.join('.')}: ${first.message}` : 'invalid'}). Ask your agent to fix it with save_dashboard.`);
  }
  return { spec: parsed.data, mtimeMs: stored.mtimeMs };
}

function cleanParams(spec: DashboardSpec, raw: unknown): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  const given = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  for (const f of spec.filters ?? []) {
    const v = given[f.id];
    if (v === undefined || v === null || v === '') {
      out[f.id] = null;
      continue;
    }
    if (typeof v !== 'string' || v.length > PARAM_MAX) throw new HttpError(400, `filter "${f.id}" must be a string of at most ${PARAM_MAX} characters`);
    if (f.type === 'date' && !DATE_RE.test(v)) throw new HttpError(400, `filter "${f.id}" must be a date (YYYY-MM-DD)`);
    out[f.id] = v;
  }
  return out;
}

export interface ServeOptions {
  port: number;
}

export interface RunningServer {
  server: Server;
  port: number;
  close(): Promise<void>;
}

/**
 * At most `n` queries run at once; the rest wait their turn. A request whose
 * browser went away while it waited is dropped instead of run.
 */
function limiter(n: number) {
  let active = 0;
  const queue: (() => void)[] = [];
  return async <T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> => {
    if (active >= n) await new Promise<void>((r) => queue.push(r));
    if (signal?.aborted) {
      queue.shift()?.();
      throw new QueryError('the request was cancelled', 'cancelled');
    }
    active++;
    try {
      return await fn();
    } finally {
      active--;
      queue.shift()?.();
    }
  };
}

export async function startServer(opts: ServeOptions): Promise<RunningServer> {
  const port = opts.port;
  const engines = new EngineHolder();
  const limit = limiter(4);
  const healthCache = new Map<string, { key: string; at: number; body: unknown }>();
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const origin = `http://127.0.0.1:${port}`;
  const allowedOrigins = new Set([origin, `http://localhost:${port}`]);

  const server = createServer((req, res) => {
    handle(req, res).catch((e: unknown) => {
      const status = e instanceof HttpError ? e.status : 500;
      if (status === 500) log.error(`request failed: ${(e as Error)?.stack ?? String(e)}`);
      if (!res.headersSent) sendJson(res, status, { error: e instanceof Error ? e.message : 'internal error' });
      else res.end();
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    securityHeaders(res);
    const host = req.headers.host ?? '';
    if (!allowedHosts.has(host)) throw new HttpError(403, 'forbidden host');
    const method = req.method ?? 'GET';
    if (method !== 'GET' && method !== 'HEAD' && method !== 'POST') throw new HttpError(405, 'method not allowed');
    if (method === 'POST') {
      const o = req.headers.origin;
      if (o !== undefined && !allowedOrigins.has(o)) throw new HttpError(403, 'forbidden origin');
    }
    const url = new URL(req.url ?? '/', origin);
    const path = url.pathname;

    // Static assets.
    if (method !== 'POST' && path.startsWith('/assets/')) {
      const name = path.slice('/assets/'.length);
      const type = ASSETS[name];
      if (!type) throw new HttpError(404, 'not found');
      const file = join(uiDir(), name);
      if (!existsSync(file)) throw new HttpError(404, `asset missing; run "npm run build" (${name})`);
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
      res.end(method === 'HEAD' ? undefined : readFileSync(file));
      return;
    }

    // Pages: the bundle routes on the client.
    if (method !== 'POST' && (path === '/' || /^\/d\/[a-z0-9-]+\/?$/.test(path))) {
      let title = 'Overlook';
      const m = /^\/d\/([a-z0-9-]+)/.exec(path);
      if (m && SLUG_RE.test(m[1]!)) {
        try {
          const d = loadDashboard(m[1]!);
          if (d && typeof d.spec.title === 'string') title = `${d.spec.title} · Overlook`;
        } catch {
          /* the page will show the error */
        }
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(pageHtml(title));
      return;
    }

    if (path === '/api/health' && method === 'GET') {
      sendJson(res, 200, { app: 'overlook', version: VERSION, pid: process.pid });
      return;
    }

    if (path === '/api/shutdown' && method === 'POST') {
      await readJsonBody(req);
      sendJson(res, 200, { ok: true });
      setTimeout(() => void running.close().then(() => process.exit(0)), 50);
      return;
    }

    if (path === '/api/dashboards' && method === 'GET') {
      sendJson(res, 200, { dashboards: listDashboards() });
      return;
    }

    let m = /^\/api\/d\/([a-z0-9-]+)$/.exec(path);
    if (m && method === 'GET') {
      const slug = m[1]!;
      const { spec, mtimeMs } = loadValid(slug);
      const engine = await engines.get();
      const sources: Record<string, string> = {};
      // The file name only (never the full path), so the SQL drawer can say
      // which file a number came from without exposing the folder layout.
      const sourceNames: Record<string, string> = {};
      for (const p of spec.panels) {
        if (p.type === 'text') continue;
        const def = engine.config.sources[p.source];
        sources[p.source] = def?.type ?? 'missing';
        if (def) sourceNames[p.source] = isDbSource(def) ? (def.env ? `${def.type} (${def.env})` : def.type) : basename(def.path.replaceAll('\\', '/'));
      }
      sendJson(res, 200, { slug, spec, mtimeMs, sources, sourceNames });
      return;
    }

    m = /^\/api\/d\/([a-z0-9-]+)\/mtime$/.exec(path);
    if (m && method === 'GET') {
      const slug = m[1]!;
      if (!SLUG_RE.test(slug)) throw new HttpError(404, 'no such dashboard');
      sendJson(res, 200, { mtimeMs: dashboardMtime(slug) ?? null });
      return;
    }

    // Health for the list page: run every panel's query once (1 row, short
    // timeout, default filter values) and report which fail. The result is
    // cached until the dashboard file or the config changes, or for 60 s.
    m = /^\/api\/d\/([a-z0-9-]+)\/health$/.exec(path);
    if (m && method === 'GET') {
      const slug = m[1]!;
      let spec: DashboardSpec;
      let mtimeMs: number;
      try {
        ({ spec, mtimeMs } = loadValid(slug));
      } catch (e) {
        if (e instanceof HttpError && e.status === 422) {
          sendJson(res, 200, { panels: 0, failed: [{ id: '', error: e.message }] });
          return;
        }
        throw e;
      }
      const key = `${slug}:${mtimeMs}:${configMtime()}`;
      const hit = healthCache.get(slug);
      if (hit && hit.key === key && Date.now() - hit.at < 60_000) {
        sendJson(res, 200, hit.body);
        return;
      }
      const defaults: Record<string, string | null> = {};
      for (const f of spec.filters ?? []) defaults[f.id] = f.default ?? null;
      const queryPanels = spec.panels.filter((p) => p.type !== 'text');
      const failed: { id: string; error: string }[] = [];
      for (const p of spec.panels) {
        if (p.type === 'text') continue;
        try {
          await limit(async () => {
            const engine = await engines.get();
            if (engine.sourceErrors[p.source]) throw new Error(`source "${p.source}" could not be opened`);
            if (!engine.config.sources[p.source]) throw new Error(`source "${p.source}" is not registered`);
            return engine.run(p.sql, defaults, { limit: 1, timeoutMs: 5_000 });
          });
        } catch (e) {
          failed.push({ id: p.id, error: (e as Error).message });
        }
      }
      const body = { panels: queryPanels.length, failed };
      healthCache.set(slug, { key, at: Date.now(), body });
      sendJson(res, 200, body);
      return;
    }

    m = /^\/api\/d\/([a-z0-9-]+)\/panels\/([A-Za-z0-9_]+)$/.exec(path);
    if (m && method === 'POST') {
      const body = (await readJsonBody(req)) as { params?: unknown };
      const { spec } = loadValid(m[1]!);
      const panel = spec.panels.find((p) => p.id === m![2]);
      if (!panel) throw new HttpError(404, `no panel "${m[2]}"`);
      if (panel.type === 'text') throw new HttpError(400, 'text panels have no data');
      const params = cleanParams(spec, body.params);
      // Cancel the query if the browser drops the request (a filter changed,
      // the tab closed).
      const ctrl = new AbortController();
      res.on('close', () => {
        if (!res.writableFinished) ctrl.abort();
      });
      try {
        const r = await limit(async () => {
          // Fetch the engine only when this query's turn comes, so a queued
          // request never holds an engine that was replaced meanwhile.
          const engine = await engines.get();
          if (!engine.config.sources[panel.source]) {
            throw new QueryError(`source "${panel.source}" is not registered on this machine`, 'source');
          }
          if (engine.sourceErrors[panel.source]) {
            throw new QueryError(`source "${panel.source}" could not be opened: ${engine.sourceErrors[panel.source]}`, 'source');
          }
          return engine.run(panel.sql, params, { limit: 5000, timeoutMs: 15_000, signal: ctrl.signal });
        }, ctrl.signal);
        sendJson(res, 200, { ...r, ranAt: new Date().toISOString() });
      } catch (e) {
        if (ctrl.signal.aborted) return;
        const kind = e instanceof QueryError ? e.kind : 'duckdb';
        sendJson(res, 200, { error: (e as Error).message, kind });
      }
      return;
    }

    m = /^\/api\/d\/([a-z0-9-]+)\/options\/([A-Za-z0-9_]+)$/.exec(path);
    if (m && method === 'GET') {
      const { spec } = loadValid(m[1]!);
      const f = (spec.filters ?? []).find((x) => x.id === m![2]);
      if (!f) throw new HttpError(404, `no filter "${m[2]}"`);
      if (f.options) {
        sendJson(res, 200, { options: f.options });
        return;
      }
      if (!f.options_sql) {
        sendJson(res, 200, { options: [] });
        return;
      }
      try {
        const r = await limit(async () => (await engines.get()).run(f.options_sql!, {}, { limit: 500, timeoutMs: 10_000 }));
        const col = r.columns[0]?.name;
        const options = col ? [...new Set(r.rows.map((row) => row[col]).filter((v) => v !== null && v !== undefined).map(String))] : [];
        sendJson(res, 200, { options });
      } catch (e) {
        sendJson(res, 200, { options: [], error: (e as Error).message });
      }
      return;
    }

    throw new HttpError(404, 'not found');
  }

  await new Promise<void>((resolve, reject) => {
    const onError = (e: NodeJS.ErrnoException) => {
      server.off('listening', onListening);
      reject(e);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, '127.0.0.1');
  });

  server.on('error', (e) => log.error(`server error: ${e.message}`));

  const running: RunningServer = {
    server,
    port,
    close: () =>
      new Promise<void>((resolve) => {
        engines.close();
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
  return running;
}

/** CLI entry for `overlook serve`. */
export async function serveCommand(port: number): Promise<void> {
  let running: RunningServer;
  try {
    running = await startServer({ port });
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === 'EADDRINUSE') {
      const p = await probe(port);
      if (p.kind === 'overlook') {
        log.info(`an Overlook server (${p.health.version}) is already running on port ${port}`);
        process.exit(0);
      }
      log.error(`port ${port} is in use by another program. Set "port" in the Overlook config or OVERLOOK_PORT.`);
      process.exit(1);
    }
    throw e;
  }
  log.info(`Overlook ${VERSION} serving dashboards at http://127.0.0.1:${port}`);
  const stop = () => void running.close().then(() => process.exit(0));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
