#!/usr/bin/env node
/**
 * The `overlook` command.
 */
import { spawn } from 'node:child_process';
import { checkDashboard, summarizeCheck } from './check.js';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { addSource, configPath, inferSource, loadConfig, normalizePath, overlookHome, parseEnvText, readJsonFile, removeSource, sourceLocation, type SourceDef } from './config.js';
import { Engine, extensionFor, installExtensions } from './engine/engine.js';
import { dbKindOf, nameFor } from './project.js';
import { configureLog, log } from './log.js';
import { configuredPort, ensureServer, openInBrowser, probe, shutdownServer } from './server/control.js';
import { slugify } from './store.js';
import { VERSION } from './version.js';

const HELP = `overlook ${VERSION} — live dashboards any MCP agent can build from your local data

Usage:
  overlook auto [file]                      build a dashboard from a file (or this project's data)
                                            and open it; [--title T] [--name N] [--source S] [--no-open]
  overlook setup [harness…] [--project]     add Overlook to your agents' MCP config
                                            (claude, codex, cursor, windsurf, gemini, vscode, opencode, cline, zed)
  overlook mcp                              run the MCP server (stdio) for your agent
  overlook serve [--port N]                 run the dashboard web server
  overlook source add <name> <path> [--type file|sqlite|duckdb]
  overlook source add <name> postgres://… | mysql://…
  overlook source add <name> --env DATABASE_URL [--env-file .env]
                                            a database whose URL stays in .env
  overlook source list
  overlook source remove <name>
  overlook validate <spec.json>             check a dashboard spec file
  overlook open <name>                      open a dashboard in the browser
  overlook stop                             stop the web server
  overlook doctor [--install]               check setup; --install downloads the DuckDB extensions
                                            your sources need (sqlite, postgres, mysql)

Files live in ${overlookHome()} (set OVERLOOK_HOME to move them).`;

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
}

function hasFlag(args: string[], name: string): boolean {
  const i = args.indexOf(name);
  if (i === -1) return false;
  args.splice(i, 1);
  return true;
}

function fail(msg: string): never {
  process.stderr.write(`overlook: ${msg}\n`);
  process.exit(1);
}

function out(msg: string): void {
  process.stdout.write(msg + '\n');
}

function openBrowser(url: string): void {
  if (!openInBrowser(url, { force: true })) out(url);
}

async function sourceCommand(args: string[]): Promise<void> {
  const sub = args.shift();
  if (sub === 'add') {
    const type = flag(args, '--type');
    const env = flag(args, '--env');
    const envFile = flag(args, '--env-file');
    const [name, target] = args;
    const usage =
      'usage: overlook source add <name> <path | postgres://… | mysql://…> [--type file|sqlite|duckdb]\n' +
      '       overlook source add <name> --env DATABASE_URL [--env-file .env] [--type postgres|mysql]';
    if (!name || (!target && !env)) fail(usage);
    let def: SourceDef;
    if (env) {
      // The URL stays in the .env file (or the environment) and is read when
      // the source opens; Overlook's config holds only the variable's name.
      const file = envFile ? resolve(envFile) : existsSync(resolve('.env')) ? resolve('.env') : undefined;
      let value: string | undefined;
      if (file) value = parseEnvText(readFileSync(file, 'utf8'))[env];
      value ??= process.env[env];
      if (!value) fail(`${env} is not set${file ? ` in ${file}` : ''}`);
      const kind = type ?? dbKindOf(value);
      if (kind !== 'postgres' && kind !== 'mysql') fail(`${env} does not hold a postgres:// or mysql:// URL; pass --type postgres or --type mysql`);
      def = { type: kind, env, ...(file ? { envFile: normalizePath(file) } : {}) };
    } else if (type) {
      // An explicit --type wins, even for an extension Overlook does not know.
      if (type === 'postgres' || type === 'mysql') def = { type, url: target! };
      else if (type === 'file' || type === 'sqlite' || type === 'duckdb') def = { type, path: normalizePath(resolve(target!)) };
      else fail(`unknown --type "${type}" (use file, sqlite, duckdb, postgres or mysql)`);
    } else {
      try {
        def = inferSource(target!);
      } catch (e) {
        fail(`${(e as Error).message}. Pass --type to say what it is.`);
      }
    }
    const ext = extensionFor(def);
    if (ext) {
      out(`Installing DuckDB's ${ext} extension (a one-time download from extensions.duckdb.org)…`);
      const r = await installExtensions([ext]);
      if (r[ext] !== 'installed') fail(`could not install the DuckDB ${ext} extension: ${r[ext]}`);
    }
    try {
      addSource(name, def);
    } catch (e) {
      fail((e as Error).message);
    }
    const engine = await Engine.open(loadConfig());
    try {
      if (engine.sourceErrors[name]) fail(`saved, but the source does not open: ${engine.sourceErrors[name]}`);
      const [d] = await engine.describe(name);
      out(`Added source "${name}" (${def.type}): ${sourceLocation(def)}`);
      for (const t of d?.tables ?? []) out(`  ${t.ref}: ${t.columns.length} columns, ${t.rowCount ?? '?'} rows`);
    } finally {
      engine.close();
    }
    return;
  }
  if (sub === 'list') {
    const c = loadConfig();
    const entries = Object.entries(c.sources);
    if (entries.length === 0) out('No sources. Add one with: overlook source add <name> <path>');
    for (const [name, def] of entries) out(`${name}\t${def.type}\t${sourceLocation(def)}`);
    return;
  }
  if (sub === 'remove') {
    const name = args[0];
    if (!name) fail('usage: overlook source remove <name>');
    out(removeSource(name) ? `Removed source "${name}".` : `No source named "${name}".`);
    return;
  }
  fail('usage: overlook source add|list|remove');
}

/**
 * `overlook auto [path]`: the whole flow in one command, for agents that can
 * run shell commands but do not speak MCP, and for people. A path given here
 * may be anywhere: whoever runs a command can read the file anyway.
 */
async function autoCommand(args: string[]): Promise<void> {
  const source = flag(args, '--source');
  const title = flag(args, '--title');
  const name = flag(args, '--name');
  const table = flag(args, '--table');
  if (hasFlag(args, '--no-open')) process.env.OVERLOOK_OPEN = '0';
  const target = args[0];
  const { EngineHolder } = await import('./engine/engine.js');
  const { createTools } = await import('./mcp/tools.js');
  const engines = new EngineHolder();
  const tools = createTools(engines);
  let use = source;
  if (target && !source) {
    const abs = resolve(target);
    if (!existsSync(abs)) fail(`no file at ${normalizePath(abs)}`);
    const config = loadConfig();
    const already = Object.entries(config.sources).find(([, d]) => 'path' in d && normalizePath(d.path).toLowerCase() === normalizePath(abs).toLowerCase());
    if (already) use = already[0];
    else {
      let def: SourceDef;
      try {
        def = inferSource(abs);
      } catch (e) {
        fail((e as Error).message);
      }
      const ext = extensionFor(def);
      if (ext) {
        const r = await installExtensions([ext]);
        if (r[ext] !== 'installed') fail(`could not install the DuckDB ${ext} extension: ${r[ext]}`);
      }
      use = nameFor(abs, new Set(Object.keys(config.sources)));
      try {
        addSource(use, def);
      } catch (e) {
        fail((e as Error).message);
      }
      out(`Added ${normalizePath(abs)} as source "${use}".`);
    }
  }
  const r = await tools.auto_dashboard({ ...(use ? { source: use } : {}), ...(title ? { title } : {}), ...(name ? { name } : {}), ...(table ? { table } : {}) });
  if (r.isError) {
    engines.close();
    fail(r.text);
  }
  const { servingInProcess } = await import('./server/control.js');
  if (servingInProcess() && process.stdout.isTTY) {
    // A separate server could not be started (a sandbox blocked it), so this
    // process is the server: stay up instead of taking the page down with us.
    // Only for a person at a terminal: an agent's shell tool or CI would wait
    // forever, so they get the note to run "overlook serve" and an exit.
    out(r.text.replace(/\nNote: the dashboard server is running inside[^\n]*/, '').replace(/\n\nTo change it:[^\n]*$/, ''));
    out('\nServing the dashboard from this command. Press Ctrl+C to stop.');
    return;
  }
  out(r.text.replace(/\n\nTo change it:[^\n]*$/, ''));
  // End by letting the event loop drain, not process.exit(): on Windows,
  // exiting while the PowerShell helper's handle is still closing aborts.
  engines.close();
}

async function validateCommand(args: string[]): Promise<void> {
  const json = hasFlag(args, '--json');
  const file = args[0];
  if (!file) fail('usage: overlook validate <spec.json> [--json]');
  let spec: unknown;
  try {
    spec = readJsonFile(file);
  } catch (e) {
    fail(`cannot read ${file}: ${(e as Error).message}`);
  }
  const engine = await Engine.open(loadConfig());
  try {
    const r = await checkDashboard(spec, engine);
    if (json) out(JSON.stringify(r, null, 2));
    else out(r.ok ? `OK: ${r.panels.length} panels valid.${summarizeCheck(r) ? `\n${summarizeCheck(r)}` : ''}` : summarizeCheck(r, 'The spec is not valid.'));
    process.exitCode = r.ok ? 0 : 1;
  } finally {
    engine.close();
  }
}

async function doctorCommand(args: string[]): Promise<void> {
  const install = hasFlag(args, '--install');
  out(`Overlook ${VERSION}`);
  out(`Node ${process.version} on ${process.platform}-${process.arch}`);
  out(`Home: ${overlookHome()}`);
  out(`Config: ${configPath()}`);
  let config;
  try {
    config = loadConfig();
  } catch (e) {
    out(`Config error: ${(e as Error).message}`);
    process.exitCode = 1;
    return;
  }
  if (install) {
    // sqlite always, plus what the registered sources need.
    const needed = new Set(['sqlite' as const, ...Object.values(config.sources).flatMap((d) => extensionFor(d) ?? [])]);
    const r = await installExtensions([...needed]);
    for (const [k, v] of Object.entries(r)) out(`Extension ${k}: ${v}`);
  }
  const engine = await Engine.open(config);
  try {
    const v = await engine.run('SELECT version() AS v');
    out(`DuckDB ${String(v.rows[0]?.v ?? '?')}`);
    const sources = Object.entries(config.sources);
    if (sources.length === 0) out('Sources: none (add one with "overlook source add <name> <path>")');
    for (const [name, def] of sources) {
      const err = engine.sourceErrors[name];
      out(`Source ${name} (${def.type}): ${err ? `ERROR ${err}` : 'ok'}`);
      if (err) process.exitCode = 1;
    }
  } finally {
    engine.close();
  }
  const port = configuredPort();
  const p = await probe(port);
  out(`Server on port ${port}: ${p.kind === 'overlook' ? `running (${p.health.version}, pid ${p.health.pid})` : p.kind === 'other' ? 'PORT USED BY ANOTHER PROGRAM' : 'not running (starts when a dashboard is saved)'}`);
  out(`
Add Overlook to your agent:

Claude Code:
  claude mcp add overlook -- npx -y overlook-dash@${VERSION} mcp

Codex CLI (~/.codex/config.toml):
  [mcp_servers.overlook]
  command = "npx"
  args = ["-y", "overlook-dash@${VERSION}", "mcp"]

OpenCode (opencode.json):
  "mcp": { "overlook": { "type": "local", "command": ["npx", "-y", "overlook-dash@${VERSION}", "mcp"] } }`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const cmd = args.shift();
  switch (cmd) {
    case 'mcp': {
      configureLog({ quiet: !hasFlag(args, '--verbose') });
      const { mcpCommand } = await import('./mcp/server.js');
      await mcpCommand();
      return;
    }
    case 'serve': {
      const quiet = hasFlag(args, '--quiet');
      // --home lets a launcher that cannot pass environment variables (the
      // Windows out-of-job start) say which Overlook folder to serve.
      const home = flag(args, '--home');
      if (home) process.env.OVERLOOK_HOME = home;
      configureLog({ quiet });
      const p = flag(args, '--port');
      const port = p ? Number(p) : configuredPort();
      if (!Number.isInteger(port) || port <= 0 || port >= 65536) fail(`invalid port "${p}"`);
      const { serveCommand } = await import('./server/server.js');
      await serveCommand(port);
      return;
    }
    case 'source':
      configureLog({ quiet: true });
      await sourceCommand(args);
      return;
    case 'validate':
      configureLog({ quiet: true });
      await validateCommand(args);
      return;
    case 'auto':
      configureLog({ quiet: true });
      await autoCommand(args);
      return;
    case 'setup':
      configureLog({ quiet: true });
      await (await import('./setup.js')).setupCommand(args, out, fail);
      return;
    case 'open': {
      configureLog({ quiet: true });
      const name = args[0];
      const s = await ensureServer();
      if (s.note) process.stderr.write(`overlook: ${s.note}\n`);
      const url = name ? `${s.url}/d/${slugify(name)}` : s.url;
      out(url);
      openBrowser(url);
      return;
    }
    case 'stop': {
      configureLog({ quiet: true });
      const port = configuredPort();
      const p = await probe(port);
      if (p.kind !== 'overlook') {
        out('No Overlook server is running.');
        return;
      }
      out((await shutdownServer(port)) ? 'Stopped the Overlook server.' : 'Could not stop the server.');
      return;
    }
    case 'doctor':
      configureLog({ quiet: true });
      await doctorCommand(args);
      return;
    case '--version':
    case '-v':
      out(VERSION);
      return;
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      out(HELP);
      return;
    default:
      fail(`unknown command "${cmd}". Run "overlook help".`);
  }
}

main().catch((e: unknown) => {
  log.error((e as Error)?.stack ?? String(e));
  process.stderr.write(`overlook: ${(e as Error)?.message ?? String(e)}\n`);
  process.exit(1);
});
