/**
 * `overlook setup`: add Overlook to the MCP config of the agents on this
 * machine, so "use overlook to make a dashboard" works in each of them.
 *
 * Each harness keeps MCP servers in its own file and shape. setup writes
 * only the "overlook" entry: other entries and keys are kept, an existing
 * "overlook" entry is left alone unless --force, the file is backed up first,
 * and a file it cannot parse safely (JSON with comments) is not touched; the
 * snippet to paste is printed instead.
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { writeFileAtomic } from './config.js';
import { PACKAGE_ROOT, VERSION } from './version.js';

export interface Launch {
  command: string;
  args: string[];
}

/**
 * How a harness should start Overlook. From a stable install (global or a
 * checkout) that is this Node and this cli.js; from an npx cache, which can be
 * cleaned at any time, it is npx itself (through cmd on Windows, where npx is
 * a .cmd file that clients cannot spawn directly).
 */
export function launchCommand(): Launch {
  const cli = join(PACKAGE_ROOT, 'dist', 'src', 'cli.js');
  const ephemeral = /[\\/]_npx[\\/]/.test(PACKAGE_ROOT) || !existsSync(cli);
  if (!ephemeral) return { command: process.execPath, args: [cli, 'mcp'] };
  const npx = ['-y', `overlook-dash@${VERSION}`, 'mcp'];
  return process.platform === 'win32' ? { command: 'cmd', args: ['/c', 'npx', ...npx] } : { command: 'npx', args: npx };
}

type Shape = 'mcpServers' | 'vscode' | 'opencode' | 'zed';

interface Target {
  id: string;
  label: string;
  /** Config file, or null when this harness is configured by its own command. */
  file: (project: boolean) => string | null;
  shape: Shape | 'toml' | 'claude-cli';
  /** Whether the harness looks installed. */
  present: () => boolean;
  /** Only a project file exists for this harness. */
  projectOnly?: boolean;
  userOnly?: boolean;
}

const home = homedir();
const appData = process.env.APPDATA ?? join(home, 'AppData', 'Roaming');
const configHome = process.env.XDG_CONFIG_HOME ?? join(home, '.config');
const appSupport = process.platform === 'win32' ? appData : process.platform === 'darwin' ? join(home, 'Library', 'Application Support') : configHome;

function onPath(cmd: string): boolean {
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [cmd], { stdio: 'ignore', shell: false });
  return r.status === 0;
}

export const TARGETS: Target[] = [
  { id: 'claude', label: 'Claude Code', file: () => null, shape: 'claude-cli', present: () => onPath('claude') || existsSync(join(home, '.claude')) },
  { id: 'claude-desktop', label: 'Claude Desktop', file: () => join(appSupport, 'Claude', 'claude_desktop_config.json'), shape: 'mcpServers', present: () => existsSync(join(appSupport, 'Claude')), userOnly: true },
  { id: 'codex', label: 'Codex CLI', file: () => join(process.env.CODEX_HOME ?? join(home, '.codex'), 'config.toml'), shape: 'toml', present: () => existsSync(process.env.CODEX_HOME ?? join(home, '.codex')) || onPath('codex'), userOnly: true },
  { id: 'cursor', label: 'Cursor', file: (p) => (p ? join(process.cwd(), '.cursor', 'mcp.json') : join(home, '.cursor', 'mcp.json')), shape: 'mcpServers', present: () => existsSync(join(home, '.cursor')) },
  { id: 'windsurf', label: 'Windsurf', file: () => join(home, '.codeium', 'windsurf', 'mcp_config.json'), shape: 'mcpServers', present: () => existsSync(join(home, '.codeium', 'windsurf')), userOnly: true },
  { id: 'gemini', label: 'Gemini CLI', file: (p) => (p ? join(process.cwd(), '.gemini', 'settings.json') : join(home, '.gemini', 'settings.json')), shape: 'mcpServers', present: () => existsSync(join(home, '.gemini')) || onPath('gemini') },
  { id: 'vscode', label: 'VS Code (Copilot agent)', file: () => join(process.cwd(), '.vscode', 'mcp.json'), shape: 'vscode', present: () => existsSync(join(process.cwd(), '.vscode')), projectOnly: true },
  { id: 'opencode', label: 'OpenCode', file: (p) => (p ? join(process.cwd(), 'opencode.json') : join(configHome, 'opencode', 'opencode.json')), shape: 'opencode', present: () => existsSync(join(configHome, 'opencode')) || onPath('opencode') },
  {
    id: 'cline',
    label: 'Cline',
    file: () => join(appSupport, 'Code', 'User', 'globalStorage', 'saoudrizwan.claude-dev', 'settings', 'cline_mcp_settings.json'),
    shape: 'mcpServers',
    present: () => existsSync(join(appSupport, 'Code', 'User', 'globalStorage', 'saoudrizwan.claude-dev')),
    userOnly: true,
  },
  { id: 'zed', label: 'Zed', file: () => (process.platform === 'win32' ? join(appData, 'Zed', 'settings.json') : join(configHome, 'zed', 'settings.json')), shape: 'zed', present: () => existsSync(process.platform === 'win32' ? join(appData, 'Zed') : join(configHome, 'zed')), userOnly: true },
];

/** The entry to add, in a harness's shape. */
export function entryFor(shape: Shape, l: Launch): unknown {
  switch (shape) {
    case 'mcpServers':
      return { command: l.command, args: l.args };
    case 'vscode':
      return { type: 'stdio', command: l.command, args: l.args };
    case 'opencode':
      return { type: 'local', command: [l.command, ...l.args], enabled: true };
    case 'zed':
      return { command: l.command, args: l.args };
  }
}

const KEY: Record<Shape, string> = { mcpServers: 'mcpServers', vscode: 'servers', opencode: 'mcp', zed: 'context_servers' };

/**
 * Add the entry to a JSON config's text. Returns the new text, 'exists' when
 * an entry is already there (and not forced), or 'unparseable'.
 */
export function mergeJson(text: string | null, shape: Shape, l: Launch, force = false): string | 'exists' | 'unparseable' {
  let doc: Record<string, unknown> = {};
  if (text !== null && text.trim() !== '') {
    try {
      const parsed = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return 'unparseable';
      doc = parsed as Record<string, unknown>;
    } catch {
      return 'unparseable';
    }
  }
  const key = KEY[shape];
  const servers = (doc[key] && typeof doc[key] === 'object' ? doc[key] : {}) as Record<string, unknown>;
  if (servers.overlook && !force) return 'exists';
  doc[key] = { ...servers, overlook: entryFor(shape, l) };
  return JSON.stringify(doc, null, 2) + '\n';
}

/** A TOML literal string (no escapes: Windows paths stay as they are). */
function tomlStr(s: string): string {
  return s.includes("'") ? JSON.stringify(s) : `'${s}'`;
}

export function mergeToml(text: string | null, l: Launch, force = false): string | 'exists' {
  const block = `[mcp_servers.overlook]\ncommand = ${tomlStr(l.command)}\nargs = [${l.args.map(tomlStr).join(', ')}]\nstartup_timeout_sec = 20\n`;
  const current = text ?? '';
  const re = /^\[mcp_servers\.overlook\][^\n]*\n(?:(?!\[)[^\n]*\n?)*/m;
  if (re.test(current)) {
    if (!force) return 'exists';
    return current.replace(re, block + '\n');
  }
  return (current && !current.endsWith('\n') ? current + '\n' : current) + (current ? '\n' : '') + block;
}

function snippet(t: Target, l: Launch): string {
  if (t.shape === 'claude-cli') return `claude mcp add --scope user overlook -- ${[l.command, ...l.args].map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ')}`;
  if (t.shape === 'toml') return mergeToml(null, l) as string;
  return JSON.stringify({ [KEY[t.shape]]: { overlook: entryFor(t.shape, l) } }, null, 2);
}

/**
 * Run the claude CLI. On Windows it is a .cmd shim, which only runs through
 * the shell: build one quoted command line there rather than passing an
 * argument list with shell: true (unescaped, and deprecated in Node).
 */
function claude(args: string[]) {
  if (process.platform !== 'win32') return spawnSync('claude', args, { encoding: 'utf8' });
  const line = ['claude', ...args.map((a) => (/[\s&()^|<>"]/.test(a) ? `"${a.replaceAll('"', '')}"` : a))].join(' ');
  return spawnSync(line, { encoding: 'utf8', shell: true });
}

export async function setupCommand(args: string[], out: (s: string) => void, fail: (s: string) => never): Promise<void> {
  const take = (f: string) => {
    const i = args.indexOf(f);
    if (i === -1) return false;
    args.splice(i, 1);
    return true;
  };
  const project = take('--project');
  const force = take('--force');
  const print = take('--print');
  const all = take('--all');
  const l = launchCommand();
  const unknown = args.filter((a) => !TARGETS.some((t) => t.id === a));
  if (unknown.length) fail(`unknown harness: ${unknown.join(', ')}. Known: ${TARGETS.map((t) => t.id).join(', ')}`);
  let targets = args.length ? TARGETS.filter((t) => args.includes(t.id)) : TARGETS.filter((t) => all || t.present());
  if (project) targets = targets.filter((t) => !t.userOnly);
  else if (!args.length) targets = targets.filter((t) => !t.projectOnly);
  if (targets.length === 0) {
    out('No supported agent found on this machine. Name one: overlook setup codex (or claude, cursor, windsurf, gemini, vscode, opencode, cline, zed).');
    out(`\nAny other MCP client: run "${[l.command, ...l.args].join(' ')}" over stdio.`);
    out('Agents without MCP can run: npx overlook-dash auto');
    return;
  }

  out(`Overlook starts as: ${[l.command, ...l.args].join(' ')}\n`);
  for (const t of targets) {
    if (print) {
      out(`## ${t.label}\n${snippet(t, l)}\n`);
      continue;
    }
    if (t.shape === 'claude-cli') {
      if (!onPath('claude')) {
        out(`- ${t.label}: the "claude" command is not on PATH. Run:\n    ${snippet(t, l)}`);
        continue;
      }
      const scope = project ? 'project' : 'user';
      const exists = claude(['mcp', 'get', 'overlook']);
      if (exists.status === 0 && !force) {
        out(`- ${t.label}: already set up.`);
        continue;
      }
      if (exists.status === 0) claude(['mcp', 'remove', 'overlook', '-s', scope]);
      const r = claude(['mcp', 'add', '--scope', scope, 'overlook', '--', l.command, ...l.args]);
      out(r.status === 0 ? `- ${t.label}: added (${scope} scope).` : `- ${t.label}: "claude mcp add" failed: ${(r.stderr || r.stdout).trim()}\n    Run it yourself: ${snippet(t, l)}`);
      continue;
    }
    const file = t.file(project);
    if (!file) continue;
    const text = existsSync(file) ? readFileSync(file, 'utf8') : null;
    const next = t.shape === 'toml' ? mergeToml(text, l, force) : mergeJson(text, t.shape, l, force);
    if (next === 'exists') {
      out(`- ${t.label}: already set up in ${file} (use --force to replace it).`);
      continue;
    }
    if (next === 'unparseable') {
      out(`- ${t.label}: ${file} has comments or is not plain JSON, so it was not changed. Add this yourself:\n${snippet(t, l).replace(/^/gm, '    ')}`);
      continue;
    }
    if (text !== null) copyFileSync(file, `${file}.bak-overlook`);
    writeFileAtomic(file, next);
    out(`- ${t.label}: added to ${file}${text !== null ? ` (backup: ${file}.bak-overlook)` : ''}.`);
  }
  out('\nRestart the agents, then ask one: "use overlook to make a dashboard of my data".');
  out('Agents without MCP support can run: npx overlook-dash auto');
}
