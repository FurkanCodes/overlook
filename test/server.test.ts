import { request } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { saveDashboard } from '../src/store.js';
import { startServer, type RunningServer } from '../src/server/server.js';
import { fixture, type Fixture } from './helpers.js';

let f: Fixture;
let srv: RunningServer;
const port = 47_000 + Math.floor(Math.random() * 1000);

beforeAll(async () => {
  f = await fixture();
  saveDashboard('sales', {
    version: 1,
    title: 'Sales',
    filters: [{ id: 'region', label: 'Region', type: 'select', options: ['EMEA', 'APAC'] }],
    panels: [
      { id: 'n', type: 'kpi', source: 'sales', sql: 'SELECT count(*) AS n FROM sales WHERE ($region IS NULL OR region = $region)', value: 'n' },
      { id: 'note', type: 'text', markdown: 'hi' },
    ],
  });
  srv = await startServer({ port });
});
afterAll(async () => {
  await srv.close();
  f.cleanup();
});

function call(path: string, opts: { method?: string; host?: string; headers?: Record<string, string>; body?: string } = {}): Promise<{ status: number; body: string; headers: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port, path, method: opts.method ?? 'GET', headers: { host: opts.host ?? `127.0.0.1:${port}`, ...opts.headers } },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += String(c)));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
      },
    );
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

const json = { 'content-type': 'application/json' };

describe('web server', () => {
  it('answers health with app and version', async () => {
    const r = await call('/api/health');
    expect(JSON.parse(r.body)).toMatchObject({ app: 'overlook' });
  });

  it('serves the page with a strict CSP and no CORS header', async () => {
    const r = await call('/d/sales');
    expect(r.status).toBe(200);
    expect(r.body).toContain('<title>Sales · Overlook</title>');
    expect(String(r.headers['content-security-policy'])).toContain("script-src 'self'");
    expect(r.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('escapes the dashboard title in HTML', async () => {
    saveDashboard('xss', { version: 1, title: '</title><script>alert(1)</script>', panels: [{ id: 't', type: 'text', markdown: 'x' }] });
    const r = await call('/d/xss');
    expect(r.body).not.toContain('<script>alert(1)</script>');
    expect(r.body).toContain('&lt;/title&gt;');
  });

  it('rejects other Host headers (DNS rebinding)', async () => {
    expect((await call('/api/health', { host: 'evil.example:80' })).status).toBe(403);
    expect((await call('/api/d/sales', { host: `attacker.test:${port}` })).status).toBe(403);
  });

  it('runs a stored panel with bound filters', async () => {
    const all = JSON.parse((await call('/api/d/sales/panels/n', { method: 'POST', headers: json, body: '{}' })).body);
    expect(all.rows[0].n).toBe(6);
    const emea = JSON.parse((await call('/api/d/sales/panels/n', { method: 'POST', headers: json, body: JSON.stringify({ params: { region: 'EMEA' } }) })).body);
    expect(emea.rows[0].n).toBe(2);
  });

  it('ignores undeclared params and rejects non-JSON or cross-origin POSTs', async () => {
    const r = JSON.parse((await call('/api/d/sales/panels/n', { method: 'POST', headers: json, body: JSON.stringify({ params: { region: 'EMEA', evil: 'x' } }) })).body);
    expect(r.rows[0].n).toBe(2);
    expect((await call('/api/d/sales/panels/n', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' })).status).toBe(415);
    expect((await call('/api/d/sales/panels/n', { method: 'POST', headers: { ...json, origin: 'https://evil.example' }, body: '{}' })).status).toBe(403);
    expect((await call('/api/shutdown', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'a=1' })).status).toBe(415);
  });

  it('404s unknown dashboards, panels and assets; refuses text panel data', async () => {
    expect((await call('/api/d/nope')).status).toBe(404);
    expect((await call('/api/d/sales/panels/zzz', { method: 'POST', headers: json, body: '{}' })).status).toBe(404);
    expect((await call('/api/d/sales/panels/note', { method: 'POST', headers: json, body: '{}' })).status).toBe(400);
    expect((await call('/assets/../../package.json')).status).toBe(404);
    expect((await call('/assets/secret.txt')).status).toBe(404);
  });

  it('reports a hand-edited invalid file instead of running it', async () => {
    const { writeFileSync } = await import('node:fs');
    const { dashboardPath } = await import('../src/store.js');
    writeFileSync(dashboardPath('broken'), JSON.stringify({ version: 1, title: 'B', panels: [{ id: 'x', type: 'kpi', source: 'sales', sql: 'SELECT 1' }] }));
    const r = await call('/api/d/broken');
    expect(r.status).toBe(422);
    expect(JSON.parse(r.body).error).toMatch(/not a valid spec/);
  });

  it('serves the bundled font locally with the right type', async () => {
    const r = await call('/assets/inter.woff2');
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toBe('font/woff2');
    const page = await call('/d/sales');
    expect(page.body).toContain('rel="preload" href="/assets/inter.woff2"');
  });

  it('reports dashboard health, naming failing panels', async () => {
    const ok = JSON.parse((await call('/api/d/sales/health')).body);
    expect(ok).toEqual({ panels: 1, failed: [] });
    saveDashboard('sick', { version: 1, title: 'Sick', panels: [{ id: 'bad', type: 'table', source: 'sales', sql: 'SELECT nope FROM sales' }] });
    const sick = JSON.parse((await call('/api/d/sick/health')).body);
    expect(sick.panels).toBe(1);
    expect(sick.failed[0].id).toBe('bad');
  });

  it('names each source file without exposing its folder', async () => {
    const body = JSON.parse((await call('/api/d/sales')).body);
    expect(body.sourceNames).toEqual({ sales: 'sales.csv' });
    expect(JSON.stringify(body)).not.toContain(f.dir.replaceAll('\\', '/'));
  });

  it('serves the mtime endpoint and the dashboard list', async () => {
    expect(JSON.parse((await call('/api/d/sales/mtime')).body).mtimeMs).toBeGreaterThan(0);
    const list = JSON.parse((await call('/api/dashboards')).body);
    expect(list.dashboards.map((d: { slug: string }) => d.slug)).toContain('sales');
  });
});
