import { existsSync, globSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, extname, isAbsolute, join, resolve } from 'node:path';
import { IDENT_RE } from './spec/schema.js';

/**
 * A database server reached by connection URL. The URL is either stored here
 * (`url`, added by the user on the command line) or read when the source is
 * opened from a variable (`env`) in a .env file (`envFile`) or, failing that,
 * the environment, so a password never has to be copied into Overlook.
 */
export interface DbSourceDef {
  type: 'postgres' | 'mysql';
  url?: string;
  env?: string;
  envFile?: string;
}

export type SourceDef =
  | { type: 'file'; path: string }
  | { type: 'sqlite'; path: string }
  | { type: 'duckdb'; path: string }
  | DbSourceDef;

export const DB_TYPES = ['postgres', 'mysql'] as const;

export function isDbSource(def: SourceDef): def is DbSourceDef {
  return def.type === 'postgres' || def.type === 'mysql';
}

/** Where a source lives, for display: a path, or "postgres via DATABASE_URL". Never a password. */
export function sourceLocation(def: SourceDef): string {
  if (!isDbSource(def)) return def.path;
  if (def.env) return `${def.type} via ${def.env}${def.envFile ? ` in ${def.envFile}` : ''}`;
  return redactUrl(def.url ?? '');
}

/** A connection URL with any password replaced by ***. */
export function redactUrl(url: string): string {
  return url.replace(/^([a-z][a-z0-9+.-]*:\/\/[^:/@]*):[^@]*@/i, '$1:***@').replace(/(password=)[^&\s]*/gi, '$1***');
}

/** Parse KEY=value lines of a dotenv file. Quotes are removed; ${VAR} is not expanded. */
export function parseEnvText(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.]*)\s*=\s*(.*)$/.exec(raw);
    if (!m || raw.trim().startsWith('#')) continue;
    let v = m[2]!.trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, '');
    out[m[1]!] = v;
  }
  return out;
}

/** The connection URL of a database source, read now. Throws a message naming what is missing. */
export function resolveDbUrl(def: DbSourceDef): string {
  if (def.url) return toDuckDbUrl(def.type, def.url);
  if (!def.env) throw new Error('the source has neither "url" nor "env"');
  let value: string | undefined;
  if (def.envFile) {
    try {
      value = parseEnvText(readFileSync(def.envFile, 'utf8'))[def.env];
    } catch {
      throw new Error(`cannot read ${def.envFile}`);
    }
  }
  value ??= process.env[def.env];
  if (!value) throw new Error(`${def.env} is not set${def.envFile ? ` in ${def.envFile}` : ''}`);
  return toDuckDbUrl(def.type, value);
}

/**
 * DuckDB's scanners take libpq-style URLs. Strip ORM driver suffixes
 * ("postgresql+asyncpg://", "mysql+pymysql://") and Prisma's ?schema= option,
 * which libpq rejects.
 */
export function toDuckDbUrl(type: DbSourceDef['type'], url: string): string {
  let u = url.trim().replace(/^([a-z]+)\+[a-z0-9_]+:\/\//i, '$1://');
  if (type === 'postgres') {
    u = u.replace(/^postgres:\/\//i, 'postgresql://');
    u = u.replace(/([?&])schema=[^&]*&?/i, '$1').replace(/[?&]$/, '');
  } else {
    u = u.replace(/^mariadb:\/\//i, 'mysql://');
  }
  return u;
}

export interface Config {
  version: 1;
  sources: Record<string, SourceDef>;
  /** Preferred port for `overlook serve`. */
  port?: number;
  /** Whether describe_data may return sample rows to the model. Default true. */
  samples?: boolean;
}

export const DEFAULT_PORT = 4777;

export function overlookHome(): string {
  return process.env.OVERLOOK_HOME ? resolve(process.env.OVERLOOK_HOME) : join(homedir(), '.overlook');
}

export function homePath(...parts: string[]): string {
  return join(overlookHome(), ...parts);
}

export function configPath(): string {
  return homePath('config.json');
}

export function ensureHome(): void {
  for (const d of ['', 'dashboards', 'history', 'state', 'logs']) mkdirSync(homePath(d), { recursive: true });
}

export function emptyConfig(): Config {
  return { version: 1, sources: {} };
}

/**
 * Read a JSON file written by Overlook or by hand. A UTF-8 byte-order mark
 * (added by some Windows editors and PowerShell) is ignored.
 */
export function readJsonFile(p: string): unknown {
  const text = readFileSync(p, 'utf8');
  return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
}

function readRawConfig(p: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = readJsonFile(p);
  } catch (e) {
    throw new Error(`${p} is not valid JSON: ${(e as Error).message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${p} must hold a JSON object`);
  const version = (parsed as { version?: unknown }).version;
  if (typeof version === 'number' && version > 1) {
    throw new Error(`${p} uses config version ${version}; this build of Overlook supports version 1. Upgrade overlook-dash.`);
  }
  return parsed as Record<string, unknown>;
}

export function loadConfig(): Config {
  const p = configPath();
  if (!existsSync(p)) return emptyConfig();
  const c = readRawConfig(p) as Partial<Config>;
  return {
    version: 1,
    sources: c.sources && typeof c.sources === 'object' ? c.sources : {},
    ...(typeof c.port === 'number' ? { port: c.port } : {}),
    ...(typeof c.samples === 'boolean' ? { samples: c.samples } : {}),
  };
}

/** Modification time of the config file, or 0 if it does not exist. */
export function configMtime(): number {
  try {
    return statSync(configPath()).mtimeMs;
  } catch {
    return 0;
  }
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Write a temp file, then rename it over the target. On Windows the rename
 * fails while another process has the target open (a page request, antivirus),
 * so it is retried with backoff.
 */
export function writeFileAtomic(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, text, 'utf8');
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(tmp, path);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if ((code === 'EPERM' || code === 'EBUSY' || code === 'EACCES') && attempt < 8) {
        sleepSync(25 * 2 ** attempt);
        continue;
      }
      try {
        rmSync(tmp, { force: true });
      } catch {
        /* ignore */
      }
      throw e;
    }
  }
}

/** Save the config. Keys this build does not know are kept as they were. */
export function saveConfig(config: Config): void {
  ensureHome();
  const p = configPath();
  const existing = existsSync(p) ? readRawConfig(p) : {};
  writeFileAtomic(p, JSON.stringify({ ...existing, ...config }, null, 2) + '\n');
}

const FILE_EXTS = new Set(['.csv', '.tsv', '.txt', '.parquet', '.json', '.jsonl', '.ndjson']);
const SQLITE_EXTS = new Set(['.sqlite', '.sqlite3', '.db', '.db3']);
const DUCKDB_EXTS = new Set(['.duckdb', '.ddb']);

export function hasGlob(path: string): boolean {
  return /[*?[\]{}]/.test(path);
}

/** Forward-slash form; DuckDB's path checks compare strings. */
export function normalizePath(p: string): string {
  return p.replaceAll('\\', '/');
}

/** Expand a file source's path (which may be a glob) to concrete files. */
export function expandFiles(path: string): string[] {
  if (!hasGlob(path)) return [normalizePath(path)];
  return globSync(normalizePath(path))
    .map((p) => normalizePath(isAbsolute(p) ? p : resolve(p)))
    .sort();
}

/** Guess a source definition from a path or a database URL. */
export function inferSource(target: string): SourceDef {
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(target)?.[1]?.toLowerCase().replace(/\+.*$/, '');
  if (scheme === 'postgres' || scheme === 'postgresql') return { type: 'postgres', url: target };
  if (scheme === 'mysql' || scheme === 'mariadb') return { type: 'mysql', url: target };
  const abs = normalizePath(resolve(target));
  const ext = extname(abs).toLowerCase();
  if (SQLITE_EXTS.has(ext) && !hasGlob(abs)) return { type: 'sqlite', path: abs };
  if (DUCKDB_EXTS.has(ext) && !hasGlob(abs)) return { type: 'duckdb', path: abs };
  if (FILE_EXTS.has(ext)) return { type: 'file', path: abs };
  throw new Error(
    `cannot tell what kind of source "${target}" is. Supported: .csv .tsv .parquet .json .jsonl (files or globs), .sqlite/.db, .duckdb, postgres:// and mysql:// URLs`,
  );
}

export function validateSource(alias: string, def: SourceDef): void {
  if (!IDENT_RE.test(alias)) {
    throw new Error(`source name "${alias}" must start with a letter or _ and contain only letters, digits and _`);
  }
  if (isDbSource(def)) {
    if (!def.url && !def.env) throw new Error(`a ${def.type} source needs "url" or "env"`);
    if (def.envFile && !isAbsolute(def.envFile)) throw new Error(`envFile must be absolute: ${def.envFile}`);
    return;
  }
  if (!['file', 'sqlite', 'duckdb'].includes(def.type)) throw new Error(`unknown source type "${String((def as { type: unknown }).type)}"`);
  if (!isAbsolute(def.path)) throw new Error(`source path must be absolute: ${def.path}`);
  if (def.type === 'file') {
    const files = expandFiles(def.path);
    if (files.length === 0 || (!hasGlob(def.path) && !existsSync(def.path))) {
      throw new Error(`no file found at ${def.path}`);
    }
  } else if (!existsSync(def.path)) {
    throw new Error(`no file found at ${def.path}`);
  }
}

export function addSource(alias: string, def: SourceDef): Config {
  validateSource(alias, def);
  const config = loadConfig();
  config.sources[alias] = def;
  saveConfig(config);
  return config;
}

export function removeSource(alias: string): boolean {
  const config = loadConfig();
  if (!(alias in config.sources)) return false;
  delete config.sources[alias];
  saveConfig(config);
  return true;
}

export function samplesEnabled(config: Config): boolean {
  if (process.env.OVERLOOK_SAMPLES === '0') return false;
  if (process.env.OVERLOOK_SAMPLES === '1') return true;
  return config.samples !== false;
}
