/**
 * End to end: start the built `overlook mcp` over stdio with the official MCP
 * client, and drive the real tools. Requires `npm run build` (npm test runs it).
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SALES_CSV } from './helpers.js';

const CLI = join(import.meta.dirname, '..', 'dist', 'src', 'cli.js');
let home: string;
let client: Client;

type TextResult = { content: { type: string; text: string }[]; isError?: boolean };
const text = (r: unknown) => (r as TextResult).content.map((c) => c.text).join('\n');

beforeAll(async () => {
  if (!existsSync(CLI)) throw new Error('run "npm run build" first');
  home = mkdtempSync(join(tmpdir(), 'overlook-e2e-'));
  const data = join(home, 'data');
  mkdirSync(data);
  writeFileSync(join(data, 'sales.csv'), SALES_CSV + '\n');
  writeFileSync(join(home, 'config.json'), JSON.stringify({ version: 1, sources: { sales: { type: 'file', path: join(data, 'sales.csv').replaceAll('\\', '/') } } }));
  // The agent's project: one unregistered data file.
  const project = join(home, 'project');
  mkdirSync(join(project, 'exports'), { recursive: true });
  writeFileSync(join(project, 'exports', 'Signups.csv'), 'day,n\n2026-01-01,3\n2026-01-02,5\n');
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [CLI, 'mcp'],
    cwd: project,
    env: { ...process.env, OVERLOOK_HOME: home, OVERLOOK_NO_SERVE: '1' } as Record<string, string>,
    stderr: 'pipe',
  });
  client = new Client({ name: 'overlook-e2e', version: '0.0.0' });
  await client.connect(transport);
});

afterAll(async () => {
  await client?.close();
  rmSync(home, { recursive: true, force: true });
});

describe('overlook mcp over stdio', () => {
  it('lists the eight tools with flat input schemas, and the dashboard prompt', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['add_source', 'auto_dashboard', 'describe_data', 'get_dashboard', 'get_spec_reference', 'list_dashboards', 'preview_query', 'save_dashboard']);
    const totalDescription = tools.reduce((n, t) => n + (t.description?.length ?? 0), 0);
    expect(totalDescription).toBeLessThan(8800); // about 2,200 tokens
    expect(tools.find((t) => t.name === 'add_source')?.annotations?.readOnlyHint).toBe(false);
    const { prompts } = await client.listPrompts();
    expect(prompts.map((p) => p.name)).toEqual(['dashboard']);
    const p = await client.getPrompt({ name: 'dashboard', arguments: {} });
    expect(JSON.stringify(p.messages)).toMatch(/auto_dashboard/);
  });

  it('describes the data, and the project files not added yet', async () => {
    const r = await client.callTool({ name: 'describe_data', arguments: {} });
    expect(text(r)).toMatch(/## sales \(file\)/);
    expect(text(r)).toMatch(/amount DOUBLE/);
    expect(text(r)).toMatch(/exports\/Signups\.csv .*add_source \{"name": "signups", "path": "exports\/Signups\.csv"\}/);
  });

  it('adds a project file as a source, and refuses one outside the project', async () => {
    const r = await client.callTool({ name: 'add_source', arguments: { name: 'signups', path: 'exports/Signups.csv' } });
    expect((r as TextResult).isError).toBeFalsy();
    expect(text(r)).toMatch(/Added source "signups"/);
    expect(text(r)).toMatch(/day DATE/);
    const q = await client.callTool({ name: 'preview_query', arguments: { sql: 'SELECT sum(n) AS total FROM signups' } });
    expect(text(q)).toMatch(/\n8$/);
    const out = await client.callTool({ name: 'add_source', arguments: { name: 'evil', path: '../config.json' } });
    expect((out as TextResult).isError).toBe(true);
    expect(text(out)).toMatch(/outside this project|cannot tell/);
    const d = await client.callTool({ name: 'describe_data', arguments: {} });
    expect(text(d)).not.toMatch(/Not added yet/);
  });

  it('previews a query', async () => {
    const r = await client.callTool({ name: 'preview_query', arguments: { sql: 'SELECT region, sum(amount) AS revenue FROM sales GROUP BY 1 ORDER BY 2 DESC' } });
    expect(text(r)).toMatch(/3 rows/);
    expect(text(r)).toMatch(/region \| revenue/);
  });

  it('refuses a broken spec with numbered fixes, then saves the fixed one', async () => {
    const bad = {
      version: 1,
      title: 'Sales',
      panels: [{ id: 'r', type: 'bar', source: 'sales', sql: 'SELECT region, sum(amount) AS revenue FROM sales GROUP BY 1', x: 'region', y: 'revenu' }],
    };
    const r1 = await client.callTool({ name: 'save_dashboard', arguments: { name: 'Sales', spec: bad } });
    expect((r1 as TextResult).isError).toBe(true);
    expect(text(r1)).toMatch(/NOT saved/);
    expect(text(r1)).toMatch(/1\. panels\[0\]\.y: column "revenu" is not in the query result/);

    const good = { ...bad, panels: [{ ...bad.panels[0], y: 'revenue' }] };
    const r2 = await client.callTool({ name: 'save_dashboard', arguments: { name: 'Sales', spec: JSON.stringify(good) } });
    expect((r2 as TextResult).isError).toBeFalsy();
    expect(text(r2)).toMatch(/Created dashboard "Sales"/);
    expect(text(r2)).toMatch(/\/d\/sales/);
    const saved = JSON.parse(readFileSync(join(home, 'dashboards', 'sales.json'), 'utf8'));
    expect(saved.panels[0].y).toBe('revenue');
  });

  it('reports current status and warns about removed panels on replace', async () => {
    const g = await client.callTool({ name: 'get_dashboard', arguments: { name: 'sales' } });
    expect(text(g)).toMatch(/r \(bar\): ok, 3 rows/);
    const next = { version: 1, title: 'Sales', panels: [{ id: 'notes', type: 'text', markdown: 'hi' }] };
    const r = await client.callTool({ name: 'save_dashboard', arguments: { name: 'sales', spec: next } });
    expect(text(r)).toMatch(/Replaced dashboard/);
    expect(text(r)).toMatch(/panels removed compared with the previous version: r/);
    const l = await client.callTool({ name: 'list_dashboards', arguments: {} });
    expect(text(l)).toMatch(/sales: "Sales"/);
  });

  it('builds a whole dashboard in one call', async () => {
    const r = await client.callTool({ name: 'auto_dashboard', arguments: { source: 'signups' } });
    expect((r as TextResult).isError).toBeFalsy();
    expect(text(r)).toMatch(/Created dashboard "Signups overview" from signups/);
    expect(text(r)).toMatch(/\/d\/signups-overview/);
    expect(text(r)).toMatch(/Give the user the link/);
    const saved = JSON.parse(readFileSync(join(home, 'dashboards', 'signups-overview.json'), 'utf8'));
    expect(saved.panels.length).toBeGreaterThan(1);
  });

  it('writes nothing to stdout but protocol messages', async () => {
    const child = spawn(process.execPath, [CLI, 'mcp'], { env: { ...process.env, OVERLOOK_HOME: home, OVERLOOK_NO_SERVE: '1' } });
    let out = '';
    child.stdout.on('data', (d) => (out += String(d)));
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } }) + '\n');
    const started = Date.now();
    while (!out.includes('\n') && Date.now() - started < 5000) await new Promise((r) => setTimeout(r, 25));
    const ms = Date.now() - started;
    child.kill();
    const lines = out.split('\n').filter(Boolean);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(JSON.parse(line).jsonrpc).toBe('2.0');
    expect(ms).toBeLessThan(3000);
  });
});
