/**
 * The query engine: one in-memory DuckDB instance per process, with the
 * user's sources attached read-only and the configuration locked so a query
 * cannot read other files, write files, load extensions or attach databases.
 */
import { DuckDBInstance, StatementType, type DuckDBConnection, type DuckDBValue } from '@duckdb/node-api';
import { existsSync, mkdirSync } from 'node:fs';
import { extname } from 'node:path';
import { configMtime, expandFiles, hasGlob, homePath, loadConfig, normalizePath, redactUrl, resolveDbUrl, sourceLocation, type Config, type SourceDef } from '../config.js';
import { log } from '../log.js';

export type ColumnKind = 'number' | 'date' | 'text' | 'boolean' | 'other';

export interface ColumnInfo {
  name: string;
  /** DuckDB type, e.g. `BIGINT`, `DATE`, `DECIMAL(18,2)`. */
  type: string;
  kind: ColumnKind;
}

export type Row = Record<string, unknown>;

export interface QueryResult {
  columns: ColumnInfo[];
  rows: Row[];
  /** True when more rows existed than the limit allowed. */
  truncated: boolean;
  ms: number;
}

export interface TableDescription {
  /** How to refer to the table in SQL. */
  ref: string;
  columns: ColumnInfo[];
  rowCount: number | null;
  sample?: Row[];
}

export interface SourceDescription {
  alias: string;
  type: SourceDef['type'];
  ok: boolean;
  error?: string;
  tables: TableDescription[];
}

export class QueryError extends Error {
  constructor(
    message: string,
    readonly kind: 'rejected' | 'duckdb' | 'timeout' | 'params' | 'cancelled' | 'source',
  ) {
    super(message);
    this.name = 'QueryError';
  }
}

export interface RunOptions {
  /** Maximum rows to return (default 5000). */
  limit?: number;
  /** Interrupt the query after this many ms (default 15000). */
  timeoutMs?: number;
  /** Interrupt the query when this signal aborts (a closed browser request). */
  signal?: AbortSignal;
}

export const DEFAULT_ROW_LIMIT = 5000;
export const DEFAULT_TIMEOUT_MS = 15_000;

const NUMBER_TYPE = /^(TINYINT|SMALLINT|INTEGER|BIGINT|HUGEINT|UTINYINT|USMALLINT|UINTEGER|UBIGINT|UHUGEINT|FLOAT|DOUBLE|REAL|DECIMAL|NUMERIC|INT\d*)\b/;
const DATE_TYPE = /^(DATE|TIMESTAMP)/;

export function kindOf(type: string): ColumnKind {
  const t = type.toUpperCase();
  if (NUMBER_TYPE.test(t)) return 'number';
  if (DATE_TYPE.test(t)) return 'date';
  if (t === 'BOOLEAN') return 'boolean';
  if (t === 'VARCHAR' || t.startsWith('VARCHAR') || t === 'UUID' || t.startsWith('ENUM') || t === 'TIME' || t === 'INTERVAL') return 'text';
  return 'other';
}

function q(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function lit(text: string): string {
  return `'${text.replaceAll("'", "''")}'`;
}

/** Strip leading SQL comments and whitespace. */
function stripLeadingComments(sql: string): string {
  let s = sql;
  for (;;) {
    const t = s.replace(/^\s+/, '');
    if (t.startsWith('--')) {
      const nl = t.indexOf('\n');
      s = nl === -1 ? '' : t.slice(nl + 1);
    } else if (t.startsWith('/*')) {
      const end = t.indexOf('*/');
      s = end === -1 ? '' : t.slice(end + 2);
    } else {
      return t;
    }
  }
}

const ALLOWED_START = /^(SELECT|WITH|FROM|VALUES|\()/i;

/** Cheap text check before DuckDB parses the statement. */
export function checkSqlText(sql: string): void {
  const body = stripLeadingComments(sql);
  if (!body) throw new QueryError('sql is empty', 'rejected');
  if (!ALLOWED_START.test(body)) {
    const word = body.split(/\s+/, 1)[0] ?? '';
    throw new QueryError(`only read queries are allowed (SELECT, WITH or FROM); got "${word.slice(0, 20)}"`, 'rejected');
  }
}

function cleanDuckError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  return msg.length > 900 ? `${msg.slice(0, 900)}…` : msg;
}

function toIsoish(v: string): string {
  // "2026-01-01 10:00:00" → "2026-01-01T10:00:00" so every browser parses it,
  // and a short "+00" offset (TIMESTAMPTZ) becomes "+00:00".
  if (!/^\d{4}-\d{2}-\d{2} \d/.test(v)) return v;
  return v.replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00');
}

function convertCell(v: unknown, kind: ColumnKind): unknown {
  if (v === null || v === undefined) return null;
  if (kind === 'number') {
    if (typeof v === 'number') return v;
    const n = Number(v);
    return Number.isFinite(n) ? n : String(v);
  }
  if (kind === 'date' && typeof v === 'string') return toIsoish(v);
  return v;
}

export class Engine {
  private constructor(
    private readonly instance: DuckDBInstance,
    readonly config: Config,
    readonly sourceErrors: Record<string, string>,
    readonly openedAt: number,
  ) {}

  /** Open an instance, attach the sources, then lock it down. */
  static async open(config: Config): Promise<Engine> {
    const instance = await DuckDBInstance.create(':memory:');
    const conn = await instance.connect();
    await useOwnExtensionDir(conn);
    const sourceErrors: Record<string, string> = {};
    const allowedPaths = new Set<string>();
    try {
      // No extension may be fetched or loaded implicitly, even while sources
      // are attached; the only explicit LOAD is of the installed sqlite one.
      await conn.run('SET autoinstall_known_extensions = false');
      await conn.run('SET autoload_known_extensions = false');
      for (const [alias, def] of Object.entries(config.sources)) {
        try {
          await attachSource(conn, alias, def, allowedPaths);
        } catch (e) {
          sourceErrors[alias] = cleanDuckError(e);
          log.warn(`source "${alias}" could not be opened: ${sourceErrors[alias]}`);
        }
      }
      if (allowedPaths.size > 0) {
        await conn.run(`SET allowed_paths = [${[...allowedPaths].map(lit).join(', ')}]`);
      }
      // Spill files go in Overlook's own folder, never the current directory.
      const tmp = normalizePath(homePath('tmp'));
      mkdirSync(tmp, { recursive: true });
      await conn.run(`SET temp_directory = ${lit(tmp)}`);
      await conn.run('SET enable_external_access = false');
      await conn.run(`SET memory_limit = '2GB'`);
      await conn.run('SET lock_configuration = true');
    } finally {
      conn.closeSync();
    }
    return new Engine(instance, config, sourceErrors, Date.now());
  }

  close(): void {
    try {
      this.instance.closeSync();
    } catch {
      /* already closed */
    }
  }

  /**
   * A raw connection with no Overlook checks in front of it. Only the
   * security tests use it, to prove DuckDB's own lockdown holds on its own.
   */
  async rawConnectionForSecurityTests(): Promise<DuckDBConnection> {
    return this.instance.connect();
  }

  aliases(): string[] {
    return Object.keys(this.config.sources);
  }

  /** Named parameters ($name) a query uses. */
  async parameters(sql: string): Promise<string[]> {
    checkSqlText(sql);
    const conn = await this.instance.connect();
    try {
      const stmt = await this.prepareSingle(conn, sql);
      return paramNames(stmt);
    } finally {
      conn.closeSync();
    }
  }

  private async prepareSingle(conn: DuckDBConnection, sql: string) {
    let extracted;
    try {
      extracted = await conn.extractStatements(sql);
    } catch (e) {
      throw new QueryError(cleanDuckError(e), 'duckdb');
    }
    if (extracted.count !== 1) {
      throw new QueryError(`sql must be exactly one statement; found ${extracted.count}`, 'rejected');
    }
    let stmt;
    try {
      stmt = await extracted.prepare(0);
    } catch (e) {
      throw new QueryError(cleanDuckError(e), 'duckdb');
    }
    if (stmt.statementType !== StatementType.SELECT) {
      throw new QueryError('only read queries are allowed (one SELECT)', 'rejected');
    }
    return stmt;
  }

  /**
   * Run one read-only query. Named parameters are bound from `params`;
   * a parameter with no value is bound as NULL.
   */
  async run(sqlIn: string, params: Record<string, string | null> = {}, opts: RunOptions = {}): Promise<QueryResult> {
    const limit = Math.max(1, Math.min(opts.limit ?? DEFAULT_ROW_LIMIT, 100_000));
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const sql = sqlIn.trim().replace(/;\s*$/, '');
    checkSqlText(sql);
    if (opts.signal?.aborted) throw new QueryError('the request was cancelled', 'cancelled');
    const started = performance.now();
    this.inflight++;
    this.lastUsed = Date.now();
    let conn: DuckDBConnection;
    try {
      conn = await this.instance.connect();
    } catch (e) {
      this.inflight--;
      throw new QueryError(cleanDuckError(e), 'duckdb');
    }
    let timedOut = false;
    let cancelled = false;
    const stop = () => {
      try {
        conn.interrupt();
      } catch {
        /* ignore */
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, timeoutMs);
    const onAbort = () => {
      cancelled = true;
      stop();
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      // The statement runs exactly as written (no wrapper), so DuckDB's
      // errors point at the model's own SQL and ORDER BY is kept. Rows are
      // streamed and reading stops after limit + 1.
      const stmt = await this.prepareSingle(conn, sql);
      const names = paramNames(stmt);
      const positional = names.filter((n) => /^\d+$/.test(n));
      if (positional.length > 0) {
        throw new QueryError('use named parameters like $region, not ? or $1', 'params');
      }
      if (names.length > 0) {
        const values: Record<string, DuckDBValue> = {};
        for (const n of names) values[n] = params[n] ?? null;
        stmt.bind(values);
      }
      const reader = await stmt.streamAndReadUntil(limit + 1);
      const names2 = reader.deduplicatedColumnNames();
      const types = reader.columnTypes().map((t) => t.toString());
      const columns: ColumnInfo[] = names2.map((name, i) => ({ name, type: types[i] ?? 'UNKNOWN', kind: kindOf(types[i] ?? '') }));
      const rawRows = reader.getRowsJson();
      const truncated = rawRows.length > limit;
      const rows: Row[] = rawRows.slice(0, limit).map((r) => {
        const o: Row = {};
        columns.forEach((c, i) => {
          o[c.name] = convertCell(r[i], c.kind);
        });
        return o;
      });
      return { columns, rows, truncated, ms: Math.round(performance.now() - started) };
    } catch (e) {
      if (e instanceof QueryError) throw e;
      if (cancelled) throw new QueryError('the request was cancelled', 'cancelled');
      if (timedOut) throw new QueryError(`query took longer than ${Math.round(timeoutMs / 1000)}s and was stopped`, 'timeout');
      throw new QueryError(cleanDuckError(e), 'duckdb');
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      conn.closeSync();
      this.inflight--;
      this.lastUsed = Date.now();
    }
  }

  /** Queries running right now. */
  inflight = 0;
  /** When the last query started or finished. */
  lastUsed = Date.now();

  /** Describe one source, or all of them. */
  async describe(alias?: string, opts: { samples?: boolean } = {}): Promise<SourceDescription[]> {
    const aliases = alias ? [alias] : this.aliases();
    const out: SourceDescription[] = [];
    for (const a of aliases) {
      const def = this.config.sources[a];
      if (!def) {
        out.push({ alias: a, type: 'file', ok: false, error: 'no such source', tables: [] });
        continue;
      }
      if (this.sourceErrors[a]) {
        out.push({ alias: a, type: def.type, ok: false, error: this.sourceErrors[a], tables: [] });
        continue;
      }
      try {
        const refs = await this.tableRefs(a, def);
        const tables: TableDescription[] = [];
        for (const ref of refs.slice(0, 30)) {
          const cols = await this.run(`SELECT * FROM ${ref} LIMIT 0`, {}, { limit: 1, timeoutMs: 10_000 });
          // Row counts are best effort: a short timeout so large CSVs never
          // stall the first call of a session.
          let rowCount: number | null = null;
          try {
            const c = await this.run(`SELECT count(*) AS n FROM ${ref}`, {}, { limit: 1, timeoutMs: 2_000 });
            rowCount = Number(c.rows[0]?.n ?? 0);
          } catch {
            rowCount = null;
          }
          const t: TableDescription = { ref, columns: cols.columns, rowCount };
          if (opts.samples) {
            const s = await this.run(`SELECT * FROM ${ref} LIMIT 3`, {}, { limit: 3, timeoutMs: 5_000 });
            t.sample = s.rows;
          }
          tables.push(t);
        }
        out.push({ alias: a, type: def.type, ok: true, tables });
      } catch (e) {
        out.push({ alias: a, type: def.type, ok: false, error: e instanceof Error ? e.message : String(e), tables: [] });
      }
    }
    return out;
  }

  private async tableRefs(alias: string, def: SourceDef): Promise<string[]> {
    if (def.type === 'file') return [q(alias)];
    const res = await this.run(
      `SELECT schema_name, table_name FROM duckdb_tables() WHERE database_name = ${lit(alias)}
       UNION ALL
       SELECT schema_name, view_name FROM duckdb_views() WHERE database_name = ${lit(alias)} AND NOT internal
       ORDER BY 1, 2`,
      {},
      { limit: 500 },
    );
    const system = new Set(['information_schema', 'pg_catalog', 'pg_toast', 'mysql', 'performance_schema', 'sys']);
    return res.rows.filter((r) => !system.has(String(r.schema_name))).map((r) => {
      const schema = String(r.schema_name);
      const table = String(r.table_name ?? r.view_name);
      return schema === 'main' || schema === 'public' ? `${q(alias)}.${q(table)}` : `${q(alias)}.${q(schema)}.${q(table)}`;
    });
  }
}

function paramNames(stmt: { parameterCount: number; parameterName(i: number): string }): string[] {
  const names: string[] = [];
  for (let i = 1; i <= stmt.parameterCount; i++) names.push(stmt.parameterName(i));
  return [...new Set(names)];
}

function readerFor(path: string): string {
  const ext = extname(path).toLowerCase();
  if (ext === '.parquet') return 'read_parquet';
  if (ext === '.json' || ext === '.jsonl' || ext === '.ndjson') return 'read_json_auto';
  return 'read_csv_auto';
}

async function attachSource(conn: DuckDBConnection, alias: string, def: SourceDef, allowed: Set<string>): Promise<void> {
  switch (def.type) {
    case 'file': {
      const files = expandFiles(def.path);
      if (files.length === 0) throw new Error(`no files match ${def.path}`);
      for (const f of files) {
        if (!existsSync(f)) throw new Error(`file not found: ${f}`);
        allowed.add(f);
      }
      const reader = readerFor(files[0]!);
      const arg = files.length === 1 ? lit(files[0]!) : `[${files.map(lit).join(', ')}]`;
      await conn.run(`CREATE VIEW ${q(alias)} AS SELECT * FROM ${reader}(${arg})`);
      return;
    }
    case 'sqlite': {
      const p = normalizePath(def.path);
      if (!existsSync(p)) throw new Error(`file not found: ${p}`);
      await loadExtension(conn, 'sqlite');
      for (const f of [p, `${p}-wal`, `${p}-shm`, `${p}-journal`]) allowed.add(f);
      await conn.run(`ATTACH ${lit(p)} AS ${q(alias)} (TYPE sqlite, READ_ONLY)`);
      return;
    }
    case 'duckdb': {
      const p = normalizePath(def.path);
      if (!existsSync(p)) throw new Error(`file not found: ${p}`);
      for (const f of [p, `${p}.wal`]) allowed.add(f);
      await conn.run(`ATTACH ${lit(p)} AS ${q(alias)} (READ_ONLY)`);
      return;
    }
    case 'postgres':
    case 'mysql': {
      // The scanner opens its own network connection to the server; it is
      // attached READ_ONLY, before external access is switched off, and the
      // URL is never shown back (errors are redacted).
      const url = resolveDbUrl(def);
      await loadExtension(conn, def.type);
      try {
        await conn.run(`ATTACH ${lit(url)} AS ${q(alias)} (TYPE ${def.type}, READ_ONLY)`);
      } catch (e) {
        throw new Error(redactUrl(cleanDuckError(e)).replaceAll(url, sourceLocation(def)));
      }
      return;
    }
  }
}

/** The DuckDB extension a source needs, if any. */
export function extensionFor(def: SourceDef): Extension | null {
  if (def.type === 'sqlite') return 'sqlite';
  if (def.type === 'postgres') return 'postgres';
  if (def.type === 'mysql') return 'mysql';
  return null;
}

export type Extension = 'sqlite' | 'postgres' | 'mysql';

/** Extensions live in Overlook's folder, so install and load always agree. */
async function useOwnExtensionDir(conn: DuckDBConnection): Promise<void> {
  const dir = normalizePath(homePath('extensions'));
  mkdirSync(dir, { recursive: true });
  await conn.run(`SET extension_directory = ${lit(dir)}`);
}

/** Load an extension that is already installed. Never downloads. */
async function loadExtension(conn: DuckDBConnection, name: Extension): Promise<void> {
  try {
    await conn.run(`LOAD ${name}`);
  } catch {
    throw new Error(
      `the DuckDB "${name}" extension is not installed. Run "overlook doctor --install" once while online.`,
    );
  }
}

/**
 * Download and install optional extensions. This is the only place Overlook
 * touches the network, and it runs only from `source add` or `doctor --install`.
 */
export async function installExtensions(names: readonly Extension[] = ['sqlite']): Promise<Record<string, string>> {
  const instance = await DuckDBInstance.create(':memory:');
  const conn = await instance.connect();
  await useOwnExtensionDir(conn);
  const out: Record<string, string> = {};
  for (const name of names) {
    try {
      await conn.run(`INSTALL ${name}`);
      await conn.run(`LOAD ${name}`);
      out[name] = 'installed';
    } catch (e) {
      out[name] = cleanDuckError(e);
    }
  }
  conn.closeSync();
  instance.closeSync();
  return out;
}

/**
 * Close a replaced engine once nothing is using it: no query running, and
 * none started for a grace period, so a caller that fetched it from `get()`
 * just before it was replaced can still run its query.
 */
const RETIRE_GRACE_MS = 5_000;
function closeWhenIdle(e: Engine): void {
  const tick = () => {
    if (e.inflight === 0 && Date.now() - e.lastUsed > RETIRE_GRACE_MS) e.close();
    else setTimeout(tick, 250).unref();
  };
  setTimeout(tick, 250).unref();
}

/**
 * Holds the current engine and re-opens it lazily, on the next query after the
 * config file changes, so a source added with the CLI is visible without a
 * restart. An engine that has run nothing for `idleMs` is closed, which
 * releases the file locks DuckDB keeps on attached .duckdb sources so the
 * user's own programs can write to them.
 */
export class EngineHolder {
  private engine: Engine | undefined;
  private mtime = -1;
  private opening: Promise<Engine> | undefined;
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly idleMs = Number(process.env.OVERLOOK_IDLE_MS) || 20_000) {}

  async get(): Promise<Engine> {
    const m = configMtime();
    if (this.engine && m === this.mtime && !this.globIsStale(this.engine) && !this.failedIsStale(this.engine)) {
      this.engine.lastUsed = Date.now();
      return this.engine;
    }
    if (this.opening) return this.opening;
    this.opening = (async () => {
      const config = loadConfig();
      const next = await Engine.open(config);
      const old = this.engine;
      this.engine = next;
      this.mtime = m;
      if (old) closeWhenIdle(old);
      this.startIdleTimer();
      return next;
    })().finally(() => {
      this.opening = undefined;
    });
    return this.opening;
  }

  private startIdleTimer(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      const e = this.engine;
      if (!e) return;
      if (e.inflight === 0 && Date.now() - e.lastUsed > this.idleMs) {
        this.engine = undefined;
        this.mtime = -1;
        e.close();
        clearInterval(this.timer);
        this.timer = undefined;
      }
    }, Math.min(5_000, Math.max(50, this.idleMs / 4)));
    this.timer.unref();
  }

  /** Glob sources are expanded at open time; refresh them every minute. */
  private globIsStale(e: Engine): boolean {
    if (Date.now() - e.openedAt < GLOB_REFRESH_MS) return false;
    return Object.values(e.config.sources).some((s) => s.type === 'file' && hasGlob(s.path));
  }
  /**
   * A source that failed to open (a file being replaced, a writer holding a
   * .duckdb lock) is retried by re-opening, at most every 10 seconds.
   */
  private failedIsStale(e: Engine): boolean {
    return Object.keys(e.sourceErrors).length > 0 && Date.now() - e.openedAt > FAILED_RETRY_MS;
  }

  close(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.engine?.close();
    this.engine = undefined;
  }
}

const GLOB_REFRESH_MS = 60_000;
const FAILED_RETRY_MS = 10_000;
