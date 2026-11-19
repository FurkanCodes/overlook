// Time Overlook against the performance targets in the design doc:
//   MCP initialize < 1 s, a grouped query < 2 s, an 8-panel check < 4 s,
// on a generated 1M-row, 12-column CSV. Run after `npm run build`:
//   node scripts/bench.mjs
import { spawn } from 'node:child_process';
import { createWriteStream, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const home = mkdtempSync(join(tmpdir(), 'overlook-bench-'));
process.env.OVERLOOK_HOME = home;
process.env.OVERLOOK_NO_SERVE = '1';
const csv = join(home, 'big.csv').replaceAll('\\', '/');

// 1. Data: 1M rows x 12 columns.
await new Promise((resolve, reject) => {
  const out = createWriteStream(csv);
  out.on('error', reject);
  out.write('id,day,region,channel,product,category,qty,price,amount,cost,refunded,score\n');
  const regions = ['NA', 'EU', 'APAC', 'LATAM'];
  const channels = ['web', 'sales', 'partner'];
  let i = 0;
  const write = () => {
    let ok = true;
    while (i < 1_000_000 && ok) {
      const d = new Date(Date.UTC(2024, 0, 1) + (i % 730) * 86_400_000).toISOString().slice(0, 10);
      const qty = (i % 9) + 1;
      const price = ((i * 7919) % 50000) / 100;
      ok = out.write(`${i},${d},${regions[i % 4]},${channels[i % 3]},p${i % 40},c${i % 6},${qty},${price},${(qty * price).toFixed(2)},${(price * 0.6).toFixed(2)},${i % 29 === 0},${(i % 1000) / 10}\n`);
      i++;
    }
    if (i < 1_000_000) out.once('drain', write);
    else out.end(resolve);
  };
  write();
});

const { saveConfig, loadConfig } = await import('../dist/src/config.js');
const { Engine } = await import('../dist/src/engine/engine.js');
const { checkDashboard } = await import('../dist/src/check.js');
saveConfig({ version: 1, sources: { big: { type: 'file', path: csv } } });

const results = [];
const record = (name, ms, target) => results.push({ name, ms: Math.round(ms), target, ok: ms < target });

// 2. MCP initialize, Node start-up included.
{
  const t = performance.now();
  const child = spawn(process.execPath, [join(root, 'dist', 'src', 'cli.js'), 'mcp'], { env: process.env });
  await new Promise((resolve) => {
    child.stdout.once('data', resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'bench', version: '0' } } }) + '\n');
  });
  record('MCP initialize', performance.now() - t, 1000);
  child.kill();
}

const engine = await Engine.open(loadConfig());

// 3. One grouped query.
{
  const t = performance.now();
  await engine.run('SELECT region, date_trunc(\'month\', day) AS m, sum(amount) AS revenue FROM big GROUP BY ALL ORDER BY 1, 2');
  record('grouped query (1M rows)', performance.now() - t, 2000);
}

// 4. An 8-panel dashboard check (what a save does).
{
  const q = (sql) => ({ source: 'big', sql });
  const spec = {
    version: 1,
    title: 'Bench',
    panels: [
      { id: 'k1', type: 'kpi', ...q('SELECT sum(amount) AS v FROM big'), value: 'v' },
      { id: 'k2', type: 'kpi', ...q('SELECT count(*) AS v FROM big WHERE refunded'), value: 'v' },
      { id: 'k3', type: 'kpi', ...q('SELECT avg(score) AS v FROM big'), value: 'v' },
      { id: 'l1', type: 'line', ...q("SELECT date_trunc('month', day) AS m, sum(amount) AS v FROM big GROUP BY 1 ORDER BY 1"), x: 'm', y: 'v' },
      { id: 'b1', type: 'bar', ...q('SELECT region, sum(amount) AS v FROM big GROUP BY 1'), x: 'region', y: 'v' },
      { id: 'b2', type: 'bar', ...q('SELECT channel, region, count(*) AS v FROM big GROUP BY ALL'), x: 'channel', y: 'v', series: 'region' },
      { id: 'a1', type: 'area', ...q("SELECT date_trunc('month', day) AS m, category, sum(qty) AS v FROM big GROUP BY ALL ORDER BY 1"), x: 'm', y: 'v', series: 'category' },
      { id: 't1', type: 'table', ...q('SELECT product, sum(amount) AS revenue, sum(cost) AS cost FROM big GROUP BY 1 ORDER BY 2 DESC LIMIT 20') },
    ],
  };
  const t = performance.now();
  const r = await checkDashboard(spec, engine);
  if (!r.ok) console.error(r.errors);
  record('8-panel dashboard check', performance.now() - t, 4000);
}

engine.close();
rmSync(home, { recursive: true, force: true });
console.table(results);
process.exitCode = results.every((r) => r.ok) ? 0 : 1;
