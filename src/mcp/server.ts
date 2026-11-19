/**
 * `overlook mcp`: the MCP server over stdio. It answers `initialize` at once;
 * DuckDB opens lazily on the first tool call.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { EngineHolder } from '../engine/engine.js';
import { log } from '../log.js';
import { VERSION } from '../version.js';
import { TOOL_SPECS, checkStage, createTools, takeLastCheck, type ToolName, type ToolText } from './tools.js';

const INSTRUCTIONS = `Overlook builds live dashboards from the user's local data and opens them in the browser at a local address.
- The user just asks for a dashboard ("use overlook to make a dashboard of my data"): call auto_dashboard. One call finds the data, builds a checked dashboard, saves it and opens it. Then give the user the URL.
- The user says what to show: describe_data → preview_query → save_dashboard (fix the numbered errors it returns and save again) → give the user the URL. Read get_spec_reference once before writing your first spec.
- describe_data also lists data files and database URLs in this project that are not added yet; add the ones the user means with add_source.
- To change a dashboard: get_dashboard, edit the spec keeping panel ids stable, save_dashboard with the same name. An open page updates by itself.`;

/** A ready-made prompt, shown as a slash command by harnesses that list MCP prompts. */
const DASHBOARD_PROMPT = (what?: string) =>
  what && what.trim()
    ? `Use Overlook to build a dashboard that shows: ${what.trim()}. Call describe_data, write the spec (get_spec_reference has the format), check queries with preview_query, save with save_dashboard, fix any errors it lists, and give me the URL.`
    : 'Use Overlook to make a dashboard of the data in this project: call auto_dashboard, then give me the URL and a one-line summary of what it shows.';

/** Run a tool, turn its result into MCP content, and log the call. */
async function call(name: ToolName, fn: () => Promise<ToolText>) {
  const started = Date.now();
  let r: ToolText;
  try {
    r = await fn();
  } catch (e) {
    log.error(`tool ${name} failed: ${(e as Error)?.stack ?? String(e)}`);
    r = { text: `Overlook error: ${(e as Error)?.message ?? String(e)}`, isError: true };
  }
  const check = name === 'save_dashboard' || name === 'auto_dashboard' ? takeLastCheck() : undefined;
  log.event({
    tool: name,
    ok: !r.isError,
    ms: Date.now() - started,
    ...(check ? { stage: checkStage(check), errors: check.errors.length, repairs: check.repairs.length } : {}),
  });
  return { content: [{ type: 'text' as const, text: r.text }], ...(r.isError ? { isError: true } : {}) };
}

export function buildMcpServer(engines = new EngineHolder()): McpServer {
  const tools = createTools(engines);
  const server = new McpServer({ name: 'overlook', version: VERSION }, { instructions: INSTRUCTIONS });
  for (const name of Object.keys(TOOL_SPECS) as ToolName[]) {
    const spec = TOOL_SPECS[name];
    const handler = tools[name] as (args: unknown) => Promise<ToolText>;
    server.registerTool(
      name,
      { title: spec.title, description: spec.description, inputSchema: spec.input, annotations: { readOnlyHint: spec.readOnly } },
      (args: unknown) => call(name, () => handler(args ?? {})),
    );
  }
  server.registerPrompt(
    'dashboard',
    {
      title: 'Make a dashboard',
      description: 'Build a live dashboard from the data in this project and open it in the browser',
      argsSchema: { what: z.string().optional().describe('what to show, e.g. "monthly revenue by region"; leave empty for an automatic overview') },
    },
    ({ what }) => ({ messages: [{ role: 'user', content: { type: 'text', text: DASHBOARD_PROMPT(what) } }] }),
  );
  return server;
}

export async function mcpCommand(): Promise<void> {
  const engines = new EngineHolder();
  const server = buildMcpServer(engines);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log.info(`Overlook MCP server ${VERSION} ready on stdio`);
  const shutdown = () => {
    engines.close();
    process.exit(0);
  };
  process.stdin.on('end', shutdown);
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
