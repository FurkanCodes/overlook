#!/usr/bin/env node
/**
 * Starts Overlook's MCP server for the Claude Code plugin.
 *
 * The server itself is the npm package overlook-dash, pinned to the version
 * this plugin was released with. A plugin cannot run `npx` directly on
 * Windows (it is a .cmd file there), so this launcher starts it the right
 * way on each platform and passes stdio straight through.
 *
 * OVERLOOK_CLI_PATH, if set, runs a local build instead (for development).
 */
import { spawn } from 'node:child_process';

const VERSION = '0.1.0';
const dev = process.env.OVERLOOK_CLI_PATH;

const child = dev
  ? spawn(process.execPath, [dev, 'mcp'], { stdio: 'inherit' })
  : process.platform === 'win32'
    ? spawn(`npx -y overlook-dash@${VERSION} mcp`, { stdio: 'inherit', shell: true, windowsHide: true })
    : spawn('npx', ['-y', `overlook-dash@${VERSION}`, 'mcp'], { stdio: 'inherit' });

child.on('error', (e) => {
  process.stderr.write(`overlook: could not start the MCP server (${e.message}). Overlook needs Node.js 22 or later with npx on PATH.\n`);
  process.exit(1);
});
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => child.kill(s));
