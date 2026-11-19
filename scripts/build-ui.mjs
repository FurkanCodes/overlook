// Bundle the dashboard page into dist/ui. Everything is served locally:
// the CSP allows no CDN, so the Inter font ships with the package.
import { build } from 'esbuild';
import { copyFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'dist', 'ui');
const require = createRequire(import.meta.url);
mkdirSync(out, { recursive: true });

const app = await build({
  entryPoints: [join(root, 'ui', 'main.ts')],
  outfile: join(out, 'app.js'),
  bundle: true,
  format: 'iife',
  target: ['es2022'],
  minify: true,
  sourcemap: false,
  legalComments: 'eof',
  logLevel: 'warning',
  metafile: true,
});

// The full license text of every package bundled into app.js, taken from the
// bundle itself so the list can never drift from what actually ships.
const bundled = new Map();
for (const input of Object.keys(app.metafile.inputs)) {
  const m = /node_modules[\\/]((?:@[^\\/]+[\\/])?[^\\/]+)/.exec(input);
  if (m) bundled.set(m[1].replaceAll('\\', '/'), true);
}
const sections = [];
for (const name of [...bundled.keys()].sort()) {
  const dir = join(root, 'node_modules', name);
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  const file = readdirSync(dir).find((f) => /^licen[cs]e/i.test(f));
  if (!file) throw new Error(`no license file in bundled package ${name}`);
  sections.push(`${name} ${pkg.version} (${pkg.license})\n${'-'.repeat(60)}\n${readFileSync(join(dir, file), 'utf8').trim()}\n`);
}
writeFileSync(join(out, 'licenses.txt'), `Third-party code bundled into app.js\n\n${sections.join('\n')}`);
await build({
  entryPoints: [join(root, 'ui', 'styles.css')],
  outfile: join(out, 'app.css'),
  bundle: true,
  minify: true,
  external: ['/assets/*'],
  logLevel: 'warning',
});
copyFileSync(join(root, 'ui', 'favicon.svg'), join(out, 'favicon.svg'));
// Inter (SIL Open Font License 1.1), Latin subset, variable weight.
const interDir = dirname(require.resolve('@fontsource-variable/inter/package.json'));
copyFileSync(join(interDir, 'files', 'inter-latin-wght-normal.woff2'), join(out, 'inter.woff2'));
copyFileSync(join(interDir, 'LICENSE'), join(out, 'inter-LICENSE.txt'));
console.log('built dist/ui');
