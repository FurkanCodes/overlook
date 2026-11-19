/**
 * Release metadata: the npm package, the MCP Registry entry and the Claude
 * Code plugin must name the same version and server, or a publish ships a
 * plugin that starts an older server (or the registry rejects the entry).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..');
const json = (p: string) => JSON.parse(readFileSync(join(root, p), 'utf8'));

describe('release metadata', () => {
  const pkg = json('package.json');
  const server = json('server.json');
  const plugin = json('plugin/.claude-plugin/plugin.json');
  const market = json('.claude-plugin/marketplace.json');
  const launcher = readFileSync(join(root, 'plugin', 'launch.mjs'), 'utf8');

  it('uses one version everywhere', () => {
    expect(server.version).toBe(pkg.version);
    expect(server.packages[0].version).toBe(pkg.version);
    expect(plugin.version).toBe(pkg.version);
    expect(launcher).toContain(`const VERSION = '${pkg.version}';`);
  });

  it('names the same server and package in the registry entry and package.json', () => {
    expect(server.name).toBe(pkg.mcpName);
    expect(server.packages[0].identifier).toBe(pkg.name);
    expect(server.packages[0].packageArguments).toEqual([{ type: 'positional', value: 'mcp' }]);
    expect(server.name).toMatch(/^io\.github\.[A-Za-z0-9-]+\/[a-zA-Z0-9._-]+$/);
    expect(server.description.length).toBeLessThanOrEqual(100);
  });

  it('points the marketplace at the plugin folder, with a matching name', () => {
    expect(market.plugins).toHaveLength(1);
    expect(market.plugins[0]).toMatchObject({ name: plugin.name, source: './plugin' });
    const mcp = json('plugin/.mcp.json');
    expect(mcp.mcpServers.overlook.args).toEqual(['${CLAUDE_PLUGIN_ROOT}/launch.mjs']);
  });

  it('keeps the plugin and registry files out of the npm package', () => {
    expect(pkg.files).not.toContain('plugin');
    expect(pkg.files).not.toContain('server.json');
  });
});
