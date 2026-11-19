import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { configPath, loadConfig, saveConfig } from '../src/config.js';
import { EngineHolder } from '../src/engine/engine.js';
import { ensureServer, probe } from '../src/server/control.js';
import { dashboardPath, listDashboards, loadDashboard, removedPanelIds, saveDashboard } from '../src/store.js';
import { fixture, type Fixture } from './helpers.js';

let f: Fixture;
beforeAll(async () => {
  f = await fixture();
});
afterAll(() => f.cleanup());

const spec = (title: string, ids = ['a']) => ({ version: 1 as const, title, panels: ids.map((id) => ({ id, type: 'text' as const, markdown: 'x' })) });

describe('store', () => {
  it('keeps history and prunes it to 20 copies', () => {
    for (let i = 0; i < 25; i++) saveDashboard('hist', spec(`v${i}`));
    const dir = join(f.home, 'history', 'hist');
    expect(readdirSync(dir).length).toBeLessThanOrEqual(20);
    expect(loadDashboard('hist')?.spec.title).toBe('v24');
    expect(readdirSync(dir).every((n) => !n.includes(':'))).toBe(true);
  });

  it('refuses to read or overwrite a file from a newer spec version', () => {
    writeFileSync(dashboardPath('future'), JSON.stringify({ version: 2, title: 'F', panels: [] }));
    expect(() => loadDashboard('future')).toThrow(/version 2/);
    expect(() => saveDashboard('future', spec('x'))).toThrow(/newer spec version/);
    expect(JSON.parse(readFileSync(dashboardPath('future'), 'utf8')).version).toBe(2);
  });

  it('lists dashboards, newest first, and reports broken files', () => {
    writeFileSync(dashboardPath('garbage'), '{nope');
    const list = listDashboards();
    expect(list.find((d) => d.slug === 'garbage')?.error).toMatch(/not valid JSON/);
    expect(list.find((d) => d.slug === 'hist')?.title).toBe('v24');
  });

  it('finds removed panel ids', () => {
    expect(removedPanelIds(spec('a', ['x', 'y']), spec('b', ['y']))).toEqual(['x']);
  });

  it('rejects unsafe slugs', () => {
    expect(() => dashboardPath('../etc')).toThrow();
    expect(() => dashboardPath('A')).toThrow();
  });
});

describe('config', () => {
  it('keeps keys it does not know when saving', () => {
    const raw = JSON.parse(readFileSync(configPath(), 'utf8'));
    writeFileSync(configPath(), JSON.stringify({ ...raw, futureKey: { keep: true } }));
    saveConfig(loadConfig());
    expect(JSON.parse(readFileSync(configPath(), 'utf8')).futureKey).toEqual({ keep: true });
  });

  it('refuses a config from a newer version', () => {
    const before = readFileSync(configPath(), 'utf8');
    writeFileSync(configPath(), JSON.stringify({ version: 2, sources: {} }));
    expect(() => loadConfig()).toThrow(/config version 2/);
    writeFileSync(configPath(), before);
  });
});

describe('engine lifecycle', () => {
  it('re-opens when the config changes, and retries a failed source', async () => {
    const holder = new EngineHolder(60_000);
    const e1 = await holder.get();
    expect(await holder.get()).toBe(e1);
    const c = loadConfig();
    await new Promise((r) => setTimeout(r, 20));
    saveConfig({ ...c, sources: { ...c.sources, missing: { type: 'file', path: `${f.dir.replaceAll('\\', '/')}/missing.csv` } } });
    const e2 = await holder.get();
    expect(e2).not.toBe(e1);
    expect(e2.sourceErrors.missing).toBeDefined();
    saveConfig(c);
    holder.close();
  });

  it('cancels a running query when its signal aborts', async () => {
    const ctrl = new AbortController();
    const p = f.engine.run('SELECT count(*) FROM range(100000000000) a, range(10) b', {}, { signal: ctrl.signal, timeoutMs: 30_000 });
    setTimeout(() => ctrl.abort(), 100);
    await expect(p).rejects.toThrow(/cancelled|interrupt/i);
    expect(f.engine.inflight).toBe(0);
  });
});

describe('server control', () => {
  it('sees an empty port as "none" quickly', async () => {
    const started = Date.now();
    expect((await probe(47_999)).kind).toBe('none');
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it('sees a non-Overlook program as "other"', async () => {
    const srv = createServer((_q, s) => s.end('hello'));
    await new Promise<void>((r) => srv.listen(47_998, '127.0.0.1', () => r()));
    try {
      expect((await probe(47_998)).kind).toBe('other');
    } finally {
      srv.close();
    }
  });

  it('does not start a server when OVERLOOK_NO_SERVE=1', async () => {
    const r = await ensureServer();
    expect(r.running).toBe(false);
    expect(r.note).toMatch(/OVERLOOK_NO_SERVE/);
    expect(existsSync(join(f.home, 'serve.lock'))).toBe(false);
  });
});
