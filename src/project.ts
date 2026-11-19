/**
 * The project the agent is working in, and the data it holds.
 *
 * An agent starts Overlook's MCP server in the project folder, so the current
 * directory (or OVERLOOK_PROJECT) is the project. Overlook looks there for
 * data files and database URLs, lists them in describe_data, and lets the
 * agent register one with add_source, but only from inside that folder: the
 * model can reach the data the user put in front of it, never the rest of
 * the disk.
 */
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, extname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { hasGlob, normalizePath, overlookHome, parseEnvText, type SourceDef } from './config.js';

const SKIP_DIRS = new Set([
  'node_modules', 'dist', 'build', 'out', 'target', 'vendor', 'coverage',
  'venv', 'env', '__pycache__', 'site-packages', 'bower_components', 'Pods',
]);
/** Extensions found by the scan. .json and .txt are left out: in a code project they are almost never data. */
const SCAN_EXTS = new Set(['.csv', '.tsv', '.parquet', '.jsonl', '.ndjson', '.sqlite', '.sqlite3', '.db', '.db3', '.duckdb', '.ddb']);
const MAX_FILES = 40;
const MAX_DEPTH = 5;
const MAX_ENTRIES = 20_000;

/** The project folder, or null when the directory is too broad to scan (home, a drive root). */
export function projectRoot(): string | null {
  const raw = process.env.OVERLOOK_PROJECT || process.cwd();
  let root: string;
  try {
    root = realpathSync(resolve(raw));
  } catch {
    return null;
  }
  const same = (a: string, b: string) => normalizePath(a).toLowerCase() === normalizePath(b).toLowerCase();
  if (same(root, parse(root).root) || same(root, homedir())) return null;
  try {
    if (same(root, realpathSync(overlookHome()))) return null;
  } catch {
    /* no home yet */
  }
  return root;
}

export interface FoundFile {
  /** Absolute, forward slashes. */
  path: string;
  /** Path relative to the project, for display. */
  rel: string;
  kind: 'file' | 'sqlite' | 'duckdb';
  bytes: number;
  /** A free source name derived from the file name. */
  suggested: string;
}

function readHead(p: string, n: number): Buffer {
  const fd = openSync(p, 'r');
  try {
    const buf = Buffer.alloc(n);
    const got = readSync(fd, buf, 0, n, 0);
    return buf.subarray(0, got);
  } finally {
    closeSync(fd);
  }
}

/** What a database file really is, by its header: .db is also used by non-databases (Thumbs.db). */
export function sniffDatabase(p: string): 'sqlite' | 'duckdb' | null {
  try {
    const head = readHead(p, 16);
    if (head.subarray(0, 16).toString('latin1') === 'SQLite format 3\0') return 'sqlite';
    if (head.subarray(8, 12).toString('latin1') === 'DUCK') return 'duckdb';
  } catch {
    /* unreadable */
  }
  return null;
}

/** A source name from a file name: "Sales 2026.csv" -> "sales_2026". */
export function nameFor(file: string, taken: ReadonlySet<string>): string {
  let base = basename(file, extname(file)).toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
  if (!/^[a-z_]/.test(base)) base = `t_${base}`;
  if (!base || base === 't_') base = 'data';
  let name = base;
  for (let i = 2; taken.has(name); i++) name = `${base}_${i}`;
  return name;
}

/** Data files in the project, nearest first, skipping dependency and build folders. */
export function findDataFiles(root: string, taken: ReadonlySet<string> = new Set()): FoundFile[] {
  const out: FoundFile[] = [];
  const names = new Set(taken);
  let seen = 0;
  let queue: string[] = [root];
  for (let depth = 0; depth <= MAX_DEPTH && queue.length > 0 && out.length < MAX_FILES; depth++) {
    const next: string[] = [];
    for (const dir of queue) {
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const e of entries) {
        if (++seen > MAX_ENTRIES || out.length >= MAX_FILES) break;
        if (e.name.startsWith('.')) continue;
        const full = join(dir, e.name);
        if (e.isDirectory()) {
          if (!SKIP_DIRS.has(e.name)) next.push(full);
          continue;
        }
        if (!e.isFile()) continue;
        const ext = extname(e.name).toLowerCase();
        if (!SCAN_EXTS.has(ext)) continue;
        let bytes = 0;
        try {
          bytes = statSync(full).size;
        } catch {
          continue;
        }
        if (bytes === 0) continue;
        let kind: FoundFile['kind'] = 'file';
        if (['.sqlite', '.sqlite3', '.db', '.db3', '.duckdb', '.ddb'].includes(ext)) {
          const sniffed = sniffDatabase(full);
          if (!sniffed) continue;
          kind = sniffed;
        }
        const suggested = nameFor(e.name, names);
        names.add(suggested);
        out.push({ path: normalizePath(full), rel: normalizePath(relative(root, full)), kind, bytes, suggested });
      }
    }
    queue = next;
  }
  return out;
}

/* ----------------------------------------------------------- .env files */

const ENV_FILES = ['.env', '.env.local', '.env.development', '.env.development.local'];

export function readEnvFile(p: string): Record<string, string> {
  try {
    return parseEnvText(readFileSync(p, 'utf8'));
  } catch {
    return {};
  }
}

export type DbKind = 'postgres' | 'mysql';

/** The database a connection URL points at, if it is one Overlook can attach. */
export function dbKindOf(url: string): DbKind | null {
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(url.trim())?.[1]?.toLowerCase();
  if (!scheme) return null;
  if (scheme === 'postgres' || scheme === 'postgresql' || scheme.startsWith('postgresql+') || scheme.startsWith('postgres+')) return 'postgres';
  if (scheme === 'mysql' || scheme.startsWith('mysql+') || scheme === 'mariadb') return 'mysql';
  return null;
}

export interface FoundDatabase {
  env: string;
  /** Absolute path of the .env file that holds it. */
  envFile: string;
  kind: DbKind;
  suggested: string;
}

/** Database URLs in the project's .env files, by variable name only: values are never shown. */
export function findDatabaseUrls(root: string, taken: ReadonlySet<string> = new Set()): FoundDatabase[] {
  const out: FoundDatabase[] = [];
  const names = new Set(taken);
  const seenVars = new Set<string>();
  for (const f of ENV_FILES) {
    const p = join(root, f);
    if (!existsSync(p)) continue;
    for (const [k, v] of Object.entries(readEnvFile(p))) {
      const kind = dbKindOf(v);
      if (!kind || seenVars.has(k)) continue;
      seenVars.add(k);
      const base = k.toLowerCase().replace(/_?(database_)?url$/, '').replace(/[^a-z0-9_]+/g, '_') || 'db';
      const suggested = nameFor(base === 'database' ? 'db' : base, names);
      names.add(suggested);
      out.push({ env: k, envFile: normalizePath(p), kind, suggested });
    }
  }
  return out;
}

/* -------------------------------------------------------- add_source */

/** Whether `child` is `root` or inside it, comparing real paths. */
export function isInside(root: string, child: string): boolean {
  const rel = relative(root, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel) && !rel.split(sep).includes('..'));
}

/**
 * Resolve a path the agent asked for into a source definition, refusing
 * anything outside the project. Globs are checked by their fixed prefix.
 */
export function projectFileSource(root: string, target: string, infer: (p: string) => SourceDef): SourceDef {
  // Compare real paths on both sides: the project folder itself may sit
  // behind a symlink or junction (on macOS, /var is /private/var).
  const realRoot = realpathSync(root);
  const abs = resolve(root, target);
  if (hasGlob(abs)) {
    const fixed = abs.slice(0, abs.search(/[*?[\]{}]/));
    const base = existsSync(fixed) && statSync(fixed).isDirectory() ? fixed : dirname(fixed);
    if (/(^|[\\/])\.\.([\\/]|$)/.test(target) || !isInside(realRoot, realpathSync(base))) {
      throw new Error(`"${target}" is outside this project (${normalizePath(root)})`);
    }
    return infer(abs);
  }
  if (!existsSync(abs)) throw new Error(`no file at ${normalizePath(abs)}`);
  const real = realpathSync(abs);
  if (!isInside(realRoot, real)) throw new Error(`"${target}" is outside this project (${normalizePath(root)})`);
  const def = infer(real);
  if ((def.type === 'sqlite' || def.type === 'duckdb') && sniffDatabase(real) !== def.type) {
    const actual = sniffDatabase(real);
    if (!actual) throw new Error(`${normalizePath(real)} is not a SQLite or DuckDB database`);
    return { type: actual, path: def.path };
  }
  return def;
}
