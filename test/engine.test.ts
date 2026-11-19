import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixture, type Fixture } from './helpers.js';

let f: Fixture;
beforeAll(async () => {
  f = await fixture();
});
afterAll(() => f.cleanup());

describe('engine queries', () => {
  it('reads a CSV source as a table named after it', async () => {
    const r = await f.engine.run('SELECT region, sum(amount) AS revenue FROM sales GROUP BY 1 ORDER BY 1');
    expect(r.columns.map((c) => c.name)).toEqual(['region', 'revenue']);
    expect(r.columns[1]!.kind).toBe('number');
    expect(r.rows).toHaveLength(3);
    expect(typeof r.rows[0]!.revenue).toBe('number');
  });

  it('returns numbers for BIGINT and ISO strings for dates', async () => {
    const r = await f.engine.run("SELECT count(*) AS n, min(order_date) AS first, TIMESTAMP '2026-01-01 10:30:00' AS ts FROM sales");
    expect(r.rows[0]).toEqual({ n: 6, first: '2026-01-05', ts: '2026-01-01T10:30:00' });
    expect(r.columns.map((c) => c.kind)).toEqual(['number', 'date', 'date']);
  });

  it('caps rows and reports truncation', async () => {
    const r = await f.engine.run('SELECT * FROM range(100) t(i)', {}, { limit: 10 });
    expect(r.rows).toHaveLength(10);
    expect(r.truncated).toBe(true);
  });

  it('binds named parameters, with unset ones as NULL', async () => {
    const sql = 'SELECT count(*) AS n FROM sales WHERE ($region IS NULL OR region = $region)';
    expect((await f.engine.run(sql, { region: 'EMEA' })).rows[0]!.n).toBe(2);
    expect((await f.engine.run(sql, {})).rows[0]!.n).toBe(6);
  });

  it('binds a date filter given as a string', async () => {
    const cast = await f.engine.run('SELECT count(*) AS n FROM sales WHERE ($since IS NULL OR order_date >= CAST($since AS DATE))', { since: '2026-02-01' });
    expect(cast.rows[0]!.n).toBe(4);
    const plain = await f.engine.run('SELECT count(*) AS n FROM sales WHERE order_date >= $since', { since: '2026-02-01' });
    expect(plain.rows[0]!.n).toBe(4);
  });

  it('lists the parameters a query uses', async () => {
    expect(await f.engine.parameters('SELECT * FROM sales WHERE region = $region AND amount > $min')).toEqual(['region', 'min']);
  });

  it('passes through DuckDB binder errors that name candidate columns', async () => {
    await expect(f.engine.run('SELECT revenu FROM sales')).rejects.toThrow(/revenu/);
  });

  it('describes sources with columns, row counts and samples', async () => {
    const [d] = await f.engine.describe('sales', { samples: true });
    expect(d!.ok).toBe(true);
    expect(d!.tables[0]!.ref).toBe('"sales"');
    expect(d!.tables[0]!.rowCount).toBe(6);
    expect(d!.tables[0]!.columns.map((c) => c.name)).toEqual(['order_date', 'region', 'product', 'amount', 'qty']);
    expect(d!.tables[0]!.sample).toHaveLength(3);
  });
});

describe('engine lockdown', () => {
  const blocked: [string, string][] = [
    ['read another file', "SELECT * FROM read_csv('C:/Windows/win.ini')"],
    ['read /etc/passwd', "SELECT * FROM read_csv('/etc/passwd')"],
    ['glob the disk', "SELECT * FROM glob('/*')"],
    ['COPY out', "COPY (SELECT 1) TO 'out.csv'"],
    ['ATTACH', "ATTACH 'x.db' AS x"],
    ['INSTALL', 'INSTALL httpfs'],
    ['LOAD', 'LOAD httpfs'],
    ['SET', 'SET enable_external_access = true'],
    ['PRAGMA', 'PRAGMA version'],
    ['CREATE', 'CREATE TABLE t AS SELECT 1'],
    ['two statements', 'SELECT 1; SELECT 2'],
    ['DELETE', 'DELETE FROM sales'],
    ['comment then COPY', "-- hi\nCOPY (SELECT 1) TO 'x.csv'"],
    ['http read', "SELECT * FROM read_csv('https://example.com/x.csv')"],
  ];
  for (const [label, sql] of blocked) {
    it(`blocks: ${label}`, async () => {
      await expect(f.engine.run(sql)).rejects.toThrow();
    });
  }

  it('cannot unlock the configuration even inside a CTE-looking query', async () => {
    await expect(f.engine.run("SELECT current_setting('enable_external_access') AS v")).resolves.toMatchObject({ rows: [{ v: false }] });
  });

  it('rejects positional parameters', async () => {
    await expect(f.engine.run('SELECT * FROM sales WHERE region = ?')).rejects.toThrow(/named parameters/);
  });

  it('stops a query that runs too long', async () => {
    await expect(
      f.engine.run('SELECT count(*) FROM range(100000000000) a', {}, { timeoutMs: 300 }),
    ).rejects.toThrow(/longer than|interrupt/i);
  }, 20_000);
});
