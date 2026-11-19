// Generate the deterministic example datasets in examples/data.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'examples', 'data');
mkdirSync(out, { recursive: true });

// Small seeded PRNG (mulberry32) so the data never changes between runs.
let seed = 20261119;
const rand = () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const pick = (arr, weights) => {
  const total = weights.reduce((a, b) => a + b, 0);
  let r = rand() * total;
  for (let i = 0; i < arr.length; i++) {
    r -= weights[i];
    if (r <= 0) return arr[i];
  }
  return arr[arr.length - 1];
};
const pad = (n) => String(n).padStart(2, '0');

const regions = ['North America', 'Europe', 'Asia Pacific', 'Latin America'];
const regionW = [42, 31, 19, 8];
const products = [
  ['Starter plan', 'Subscription', 29],
  ['Team plan', 'Subscription', 99],
  ['Enterprise plan', 'Subscription', 499],
  ['Onboarding', 'Services', 1200],
  ['Training day', 'Services', 1800],
  ['API credits', 'Usage', 45],
  ['Storage add-on', 'Usage', 19],
];
const productW = [30, 22, 6, 4, 3, 25, 10];
const channels = ['Self-serve', 'Sales', 'Partner'];
const channelW = [58, 30, 12];

const rows = ['order_id,order_date,region,channel,product,category,quantity,unit_price,amount,refunded'];
let id = 100000;
const start = new Date(2025, 0, 1);
for (let day = 0; day < 669; day++) {
  const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + day);
  const growth = 1 + day / 520;
  const weekday = d.getDay() === 0 || d.getDay() === 6 ? 0.55 : 1;
  const season = 1 + 0.18 * Math.sin(((d.getMonth() + 1) / 12) * Math.PI * 2);
  const n = Math.round(9 * growth * weekday * season + rand() * 6);
  for (let i = 0; i < n; i++) {
    const p = pick(products, productW);
    const qty = p[1] === 'Usage' ? 1 + Math.floor(rand() * 20) : p[1] === 'Services' ? 1 : 1 + Math.floor(rand() * 4);
    const price = +(p[2] * (0.92 + rand() * 0.16)).toFixed(2);
    const amount = +(qty * price).toFixed(2);
    const refunded = rand() < 0.035 ? 'true' : 'false';
    rows.push([id++, `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`, pick(regions, regionW), pick(channels, channelW), p[0], p[1], qty, price, amount, refunded].join(','));
  }
}
writeFileSync(join(out, 'orders.csv'), rows.join('\n') + '\n');

// Web traffic: one row per day and source.
const traffic = ['date,source,sessions,signups'];
const sources = [['Organic search', 1600], ['Direct', 900], ['Paid search', 650], ['Social', 420], ['Referral', 260]];
for (let day = 0; day < 669; day++) {
  const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + day);
  const weekday = d.getDay() === 0 || d.getDay() === 6 ? 0.7 : 1;
  for (const [src, base] of sources) {
    const sessions = Math.round(base * (1 + day / 700) * weekday * (0.85 + rand() * 0.3));
    const rate = src === 'Paid search' ? 0.031 : src === 'Referral' ? 0.044 : 0.022;
    const signups = Math.round(sessions * rate * (0.8 + rand() * 0.4));
    traffic.push(`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())},${src},${sessions},${signups}`);
  }
}
writeFileSync(join(out, 'traffic.csv'), traffic.join('\n') + '\n');
console.log(`wrote ${rows.length - 1} orders and ${traffic.length - 1} traffic rows to examples/data`);
