import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inferSource, redactUrl, resolveDbUrl, sourceLocation, toDuckDbUrl } from '../src/config.js';
import { dbKindOf, findDatabaseUrls, findDataFiles, nameFor, projectFileSource, sniffDatabase } from '../src/project.js';

let root: string;
let outside: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'overlook-project-'));
  outside = mkdtempSync(join(tmpdir(), 'overlook-outside-'));
  mkdirSync(join(root, 'data'));
  mkdirSync(join(root, 'node_modules', 'pkg'), { recursive: true });
  mkdirSync(join(root, '.git'));
  writeFileSync(join(root, 'data', 'Sales 2026.csv'), 'a,b\n1,2\n');
  writeFileSync(join(root, 'data', 'events.parquet'), 'PAR1');
  writeFileSync(join(root, 'node_modules', 'pkg', 'fixture.csv'), 'x\n1\n');
  writeFileSync(join(root, '.git', 'x.csv'), 'x\n1\n');
  writeFileSync(join(root, 'package.json'), '{}');
  writeFileSync(join(root, 'empty.csv'), '');
  writeFileSync(join(root, 'Thumbs.db'), 'not a database at all');
  writeFileSync(join(root, 'app.db'), Buffer.concat([Buffer.from('SQLite format 3\0', 'latin1'), Buffer.alloc(84)]));
  writeFileSync(
    join(root, '.env'),
    ['# comment', 'DATABASE_URL="postgresql://app:s3cret@localhost:5432/app?schema=public"', 'ANALYTICS_URL=mysql://ro:pw@db/analytics', 'API_KEY=abc'].join('\n'),
  );
  writeFileSync(join(outside, 'secret.csv'), 'k\n1\n');
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

describe('project discovery', () => {
  it('finds data files and skips dependency, hidden, empty and non-database files', () => {
    const found = findDataFiles(root);
    expect(found.map((f) => f.rel).sort()).toEqual(['app.db', 'data/Sales 2026.csv', 'data/events.parquet']);
    expect(found.find((f) => f.rel === 'app.db')?.kind).toBe('sqlite');
    expect(found.find((f) => f.rel.endsWith('.csv'))?.suggested).toBe('sales_2026');
  });

  it('names sources without clashing', () => {
    expect(nameFor('orders.csv', new Set(['orders']))).toBe('orders_2');
    expect(nameFor('2026.csv', new Set())).toBe('t_2026');
  });

  it('sniffs database headers', () => {
    expect(sniffDatabase(join(root, 'app.db'))).toBe('sqlite');
    expect(sniffDatabase(join(root, 'Thumbs.db'))).toBeNull();
  });

  it('lists database URLs by variable name only', () => {
    const dbs = findDatabaseUrls(root);
    expect(dbs.map((d) => [d.env, d.kind, d.suggested])).toEqual([
      ['DATABASE_URL', 'postgres', 'db'],
      ['ANALYTICS_URL', 'mysql', 'analytics'],
    ]);
    expect(JSON.stringify(dbs)).not.toContain('s3cret');
  });
});

describe('add_source paths', () => {
  it('accepts files and globs inside the project', () => {
    expect(projectFileSource(root, 'data/Sales 2026.csv', inferSource)).toMatchObject({ type: 'file' });
    expect(projectFileSource(root, 'data/*.csv', inferSource)).toMatchObject({ type: 'file' });
    expect(projectFileSource(root, 'app.db', inferSource)).toMatchObject({ type: 'sqlite' });
  });

  it('refuses anything outside the project', () => {
    expect(() => projectFileSource(root, join(outside, 'secret.csv'), inferSource)).toThrow(/outside this project/);
    expect(() => projectFileSource(root, '../' + outside.split(/[\\/]/).pop() + '/secret.csv', inferSource)).toThrow(/outside this project/);
    expect(() => projectFileSource(root, '../*/secret.csv', inferSource)).toThrow(/outside this project/);
  });

  it('accepts files when the project folder itself is reached through a link', () => {
    // As on macOS, where the temp folder /var/... is really /private/var/...
    const link = join(outside, 'project-link');
    symlinkSync(root, link, process.platform === 'win32' ? 'junction' : 'dir');
    expect(projectFileSource(link, 'data/Sales 2026.csv', inferSource)).toMatchObject({ type: 'file' });
    expect(() => projectFileSource(link, join(outside, 'secret.csv'), inferSource)).toThrow(/outside this project/);
  });

  it('refuses a .db file that is not a database', () => {
    expect(() => projectFileSource(root, 'Thumbs.db', inferSource)).toThrow(/not a SQLite or DuckDB database/);
  });
});

describe('database URLs', () => {
  it('recognises URL schemes, including ORM driver suffixes', () => {
    expect(dbKindOf('postgres://x')).toBe('postgres');
    expect(dbKindOf('postgresql+asyncpg://x')).toBe('postgres');
    expect(dbKindOf('mysql+pymysql://x')).toBe('mysql');
    expect(dbKindOf('https://example.com')).toBeNull();
    expect(inferSource('postgres://u:p@h/db')).toEqual({ type: 'postgres', url: 'postgres://u:p@h/db' });
  });

  it('cleans URLs for DuckDB', () => {
    expect(toDuckDbUrl('postgres', 'postgres+asyncpg://u:p@h:5432/db?schema=public')).toBe('postgresql://u:p@h:5432/db');
    expect(toDuckDbUrl('postgres', 'postgresql://u@h/db?sslmode=require&schema=x')).toBe('postgresql://u@h/db?sslmode=require');
    expect(toDuckDbUrl('mysql', 'mariadb://u@h/db')).toBe('mysql://u@h/db');
  });

  it('reads the URL from the .env file when the source opens, and never shows the password', () => {
    const def = { type: 'postgres' as const, env: 'DATABASE_URL', envFile: join(root, '.env') };
    expect(resolveDbUrl(def)).toBe('postgresql://app:s3cret@localhost:5432/app');
    expect(sourceLocation(def)).not.toContain('s3cret');
    expect(redactUrl('postgresql://app:s3cret@localhost/app')).toBe('postgresql://app:***@localhost/app');
    expect(sourceLocation({ type: 'mysql', url: 'mysql://ro:pw@db/a' })).toBe('mysql://ro:***@db/a');
    expect(() => resolveDbUrl({ type: 'postgres', env: 'NOPE', envFile: join(root, '.env') })).toThrow(/NOPE is not set/);
  });
});
