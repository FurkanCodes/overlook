# Overlook

Live dashboards that any MCP coding agent can build from your local data, with
any model.

You ask your agent for a dashboard. The agent's model writes a small JSON spec:
a title, optional filters, and panels, each holding one SQL query and the
columns to chart. Before anything is saved, Overlook:

*   checks the spec against the schema;
*   runs every query against your data with DuckDB;
*   checks that each chart's columns exist and have the right type;
*   if anything is wrong, sends the model a short numbered list of fixes.

The dashboard then opens in your browser at `http://127.0.0.1:4777`. Its
queries re-run each time you open the page, and every number shows the SQL that
produced it.

*   **Any agent:**
    *   `overlook setup` configures Claude Code, Claude Desktop, Codex,
        Cursor, Windsurf, Gemini CLI, VS Code, OpenCode, Cline and Zed.
    *   Any other MCP client works over stdio.
    *   Agents without MCP can run `overlook auto`.
*   **Any model:**
    *   "Make a dashboard of my data" is one tool call with no arguments
        (`auto_dashboard`).
    *   For anything more specific, the model writes a compact spec, not HTML.
        The spec reference is about 2,000 tokens, sized for mid-size local
        models.
*   **Any data:**
    *   CSV, Parquet, JSON, SQLite, DuckDB, Postgres and MySQL.
    *   In a project, the agent finds the data itself.
*   **Local:**
    *   Your files are read in place by a locked-down DuckDB: read-only, with no
        network and no access to other files.
    *   Overlook uploads nothing. Your model sees only what the tools return to
        it.

## Quick start

Requires Node 22 or later. Add Overlook to every agent on this machine:

```bash
npx overlook-dash setup
```

Or, in Claude Code, install it as a plugin. The plugin adds the MCP server and a
`/overlook:dashboard` skill:

```text
/plugin install overlook --marketplace furkancodes/overlook
```

Use one or the other in Claude Code, not both, or the tools appear twice. The
MCP server is also listed in the [MCP Registry](https://registry.modelcontextprotocol.io)
as `io.github.furkancodes/overlook`, which clients that browse the registry
can install from.

Restart your agent, then in any project just say:

> use overlook to make a dashboard of my data

The agent calls `auto_dashboard`. That one call:

1.  finds the project's data;
2.  builds a dashboard of KPIs with trends, a trend chart, breakdowns and a
    summary table;
3.  checks every query;
4.  opens the dashboard in your browser at `http://127.0.0.1:4777`.

It works even with small models. Ask for something specific (*"monthly
revenue by region"*) and the agent writes the spec itself instead.

**Supported harnesses.** `setup` writes the Overlook entry into each
harness's own MCP config. It backs the file up first, keeps the other
entries, and never replaces an existing `overlook` entry unless you pass
`--force`.

| Harness | `overlook setup …` | Where it writes |
| :--- | :--- | :--- |
| Claude Code | `claude` | runs `claude mcp add --scope user` |
| Claude Desktop | `claude-desktop` | `claude_desktop_config.json` |
| Codex CLI | `codex` | `~/.codex/config.toml` |
| Cursor | `cursor` | `~/.cursor/mcp.json` (`--project`: `.cursor/mcp.json`) |
| Windsurf | `windsurf` | `~/.codeium/windsurf/mcp_config.json` |
| Gemini CLI | `gemini` | `~/.gemini/settings.json` (`--project`: `.gemini/settings.json`) |
| VS Code (Copilot agent) | `vscode --project` | `.vscode/mcp.json` |
| OpenCode | `opencode` | `~/.config/opencode/opencode.json` |
| Cline | `cline` | `cline_mcp_settings.json` |
| Zed | `zed` | `settings.json` (`context_servers`) |

**Other setups:**

*   **Other MCP clients:** start `npx -y overlook-dash@0.1.0 mcp` over stdio.
    `overlook setup --print` shows the exact entry for each harness.
*   **Config files with comments:** `setup` prints the entry for you to paste
    and leaves the file unchanged.
*   **Harnesses that have a shell but no MCP** (Aider, plain scripts, CI): run
    this from the project.

    ```bash
    npx overlook-dash auto
    ```

    It does the same thing: finds the data, builds the dashboard, prints its
    URL and opens it. Pass a file (`overlook auto exports/sales.parquet`) to
    choose the data.

**The browser:**

*   **When it opens:** a new dashboard opens on its first save. Later saves
    update the open page by themselves, so no second tab opens.
*   **When it doesn't:** nothing opens with `OVERLOOK_OPEN=0`, in CI, over SSH,
    or on Linux with no display. The agent still gets the URL to pass on.

**Approval prompts:** Codex and others ask before the tools that write
(`auto_dashboard`, `save_dashboard`, `add_source`). The read-only tools run
without asking. To skip Codex's prompt for one of them, add
`tools.auto_dashboard.approval_mode = "approve"` under
`[mcp_servers.overlook]`.

**The web server:** it outlives the agent. On Windows it is started through
WMI, so the dashboard links keep working after Codex or any other sandboxed
agent exits. If a sandbox blocks even that, Overlook serves from inside the
session and says so.

Data outside a project can be added by hand:

```bash
npx overlook-dash source add sales ~/Downloads/sales.csv
```

## Data sources

**In a project, there is nothing to set up.** Your agent starts Overlook in
the project folder. There, `describe_data` lists:

*   the data files it finds, skipping `node_modules`, build folders and hidden
    folders;
*   the database URLs named in the project's `.env` files, by variable name
    only.

Your agent then registers what you mean with `add_source`. It can add only
paths inside that project folder. Most agents ask you before each
`add_source` call. Set `OVERLOOK_AGENT_SOURCES=0` to turn the tool off.

You can also add sources yourself:

| Source | Add with | Query as |
| --- | --- | --- |
| CSV, TSV, Parquet, JSON(L), or a glob of them | `overlook source add orders ./data/*.parquet` | `FROM orders` |
| SQLite | `overlook source add shop ./shop.db` | `FROM shop.orders` |
| DuckDB | `overlook source add wh ./warehouse.duckdb` | `FROM wh.orders` |
| Postgres (experimental) | `overlook source add app --env DATABASE_URL` | `FROM app.orders` |
| MySQL / MariaDB (experimental) | `overlook source add shop mysql://ro@db/shop` | `FROM shop.orders` |

**Databases (experimental in 0.1).** Postgres and MySQL go through DuckDB's
own scanners. The URL handling is tested, but no live server has been tested
yet, so please report what you find.

*   **Attachment:** databases are attached read-only.
*   **`--env`:** Overlook keeps only the variable's name. It reads the URL from
    `.env` (or `--env-file`) each time it opens the source, so the password
    stays where it already was.
*   **URL clean-up:** ORM-style URLs work as they are. Overlook drops the driver
    suffix (`postgresql+asyncpg://`) and Prisma's `?schema=` before connecting.
*   **Database user:** use one that can only read.

**Network access:** SQLite, Postgres and MySQL sources each download a DuckDB
extension once, from extensions.duckdb.org. Apart from that download, and the
database connections you configure, Overlook never uses the network.

## What the agent gets

| Tool | What it does |
| :--- | :--- |
| `auto_dashboard` | Builds, checks, saves and opens a dashboard from the data in one call |
| `describe_data` | Sources, tables, columns, types, row counts, and sample rows; data in the project not added yet |
| `add_source` | Registers a data file or a `.env` database inside the project |
| `preview_query` | Runs one SELECT and returns the first 20 rows |
| `save_dashboard` | Checks the spec and runs its queries, then saves it or returns numbered fixes |
| `get_dashboard` | The spec, plus each panel's current status |
| `list_dashboards` | Saved dashboards and their URLs |
| `get_spec_reference` | The spec format and a full example |

## The spec

```json
{
  "version": 1,
  "title": "Revenue",
  "filters": [{ "id": "region", "label": "Region", "type": "select", "source": "sales",
                "options_sql": "SELECT DISTINCT region FROM sales ORDER BY 1" }],
  "panels": [
    { "id": "by_month", "type": "line", "title": "Revenue by month", "source": "sales",
      "sql": "SELECT date_trunc('month', order_date) AS month, sum(amount) AS revenue FROM sales WHERE ($region IS NULL OR region = $region) GROUP BY 1 ORDER BY 1",
      "x": "month", "y": "revenue", "format": "currency" }
  ]
}
```

*   **Panel types:** `kpi`, `bar`, `line`, `area`, `scatter`, `table` and
    `text`.
*   **Table formats:** `"formats": {"revenue": "currency"}` formats one column
    of a table; `format` covers the rest.
*   **KPI trend:** a `kpi` with `x` (for example a month column) shows the
    latest period, its change from the one before, and a sparkline.
*   **Filters:** each filter is bound to the SQL as a named `$parameter`. A
    filter with no value is `NULL`. Filter values are never pasted into the SQL
    text.
*   **Full reference:** [src/spec/reference.ts](src/spec/reference.ts).
*   **Example dashboard:** [examples/revenue-overview.json](examples/revenue-overview.json).

## Security model

*   **DuckDB lockdown.** Each process opens an in-memory DuckDB, attaches only
    your registered sources (read-only), turns off external access and extension
    loading, and locks the configuration.
*   **Project boundary.** The model can register only files inside the project
    folder its agent runs in. Overlook refuses paths outside it, including
    `../` paths, symlinks out of the folder, and globs that climb out. It does
    not scan when the folder is your home folder or a drive root.
*   **One SELECT per query.** Every query must be a single SELECT, and runs with
    a 5,000-row cap and a 15-second timeout.
*   **Locked-down web server.** It:
    *   listens only on `127.0.0.1`;
    *   checks the `Host` header;
    *   sends no CORS headers;
    *   requires a JSON body on every POST;
    *   sends a strict Content Security Policy;
    *   runs only the SQL stored in a saved dashboard.
*   **Data you control.** The model sees what the tools return to it: schemas,
    sample rows (turn them off with `OVERLOOK_SAMPLES=0`), and preview rows. If
    your agent uses a hosted model, that is what reaches the provider.

The attack suite in [test/security.test.ts](test/security.test.ts) must pass on
every DuckDB upgrade.

## Commands

```text
overlook setup [harness…]         add Overlook to your agents (--project, --print, --force)
overlook auto [file]              build a dashboard from the data and open it
overlook mcp                      MCP server for your agent (stdio)
overlook serve [--port N]         dashboard web server (started automatically on save)
overlook source add|list|remove   manage data sources
overlook validate <spec.json>     check a spec file
overlook open <name>              open a dashboard
overlook stop                     stop the web server
overlook doctor [--install]       check setup
```

Files live in `~/.overlook`. Set `OVERLOOK_HOME` to move them, and
`OVERLOOK_PORT` (or `"port"` in `config.json`) to change the port.

## Development

```bash
npm install
```

```bash
npm test
```

```bash
node scripts/make-examples.mjs
```

```bash
node scripts/demo.mjs
```

`npm test` builds the project, then runs the unit, security, server and stdio
end-to-end tests. `node scripts/bench.mjs` times start-up, a 1M-row query and
an 8-panel save check against the design's targets. `scripts/demo.mjs` saves the example dashboard into `./.demo`.
To serve it, run `OVERLOOK_HOME=.demo node dist/src/cli.js serve`.

**The eval** scores how well a model uses Overlook, against any
OpenAI-compatible endpoint:

```bash
OVERLOOK_EVAL_MODEL=qwen3-coder:30b npm run eval
```

Pass `--dry` to check the prompts themselves without a model.

The design, its reviews and its rejected alternatives are in
[docs/designs/overlook.md](docs/designs/overlook.md).

## The page

*   **Look:** Inter type, Lucide icons, light and dark themes, a validated
    color-blind-safe chart palette, and layouts that work down to phone width.
*   **Motion:** cards rise in and bars and lines animate in when data arrives,
    off under reduced-motion.
*   **Interaction:**
    *   every chart has hover tooltips;
    *   each panel's ⋯ menu shows the chart as a table, the source SQL, CSV
        copy and download, and a re-run;
    *   R refreshes and T switches theme.

Everything is served from `127.0.0.1`; no CDN is ever contacted.

## License

MIT. Bundled third-party components are listed in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Overlook is an independent project and is not affiliated with Anthropic or
any model provider.
