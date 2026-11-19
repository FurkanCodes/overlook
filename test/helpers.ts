import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { saveConfig, type Config } from '../src/config.js';
import { Engine } from '../src/engine/engine.js';

export interface Fixture {
  home: string;
  dir: string;
  config: Config;
  engine: Engine;
  cleanup(): void;
}

export const SALES_CSV = [
  'order_date,region,product,amount,qty',
  '2026-01-05,EMEA,Widget,120.50,3',
  '2026-01-17,APAC,Gadget,80.00,1',
  '2026-02-02,EMEA,Gadget,200.00,4',
  '2026-02-11,AMER,Widget,95.25,2',
  '2026-03-03,AMER,Gizmo,310.00,5',
  '2026-03-21,APAC,Widget,55.75,1',
].join('\n');

/** A temporary OVERLOOK_HOME with a `sales` CSV source and an open engine. */
export async function fixture(extra: Record<string, string> = {}): Promise<Fixture> {
  const home = mkdtempSync(join(tmpdir(), 'overlook-test-'));
  const dir = join(home, 'data');
  process.env.OVERLOOK_HOME = home;
  process.env.OVERLOOK_NO_SERVE = '1';
  const { mkdirSync } = await import('node:fs');
  mkdirSync(dir, { recursive: true });
  const sales = join(dir, 'sales.csv').replaceAll('\\', '/');
  writeFileSync(sales, SALES_CSV + '\n');
  const sources: Config['sources'] = { sales: { type: 'file', path: sales } };
  for (const [name, content] of Object.entries(extra)) {
    const p = join(dir, name).replaceAll('\\', '/');
    writeFileSync(p, content);
    sources[name.replace(/\W.*$/, '')] = { type: 'file', path: p };
  }
  const config: Config = { version: 1, sources };
  saveConfig(config);
  const engine = await Engine.open(config);
  return {
    home,
    dir,
    config,
    engine,
    cleanup() {
      engine.close();
      try {
        rmSync(home, { recursive: true, force: true });
      } catch {
        /* Windows may hold files briefly */
      }
    },
  };
}
