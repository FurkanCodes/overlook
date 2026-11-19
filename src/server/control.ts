/**
 * Finding, starting and replacing the local web server.
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { connect } from 'node:net';
import { delimiter, join } from 'node:path';
import { DEFAULT_PORT, homePath, loadConfig, overlookHome } from '../config.js';
import { log } from '../log.js';
import { PACKAGE_ROOT, VERSION, compareVersions } from '../version.js';

export interface Health {
  app: 'overlook';
  version: string;
  pid: number;
}

export function configuredPort(): number {
  const env = Number(process.env.OVERLOOK_PORT);
  if (Number.isInteger(env) && env > 0 && env < 65536) return env;
  try {
    const p = loadConfig().port;
    if (typeof p === 'number' && Number.isInteger(p) && p > 0 && p < 65536) return p;
  } catch {
    /* fall through */
  }
  return DEFAULT_PORT;
}

export function baseUrl(port = configuredPort()): string {
  return `http://127.0.0.1:${port}`;
}

/** Whether anything accepts a TCP connection on the port. */
export function portOpen(port: number, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = connect({ host: '127.0.0.1', port });
    const done = (open: boolean) => {
      sock.destroy();
      resolve(open);
    };
    sock.setTimeout(timeoutMs, () => done(false));
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
  });
}

/**
 * What answers on the port: an Overlook server, something else, or nothing.
 * A plain TCP connect decides "nothing" first, so a slow refusal can never be
 * mistaken for "another program"; only then is the health route asked.
 */
export async function probe(port: number, timeoutMs = 1500): Promise<{ kind: 'overlook'; health: Health } | { kind: 'other' } | { kind: 'none' }> {
  if (!(await portOpen(port, timeoutMs))) return { kind: 'none' };
  try {
    const res = await fetch(`${baseUrl(port)}/api/health`, { signal: AbortSignal.timeout(timeoutMs) });
    const body = (await res.json().catch(() => undefined)) as Partial<Health> | undefined;
    if (body && body.app === 'overlook' && typeof body.version === 'string') return { kind: 'overlook', health: body as Health };
    return { kind: 'other' };
  } catch {
    // The port accepted a connection but did not answer like Overlook.
    return { kind: 'other' };
  }
}

function cliEntry(): string {
  return process.env.OVERLOOK_CLI ?? join(PACKAGE_ROOT, 'dist', 'src', 'cli.js');
}

/**
 * Ask the web server on `port` to stop. Like every POST it needs a JSON body,
 * which a web page on another site cannot send without a CORS preflight.
 */
export async function shutdownServer(port: number): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl(port)}/api/shutdown`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return false;
  } catch {
    return false;
  }
  for (let i = 0; i < 20; i++) {
    if ((await probe(port, 300)).kind === 'none') return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

let inProcess = false;

/** Whether this process is serving the dashboards itself (no separate server could start). */
export function servingInProcess(): boolean {
  return inProcess;
}

export interface EnsureResult {
  url: string;
  running: boolean;
  started: boolean;
  note?: string;
}

/**
 * Make sure an up-to-date Overlook server answers on the configured port.
 * Never throws: on failure the result carries a note for the user.
 */
export async function ensureServer(): Promise<EnsureResult> {
  const port = configuredPort();
  const url = baseUrl(port);
  if (process.env.OVERLOOK_NO_SERVE === '1') return { url, running: false, started: false, note: 'auto-start is off (OVERLOOK_NO_SERVE=1); run "overlook serve"' };

  const found = await probe(port);
  if (found.kind === 'overlook') {
    if (compareVersions(found.health.version, VERSION) >= 0) return { url, running: true, started: false };
    log.info(`replacing Overlook server ${found.health.version} with ${VERSION}`);
    const stopped = await shutdownServer(port);
    if (!stopped) {
      return { url, running: true, started: false, note: `an older Overlook server (${found.health.version}) is running and could not be replaced; run "overlook stop" then "overlook serve"` };
    }
  } else if (found.kind === 'other') {
    return { url, running: false, started: false, note: `port ${port} is used by another program; set "port" in ${homePath('config.json')} or OVERLOOK_PORT` };
  }

  const entry = cliEntry();
  if (!existsSync(entry)) {
    return { url, running: false, started: false, note: `could not find the Overlook CLI at ${entry}; run "overlook serve" yourself` };
  }
  try {
    if (process.platform === 'win32') await startOutsideJob(entry, port);
    else {
      // detached puts the server in its own session, so it outlives the agent.
      const child = spawn(process.execPath, [entry, 'serve', '--quiet', '--port', String(port)], { detached: true, stdio: 'ignore', env: process.env });
      child.unref();
    }
  } catch (e) {
    return { url, running: false, started: false, note: `could not start the server: ${(e as Error).message}; run "overlook serve"` };
  }
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 100));
    const p = await probe(port, 300);
    if (p.kind === 'overlook') return { url, running: true, started: true };
  }
  // Last resort: some agent sandboxes block every way of starting a process
  // that outlives the agent. Serve from this MCP process instead, so the link
  // works for the rest of the session, and say how to keep it running.
  try {
    const { startServer } = await import('./server.js');
    await startServer({ port });
    inProcess = true;
    log.info(`serving dashboards from the MCP process at ${url} (a separate server could not be started)`);
    return {
      url,
      running: true,
      started: true,
      note: `the dashboard server is running inside this agent session and stops when the session ends; to keep it running, run "overlook serve" in a terminal`,
    };
  } catch (e) {
    return { url, running: false, started: false, note: `the dashboard server could not be started (${(e as Error).message}); run "overlook serve" in a terminal` };
  }
}

/**
 * Open a URL in the user's default browser. Skipped (returns false) when no
 * one could see it: CI, an SSH session, a Linux box with no display, or
 * OVERLOOK_OPEN=0. `force` (the `open` command) only skips OVERLOOK_OPEN.
 */
/** A program on PATH, or undefined. Checked up front so "opened" is never claimed for a missing opener. */
function onPathSync(name: string): string | undefined {
  const exts = process.platform === 'win32' ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';') : [''];
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    for (const ext of exts) {
      const p = join(dir, name + ext);
      if (dir && existsSync(p)) return p;
    }
  }
  return undefined;
}

/** Whether this is Linux running under Windows (WSL), where the browser is Windows'. */
export function isWsl(): boolean {
  if (process.platform !== 'linux') return false;
  if (process.env.WSL_DISTRO_NAME) return true;
  try {
    return /microsoft/i.test(readFileSync('/proc/version', 'utf8'));
  } catch {
    return false;
  }
}

/**
 * How to open a URL here, or null when nothing can. Under WSL it is the
 * Windows browser (WSL forwards 127.0.0.1 to the Linux server); on a Linux
 * desktop it needs a display and an opener such as xdg-open.
 */
export function browserOpener(force = false): { cmd: string; args: string[] } | null {
  if (process.platform === 'win32') return { cmd: 'rundll32', args: ['url.dll,FileProtocolHandler'] };
  if (process.platform === 'darwin') return { cmd: 'open', args: [] };
  if (isWsl()) {
    const r = onPathSync('rundll32.exe') ?? (existsSync('/mnt/c/Windows/System32/rundll32.exe') ? '/mnt/c/Windows/System32/rundll32.exe' : undefined);
    if (r) return { cmd: r, args: ['url.dll,FileProtocolHandler'] };
    const v = onPathSync('wslview');
    if (v) return { cmd: v, args: [] };
  }
  if (!force && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) return null;
  for (const name of ['xdg-open', 'gio', 'sensible-browser']) {
    const p = onPathSync(name);
    if (p) return { cmd: p, args: name === 'gio' ? ['open'] : [] };
  }
  return null;
}

export function openInBrowser(url: string, opts: { force?: boolean } = {}): boolean {
  if (!/^http:\/\/127\.0\.0\.1:\d+\//.test(url)) return false;
  if (!opts.force && (process.env.OVERLOOK_OPEN === '0' || process.env.CI || process.env.SSH_CONNECTION || process.env.SSH_TTY)) return false;
  const opener = browserOpener(opts.force ?? false);
  if (!opener) return false;
  const [cmd, args] = [opener.cmd, [...opener.args, url]];
  try {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', () => {
      /* no opener on this system: the URL is in the tool result anyway */
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/**
 * Windows agents (Codex, for one) run tools inside a job object that kills
 * every child process when the agent exits, detached or not, so a normally
 * spawned server dies with the session. Win32_Process.Create (through CIM)
 * starts the server as a child of the WMI service instead: outside the job,
 * with no console window. The new process inherits no environment, so the
 * Overlook home and port go on its command line.
 */
function startOutsideJob(entry: string, port: number): Promise<void> {
  const q = (s: string) => `"${s.replaceAll('"', '')}"`;
  const commandLine = [q(process.execPath), q(entry), 'serve', '--quiet', '--port', String(port), '--home', q(overlookHome())].join(' ');
  const ps = [
    '$si = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ ShowWindow = [uint16]0 };',
    `$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = '${commandLine.replaceAll("'", "''")}'; ProcessStartupInformation = $si };`,
    'exit $r.ReturnValue',
  ].join(' ');
  // Not detached: a detached PowerShell has no console and exits at once
  // without running the command. It lives only long enough to ask WMI; the
  // server it starts belongs to WMI, not to this process or its job.
  // Resolves when PowerShell is done (or after 8 s), so no child handle is
  // left open if the caller exits right after.
  return new Promise((resolve) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps], { stdio: 'ignore', windowsHide: true });
    const timer = setTimeout(() => {
      child.unref();
      resolve();
    }, 8_000);
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    child.on('exit', done);
    child.on('error', done); // no PowerShell: ensureServer falls back to serving in-process
  });
}
