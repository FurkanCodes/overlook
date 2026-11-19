import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { autoDashboard } from '../src/auto.js';
import { Engine } from '../src/engine/engine.js';
import { entryFor, mergeJson, mergeToml } from '../src/setup.js';
import { fixture, type Fixture } from './helpers.js';

let f: Fixture;
const NO_DATE = ['name,team,score,user_id', 'a,red,10,1', 'b,blue,20,2', 'c,red,30,3', 'd,green,5,4'].join('\n') + '\n';
const IDS_ONLY = ['id,email', '1,a@x.io', '2,b@x.io'].join('\n') + '\n';

beforeAll(async () => {
  f = await fixture({ 'players.csv': NO_DATE, 'ids.csv': IDS_ONLY });
});
afterAll(() => f.cleanup());

describe('auto_dashboard', () => {
  it('builds a checked dashboard with trends, breakdowns and a filter from a dated table', async () => {
    const r = await autoDashboard(f.engine, { source: 'sales' });
    expect(r.ok).toBe(true);
    const spec = r.spec!;
    expect(spec.title).toBe('Sales overview');
    const types = spec.panels.map((p) => p.type);
    expect(types.filter((t) => t === 'kpi').length).toBe(3);
    expect(types).toContain('table');
    expect(spec.panels.some((p) => p.type === 'area' || p.type === 'line')).toBe(true);
    expect(spec.panels.some((p) => p.type === 'bar')).toBe(true);
    // amount is money; the KPIs carry a trend (x).
    const amount = spec.panels.find((p) => p.id === 'kpi_amount');
    expect(amount).toMatchObject({ type: 'kpi', format: 'currency', x: 'period' });
    expect(spec.filters?.map((x) => x.type)).toEqual(['select', 'date']);
    // Every panel ran in the check.
    expect(r.check?.panels.every((p) => p.ok)).toBe(true);
  });

  it('leads with money and breaks down by a few-valued text column, not a yes/no one', async () => {
    const csv = ['day,refunded,channel,quantity,unit_price,amount'];
    const chans = ['Web', 'Partner', 'Sales'];
    for (let i = 0; i < 60; i++) csv.push(`2026-0${1 + (i % 3)}-${String(1 + (i % 28)).padStart(2, '0')},${i % 5 === 0},${chans[i % 3]},${1 + (i % 4)},${10 + (i % 7)},${(1 + (i % 4)) * (10 + (i % 7))}`);
    const g = await fixture({ 'shop.csv': csv.join('\n') + '\n' });
    try {
      const r = await autoDashboard(g.engine, { source: 'shop' });
      expect(r.ok).toBe(true);
      const panels = r.spec!.panels;
      expect(panels[0]).toMatchObject({ id: 'kpi_amount', format: 'currency' });
      expect(panels.find((p) => p.id === 'trend')).toMatchObject({ series: 'channel', y: 'amount' });
      expect(r.spec!.filters?.[0]?.id).toBe('channel');
    } finally {
      g.cleanup();
    }
  });

  it('works without a date column, leaving out the trend and skipping id columns as measures', async () => {
    const r = await autoDashboard(f.engine, { source: 'players' });
    expect(r.ok).toBe(true);
    const ids = r.spec!.panels.map((p) => p.id);
    expect(ids).not.toContain('trend');
    expect(ids).not.toContain('kpi_user_id');
    expect(ids).toContain('kpi_score');
    expect(r.notes.join(' ')).toMatch(/no date column/);
  });

  it('still makes a useful page from a table with nothing to chart', async () => {
    const r = await autoDashboard(f.engine, { source: 'ids' });
    expect(r.ok).toBe(true);
    expect(r.spec!.panels.map((p) => p.type)).toEqual(['kpi', 'table']);
  });

  it('reports a source that is not there', async () => {
    const e = await Engine.open({ version: 1, sources: {} });
    try {
      const r = await autoDashboard(e, { source: 'nope' });
      expect(r.ok).toBe(false);
    } finally {
      e.close();
    }
  });
});

describe('overlook setup', () => {
  const l = { command: 'node', args: ['/x/cli.js', 'mcp'] };
  it('adds the entry and keeps everything else', () => {
    const out = mergeJson(JSON.stringify({ theme: 'dark', mcpServers: { other: { command: 'x' } } }), 'mcpServers', l);
    expect(JSON.parse(out as string)).toEqual({ theme: 'dark', mcpServers: { other: { command: 'x' }, overlook: { command: 'node', args: ['/x/cli.js', 'mcp'] } } });
  });
  it('writes each harness shape', () => {
    expect(JSON.parse(mergeJson(null, 'vscode', l) as string)).toEqual({ servers: { overlook: { type: 'stdio', command: 'node', args: ['/x/cli.js', 'mcp'] } } });
    expect(entryFor('opencode', l)).toEqual({ type: 'local', command: ['node', '/x/cli.js', 'mcp'], enabled: true });
  });
  it('leaves an existing entry and unparseable files alone', () => {
    expect(mergeJson(JSON.stringify({ mcpServers: { overlook: {} } }), 'mcpServers', l)).toBe('exists');
    expect(mergeJson('{ // comment\n}', 'mcpServers', l)).toBe('unparseable');
    expect(mergeJson(JSON.stringify({ mcpServers: { overlook: {} } }), 'mcpServers', l, true)).not.toBe('exists');
  });
  it('appends a Codex TOML block, with Windows paths as literal strings', () => {
    const t = mergeToml('model = "x"\n', { command: 'C:\\Program Files\\nodejs\\node.exe', args: ['C:\\o\\cli.js', 'mcp'] }) as string;
    expect(t).toContain("[mcp_servers.overlook]\ncommand = 'C:\\Program Files\\nodejs\\node.exe'");
    expect(t.startsWith('model = "x"\n\n[mcp_servers.overlook]')).toBe(true);
    expect(mergeToml(t, l)).toBe('exists');
    const replaced = mergeToml(t + '[other]\na = 1\n', l, true) as string;
    expect(replaced).toContain("command = 'node'");
    expect(replaced).toContain('[other]\na = 1');
    expect(replaced.match(/\[mcp_servers\.overlook\]/g)?.length).toBe(1);
  });
});
