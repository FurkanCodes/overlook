# Overlook: live dashboards any coding agent can build

*   **Author:** furkancodes
*   **Status:** In Review
*   **Date:** 2026-11-19

--------------------------------------------------------------------------------

## Overview

Overlook is an open-source tool that lets a coding agent build live dashboards
from data on the user's machine, with whatever model that agent runs.

*   **Target:** any agent that supports MCP.
*   **Tested in v1:** Claude Code, Codex CLI and OpenCode.
*   **Expected to work but untested:** Cursor, Goose and other MCP clients.
*   **Platforms:** Windows 10+, macOS 13+ and Linux (x64 and arm64), on Node 22
    or later.

**Terms used below:**

*   **MCP server:** the `overlook mcp` process.
*   **Web server:** the `overlook serve` process.
*   **Instance:** one in-memory DuckDB database inside one of those processes.

It ships as one npm package, `overlook-dash`, with one command, `overlook`:

*   `overlook mcp` is an MCP server the agent starts over standard
    input/output. It gives the model tools to inspect data, try queries, and
    save dashboards.
*   `overlook serve` is a local web server on `127.0.0.1` that draws the saved
    dashboards in the browser and re-runs their queries on each load.

The model never writes HTML. It writes a small JSON dashboard spec: a title,
optional filters, and a list of panels. Each panel holds one SQL `SELECT`, a
chart type, and the result columns to plot. Overlook checks the spec, runs
every query against the real data through DuckDB, and sends back short,
specific errors the model can act on. Saved dashboards are plain JSON files in
a folder.

Feature parity target: the dashboard type in Anthropic's own Claude product
(called "Claude's dashboards" below). Overlook copies its useful behavior, not
its code, name or look:

*   live queries rather than copies of the data;
*   every number shows where it came from;
*   filters;
*   KPI tiles, charts, tables and text;
*   a page that reports its own errors back to the model.

## The Problem

Claude's dashboards work only inside claude.ai, only with Claude models, and
run their queries through that product's cloud connectors. Developers and
analysts who use other agents (Codex CLI, OpenCode, Cursor), other model
providers, or local models through Ollama have no equivalent.

The obvious workaround is to ask the agent to write an HTML page or a Streamlit
app. That fails in three ways:

*   **Nothing checks the output.** A wrong column name gives an empty chart and
    no error the model can see.
*   **Long free-form code gives a mid-size model more places to fail,** and
    no checker reports the failure.
*   **Every dashboard is a one-off program** that the user has to run and
    maintain.

Existing tools cover parts of the problem:

*   **Vizro-MCP** checks a dashboard config and produces Python Dash code to
    run. It does not serve live dashboards itself.
*   **AntV's chart MCP server** sends chart data to a hosted rendering service
    by default.
*   **Grafana and Metabase** are heavy servers built around accounts and
    permissions.

None of them gives a small, checked spec that runs live SQL against local data
and works the same in every MCP agent.

## Goals

*   **Any MCP agent:** a model in Claude Code, Codex CLI or OpenCode can create
    a working multi-panel dashboard from a CSV, Parquet, JSON, SQLite or DuckDB
    source, using only Overlook's MCP tools.
*   **Three levels of checking:** every saved dashboard passes all three before
    the save succeeds, or the model gets a list of errors.
    *   **Valid:** the spec matches the schema, and every source, id and filter
        it names exists (pipeline steps 1–3).
    *   **Executable:** every panel's query runs (step 4).
    *   **Fits its chart:** every chart field exists in the query result with a
        type that fits the chart (step 5).
*   **Visible sources:** every figure on the page shows where it came from:
    data source alias, the SQL, row count, run time, and when it last ran.
*   **Clear errors:** each error names the JSON path, what was expected, what
    was found, and a one-line fix. Each reply holds at most eight errors.
*   **Works with a mid-size local model:** the reference model passes at
    least 10 of the 12 bundled eval prompts.
    *   **Reference model:** Qwen3-Coder-30B-A3B, Q4_K_M, via Ollama, 32k
        context, temperature 0.3.
    *   **Prompts:** 9 create a dashboard and 3 edit one.
    *   **Scoring:** each prompt is run 3 times, and it counts as passed when
        at least 2 of the 3 runs pass. "Passes" is defined in the Eval section:
        the save succeeds within three tries, and the numbers and column
        mapping are correct.
    *   **Try:** one `save_dashboard` call. `describe_data` and `preview_query`
        calls are free.
    *   **Status:** this is a hypothesis the eval measures, not a claim. If it
        fails, see Risks.
*   **Nothing is uploaded by Overlook:**
    *   DuckDB has no network access at run time. The only download is the
        one-time `sqlite` extension install, which the user starts with
        `source add` for a SQLite source or with `doctor --install`.
    *   The web server answers only on `127.0.0.1` and only runs queries stored
        in saved dashboards.
    *   Data reaches the model only through tool results, and those can contain
        data: sample rows, up to 20 preview rows, and DuckDB error text. When
        the agent uses a hosted model, those results go to that provider.
        `OVERLOOK_SAMPLES=0` removes only the unprompted sample rows.
*   **Visual baseline,** checked by hand in the browser before each release:
    *   light and dark themes;
    *   a layout that works at full width and at 400px;
    *   a hover tooltip on every chart;
    *   loading skeletons the same size as the panel, so nothing shifts;
    *   a series palette validated for color-vision deficiency and contrast in
        both themes.
*   **Tests:** `npm test` runs:
    *   unit and integration tests;
    *   a security attack suite that must pass on every DuckDB upgrade;
    *   an end-to-end test that drives the real MCP server over stdio.

## Non-Goals

*   User accounts, sharing, permissions, or any hosted version.
*   Scheduled refreshes, alerts, or emailed reports.
*   Data entry on the page, such as ticks, notes or targets that people type
    into the page and that get saved. Claude's dashboards have these.
*   Drag-and-drop editing in the browser. The agent edits; the browser shows.
*   Any chart type outside the fixed list in the spec.
*   Calling a model from inside Overlook. The only model calls are in the
    separate eval runner.
*   Inline UI inside the agent through MCP Apps, the MCP extension that lets a
    tool return an interactive HTML view for the agent's own window to show.
*   Any Anthropic or Claude branding.

## Open Questions

*   **Question 1:** Should a later version add per-panel edit tools
    (`upsert_panel`, `remove_panel`)? Decide from eval data on whether small
    models drop panels when they replace the whole spec.
*   **Question 2:** Should results be cached for slow sources? Defer until real
    use shows it is needed. The page-load target below gives the threshold.

## Critical User Journeys (CUJs)

### CUJ 1: First dashboard from a CSV

*   **Given:** the user has run `npx overlook-dash source add sales
    ./sales.csv` and added `npx overlook-dash mcp` to their agent's MCP config.
*   **When:** they ask the agent, "Make a dashboard of monthly revenue by
    region."
*   **Then:**
    1.  The model calls `describe_data` and sees table `sales` with its columns
        and types.
    2.  It tries a query with `preview_query`.
    3.  It calls `save_dashboard`. The save step validates the spec and runs
        every query.
    4.  The reply holds the URL `http://127.0.0.1:4777/d/monthly-revenue`, and
        Overlook starts the web server if it was not already running.
    5.  The page shows a KPI row, a line chart and a table. Each panel's
        "Source" control shows its SQL and row count.

### CUJ 2: The model makes a mistake

*   **Given:** a model writes `"y": "revenu"` for the second panel, whose query
    returns the columns `month, revenue`.
*   **When:** it calls `save_dashboard`.
*   **Then:**
    *   Nothing is saved.
    *   The reply says `1. panels[1].y: column "revenu" is not in the query
        result`, followed by `fix: did you mean "revenue"? result columns:
        month, revenue`.
    *   The model corrects the name and saves again, using its second of three
        tries.
    *   Paths count from 0. They use the array position because the panel's id
        may itself be the thing that is wrong.
    *   **Case-only difference.** Had the model written `"Revenue"`, Overlook
        would fix the name itself and report the repair, because a difference
        in letter case cannot change which column is meant. Any other typo is
        never guessed, so a repair cannot change the numbers a chart shows.

### CUJ 3: Data changes after the dashboard is saved

*   **Given:** a saved dashboard reads `sales.csv`. The user then replaces the
    file and renames a column.
*   **When:** they reload the page.
*   **Then:**
    *   Panels that still work show the new data and a fresh "updated" time.
    *   The broken panel shows its own error card (source, SQL, DuckDB
        message); the rest of the page still draws.
    *   In the next agent session, `get_dashboard` returns that panel's error so
        the model can repair it.

### CUJ 4: Filters

*   **Given:** a dashboard declares a `region` select filter, and its panels
    use `$region` in their SQL.
*   **When:** the user picks "EMEA" in the page's filter bar.
*   **Then:**
    *   Every panel re-runs with `$region` bound as a query parameter, never
        pasted into the SQL text.
    *   The URL query string keeps the choice, so a reload or a bookmark shows
        the same view. The server is local, so the link works only on the
        user's own machine.

### CUJ 5: The agent edits an open dashboard

*   **Given:** the dashboard is open in a browser tab.
*   **When:** the model saves a new version.
*   **Then:**
    *   The tab notices the file changed within about two seconds and redraws.
    *   The previous version is kept in the dashboard's history folder.

## Technical Plan (Architecture)

### Components

```text
  agent (Claude Code / Codex / OpenCode)
        │  MCP over stdio
        ▼
  ┌──────────────────┐   writes JSON    ┌────────────────────────────┐
  │  overlook mcp    │ ───────────────▶ │ ~/.overlook/               │
  │  (tools)         │──▶ DuckDB #1     │   config.json  (sources)   │
  └───────┬──────────┘                  │   dashboards/<slug>.json   │
          │ spawns if not running       │   history/<slug>/*.json    │
          ▼                             │   tmp/  extensions/  logs/ │
  ┌──────────────────┐   reads JSON     └────────────────────────────┘
  │  overlook serve  │ ◀─────────────────────────────┘
  │  127.0.0.1:4777  │──▶ DuckDB #2
  └───────┬──────────┘
          │ HTTP (page + JSON API)       each DuckDB: in memory, locked down,
          ▼                              reads CSV/Parquet/JSON/SQLite/DuckDB
       browser                           files read-only
```

Both processes share one core library, and **each runs its own in-memory
DuckDB instance**: the MCP process for `describe_data`, `preview_query` and the
save checks, and the server for the page. Neither process holds state that the
other needs. The folder is the only shared record, so either can crash or
restart without losing anything.

**When an instance opens, re-opens and closes.** This is the only place the
rule is stated.

*   **Lazy opening.** Instances open lazily, on the first query.
*   **Re-open on config change.** An instance re-opens on the next query after
    `config.json` changes, so a source added mid-session is visible at once to
    both the model and the page.
*   **Re-open for globs.** If any source is a glob, it also re-opens when it is
    more than 60 seconds old, so new files matching the glob appear within a
    minute.
*   **Replaced files.** Replacing a non-glob file needs no re-open. DuckDB
    views read the file and re-detect its columns on every query (checked with
    the pinned DuckDB version), so only panels that use a removed column fail.
*   **Idle close.** An instance that has run nothing for 20 seconds is closed.
    This matters because DuckDB keeps a file lock on an attached `.duckdb`
    source, even read-only, and that lock blocks the user's own programs from
    writing to it (also checked). The lock therefore lasts at most 20 seconds
    after the last query.
*   **Retiring an instance.** A replaced or idle instance is closed only after
    its running queries finish.

### Language and dependencies

Overlook is written in TypeScript and runs on Node 22 or later. TypeScript was
chosen because the browser page and the server can share the spec types, the
official MCP SDK is written in TypeScript, and `npx` gives a one-line install.
Runtime dependencies:

*   `@duckdb/node-api` for the query engine;
*   `@modelcontextprotocol/sdk` for the MCP server;
*   `zod` for the spec schema, which also produces the JSON Schema shown to the
    model.

The browser bundle is built with esbuild into `dist/ui/app.js`. It uses three
libraries:

*   **d3 modules** for scales, shapes and formats;
*   **Lucide** for icons: one set and one stroke weight;
*   **Inter** (variable, Latin subset, 48 KB) as the single typeface.

Everything is served locally. The CSP allows no CDN, so the font ships in
`dist/ui/inter.woff2`, preloaded by the page. Licenses are in
`THIRD_PARTY_NOTICES.md`.

### The spec (version 1)

```text
Dashboard {
  version: 1
  title: string (1–120 chars)
  description?: string
  filters?: Filter[]            (max 6)
  panels: Panel[]               (1–24)
}
Filter {
  id: identifier                (used as $id in SQL)
  label: string
  type: "select" | "text" | "date"
  source?: alias                (select only: the source options_sql runs on)
  options_sql?: string          (select only: query returning one column)
  options?: string[]            (select only: fixed list)
  default?: string
}
Panel {
  id: identifier                (stable; unique in the dashboard)
  type: "kpi" | "bar" | "line" | "area" | "scatter" | "table" | "text"
  title?: string
  width?: "full" | "half" | "third"   (default by type)
  source: alias                 (not for "text")
  sql: string                   (not for "text"; one SELECT or WITH)
  x?: column    y?: column | column[]    series?: column
  value?: column                (kpi)
  compare?: column              (kpi: earlier value, from the same row)
  x?: column                    (kpi: trend; query returns one row per period)
  better?: "up" | "down"        (kpi: which direction is good; default up)
  columns?: column[]            (table: which columns to show, in order)
  format?: "number" | "currency" | "percent" | "compact"
  unit?: string                 (e.g. "USD")
  stacked?: boolean             (bar, area)
  horizontal?: boolean          (bar)
  markdown?: string             ("text" only; rendered as safe text, see below)
  note?: string                 (one line shown under the chart)
}
```

The panel `type` decides which fields are required:

*   `kpi` needs `value`.
*   `bar`, `line` and `area` need `x` and `y`.
*   `scatter` needs `x` and a single `y`.
*   `table` needs only `sql`.
*   `text` needs only `markdown`.

The checks run per type, so an error names one panel type, not every
possibility.

Two field rules:

*   **Wide or long series.** A chart's series come either from several `y`
    columns (wide data) or from one `y` plus a `series` column (long data).
    Using both is an error.
*   **KPI comparison.** A KPI shows `value` from the first row. With
    `compare`, it also shows the change as a percent, with the absolute
    difference in the tooltip. The change is green when it goes in the
    `better` direction.
*   **KPI trend.** With `x`, the query returns one row per period, ordered by
    `x`.
    *   The tile shows the last row's `value` and a sparkline of all rows.
    *   It compares against `compare` if that is set, otherwise against the
        previous row.
    *   The check warns if a trend query returns fewer than 2 rows. It does not
        give the "only the first row is shown" warning for KPIs with `x`.

Rules for SQL:

*   **SQL does the analysis.** All aggregation, filtering and sorting happen in
    the panel's SQL. The chart only maps columns to axes.
*   **Sources are table names.** A panel's `source` names the alias, and in SQL
    the alias is the table name: a CSV registered as `sales` is queried as
    `FROM sales`. A SQLite or DuckDB source is attached as a schema, so its
    tables are `alias.table`.

### Data sources and the DuckDB lockdown

Sources live in `~/.overlook/config.json`. The folder can be moved with
`OVERLOOK_HOME`. A source entry is one of:

*   `{type: "file", path}`, where `path` is an absolute path or glob to a CSV,
    TSV, Parquet or JSON file;
*   `{type: "sqlite", path}`;
*   `{type: "duckdb", path}`;
*   `{type: "postgres" | "mysql", url}` or `{type, env, envFile}`. With `env`,
    the config holds only the variable's name. The URL is read from `envFile`
    (or the environment) each time the source opens.

**Who registers sources.** There are two ways (revised 2026-11-19, so that
Overlook works in any project without setup):

*   **The user, with the CLI:** any path, or a database URL.
*   **The agent, with `add_source`:** only a file or glob inside the project
    folder, or a database URL variable in that folder's `.env` files.
    *   **Project folder:** the MCP process's working directory, or
        `OVERLOOK_PROJECT`.
    *   **Refused paths:** real paths are compared, so `../`, a symlink out of
        the folder, and a glob whose fixed prefix leaves the folder are all
        refused.
    *   **Refused folders:** the home folder, a drive root and the Overlook
        home are never treated as a project.
    *   **Approval:** the tool is not marked read-only, so agents ask the user
        before each call.
    *   **Off switch:** `OVERLOOK_AGENT_SOURCES=0` removes the ability.

The model gains nothing it could not already read with its agent's own file
tools. It still cannot reach files outside the project.

**What `describe_data` lists.** It also lists unregistered data in the
project:

*   **Data files:** found by a breadth-first scan of at most 5 levels and 40
    files. The scan skips hidden folders, dependency folders and build
    folders, and leaves out `.json` and `.txt` files. `.db` files must have a
    SQLite or DuckDB header.
*   **Database URLs:** those named in `.env` files, by variable name only.

**Database sources:**

*   **Extensions:** they use DuckDB's `postgres` and `mysql` extensions,
    attached `READ_ONLY` before external access is turned off.
*   **Errors:** URLs in error messages are redacted.
*   **Not yet tested here:** no live attach against a server has been run in
    this repository's tests. Only the URL handling is unit-tested.

Each process opens one in-memory DuckDB instance. On start it runs these steps
in order:

1.  For each file source, create a view: `CREATE VIEW "<alias>" AS SELECT *
    FROM read_csv_auto('<path>')`, or `read_parquet`, or `read_json_auto`,
    depending on the file extension. A glob is expanded to a fixed list of
    files when the instance opens.
2.  For SQLite and DuckDB sources, `ATTACH ... (READ_ONLY)`. Start-up only
    *loads* the `sqlite` extension. It is downloaded once, by `overlook source
    add` or `overlook doctor --install`, so starting `mcp` or `serve` never
    touches the network. If the extension is missing, that one source fails
    with a message naming the command to run.
3.  `SET allowed_paths` to the exact registered files, plus SQLite and DuckDB
    side files (`-wal`, `-shm`, `.wal`). `allowed_directories` is never set: a
    probe showed it lets `COPY ... TO` write into that folder.
4.  `SET extension_directory` and `SET temp_directory` to folders under
    `OVERLOOK_HOME`.
    *   Install and load always use the same extension folder.
    *   Queries that run out of memory spill there, never into the user's
        working directory, which is DuckDB's default (`.tmp`).
5.  `SET enable_external_access = false`, `SET autoinstall_known_extensions =
    false`, `SET autoload_known_extensions = false`, `SET memory_limit =
    '2GB'`.
6.  `SET lock_configuration = true`.

The DuckDB version is pinned exactly (`@duckdb/node-api` `2.0.0-r.1`, DuckDB
2.0.0), because the lockdown depends on its exact behavior. The security test
suite must pass before the pin is changed.

After step 6, a query cannot read other files, write files, load extensions,
or attach databases.

Every query from a model or a page also goes through these checks:

*   **One statement.**
    *   The SQL, after leading comments are removed, must start with `SELECT`,
        `WITH`, `FROM`, `VALUES` or `(`.
    *   DuckDB's statement extraction must find exactly one statement, and the
        prepared statement's type must be `SELECT`.
    *   The keyword check is needed because DuckDB reports `PRAGMA` as a
        `SELECT`. Together, the two checks reject `COPY`, `ATTACH`, `INSTALL`,
        `PRAGMA` and `SET`.
*   **Row cap.** The statement runs exactly as written, after one trailing
    semicolon is removed. Its result is streamed, and reading stops after
    5,001 rows. If 5,001 rows arrive, the result is marked as truncated at
    5,000.
    *   Nothing wraps the SQL, so a trailing `-- comment` cannot break the
        query, and the query's own `ORDER BY` decides which rows are kept.
*   **Timeout.** Each query runs on its own connection, which is interrupted
    after 15 seconds, both on the page and during a save check. One slow query
    never stops another.
*   **Concurrency.** The web server runs at most 4 queries at once; the rest
    wait in line.
*   **Bound filters.** Filter values are bound as named parameters (`$region`),
    never pasted into the SQL text.
    *   **Which parameters.** Only the parameters a statement actually uses
        are bound. The prepared statement reports them, so no regex is
        involved.
    *   **Types.** Values are bound as strings, and DuckDB casts them to the
        type the query needs. Tests cover a string compared with an `INTEGER`
        and with a `DATE`.
    *   **Date values** must be `YYYY-MM-DD`.
    *   **Unset filters.** A filter with no value binds `NULL`, so panels use
        the pattern `WHERE ($region IS NULL OR region = $region)`. A panel that
        uses a filter with no default but has no `IS NULL` guard gets a
        warning, because it is empty until a value is picked.

### The checking pipeline

`checkDashboard(input, engine, options?)` runs inside `save_dashboard` and
`get_dashboard`, in the CLI's `validate` command, and in the eval runner. It
gets the registered aliases from the engine's config. It runs these steps in
order:

1.  **Lenient repair.** Accept a spec sent as a JSON string. Turn the strings
    `"true"`/`"false"` into booleans. Lower-case the chart type and map common
    aliases (`"pie"` is refused with a message, `"column"` becomes `bar`,
    `"number"` becomes `kpi`). Every change is recorded in `repairs[]`.
2.  **Schema check (zod).** Each zod issue becomes one error with a path, the
    expected value, the received value, and a fix. When a field only allows a
    fixed set of values, the error lists them.
3.  **Reference check.**
    *   Every panel `source` must be a registered alias; on a miss, the error
        lists the aliases.
    *   Panel and filter ids must be unique.
    *   Every `$name` in SQL must be a declared filter.
    *   A select filter needs `options` or `options_sql` (with `source`), not
        both, and `options_sql` is run and must return one column.
4.  **Query check.**
    *   Each panel's SQL runs with the row cap. Filters use their defaults, or
        `NULL` when none is set.
    *   Panels run four at a time, each with the page's 15-second limit,
        under a total budget of 40 seconds for the whole save. 40 seconds stays
        under the 60-second tool timeout agents usually use. Any panel not
        reached within the budget gets a "not checked in time" error.
    *   A query that works on the page can therefore always be saved.
        Checking columns from DuckDB's prepare metadata alone, without running
        the query, was considered; see Alternative G.
    *   DuckDB's own error text is passed through, because its binder errors
        already suggest candidate column names.
5.  **Field check.**
    *   Every `x`, `y`, `series`, `value`, `compare` and `columns` entry must
        be a column in the result.
    *   A name that differs only in letter case, and matches exactly one column,
        is repaired and reported.
    *   Any other mismatch is an error. It lists the closest real columns ("did
        you mean") and all result columns. Edit-distance guessing was rejected
        (Alternative H) because a wrong guess saves wrong numbers silently.
    *   Types must fit: `y` and `value` must be numeric. A text `x` on a line or
        area chart gets a warning.
6.  **Warnings, which do not block saving.**
    *   Zero rows.
    *   More than 50 bars.
    *   More than 12 series.
    *   A result truncated at 5,000 rows.
    *   A KPI query that returns more than one row.
    *   A saved dashboard that loses panel ids it had before, which shows that
        a rewrite dropped panels.

Steps 3–5 run per panel, so a reply includes every panel's problems at once,
not one stage at a time.

The output is `{ok, spec?, errors[], warnings[], repairs[], panels: [{id, rows,
columns, ms, error?}]}`. When it is not ok, the MCP tool returns it as a normal
tool result with `isError: true`, so the agent shows it to the model.

*   **Order.** Errors are sorted by panel order.
*   **Duplicates.** Identical messages across panels are merged.
*   **Cap.** The reply holds at most eight, then says how many more exist.

### MCP tools

All tool inputs are flat: strings, plus one `spec` field whose schema is
`anyOf: [object, string]`, so a spec sent as a JSON string is accepted too.
All checking happens inside the MCP server (`checkDashboard`), so harnesses
with strict or limited tool-schema support still work.

Row counts in `describe_data` are best effort: each count has 2 seconds, and
a table whose count takes longer shows no count, so a large CSV never stalls
the first call of a session.

The tools:

| Tool | Input | Returns |
| --- | --- | --- |
| `describe_data` | `source?` | aliases, tables, columns with types, row counts; with `source`, 3 sample rows unless `OVERLOOK_SAMPLES=0` |
| `preview_query` | `source, sql, params?` | columns, up to 20 rows, total row count, ms |
| `save_dashboard` | `name, spec` | URL, warnings, repairs; or errors |
| `get_dashboard` | `name` | spec plus each panel's current status, from re-running the check on the stored spec |
| `list_dashboards` | none | names, titles, URLs, last modified |
| `get_spec_reference` | none | the spec reference with two examples |

The six tool descriptions together are kept under about 1,800 tokens. The
server answers `initialize` without waiting for DuckDB, which opens lazily on
the first tool call, so slow agent start-up timeouts are not hit. Codex's
default is 10 seconds.

### Storage

*   **Dashboard files.** A dashboard is saved as
    `~/.overlook/dashboards/<slug>.json`. The slug comes from `name`: lower
    case, `a-z0-9-`, at most 64 characters.
*   **Saving over an existing slug.** Saving under a name whose slug already
    exists replaces that dashboard; this is how edits work.
    *   The reply says whether the save created or replaced.
    *   If it replaced a dashboard with a different title, the reply warns and
        names the old title, so two names that map to one slug are noticed.
*   **Atomic writes.** Each save writes a temp file in the same folder, then
    renames it over the old file. On Windows a rename fails while another
    process has the file open, so the rename is retried up to 8 times with
    backoff.
*   **History names.** History file names use timestamps with no colons
    (`2026-11-19T10-15-00-123Z.json`).
*   **Slug guard.** A slug that matches a reserved Windows device name (`con`,
    `nul`, `aux`, `prn`, `com1`–`com9`, `lpt1`–`lpt9`) gets `-dashboard`
    appended, and an empty slug becomes `dashboard`.
*   **History.** Before the rename, the old file is copied to
    `history/<slug>/<timestamp>.json`, and only the newest 20 copies are kept.
*   **Version guard.** A file whose `version` is newer than the running build
    supports is refused with a message, never overwritten.

### Web server and page

`overlook serve` listens on one fixed port: `127.0.0.1:4777`, or `port` in the
config file. There is no port scan, so dashboard URLs never change.

*   **Port already in use.** When binding fails, the new process calls `GET
    /api/health` on that port.
    *   If an Overlook server answers, for example because two agents started
        one at the same moment, the new process exits quietly and the first
        server serves both.
    *   If anything else answers, or nothing does, it exits with a message
        that names the `port` setting.
*   **No lock file.** The port comes from the config, and `/api/health`
    reports the version and pid, so no lock file is needed and none can go
    stale.
*   **Opting out.** `OVERLOOK_NO_SERVE=1` stops the MCP server from starting
    the web server. Tests and the eval use it, and users who run `overlook
    serve` themselves can too.

For when the web server's instance re-opens, see "When an instance opens,
re-opens and closes".

The MCP process decides whether to start or replace a server like this, just
before it returns a URL:

1.  It calls `GET /api/health`, which returns `{app: "overlook", version,
    pid}`.
2.  If the answer comes from an Overlook server running an **older** `version`
    (compared as semver), it calls `POST /api/shutdown`, then starts a new one. A newer or equal server is left
    alone, so two agents on different versions never keep replacing each
    other's server.
3.  If nothing answers, it starts `overlook serve` as a detached process and
    waits up to 3 seconds for the health check to pass.
    *   It starts the server with `process.execPath` and the CLI script's
        path, not through `npx`, so there is no package-manager cold start.
    *   `windowsHide` is set, so no console window opens.
    *   If the 3 seconds run out, the dashboard is still saved, and the reply
        gives the URL plus a note asking the user to run `overlook serve`.
4.  If a different program holds the port, the tool reply says so and names
    the `port` setting.

`overlook stop` shuts the server down.

Routes:

*   `GET /` lists dashboards.
*   `GET /d/<slug>` is the dashboard page.
*   `GET /api/dashboards` returns the list for the `/` page.
*   `GET /api/d/<slug>` returns the spec and its file modified time.
*   `GET /api/d/<slug>/mtime` returns only the modified time. The page polls
    it, and it runs no query.
*   `POST /api/d/<slug>/panels/<id>` with filter values returns `{columns,
    rows, truncated, ms, ranAt}` or `{error}`.
*   `GET /api/d/<slug>/options/<filterId>` returns filter options.
*   `GET /api/health` reports server status.
*   `POST /api/shutdown` stops the server. The MCP process and `overlook stop`
    use it, never the page. It follows the same POST rules as every other
    route, which already keep web pages out. Local processes can call it, but
    Risks accepts that they can already reach everything else, and stopping
    the server only blanks the page until the next save restarts it.
*   `/assets/*` serves the page bundle and CSS.

Safety rules:

*   **Host header.** Every request must have a `Host` of `127.0.0.1:<port>` or
    `localhost:<port>`; anything else gets 403. This blocks DNS rebinding.
*   **No CORS headers**, so other sites cannot read responses.
*   **Rules for every `POST`.**
    *   The request must send `Content-Type: application/json`. A page on
        another site cannot send that type without a CORS preflight, and the
        server never answers a preflight. This is why the panel route is a
        `POST` even though it changes nothing: filter values go in a JSON body
        that other sites cannot forge.
    *   If an `Origin` header is present, it must equal the server's own origin.
*   **Response headers.**
    *   Every response also sends `X-Content-Type-Options: nosniff`,
        `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer` and
        `Cross-Origin-Resource-Policy: same-origin`.
    *   API responses send `Cache-Control: no-store`.
*   **Strict Content Security Policy:** `default-src 'self'; script-src 'self';
    style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors
    'none'`.
*   **No SQL or file paths from the browser.** The panel API runs only the SQL
    stored in the dashboard file, found by slug and panel id.

The page:

*   **Data as text.** All data values are inserted as text nodes. The
    `markdown` in text panels supports a small set (headings, bold, italic,
    lists, inline code, links to `http(s)` only), and is rendered by building
    DOM nodes, never through `innerHTML`.
*   **Layout.** Panels sit in a 12-column grid. `full` spans 12 columns, `half`
    6 and `third` 4. Below 720px wide every panel is full width. KPIs default to
    `third`, charts to `half`, and tables and text to `full`.
*   **Charts.** Charts are drawn as SVG with d3, sized from the panel's width,
    and redrawn on resize. Each chart has a hover tooltip that stays inside the
    panel, and line and area charts have a crosshair.
*   **Colors.** Series use a fixed eight-color palette that is checked for
    contrast in both themes. The theme follows the system setting and has a
    toggle.
*   **Panel footer.** Each panel shows:
    *   the row count;
    *   the query run time in ms;
    *   the time since its last run;
    *   a "`<alias>` SQL" button that opens the SQL drawer.
*   **SQL drawer.** It shows:
    *   the source alias and its file name (never the folder);
    *   the values the query ran with (`$region = 'Europe'`, or `NULL (all)`);
    *   the SQL itself, with a Copy SQL button.

    On a KPI, the drawer floats below the card instead of stretching the cards
    beside it.
*   **Filter scope.** The page reads which `$parameters` each panel's SQL uses.
    When a filter has a value that a panel does not use, the panel's header
    says "Not filtered by Region", so an unfiltered number never passes for a
    filtered one.
*   **Panel menu.** A "⋯" menu, navigable by keyboard, holds the less frequent
    actions:
    *   show as a table or as a chart;
    *   view the source SQL;
    *   copy or download CSV, with a toast confirming.
*   **Failure.**
    *   **Top bar:** while any panel has failed, the status reads "N panels
        failed" and jumps to the first one.
    *   **SQL errors** always fail the same way, so the panel offers "Copy for
        your agent", which copies the panel id, SQL and error as a prompt.
    *   **Missing sources and timeouts** offer Retry instead.
*   **KPI tiles.** A tile shows:
    *   the value;
    *   a delta chip with an arrow and a good or bad color;
    *   the comparison value, with the same precision as the value;
    *   with `x` set, a sparkline of the series, with the first and last
        periods labelled.

    Percent KPIs show the change in points ("−1.8 pts"), with the relative
    change on hover.
*   **Tables.** Column headers are humanized ("Refund rate"). A numeric column
    named like a rate whose values all lie in [−1, 1] is formatted as a
    percent.
*   **Keyboard and screen readers.**
    *   Bar bands are focusable and named with their values.
    *   Line and area charts take focus and step through points with the arrow
        keys (Home and End jump to the ends).
    *   Tooltips are not live regions.
*   **Page chrome.**
    *   **Top bar:** sticky, with a breadcrumb and a live freshness indicator
        ("Live · updated 2 min ago", or "Updating…" while queries run).
    *   **Under the title:** a row of source chips.
    *   **Page footer:** lists the keyboard shortcuts (R to refresh, T for
        theme).
    *   **Entrance motion:** cards rise in with a short stagger on first load.
        Bars grow and lines draw only when new data arrives, never on resize.
        All motion is off under `prefers-reduced-motion`.
*   **Live editing.** The page polls `GET /api/d/<slug>/mtime` every 2 seconds
    while the tab is visible. That route reads only the file's modified time
    and runs no query. When the time changes, the page re-fetches the spec and
    redraws every panel.
*   **Cancelled runs.** When a filter changes, in-flight panel requests are
    cancelled in the browser before new ones start.
*   **Loading and errors.** A panel that is loading shows a skeleton of the same
    size. A panel with an error shows an error card; the other panels are not
    affected.

### Observability

*   **Logs.** Logs go to stderr and `~/.overlook/logs/overlook.log`. Nothing is
    written to stdout in MCP mode except protocol messages, and a test enforces
    this.
*   **Tool-call log.** Every tool call is logged as one JSON line: tool name,
    stage reached, error count, repairs, run time.
*   **Panel errors.** `get_dashboard` re-runs the check on the stored spec, so
    the model sees each panel's current state even if nobody has opened the
    page. No per-dashboard state files are kept.
*   **Log size.** The log file rotates at 5 MB, and one old copy is kept.
*   **`overlook doctor`.** Prints the Node and DuckDB versions, checks that
    each source opens, reports server status, and prints MCP config snippets
    for Claude Code, Codex CLI and OpenCode.

### Eval

`eval/run.ts` talks to any OpenAI-compatible chat-completions endpoint (Ollama,
OpenRouter, OpenAI, or a local server) through the same tool definitions the
MCP server uses, calling the core functions directly. It loads the fixture
data in `eval/fixtures/` and the prompts in `eval/prompts.json`.

Each prompt has:

*   an instruction;
*   the expected panel types;
*   one `check_sql` per required panel, giving the correct numbers;
*   for the 3 edit prompts, a starting dashboard and the panel ids that must
    survive the edit, which answers Open Question 1.

The eval calls the core library instead of going through MCP. This keeps
harness behavior out of the score. The stdio end-to-end test covers the MCP
layer separately.

A run of a prompt passes when all of these hold:

*   **Save:** the save succeeded within 3 tries, where a try is one
    `save_dashboard` call.
*   **Numbers:** for each `check_sql`, some saved panel's result matches its
    rows, ignoring column names and row order, with numbers compared to 1e-6.
    Values go through the same JSON conversion as the page.
*   **Mapping:** that panel has an allowed type, and its `x`, `y` or `value`
    columns hold the expected values. This catches swapped axes.
*   **Edits only:** every required panel id is still present.

Each prompt runs 3 times at temperature 0.3 with 3 different seeds, and passes
when at least 2 runs pass. A nonzero temperature is what makes the three runs
differ. At temperature 0 they would be near-copies, and "2 of 3" would measure
nothing. The runner prints a table
and writes `eval/results/<model>-<date>.json`.

## Alternatives Considered

### Alternative A: The model writes HTML or a Streamlit app

*   **Pros:** no limits on what the dashboard can do.
*   **Cons:** nothing is checked, there is no structured error signal, a long
    program gives a mid-size model many places to fail, and it runs unchecked
    code.
*   **Reason for Rejection:** Rejected by author. It removes the small, checked
    output this design depends on for mid-size models.

### Alternative B: Vega-Lite or ECharts as the spec the model writes

*   **Pros:** many chart types, documented formats.
*   **Cons:**
    *   **Size.** The Vega-Lite JSON Schema is several hundred kilobytes, far
        more than the whole of this spec's reference (about 2,000 tokens). A
        32k-context model cannot hold it beside the agent's own prompt.
    *   **Errors.** Its errors come from deep `anyOf` branches ("must match
        exactly one schema in oneOf"), which give a model no single fix.
    *   **Coupling.** Saved files would follow the library's versions.
*   **Reason for Rejection:** Rejected by author. Every feature it adds over
    this spec, such as layered marks, transforms and selections, is either
    done in SQL here or out of scope. Every cost it brings lands on the
    weakest models.

### Alternative C: Vega-Lite as the renderer behind our own spec

*   **Pros:** less chart code to write.
*   **Cons:**
    *   There is less control over tooltips, crosshairs and loading states.
    *   The bundle is about 800 KB, against the 150 KB budget.
    *   Meeting the visual baseline (the mark specs, both themes, and a palette
        validated for color-vision deficiency) would mean overriding most of
        its default config.
*   **Reason for Rejection:** Rejected by author. Six chart types drawn with d3
    take less code than theming Vega-Lite to the same quality, and give full
    control of the look.

### Alternative D: One daemon that owns the store, with MCP calling its API

*   **Pros:**
    *   One DuckDB instance instead of two: half the memory ceiling, and one
        set of file locks.
    *   One copy of the re-open logic.
*   **Cons:**
    *   **Startup.** Every MCP tool call would depend on the web server
        running. Today `describe_data`, `preview_query` and the save check
        work even when the web server cannot start (a port conflict, or
        `OVERLOOK_NO_SERVE`).
    *   **Timeouts.** A slow page query would compete with the model's save
        check inside one process, so the agent's tool timeout could hit
        because a browser tab was busy.
    *   **Crashes.** A crash of the daemon would fail the agent's tool calls
        mid-session, instead of only blanking a browser tab until it restarts.
*   **Reason for Rejection:** Rejected by author. The doubled memory ceiling (2
    × 2 GB) and the doubled file locks are accepted. The idle close removes
    most of the lock cost, and each instance is idle almost all the time.

### Alternative E: Build on Vizro-MCP, Evidence or Rill

*   **Pros:** existing, maintained projects.
*   **Cons:**
    *   **Vizro-MCP** produces Python Dash code for the user to run.
    *   **Evidence** copies data at build time and needs a Node build.
    *   **Rill** uses its own YAML project format and is a large install.
*   **Reason for Rejection:** Rejected by author. None gives a checked small
    spec with live local SQL from any MCP agent. Their good ideas are borrowed:
    Vizro's validate-and-retry loop, and Evidence's SQL-first panels.

### Alternative F: Let the model register data sources

*   **Pros:** fewer setup steps; the model could add a file it finds.
*   **Cons:**
    *   In v1 the main cost is reach: a model, or a prompt injected through
        data, could add `~/.ssh/id_rsa` or any other file as a "source" and
        read it through `preview_query`.
    *   The registration step is the user's decision about what the model may
        read.
    *   When credentialed sources arrive (Postgres), passwords would also end
        up in transcripts.
*   **Reason for Rejection:** Rejected by author. Sources are registered with
    the CLI.

### Alternative H: Repair column typos by edit distance

*   **Pros:** it saves one try when a model mistypes a column name.
*   **Cons:**
    *   A wrong guess (`max_temp` → `min_temp`, `revenue_2024` →
        `revenue_2023`) saves wrong numbers with no error, and the repair note
        goes to the model, not to the person reading the page.
    *   Making it safe took five rules, a CUJ and a risk entry.
    *   The model wrote the SQL that named the columns, so this kind of typo is
        uncommon, and the error already suggests the right name.
*   **Reason for Rejection:** Rejected by author. Only case-only matches are
    repaired. If the tool-call log shows typos are common, this can be
    revisited with that evidence.

### Alternative G: Check column names from prepare metadata, without running

*   **Pros:** a save is fast on any data size, and has no 40-second budget
    problem.
*   **Cons:**
    *   It misses runtime errors: failed casts, division by zero, a file that
        changed since it was prepared.
    *   It cannot produce the "no rows" or "too many bars" warnings.
    *   The `@duckdb/node-api` version in use does not expose a prepared
        statement's result columns, so it would need a second `DESCRIBE`
        round trip anyway.
*   **Reason for Rejection:** Rejected by author. Running the query with the
    page's own 15-second limit means "saved" implies "works on the page".

--------------------------------------------------------------------------------

## Risks & Mitigations

| Risk | Category | Impact | Mitigation or accepted limit |
| --- | --- | --- | --- |
| A DuckDB upgrade changes lockdown behavior | Security | Queries could read or write files | Exact version pin. The attack suite (`test/security.test.ts`) must pass before the pin moves. |
| Attached `.duckdb` sources are locked against the user's writers | Failure mode | The user's pipeline fails with a lock error | Idle close after 20 s. A test writes to the file after the timeout. |
| A `.duckdb` source is held open for writing by another program | Failure mode | That source cannot be attached | Only that source's panels show DuckDB's lock error, until the writer closes it. Export to Parquet for concurrent access. |
| Tool results carry data to a hosted model provider | Privacy | Rows leave the machine through the agent, not through Overlook | Stated in Goals. `OVERLOOK_SAMPLES=0`. Users who need full locality use a local model. |
| Other local processes or users can read the `127.0.0.1` routes | Security | A process on the same machine can read dashboards and run their stored queries | Accepted for v1: it is a single-user tool, and those processes can already read the source files. |
| Two instances, each with a 2 GB memory ceiling | Scalability | Up to 4 GB under heavy queries | Accepted. The idle close frees memory. Queries spill to `OVERLOOK_HOME/tmp`. |
| Many open tabs or panels overload the web server | Scalability | Slow pages | At most 4 queries at once. Cancelled filter changes. 2 s polls read only an mtime. |
| The web server never exits | Operations | One idle Node process | Accepted (about 40 MB when idle, with DuckDB closed). `overlook stop` ends it. |
| The `sqlite` extension download | Supply chain | An extension from DuckDB's extension repository | It is the only download, done only on an explicit user action. DuckDB checks extension signatures by default, and Overlook never sets `allow_unsigned_extensions`. |
| `npx` installs an unpinned version | Supply chain | A changed package runs | The setup snippets that `doctor` prints pin the exact version. |
| The reference model misses 10 of 12 | Project | The mid-size claim fails | The eval results say which stage fails. Repairs and error text are tuned from those failures, and per-panel edit tools (Open Question 1) are next. The goal is then restated with the measured number. |

**Fixed limits:**

*   5,000 rows per panel;
*   24 panels and 6 filters per dashboard;
*   15 s per query, and 40 s per save check;
*   60 s glob refresh;
*   20 s idle close;
*   2 s page polling per open tab.

## Non-Functional Requirements

*   **Security & Privacy:** see the lockdown, the web server's safety rules,
    and Risks & Mitigations. No credentials are stored or handled in v1.
*   **Performance**, on the reference machine (a 4-core laptop CPU from 2022 or
    later, 16 GB RAM, SSD) with a 1M-row, 12-column CSV of about 90 MB:
    *   The MCP server answers `initialize` in under 1 second.
    *   A grouped panel query returns in under 2 seconds.
    *   An 8-panel dashboard is fully drawn in under 4 seconds.
    *   If the 8-panel target is missed on the reference machine, caching
        (Open Question 2) is next.
    *   The page bundle stays under 150 KB gzipped.
*   **Rollout & Rollback:**
    *   Every file has a `version`.
    *   History copies allow undo. In v1, that means copying a file from
        `history/<slug>/` back over `dashboards/<slug>.json` by hand.
    *   npm versions are pinned in the setup snippets that `doctor` prints.

--------------------------------------------------------------------------------

### Additional Resources

*   [Concepts brief](../concepts_brief.md): the brainstorm brief and its
    multi-lens review.
*   [Review reports](../reviews/): stage-by-stage EGM review findings.
*   [Securing DuckDB](https://duckdb.org/docs/stable/operations_manual/securing_duckdb/overview):
    `enable_external_access`, `allowed_paths` and `lock_configuration`.
*   [Codex MCP configuration](https://developers.openai.com/codex/mcp): the
    MCP server start-up timeout (`startup_timeout_sec`) defaults to 10 s.

### Future Improvements

*   **Per-panel edits:** add `upsert_panel` and `remove_panel` if the eval shows
    whole-spec rewrites drop panels.
*   **More charts:** pie and donut charts, heatmaps and maps.
*   **Postgres:** a read-only `ATTACH` with the connection string taken from an
    environment variable, plus `postgres_query()` passthrough so aggregation
    runs inside Postgres.
*   **Caching:** a short result cache for slow sources.
*   **Restore from history:** an `overlook restore <name>` command for the
    history copies.
*   **Inline view:** a view inside the agent through MCP Apps.

--------------------------------------------------------------------------------

## Detailed Implementation Plan

Every file below exists in the repository. v1 is one change set, so each one is
marked Create. The plan defines the contracts between modules first, then lists
the files.

### Order of Work and Checkpoints

The phases below are the order the code was built and the order to verify it.
Each phase ends with a check that must pass before the next one starts.

1.  **Spec and checks**: `src/spec/*`, `src/check.ts`.
    *   Checkpoint: `test/check.test.ts` passes.
2.  **Engine and lockdown**: `src/engine/engine.ts`, `src/config.ts`.
    *   Checkpoint: `test/engine.test.ts` and `test/security.test.ts` pass.
3.  **Store and MCP**: `src/store.ts`, `src/mcp/*`, `src/cli.ts`.
    *   Checkpoint: `test/store.test.ts` and `test/mcp.e2e.test.ts` pass.
4.  **Web server and page**: `src/server/*`, `ui/*`.
    *   Checkpoint: `test/server.test.ts` passes.
    *   Checkpoint: the manual browser check in the Verification Plan passes.
5.  **Eval**: `eval/*`.
    *   Checkpoint: `node dist/eval/run.js --dry` passes.

### Contracts

#### Query results (`src/engine/engine.ts`)

```text
ColumnInfo  { name: string, type: string /* DuckDB type, e.g. DECIMAL(18,2) */,
              kind: "number" | "date" | "text" | "boolean" | "other" }
QueryResult { columns: ColumnInfo[], rows: Record<string, unknown>[],
              truncated: boolean, ms: number }
RunOptions  { limit?: number = 5000 (max 100000), timeoutMs?: number = 15000,
              signal?: AbortSignal }
QueryError  extends Error { kind: "rejected" | "duckdb" | "timeout" | "params"
                                  | "cancelled" | "source" }
```

**How DuckDB types map to `kind`:**

| DuckDB type | `kind` |
| --- | --- |
| Any integer, `FLOAT`, `DOUBLE`, `DECIMAL` | `number` |
| `DATE`, `TIMESTAMP*` | `date` |
| `BOOLEAN` | `boolean` |
| `VARCHAR`, `UUID`, `ENUM`, `TIME`, `INTERVAL` | `text` |
| Lists, structs, maps and anything else | `other` |

**How values are converted to JSON:**

*   `number` values become JS numbers. A value outside the safe-integer range
    loses precision.
*   `DATE` values stay `YYYY-MM-DD` strings, and the page parses them as local
    dates.
*   Timestamps become `YYYY-MM-DDTHH:MM:SS`. A short `+00` offset becomes
    `+00:00`.
*   `other` values stay as DuckDB's JSON form.
*   `NULL` becomes `null`.

#### Check results (`src/spec/errors.ts`, `src/check.ts`)

```text
SpecError   { path: string /* "panels[1].y", 0-based */, message: string, fix?: string }
SpecWarning { path: string, message: string }
SpecRepair  { path: string, from: unknown, to: unknown, reason: string }
CheckOptions { budgetMs = 40000, perQueryMs = 15000, concurrency = 4, skipQueries = false }
PanelCheck  { id, type, ok, rows?, columns?: ColumnInfo[], ms?, error? }
CheckResult { ok, spec?: DashboardSpec /* only when ok */, errors: SpecError[],
              warnings: SpecWarning[], repairs: SpecRepair[], panels: PanelCheck[] }
```

`errors` are merged when their message and fix match, and sorted with filters
first, then panels in order. Replies show at most 8.

#### Lenient repairs (`src/spec/repair.ts`)

Each repair below is applied, then recorded in `repairs[]`:

*   **The spec arrives wrapped.**
    *   A JSON string, including one inside a fenced code block, is parsed.
    *   A bare array is taken as `panels`.
    *   `{"dashboard": {...}}` is unwrapped.
*   **`version` is missing or the string `"1"`.** It becomes the number `1`.
*   **`panels` is a JSON string.** It is parsed.
*   **The panel type uses an alias.** The type is lower-cased first. Aliases
    then map like this:
    *   `column`, `bar_chart` and `histogram` become `bar`.
    *   `timeseries` becomes `line`.
    *   `number`, `metric` and `card` become `kpi`.
    *   `markdown` becomes `text`.
    *   `pie`, `donut`, `map`, `heatmap` and `gauge` are errors, each with
        advice on what to use instead.
*   **The width uses an alias.** `wide` becomes `full`, `1/2` becomes `half`,
    and `narrow` becomes `third`.
*   **`stacked` or `horizontal` is a string.** `"true"` and `"false"` become
    booleans.
*   **A panel has no `id`.** One is made from the title or type, and made
    unique.
*   **The query is in `query`.** It is moved to `sql`.
*   **The SQL ends in a semicolon.** It is removed.
*   **A column name differs only in letter case.** It is fixed to match the
    result (pipeline step 5).

#### `config.json` (`src/config.ts`)

```text
{ version: 1,
  sources: { <alias>: {type: "file", path} | {type: "sqlite", path} | {type: "duckdb", path} },
  port?: number /* default 4777 */,
  samples?: boolean /* default true */ }
```

*   **Aliases** match `^[A-Za-z_][A-Za-z0-9_]{0,63}$`.
*   **Paths** are absolute, use forward slashes, and may be globs for `file`
    sources.
*   **Newer versions.** A config with a `version` newer than 1 is refused, and
    is never overwritten.
*   **Unknown keys** are kept when Overlook saves the file.

#### MCP tools (`src/mcp/tools.ts`, `TOOL_SPECS`)

The input schemas in `TOOL_SPECS` are the only definition. The MCP server and
the eval both use them.

*   **Result shape.** Every tool returns one text content block. A failure sets
    `isError: true` in a normal tool result, never as a protocol error.
*   **`describe_data`** returns one `## alias (type)` block per source. Each
    table in it gets a `table <ref> — N rows` line, one line per column (`name
    TYPE`), and sample rows when they are allowed.
*   **`preview_query`** returns three parts:
    *   `N [of M] rows in X ms`;
    *   `columns: name TYPE, ...`;
    *   a table with cells separated by pipes.
*   **`save_dashboard`**
    *   **On success:** `Created|Replaced dashboard "<title>"`, then the URL,
        an optional server note, the panel lines, repairs, warnings, and an
        optional "Also" list (removed panels, replaced title).
    *   **On failure:** `The dashboard was NOT saved. N problems to fix:`
        followed by the numbered errors.
*   **`get_dashboard`** returns the URL, the current status from a fresh check,
    and the stored spec as JSON. A spec with a newer `version` is refused.
*   **`list_dashboards`** returns one line per dashboard.
*   **`get_spec_reference`** returns the reference text.

#### HTTP API (`src/server/server.ts`)

Every response sends these headers:

*   `Content-Security-Policy: default-src 'self'; script-src 'self'; style-src
    'self'; img-src 'self' data:; font-src 'self'; connect-src 'self';
    base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;
*   `X-Content-Type-Options: nosniff`;
*   `X-Frame-Options: DENY`;
*   `Referrer-Policy: no-referrer`;
*   `Cross-Origin-Opener-Policy: same-origin`;
*   `Cross-Origin-Resource-Policy: same-origin`.

JSON responses also send `Cache-Control: no-store`.

| Request | Success | Errors |
| --- | --- | --- |
| any, with the wrong `Host` | | 403 `{error}` |
| any method except GET, HEAD or POST | | 405 |
| any POST with a foreign `Origin` | | 403 |
| any POST without `Content-Type: application/json` | | 415 |
| any POST with a body over 64 KB, or that is not JSON | | 413 / 400 |
| `GET /`, `GET /d/<slug>` | 200 HTML page | |
| `GET /assets/app.js`, `app.css`, `favicon.svg` | 200 | 404 for any other name |
| `GET /api/health` | `{app: "overlook", version, pid}` | |
| `GET /api/dashboards` | `{dashboards: [{slug, title, panels, mtimeMs, error?}]}` | |
| `GET /api/d/<slug>` | `{slug, spec, mtimeMs, sources: {alias: type}, sourceNames: {alias: file name}}` | 404 unknown; 422 invalid or newer file |
| `GET /api/d/<slug>/mtime` | `{mtimeMs: number \| null}` | |
| `POST /api/d/<slug>/panels/<id>` with `{params?: {filterId: string \| null}}` | `QueryResult` plus `ranAt` | 404 unknown panel; 400 text panel or bad param; 200 `{error, kind}` when the query fails |
| `GET /api/d/<slug>/options/<filterId>` | `{options: string[]}` | 404 unknown filter; 200 `{options: [], error}` when the query fails |
| `POST /api/shutdown` with `{}` | `{ok: true}`, then the server exits | |

**Panel route rules:**

*   **Unknown parameters** in `params` are ignored.
*   **Values** are strings of at most 200 characters, or `null`. A date filter
    value must match `YYYY-MM-DD`.
*   **Cancellation.** When the browser drops the request, the query is
    cancelled, whether it is waiting in line or already running.

#### CLI (`src/cli.ts`)

| Command | Flags | Exit code |
| --- | --- | --- |
| `mcp` | `--verbose` sends logs to stderr | runs until stdin closes |
| `serve` | `--port N`, `--quiet` | 0 if an Overlook server already holds the port; 1 if another program does |
| `source add <name> <path>` | `--type file\|sqlite\|duckdb` | 1 on a bad name, a missing file, or a source that does not open |
| `source list`, `source remove <name>` | | 0 |
| `validate <spec.json>` | `--json` prints the full `CheckResult` | 0 if valid, 1 if not |
| `open [name]` | | 0 |
| `stop` | | 0 |
| `doctor` | `--install` downloads the sqlite extension | 1 if the config or a source has an error |

An unknown command exits with 1.

#### Environment variables

| Variable | Default | Effect |
| --- | --- | --- |
| `OVERLOOK_HOME` | `~/.overlook` | Folder for the config, dashboards, history, logs, temp files and extensions |
| `OVERLOOK_PORT` | `config.port`, else 4777 | Web server port |
| `OVERLOOK_SAMPLES` | unset | `0` hides sample rows and `1` forces them on; this beats `config.samples` |
| `OVERLOOK_NO_SERVE` | unset | `1` stops the MCP server from starting the web server |
| `OVERLOOK_IDLE_MS` | 20000 | Idle time before an instance closes |
| `OVERLOOK_CLI` | the package's `dist/src/cli.js` | Script started for `serve` (tests only) |
| `OVERLOOK_UI_DIR` | the package's `dist/ui` | Where page assets are served from (tests only) |
| `OVERLOOK_EVAL_BASE_URL` | `http://localhost:11434/v1` | Eval model endpoint |
| `OVERLOOK_EVAL_MODEL` | none (required) | Eval model name |
| `OVERLOOK_EVAL_API_KEY` | none | Sent as `Authorization: Bearer` |
| `OVERLOOK_EVAL_RUNS` | 3 | Runs per prompt |
| `OVERLOOK_EVAL_TEMPERATURE` | 0.3 | Sampling temperature |

The eval's 32k context is set on the Ollama server with
`OLLAMA_CONTEXT_LENGTH=32768`, because the OpenAI-compatible endpoint cannot
set it per request.

#### Dependencies (`package.json`, locked by `package-lock.json`)

*   **Runtime:**
    *   `@duckdb/node-api` `2.0.0-r.1` (exact);
    *   `@modelcontextprotocol/sdk` `^1.32`;
    *   `zod` `^4.6`.
*   **Dev:**
    *   `typescript` `^7`;
    *   `vitest` `^5`;
    *   `esbuild` `^0.28`;
    *   `@types/node`;
    *   `lucide` (icons) and `@fontsource-variable/inter` (the font file),
        both bundled into or shipped with the page;
    *   the d3 modules (`d3-array`, `d3-scale`, `d3-shape`, `d3-format`,
        `d3-time-format`) and their types. These are bundled into the page,
        so they are not runtime dependencies.
*   **Build settings:**
    *   `tsconfig.json`: `NodeNext`, `ES2023`, `strict`,
        `noUncheckedIndexedAccess`, output in `dist/`.
    *   `tsconfig.ui.json`: DOM libs, `Bundler` resolution, no emit.
    *   esbuild builds the page as minified IIFE for ES2022.

### Target Files to Create/Modify

#### 1. `package.json`, `tsconfig.json`, `tsconfig.ui.json`, `vitest.config.ts`, `.gitignore`, `LICENSE` (Create)

*   **Type / Scope:** build configuration.
*   **Proposed Changes:**
    *   ESM package `overlook-dash`, with a `bin` entry named `overlook`, for
        Node 22 or later.
    *   `@duckdb/node-api` pinned exactly to `2.0.0-r.1`.
    *   Scripts:
        *   `build`: tsc, then `scripts/build-ui.mjs`;
        *   `typecheck`: tsc for both, with no output;
        *   `pretest`: the build;
        *   `test`: vitest;
        *   `eval`: the eval runner.
    *   Licensed under MIT.

#### 2. `scripts/build-ui.mjs`, `scripts/make-examples.mjs`, `scripts/demo.mjs` (Create)

*   **Type / Scope:** build and demo scripts.
*   **Proposed Changes:**
    *   **`build-ui.mjs`.** esbuild bundles `ui/main.ts` and `ui/styles.css` into
        `dist/ui/app.js` and `dist/ui/app.css`.
    *   **`make-examples.mjs`.** Writes the seeded example CSVs, `orders` and
        `traffic`.
    *   **`demo.mjs`.** Registers those CSVs in `./.demo` and saves
        `examples/revenue-overview.json` through `checkDashboard`.

#### 3. `src/spec/schema.ts`, `src/spec/errors.ts`, `src/spec/repair.ts`, `src/spec/reference.ts` (Create)

*   **Type / Scope:** the spec.
*   **Proposed Changes:**
    *   **`schema.ts`.** zod schemas: one per panel type, `Filter`, the
        top-level shape, and the full `Dashboard`, plus `SPEC_VERSION`.
    *   **`errors.ts`.** The `SpecError` type, conversion of zod issues into
        errors, case-only column matching, "did you mean" suggestions, and
        error formatting capped at 8.
    *   **`repair.ts`.** The lenient front door (pipeline step 1).
    *   **`reference.ts`.** The `get_spec_reference` text.

#### 4. `src/config.ts`, `src/log.ts`, `src/version.ts` (Create)

*   **Type / Scope:** core utilities.
*   **Proposed Changes:**
    *   **`config.ts`.**
        *   `OVERLOOK_HOME` and the source config: load, save and add.
        *   Source type inference from the file extension.
        *   Glob expansion.
        *   An atomic write that tolerates Windows sharing violations.
    *   **`log.ts`.** A logger that writes to stderr and a file, never to
        stdout, and rotates at 5 MB.
    *   **`version.ts`.** The package version and semver comparison.

#### 5. `src/engine/engine.ts` (Create)

*   **Type / Scope:** the query engine.
*   **Proposed Changes:**
    *   **`Engine`**, with:
        *   `open(config)`, which applies the lockdown steps, turning off
            extension auto-install and auto-load before any source attaches;
        *   `describe()`;
        *   `parameters()`;
        *   `run(sql, params, RunOptions)`;
        *   `rawConnectionForSecurityTests()`.
    *   **`EngineHolder`**, which follows "When an instance opens, re-opens
        and closes" exactly, plus one more rule: an instance with a failed
        source re-opens after 10 s, so a temporarily locked or missing file
        recovers. A retired instance closes only once no query is running and
        none started in the last 5 s.
    *   **`installExtensions()`.**

#### 6. `src/check.ts` (Create)

*   **Type / Scope:** the checking pipeline.
*   **Proposed Changes:** `checkDashboard(input, engine, options?) →
    CheckResult`, `summarizeCheck()` and `filterDefaults()`.

#### 7. `src/store.ts` (Create)

*   **Type / Scope:** dashboard files.
*   **Proposed Changes:**
    *   save, with history;
    *   load, with the version guard;
    *   list;
    *   the slug rules;
    *   the dropped-panel comparison.

#### 8. `src/server/server.ts`, `src/server/control.ts` (Create)

*   **Type / Scope:** the web server.
*   **Proposed Changes:**
    *   **`server.ts`.** `startServer({port})` with the routes, safety rules
        and a 4-query limit, plus `serveCommand()`.
    *   **`control.ts`.** `ensureServer()`, `probe()` and `shutdownServer()`.

#### 9. `src/mcp/server.ts`, `src/mcp/tools.ts` (Create)

*   **Type / Scope:** the MCP adapter.
*   **Proposed Changes:**
    *   **`server.ts`.** The six tools registered on `McpServer` over stdio,
        with server instructions.
    *   **`tools.ts`.** Their text-returning handlers, which the eval runner
        also uses.

#### 10. `src/cli.ts` (Create)

*   **Type / Scope:** the CLI.
*   **Proposed Changes:**
    *   **Commands.** `mcp`, `serve`, `source add|list|remove`, `validate`,
        `open`, `stop` and `doctor [--install]`.
    *   **`source add` type.** The type comes from the extension and can be
        overridden with `--type`. The `sqlite` extension is downloaded only
        when a sqlite source is added.

#### 11. `ui/main.ts`, `ui/charts.ts`, `ui/panels.ts`, `ui/format.ts`, `ui/markdown.ts`, `ui/dom.ts`, `ui/styles.css`, `ui/favicon.svg` (Create)

*   **Type / Scope:** the browser bundle.
*   **Proposed Changes:**
    *   **`main.ts`**
        *   **Routing.** `/` is the list page and `/d/<slug>` is a dashboard.
        *   **Theme.** It follows the system setting, a toggle overrides it,
            and the choice is kept in `localStorage` under `overlook-theme`.
        *   **Filter bar.**
            *   A select gets an "All" option, which binds `NULL`.
            *   A text filter is debounced by 400 ms.
            *   A date filter uses a native date input.
            *   Filter values are synced to the URL query string, omitting any
                that equal the default.
            *   A Reset button appears only when a value differs from its
                default.
        *   **Panel runs.** Each run has an `AbortController`, and a new run
            aborts the previous one.
        *   **Live reload.** The page polls the mtime every 2 s while the tab
            is visible, and re-fetches when it changes.
        *   **Panel footers** show rows, ms and time since the last run, and
            update every 15 s.
    *   **`charts.ts`**
        *   **Types.** Bar (vertical, horizontal, grouped, stacked), line,
            area (stacked or not) and scatter, drawn to the mark specs in the
            Technical Plan.
        *   **Colors.** Every chart starts at color slot 1. Slots are kept per
            series name for the page's lifetime.
        *   **Many series.** Past 8 series, the smaller ones fold into "Other":
            bars and areas sum them, lines drop them with a note, and scatter
            charts cap at 3 slots and pool the rest of the points into "Other".
        *   **Labels.** Lines and areas get end labels for 2–4 series when the
            chart is at least 480 px wide and the labels do not collide.
        *   **Hover.** Bars get a hover band and tooltip per category, lines
            and areas get a crosshair, and scatter points get the nearest point
            within 24 px.
    *   **`panels.ts`**
        *   KPI tiles: the value, plus a delta chip colored by `better`.
        *   Tables: sortable, showing at most 500 rows.
        *   CSV export. A text cell that starts with `=`, `+`, `-`, `@`, a tab
            or a carriage return gets a leading `'`, so spreadsheets never run
            data as a formula. Numbers are unchanged.
    *   **`format.ts`.** Number formats (`number`, `compact`, `currency`,
        `percent`). One date format is picked per axis.
    *   **`markdown.ts`.** Markdown is rendered by building DOM nodes, never
        through `innerHTML`. Links are kept only for `http(s)`, and open with
        `rel="noopener noreferrer"`.
    *   **`styles.css`.** Role tokens, the validated palette in light and dark
        steps, the layout, and the loading and error states. Colors are CSS
        classes, because the CSP blocks inline style attributes.

#### 12. `eval/run.ts`, `eval/prompts.json` (Create)

*   **Type / Scope:** the eval runner.
*   **Proposed Changes:**
    *   The runner described in the Eval section.
    *   12 prompts over `examples/data`.
    *   `--dry` and `--only=<id>` modes.

#### 13. `examples/revenue-overview.json`, `examples/data/*` (Create)

*   **Type / Scope:** examples and fixtures.
*   **Proposed Changes:**
    *   A full example dashboard covering KPIs with comparison, a stacked area,
        horizontal and stacked bars, a multi-series line, a table, text and
        both filter types.
    *   The generated data it reads.

#### 14. `test/helpers.ts`, `test/engine.test.ts`, `test/check.test.ts`, `test/security.test.ts`, `test/store.test.ts`, `test/server.test.ts`, `test/mcp.e2e.test.ts` (Create)

*   **Type / Scope:** vitest.
*   **Proposed Changes:**
    *   **`engine.test.ts`.**
        *   query results and value conversion;
        *   parameter binding, including NULL;
        *   the timeout;
        *   14 lockdown cases.
    *   **`check.test.ts`.** Every pipeline stage, including:
        *   case-only repair;
        *   typo suggestions;
        *   the budget;
        *   warnings;
        *   filter checks.
    *   **`security.test.ts`.** This is the upgrade gate.
        *   DuckDB's own lockdown, tested on a raw connection with no Overlook
            checks in front. It must block reading other files, glob,
            `COPY TO`, `ATTACH`, `INSTALL` and `LOAD`, re-enabling external
            access, unlocking the configuration, widening `allowed_paths`,
            allowing unsigned extensions, and http reads;
        *   the same attacks through Overlook's checks, with every allowed
            leading keyword;
        *   the spill directory;
        *   the row cap keeping `ORDER BY` and accepting trailing `;` and `--`;
        *   string-to-integer binding;
        *   the idle close releasing a `.duckdb` lock so another writer can
            write;
        *   per-source failure isolation;
        *   a replaced file whose columns are re-detected;
        *   files with a byte-order mark;
        *   slug guards.
    *   **`store.test.ts`.**
        *   history pruning and safe file names;
        *   the spec and config version guards;
        *   unknown config keys being kept;
        *   unsafe slugs;
        *   the engine re-opening on a config change, and retrying a failed
            source;
        *   query cancellation through `signal`, with `inflight` returning to 0;
        *   `probe()` telling "none" from "other";
        *   `OVERLOOK_NO_SERVE`.
    *   **`server.test.ts`.**
        *   Host check;
        *   CSP;
        *   title escaping;
        *   the JSON-only and Origin rules;
        *   undeclared params ignored;
        *   404s and the invalid-file 422;
        *   the mtime and list routes.
    *   **`mcp.e2e.test.ts`.** Drives the built `overlook mcp` over stdio with
        the official SDK client.
        *   tool list and description budget;
        *   describe, preview, a refused save, then the fixed save;
        *   `get_dashboard` status;
        *   the removed-panel warning;
        *   stdout carrying only protocol messages;
        *   the first `initialize` reply arriving in under 3 s, Node start-up
            included. This is a loose bound so CI machines pass. The 1-second
            NFR is measured on the reference machine with `node
            scripts/bench.mjs`.
    *   **Not covered by automated tests:** the page itself (charts, layout,
        markdown rendering in a browser). The manual browser check covers it.
    *   **Upgrade gate.** All of `security.test.ts`, plus the replaced-file
        re-detect test in the same file, must pass before the
        DuckDB pin moves.

#### 15. `README.md`, `docs/designs/overlook.md`, `docs/concepts_brief.md`, `docs/reviews/*` (Create)

*   **Type / Scope:** documentation.
*   **Proposed Changes:** the README covers setup for each agent, sources, the
    tools, the spec, the security model and development. The docs folder
    holds this design, the brief and the review reports.

### Verification Plan

*   **Compilation/Build:** `npm run build`.
*   **Unit and Integration Tests:** `npm test`. It runs the build, then all six
    test files.
*   **Static Analysis:** `npm run typecheck`, which runs `tsc --noEmit` with
    `strict` and `noUncheckedIndexedAccess` for both `src/` and `ui/`.
*   **Test Coverage Requirement:**
    *   every pipeline stage and every lockdown rule has at least one test;
    *   every Risks row that names a test has that test.
*   **E2E/Integration:**
    *   The stdio MCP test, run by `npm test`.
    *   **Manual browser check:**
        1.  Run `node scripts/make-examples.mjs`.
        2.  Run `node scripts/demo.mjs`, which writes to `./.demo`.
        3.  Run `OVERLOOK_HOME=.demo node dist/src/cli.js serve` (PowerShell:
            `$env:OVERLOOK_HOME=".demo"`).
        4.  Open `http://127.0.0.1:4777/d/revenue-overview`.
        5.  Check it in both themes and at 400 px against the visual baseline:
            hover every chart, open Source and Table, change both filters, and
            edit the JSON file to see the live reload.
    *   **Performance:** `node scripts/bench.mjs` times three things against a
        generated 1M-row, 12-column CSV, and compares them with the NFR
        targets:
        *   MCP `initialize`;
        *   a grouped query;
        *   an 8-panel dashboard check.
    *   **Eval:**
        *   `node dist/eval/run.js --dry` checks the prompts without a model.
        *   The full eval runs against the reference model when one is
            available.

--------------------------------------------------------------------------------

*Drafted with EGM*
