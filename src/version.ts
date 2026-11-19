import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The package root: the nearest folder above this file with our package.json. */
export const PACKAGE_ROOT: string = (() => {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    const p = join(dir, 'package.json');
    if (existsSync(p)) {
      try {
        if ((JSON.parse(readFileSync(p, 'utf8')) as { name?: string }).name === 'overlook-dash') return dir;
      } catch {
        /* keep looking */
      }
    }
    dir = dirname(dir);
  }
  return dirname(fileURLToPath(import.meta.url));
})();

export const VERSION: string = (() => {
  try {
    return (JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8')) as { version: string }).version;
  } catch {
    return '0.0.0';
  }
})();

/** -1 if a < b, 0 if equal, 1 if a > b. Pre-release tags are ignored. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('-')[0]!.split('.').map((n) => Number(n) || 0);
  const pb = b.split('-')[0]!.split('.').map((n) => Number(n) || 0);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}
