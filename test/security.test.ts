/**
 * Attack suite for the DuckDB lockdown and the repair rules. Every case here
 * must keep passing on each DuckDB upgrade.
 */
import { DuckDBInstance } from '@duckdb/node-api';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { saveConfig } from '../src/config.js';
import { Engine, EngineHolder } from '../src/engine/engine.js';
import { caseOnlyMatch } from '../src/spec/errors.js';
import { slugify } from '../src/store.js';
import { fixture, type Fixture } from './helpers.js';

let f: Fixture;
beforeAll(async () => {
  f = await fixture();
});
afterAll(() => f.cleanup());

describe('lockdown: every allowed leading keyword', () => {
  const attacks = [
    "SELECT * FROM query('COPY (SELECT 1) TO ''x.csv''')",
    "SELECT * FROM read_text('C:/Windows/win.ini')",
    "SELECT * FROM read_blob('/etc/hosts')",
    "WITH x AS (SELECT 1) SELECT * FROM read_parquet('/tmp/other.parquet')",
    "FROM read_json_auto('https://example.com/a.json')",
    "VALUES (1); SET enable_external_access = true",
    "(SELECT 1); INSTALL httpfs",
    "SELECT * FROM sniff_csv('C:/Windows/win.ini')",
    "SELECT * FROM duckdb_extensions() WHERE false; LOAD httpfs",
  ];
  for (const sql of attacks) {
    it(`blocks: ${sql.slice(0, 60)}`, async () => {
      await expect(f.engine.run(sql)).rejects.toThrow();
    });
  }

  it('writes spill files under OVERLOOK_HOME, not the working directory', async () => {
    const r = await f.engine.run("SELECT current_setting('temp_directory') AS t");
    expect(String(r.rows[0]!.t).replaceAll('\\', '/')).toContain(f.home.replaceAll('\\', '/'));
  });
});

describe("DuckDB's own lockdown, with Overlook's SQL checks bypassed", () => {
  // These run straight on a raw connection, so they prove the instance
  // settings hold even if a bug ever let a statement past checkSqlText or the
  // statement-type check. This is the part a DuckDB upgrade could change.
  const mustFail: [string, string][] = [
    ['read an unregistered file', "SELECT * FROM read_csv('C:/Windows/win.ini')"],
    ['read /etc/passwd', "SELECT * FROM read_text('/etc/passwd')"],
    ['glob the disk', "SELECT * FROM glob('/*')"],
    ['write next to a source', "COPY (SELECT 1) TO '__DIR__/written.csv'"],
    ['attach a database file', "ATTACH '__DIR__/other.duckdb' AS other"],
    ['install an extension', 'INSTALL httpfs'],
    ['load an extension', 'LOAD httpfs'],
    ['turn external access back on', 'SET enable_external_access = true'],
    ['unlock the configuration', 'SET lock_configuration = false'],
    ['allow more paths', "SET allowed_paths = ['/']"],
    ['allow unsigned extensions', 'SET allow_unsigned_extensions = true'],
    ['read over http', "SELECT * FROM read_csv('https://example.com/x.csv')"],
  ];
  for (const [label, sql] of mustFail) {
    it(`raw connection cannot ${label}`, async () => {
      const conn = await f.engine.rawConnectionForSecurityTests();
      try {
        await expect(conn.run(sql.replaceAll('__DIR__', f.dir.replaceAll('\\', '/')))).rejects.toThrow();
      } finally {
        conn.closeSync();
      }
    });
  }

  it('raw connection can still read the registered source', async () => {
    const conn = await f.engine.rawConnectionForSecurityTests();
    try {
      const r = await conn.runAndReadAll('SELECT count(*) AS n FROM sales');
      expect(Number(r.getRowsJson()[0]![0])).toBe(6);
    } finally {
      conn.closeSync();
    }
  });
});

describe('row cap keeps SQL as written', () => {
  it('accepts a trailing semicolon and a trailing line comment', async () => {
    await expect(f.engine.run('SELECT 1 AS a;')).resolves.toMatchObject({ rows: [{ a: 1 }] });
    await expect(f.engine.run('SELECT 1 AS a -- the end')).resolves.toMatchObject({ rows: [{ a: 1 }] });
  });

  it('keeps ORDER BY when the cap applies', async () => {
    const r = await f.engine.run('SELECT i FROM range(20000) t(i) ORDER BY i DESC', {}, { limit: 3 });
    expect(r.rows.map((x) => x.i)).toEqual([19999, 19998, 19997]);
    expect(r.truncated).toBe(true);
  });

  it('binds a string filter value to an integer comparison', async () => {
    const r = await f.engine.run('SELECT count(*) AS n FROM sales WHERE qty >= $min', { min: '3' });
    expect(r.rows[0]!.n).toBe(3);
  });
});

describe('typo repair never changes meaning', () => {
  it.each([
    ['max_temp', ['min_temp', 'region'], undefined],
    ['revenue_2024', ['revenue_2023'], undefined],
    ['cost', ['count'], undefined],
    ['revnue', ['revenue', 'region'], undefined],
    ['Revenue', ['revenue'], 'revenue'],
    ['regoin', ['region'], undefined],
  ])('%s with %j → %s', (name, cands, want) => {
    expect(caseOnlyMatch(name, cands)).toBe(want);
  });
});

describe('file locks are released when idle', () => {
  it('lets the user write to an attached .duckdb file after the idle timeout', async () => {
    const path = `${f.dir.replaceAll('\\', '/')}/shop.duckdb`;
    {
      const w = await DuckDBInstance.create(path);
      const c = await w.connect();
      await c.run('CREATE TABLE orders AS SELECT 1 AS id');
      c.closeSync();
      w.closeSync();
    }
    saveConfig({ ...f.config, sources: { ...f.config.sources, shop: { type: 'duckdb', path } } });
    const holder = new EngineHolder(150);
    const e = await holder.get();
    expect((await e.run('SELECT count(*) AS n FROM shop.orders')).rows[0]!.n).toBe(1);
    await new Promise((r) => setTimeout(r, 700));
    const w = await DuckDBInstance.create(path);
    const c = await w.connect();
    await c.run('INSERT INTO orders VALUES (2)');
    c.closeSync();
    w.closeSync();
    const again = await holder.get();
    expect((await again.run('SELECT count(*) AS n FROM shop.orders')).rows[0]!.n).toBe(2);
    holder.close();
  });

  it('a source that fails to open does not break the others', async () => {
    const e = await Engine.open({ version: 1, sources: { ...f.config.sources, gone: { type: 'file', path: `${f.dir}/missing.csv` } } });
    expect(e.sourceErrors.gone).toMatch(/not found/);
    await expect(e.run('SELECT count(*) AS n FROM sales')).resolves.toBeTruthy();
    e.close();
  });
});

describe('replaced source files', () => {
  it('re-detects columns when a file is replaced, failing only queries on a removed column', async () => {
    const { writeFileSync } = await import('node:fs');
    const p = `${f.dir.replaceAll('\\', '/')}/swap.csv`;
    writeFileSync(p, 'a,b\n1,2\n');
    const e = await Engine.open({ version: 1, sources: { swap: { type: 'file', path: p } } });
    expect((await e.run('SELECT b FROM swap')).rows).toEqual([{ b: 2 }]);
    writeFileSync(p, 'a,c\n5,x\n');
    expect((await e.run('SELECT a FROM swap')).rows).toEqual([{ a: 5 }]);
    await expect(e.run('SELECT b FROM swap')).rejects.toThrow(/b/);
    e.close();
  });
});

describe('hand-edited files', () => {
  it('reads dashboard files saved with a UTF-8 byte-order mark', async () => {
    const { writeFileSync } = await import('node:fs');
    const { dashboardPath, loadDashboard } = await import('../src/store.js');
    writeFileSync(dashboardPath('bom'), '﻿' + JSON.stringify({ version: 1, title: 'BOM', panels: [{ id: 't', type: 'text', markdown: 'x' }] }));
    expect(loadDashboard('bom')?.spec.title).toBe('BOM');
  });
});

describe('slugs', () => {
  it('avoids Windows reserved names and empty slugs', () => {
    expect(slugify('CON')).toBe('con-dashboard');
    expect(slugify('日本')).toBe('dashboard');
    expect(slugify('Sales: Q1 / Q2')).toBe('sales-q1-q2');
  });
});
