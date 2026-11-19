// Set up a demo: register the example data in ./.demo and save the example
// dashboard through the same check the MCP tool uses. Run after `npm run build`.
//   node scripts/demo.mjs            then   OVERLOOK_HOME=.demo node dist/src/cli.js serve
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
process.env.OVERLOOK_HOME ??= join(root, '.demo');

const { addSource, loadConfig } = await import('../dist/src/config.js');
const { Engine } = await import('../dist/src/engine/engine.js');
const { checkDashboard, summarizeCheck } = await import('../dist/src/check.js');
const { saveDashboard } = await import('../dist/src/store.js');

addSource('orders', { type: 'file', path: join(root, 'examples', 'data', 'orders.csv').replaceAll('\\', '/') });
addSource('traffic', { type: 'file', path: join(root, 'examples', 'data', 'traffic.csv').replaceAll('\\', '/') });

const engine = await Engine.open(loadConfig());
const spec = JSON.parse(readFileSync(join(root, 'examples', 'revenue-overview.json'), 'utf8'));
const r = await checkDashboard(spec, engine);
engine.close();
console.log(summarizeCheck(r) || 'check passed');
if (!r.ok) process.exit(1);
saveDashboard('revenue-overview', r.spec);
console.log(`saved revenue-overview in ${process.env.OVERLOOK_HOME}`);
