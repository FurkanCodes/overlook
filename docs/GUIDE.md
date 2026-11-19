# Overlook guide

The full reference behind the [README](../README.md): how Overlook works,
setting it up in each agent, data sources, the tools, the dashboard spec and
the security model.

*   [How it works](#how-it-works)
*   [Setting up each agent](#setting-up-each-agent)
*   [Data sources](#data-sources)
*   [The tools your agent gets](#the-tools-your-agent-gets)
*   [The dashboard spec](#the-dashboard-spec)
*   [The dashboard page](#the-dashboard-page)
*   [Security model](#security-model)
*   [Commands and settings](#commands-and-settings)
*   [Development](#development)

## How it works

There are two ways a dashboard gets made.

**When you just ask for a dashboard** ("make a dashboard of my data"), the agent
calls `auto_dashboard`. That one call:

1.  finds the project's data;
2.  profiles it to pick a date column, the measures and the breakdowns;
3.  builds a dashboard of KPIs with trends, a trend chart, breakdowns and a
    summary table;
4.  runs every query and leaves out any panel that fails;
5.  saves the dashboard and opens it in your browser.

Small models handle this too, because it is a single call with no arguments.

**When you say what to show** ("monthly revenue by region"), the agent's model
writes a small JSON spec. The spec has a title, optional filters, and panels,
each holding one SQL query and the columns to chart. Before anything is saved,
Overlook:

*   checks the spec against the schema;
*   runs every query against your data with DuckDB;
*   checks that each chart's columns exist and have the right type;
*   if anything is wrong, sends the model a short numbered list of fixes.

**Every dashboard:**

*   is served at `http://127.0.0.1:4777`;
*   re-runs its queries each time you open the page;
*   shows the SQL behind every number.

## Setting up each agent

`overlook setup` writes the Overlook entry into each agent's own MCP config:

*   **Backup:** it backs the file up first, as `<file>.bak-overlook`.
*   **Other entries:** it keeps every other entry in the file.
*   **Existing entry:** it never replaces an existing `overlook` entry unless
    you pass `--force`.
*   **Files with comments:** it leaves the file unchanged and prints the entry
    for you to paste.

With no arguments it sets up every agent it finds. Name one or more agents to
set up only those (`overlook setup cursor codex`).

| Agent | `overlook setup …` | Where it writes |
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

`overlook setup --print` prints each entry instead of writing it.

**Claude Code plugin.** Instead of `setup`, Claude Code users can install the
plugin:

```text
/plugin install overlook --marketplace furkancodes/overlook
```

It adds the MCP server and a `/overlook:dashboard` skill. Use either the plugin
or `setup` in Claude Code, not both, or the tools appear twice.

**Any other MCP client.** Run the server over stdio with
`npx -y overlook-dash mcp`. It is also listed in the
[MCP Registry](https://registry.modelcontextprotocol.io) as
`io.github.furkancodes/overlook`.

**Agents without MCP** (Aider, scripts, CI): run this from the project.

```bash
npx overlook-dash auto
```

It does the same as `auto_dashboard`: it finds the data, builds the dashboard,
prints its URL and opens it. Pass a file to choose the data
(`overlook auto exports/sales.parquet`).

**Approval prompts.** Codex and most other agents ask before running the tools
that write (`auto_dashboard`, `save_dashboard`, `add_source`). The read-only
tools run without asking. To skip Codex's prompt for one tool, add
`tools.auto_dashboard.approval_mode = "approve"` under `[mcp_servers.overlook]`.

**The browser:**

*   **When it opens:** a new dashboard opens on its first save. Later saves
    update the open page by themselves, so no second tab opens.
*   **When it doesn't open:** nothing opens with `OVERLOOK_OPEN=0`, in CI, over
    SSH, or on a Linux machine with no display. The agent still gets the URL
    to give you.
*   **Under WSL:** the dashboard opens in the Windows browser.

**The web server outlives your agent:**

*   **On Windows:** it is started through WMI, so dashboard links keep working
    after Codex or another sandboxed agent exits.
*   **If a sandbox blocks that too:** Overlook serves from inside the session
    and says so. Run `overlook serve` to keep the page up.

## Data sources

**In a project, there is nothing to set up.** Your agent starts Overlook in the
project folder, and `describe_data` lists what is there:

*   the data files it finds, skipping `node_modules`, build folders and hidden
    folders;
*   the database URLs named in the project's `.env` files, listed by variable
    name only.

Your agent then registers what you mean with `add_source`:

*   **Project only:** it can add only paths inside the project folder.
*   **Approval:** most agents ask you before each `add_source` call.
*   **Off switch:** set `OVERLOOK_AGENT_SOURCES=0` to turn the tool off.

You can also add sources yourself:

| Source | Add with | Query as |
| :--- | :--- | :--- |
| CSV, TSV, Parquet, JSON(L), or a glob of them | `overlook source add orders ./data/*.parquet` | `FROM orders` |
| SQLite | `overlook source add shop ./shop.db` | `FROM shop.orders` |
| DuckDB | `overlook source add wh ./warehouse.duckdb` | `FROM wh.orders` |
| Postgres (experimental) | `overlook source add app --env DATABASE_URL` | `FROM app.orders` |
| MySQL / MariaDB (experimental) | `overlook source add shop mysql://ro@db/shop` | `FROM shop.orders` |

**Databases (experimental in 0.1).** Postgres and MySQL go through DuckDB's own
scanners. The URL handling is tested, but no live server has been tested yet,
so please report what you find.

*   **Attachment:** databases are attached read-only.
*   **`--env`:** Overlook keeps only the variable's name. It reads the URL from
    `.env` (or `--env-file`) each time it opens the source, so the password
    stays where it already was.
*   **URL clean-up:** ORM-style URLs work as they are. Overlook drops the driver
    suffix (`postgresql+asyncpg://`) and Prisma's `?schema=` before connecting.
*   **Database user:** use one that can only read.

**Network access:** SQLite, Postgres and MySQL sources each download a DuckDB
extension once, from extensions.duckdb.org. Apart from that download and the
database connections you configure, Overlook never uses the network.

## The tools your agent gets

| Tool | What it does |
| :--- | :--- |
| `auto_dashboard` | Builds, checks, saves and opens a dashboard from the data in one call |
| `describe_data` | Sources, tables, columns, types, row counts and sample rows, plus project data not added yet |
| `add_source` | Registers a data file or a `.env` database inside the project |
| `preview_query` | Runs one SELECT and returns the first 20 rows |
| `save_dashboard` | Checks the spec and runs its queries, then saves it or returns numbered fixes |
| `get_dashboard` | The spec, plus each panel's current status |
| `list_dashboards` | Saved dashboards and their URLs |
| `get_spec_reference` | The spec format and a full example |

Overlook also offers a `dashboard` MCP prompt, which agents that list MCP
prompts show as a slash command.

## The dashboard spec

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
*   **KPI trend:** a `kpi` with `x` (for example a month column) shows the
    latest period, its change from the one before, and a sparkline.
*   **Table formats:** `"formats": {"revenue": "currency"}` formats one column
    of a table, and `format` covers the rest.
*   **Filters:** each filter is bound to the SQL as a named `$parameter`. A
    filter with no value is `NULL`. Filter values are never pasted into the SQL
    text.
*   **Full reference:** [src/spec/reference.ts](../src/spec/reference.ts).
*   **Example dashboard:** [examples/revenue-overview.json](../examples/revenue-overview.json).

## The dashboard page

*   **Look:** Inter type, Lucide icons, light and dark themes, a validated
    color-blind-safe chart palette, and layouts that work down to phone width.
*   **Motion:** cards rise in, and bars and lines animate in when data
    arrives. Motion is off under reduced-motion.
*   **Interaction:**
    *   Every chart has hover tooltips.
    *   Clicking a legend item highlights that series.
    *   Each panel's ⋯ menu shows the chart as a table or shows the source SQL,
        and copies or downloads CSV.
    *   A panel that ignores an active filter is labeled with the filter it
        ignores.
    *   R refreshes, T switches the theme, and F focuses the filters.
*   **No CDN:** everything is served from `127.0.0.1`, and no CDN is ever
    contacted.

## Security model

*   **DuckDB lockdown.** Each process opens an in-memory DuckDB. It attaches only
    your registered sources (read-only), turns off external access and extension
    loading, and locks the configuration.
*   **Project boundary.** The model can register only files inside the project
    folder its agent runs in.
    *   **Refused paths:** paths outside the folder, including `../` paths,
        symlinks out of the folder and globs that climb out.
    *   **No scan:** Overlook does not scan when the folder is your home folder
        or a drive root.
*   **One SELECT per query.** Every query must be a single SELECT. It runs with a
    5,000-row cap and a 15-second timeout.
*   **Locked-down web server.** It:
    *   listens only on `127.0.0.1`;
    *   checks the `Host` header;
    *   sends no CORS headers;
    *   requires a JSON body on every POST;
    *   sends a strict Content Security Policy;
    *   runs only the SQL stored in a saved dashboard.
*   **Data you control.** The model sees only what the tools return to it:
    schemas, sample rows (turn them off with `OVERLOOK_SAMPLES=0`) and preview
    rows. If your agent uses a hosted model, that is what reaches the provider.

The attack suite in [test/security.test.ts](../test/security.test.ts) must pass
on every DuckDB upgrade. To report a vulnerability, see
[SECURITY.md](../SECURITY.md).

## Commands and settings

```text
overlook setup [agent…]          add Overlook to your agents (--project, --print, --force)
overlook auto [file]             build a dashboard from the data and open it
overlook mcp                     MCP server for your agent (stdio)
overlook serve [--port N]        dashboard web server (started automatically on save)
overlook source add|list|remove  manage data sources
overlook validate <spec.json>    check a spec file
overlook open <name>             open a dashboard
overlook stop                    stop the web server
overlook doctor [--install]      check setup; --install downloads the DuckDB extensions your sources need
```

| Setting | Default | What it does |
| :--- | :--- | :--- |
| `OVERLOOK_HOME` | `~/.overlook` | Where config, dashboards and logs live |
| `OVERLOOK_PORT` | `4777` | Port of the dashboard server (also `"port"` in `config.json`) |
| `OVERLOOK_OPEN` | on | `0` stops opening new dashboards in the browser |
| `OVERLOOK_AGENT_SOURCES` | on | `0` stops the agent from adding project data |
| `OVERLOOK_SAMPLES` | on | `0` keeps sample rows out of what the model sees |
| `OVERLOOK_PROJECT` | current folder | The project folder the agent may add data from |

## Development

```bash
npm install
```

```bash
npm test
```

`npm test` builds the project, then runs the unit, security, server and stdio
end-to-end tests. Other scripts:

*   **`node scripts/make-examples.mjs`:** regenerates the example data.
*   **`node scripts/demo.mjs`:** saves the example dashboard into `./.demo`.
    Serve it with `OVERLOOK_HOME=.demo node dist/src/cli.js serve`.
*   **`node scripts/bench.mjs`:** times start-up, a 1M-row query and an 8-panel
    save check.

**The eval** scores how well a model uses Overlook, against any
OpenAI-compatible endpoint:

```bash
OVERLOOK_EVAL_MODEL=qwen3-coder:30b npm run eval
```

Pass `--dry` to check the prompts themselves without a model.

**Further reading:**

*   **Design:** the design, its reviews and its rejected alternatives are in
    [docs/designs/overlook.md](designs/overlook.md).
*   **Releasing:** release steps are in [docs/PUBLISHING.md](PUBLISHING.md).
