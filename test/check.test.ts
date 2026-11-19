import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkDashboard, mergeErrors } from '../src/check.js';
import { caseOnlyMatch } from '../src/spec/errors.js';
import { repairInput } from '../src/spec/repair.js';
import { fixture, type Fixture } from './helpers.js';

let f: Fixture;
beforeAll(async () => {
  f = await fixture();
});
afterAll(() => f.cleanup());

const good = () => ({
  version: 1,
  title: 'Sales',
  filters: [{ id: 'region', label: 'Region', type: 'select', source: 'sales', options_sql: 'SELECT DISTINCT region FROM sales ORDER BY 1' }],
  panels: [
    { id: 'total', type: 'kpi', source: 'sales', sql: 'SELECT sum(amount) AS revenue FROM sales WHERE ($region IS NULL OR region = $region)', value: 'revenue', format: 'currency' },
    {
      id: 'by_month',
      type: 'line',
      source: 'sales',
      sql: "SELECT date_trunc('month', order_date) AS month, sum(amount) AS revenue FROM sales WHERE ($region IS NULL OR region = $region) GROUP BY 1 ORDER BY 1",
      x: 'month',
      y: 'revenue',
    },
    { id: 'notes', type: 'text', markdown: '# Hello' },
  ],
});

describe('checkDashboard', () => {
  it('accepts a valid dashboard', async () => {
    const r = await checkDashboard(good(), f.engine);
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.spec?.panels).toHaveLength(3);
    expect(r.panels.map((p) => [p.id, p.ok])).toEqual([
      ['total', true],
      ['by_month', true],
      ['notes', true],
    ]);
  });

  it('accepts a spec sent as a JSON string and reports the repair', async () => {
    const r = await checkDashboard(JSON.stringify(good()), f.engine);
    expect(r.ok).toBe(true);
    expect(r.repairs.some((x) => x.reason.includes('JSON string'))).toBe(true);
  });

  it('repairs a case-only column difference and reports it', async () => {
    const s = good();
    (s.panels[1] as { y: string }).y = 'Revenue';
    const r = await checkDashboard(s, f.engine);
    expect(r.ok).toBe(true);
    expect(r.repairs).toContainEqual(expect.objectContaining({ path: 'panels[1].y', from: 'Revenue', to: 'revenue' }));
    expect((r.spec!.panels[1] as { y: string }).y).toBe('revenue');
  });

  it('does not guess a typo; it suggests the real column', async () => {
    const s = good();
    (s.panels[1] as { y: string }).y = 'revenu';
    const r = await checkDashboard(s, f.engine);
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toMatchObject({ path: 'panels[1].y' });
    expect(r.errors[0]!.fix).toMatch(/did you mean "revenue"/);
  });

  it('refuses to guess between two equally close columns', async () => {
    const s = good();
    s.panels[1] = {
      id: 'wide',
      type: 'bar',
      source: 'sales',
      sql: 'SELECT region, sum(amount) AS rev_2023, sum(qty) AS rev_2024 FROM sales GROUP BY 1',
      x: 'region',
      y: 'rev_202',
    } as never;
    const r = await checkDashboard(s, f.engine);
    expect(r.ok).toBe(false);
    expect(r.errors[0]!.path).toBe('panels[1].y');
    expect(r.errors[0]!.fix).toMatch(/rev_2023.*rev_2024|result columns/);
  });

  it('only matches case-only differences', () => {
    expect(caseOnlyMatch('cost', ['count', 'region'])).toBeUndefined();
    expect(caseOnlyMatch('Revenue', ['revenue'])).toBe('revenue');
    expect(caseOnlyMatch('a', ['A', 'a'.toUpperCase()])).toBeUndefined();
  });

  it('reports SQL errors on the panel path with DuckDB text', async () => {
    const s = good();
    (s.panels[0] as { sql: string }).sql = 'SELECT sum(amout) AS revenue FROM sales';
    const r = await checkDashboard(s, f.engine);
    expect(r.ok).toBe(false);
    expect(r.errors[0]!.path).toBe('panels[0].sql');
    expect(r.errors[0]!.message).toMatch(/amout/);
  });

  it('reports every broken panel in one reply', async () => {
    const s = good();
    (s.panels[0] as { source: string }).source = 'sale';
    (s.panels[1] as { x: string }).x = 'nonexistent_column';
    const r = await checkDashboard(s, f.engine);
    expect(r.errors.map((e) => e.path)).toEqual(['panels[0].source', 'panels[1].x']);
    expect(r.errors[0]!.fix).toMatch(/did you mean "sales"/);
  });

  it('requires numeric y and value', async () => {
    const s = good();
    (s.panels[0] as { value: string; sql: string }).sql = 'SELECT any_value(region) AS revenue FROM sales';
    const r = await checkDashboard(s, f.engine);
    expect(r.errors[0]).toMatchObject({ path: 'panels[0].value' });
    expect(r.errors[0]!.message).toMatch(/must be a number/);
  });

  it('flags undeclared $parameters', async () => {
    const s = good();
    (s.panels[0] as { sql: string }).sql = 'SELECT sum(amount) AS revenue FROM sales WHERE region = $country';
    const r = await checkDashboard(s, f.engine);
    expect(r.errors[0]!.message).toMatch(/\$country/);
  });

  it('rejects unknown panel types with the allowed list, and pie with advice', async () => {
    const s = good();
    (s.panels[1] as { type: string }).type = 'pie';
    (s.panels[2] as { type: string }).type = 'sparkle';
    const r = await checkDashboard(s, f.engine);
    expect(r.errors.find((e) => e.path === 'panels[1].type')?.fix).toMatch(/bar/);
    expect(r.errors.find((e) => e.path === 'panels[2].type')?.fix).toMatch(/kpi, bar, line/);
  });

  it('maps type aliases and fills a missing version and ids', async () => {
    const s = good() as Record<string, unknown>;
    delete s.version;
    const panels = s.panels as Record<string, unknown>[];
    panels[1]!.type = 'Line Chart';
    delete panels[2]!.id;
    const r = await checkDashboard(s, f.engine);
    expect(r.ok).toBe(true);
    expect(r.repairs.map((x) => x.path)).toEqual(expect.arrayContaining(['version', 'panels[1].type', 'panels[2].id']));
  });

  it('warns on empty results, too many bars and multi-row KPIs', async () => {
    const s = good();
    s.panels.push({ id: 'empty', type: 'table', source: 'sales', sql: "SELECT * FROM sales WHERE region = 'NOPE'" } as never);
    s.panels.push({ id: 'many', type: 'bar', source: 'sales', sql: 'SELECT i::VARCHAR AS k, i AS v FROM range(80) t(i)', x: 'k', y: 'v' } as never);
    (s.panels[0] as { sql: string }).sql = 'SELECT amount AS revenue FROM sales';
    const r = await checkDashboard(s, f.engine);
    expect(r.ok).toBe(true);
    const msgs = r.warnings.map((w) => w.message).join('\n');
    expect(msgs).toMatch(/no rows/);
    expect(msgs).toMatch(/80 bars/);
    expect(msgs).toMatch(/first row/);
  });

  it('accepts a KPI trend with x and checks the x column', async () => {
    const s = good();
    s.panels[0] = { id: 'trend', type: 'kpi', source: 'sales', sql: "SELECT date_trunc('month', order_date) AS m, sum(amount) AS revenue FROM sales GROUP BY 1 ORDER BY 1", value: 'revenue', x: 'm' } as never;
    const r = await checkDashboard(s, f.engine);
    expect(r.ok).toBe(true);
    expect(r.warnings.some((w) => /first row/.test(w.message))).toBe(false);
    (s.panels[0] as { x: string }).x = 'month';
    const bad = await checkDashboard(s, f.engine);
    expect(bad.errors[0]).toMatchObject({ path: 'panels[0].x' });
  });

  it('rejects y arrays combined with series', async () => {
    const s = good();
    Object.assign(s.panels[1]!, { y: ['revenue'], series: 'month' });
    const r = await checkDashboard(s, f.engine);
    expect(r.errors.some((e) => e.path === 'panels[1].series')).toBe(true);
  });

  it('checks select filter options', async () => {
    const s = good();
    s.filters[0] = { id: 'region', label: 'Region', type: 'select' } as never;
    const r = await checkDashboard(s, f.engine);
    expect(r.errors[0]!.message).toMatch(/exactly one of "options" or "options_sql"/);
  });

  it('rejects write statements inside a panel', async () => {
    const s = good();
    (s.panels[0] as { sql: string }).sql = "COPY (SELECT 1) TO 'x.csv'";
    const r = await checkDashboard(s, f.engine);
    expect(r.errors[0]!.message).toMatch(/only read queries/);
  });

  it('keeps duplicate panel ids out', async () => {
    const s = good();
    (s.panels[1] as { id: string }).id = 'total';
    const r = await checkDashboard(s, f.engine);
    expect(r.errors.some((e) => /duplicate panel id/.test(e.message))).toBe(true);
  });

  it('enforces the total time budget', async () => {
    const s = good();
    const r = await checkDashboard(s, f.engine, { budgetMs: 0 });
    expect(r.errors.some((e) => /not checked in time/.test(e.message))).toBe(true);
  });
});

describe('repair and merge helpers', () => {
  it('unwraps {dashboard: ...} and bare panel arrays', () => {
    expect((repairInput({ dashboard: { title: 'x', panels: [] } }).value as { title: string }).title).toBe('x');
    expect(Array.isArray((repairInput([{ type: 'text', markdown: 'a' }]).value as { panels: unknown[] }).panels)).toBe(true);
  });

  it('reports invalid JSON strings', () => {
    expect(repairInput('{nope').errors[0]!.message).toMatch(/not valid JSON/);
  });

  it('merges identical errors', () => {
    const m = mergeErrors([
      { path: 'panels[0].source', message: 'x' },
      { path: 'panels[2].source', message: 'x' },
      { path: 'panels[1].y', message: 'y' },
    ]);
    expect(m).toEqual([
      { path: 'panels[0].source, panels[2].source', message: 'x' },
      { path: 'panels[1].y', message: 'y' },
    ]);
  });
});
