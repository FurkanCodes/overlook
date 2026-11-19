# Model-Agnostic Live Dashboards over MCP

* **Author:** furkancodes
* **Date:** 2026-11-19

## Overview

This is an open-source tool that lets any coding agent build live dashboards from data on your own machine, whatever model the agent runs.

It is one package with two commands:

* `mcp` is a small MCP server that the agent talks to. MCP is the standard most coding agents use to call outside tools.
* `serve` is a local web server that draws the dashboards in your browser.

The agent's model does not write HTML. It writes a short JSON description of the dashboard. Each panel holds one SQL query plus a chart type and the columns to plot. Before saving, the tool checks that JSON against a schema, runs every query against your data through DuckDB (a local SQL engine that reads CSV, Parquet, SQLite and Postgres), and confirms the chart columns exist. Each problem it finds comes back as a short, specific error the model can fix. A dashboard is a plain JSON file on disk. It re-runs its queries each time you open or refresh it, so it never holds a stale copy of the data.

**Target user:** solo developers and analysts who want AI-built dashboards outside Anthropic's own product. That product only works in claude.ai with Claude models, and the data goes to the cloud. These users run other agents (Codex CLI, OpenCode, Cursor), other models, or local models through Ollama, and want their data to stay on their own machine.

**What makes it different from existing tools:** it works in any MCP-capable agent, queries several kinds of data source live through DuckDB, uses a spec small enough for mid-size local models, and comes with a test suite that measures quality across model families.

## Analysis

All seven review lenses ran. They agree that the concept holds up, but six things must be settled before any code is written. The first six points below are those six.

### 1. A schema check only proves the JSON is well-formed, not that the dashboard is right

Small models rarely fail on JSON shape. They fail on meaning:

* column names that don't exist;
* SQL that DuckDB rejects;
* a chart field the query doesn't return;
* a date axis on a text column;
* empty results, or 4,000 bars in one chart.

A schema check passes all of these. So the brief now defines three levels:

* **Valid:** the JSON passes the schema.
* **Executable:** every query runs, and returns columns that fit its chart.
* **Correct:** the query results match the stored correct results for that test prompt, using test data kept in the repo.

Checking happens in one save step, in this order:

1. Lenient repair, which always reports what it changed.
2. Schema check.
3. A dry run of each query in DuckDB, with a row limit and a timeout.
4. A check that each chart field exists in the query's output with a type that fits.
5. Warnings that don't block saving, such as zero rows or too many categories.

### 2. The MCP process is too short-lived to host the dashboards

Most agents start a fresh MCP server per session over standard input/output (stdio) and kill it when the session ends. A web server inside that process would take the dashboard down when you close the agent. Two agents running at once would also fight over the port and the data.

Decision:

* Dashboards are plain JSON files in one user-level folder. The files are the only record; there is no metadata database.
* `mcp` and `serve` share only that folder.
* `mcp` checks whether `serve` is running (a lockfile plus a health check) and starts it in the background if not.
* Each process opens DuckDB in memory and attaches data sources read-only, so neither ever needs a write lock.
* Files are written atomically: write to a temp file, then rename it.

Two lenses preferred a daemon that owns the store, with `mcp` calling its API. The shared folder won because:

* there is no API between the processes to build;
* nothing is lost if a process crashes;
* dashboards work with git and can be edited by hand.

### 3. SQL written by the model runs with your full file and network access

Without limits, DuckDB SQL can:

* read any file (for example `read_csv('~/.ssh/...')`);
* write files with `COPY ... TO`;
* install extensions;
* reach the network;
* attach any database.

Prompt injection can also arrive inside data cells. Separately, any web page you visit can send requests to a server on localhost.

The fix is a few lines of setup, not a security project:

* **DuckDB:**
  * Attach only the declared sources, read-only.
  * Turn off automatic installing and loading of extensions.
  * Block access to anything outside the allowed paths, then lock the configuration.
  * Accept exactly one `SELECT` or `WITH` statement per panel, checked by parsing the SQL.
  * Put a timeout and a row cap of about 5,000 on every query.
* **Web server:**
  * Listen on 127.0.0.1 only, and check the Host header.
  * Send no CORS headers, and use a strict Content Security Policy.
  * Render all data as text, never as HTML.
* **Browser API:** it only runs queries already stored in a dashboard, looked up by dashboard ID. It never accepts SQL or file paths.

The design document gets a short threat-model section covering this.

### 4. "Your data stays local" is only partly true

With a cloud model, which is the default in Claude Code and Codex, everything a tool returns goes to that model provider: table structure, sample rows, previews, and error messages (DuckDB errors often quote data values). Overclaiming here would cost trust.

* **New claim:** "This tool never uploads or copies your data. The model sees only what the tools return, and you control that."
* **Where results go:** query results reach the browser straight from the local server and never pass through the model.
* **Default:** tools return column names, types and row counts.
* **Settings:** sample rows are an opt-in setting. A schema-only mode also removes data values from error text.

### 5. The model needs tools to look at the data before it writes

With only create and update tools, the model has to guess column names. No validator can stop that guessing.

Two decisions follow:

* **Read tools are added:** `describe_data` and `preview_query`.
* **Data sources move out of the model's reach.** They are registered in a user config file or through the CLI, not by a model tool. Specs refer to a source by a short alias, and Postgres passwords come from environment variables. Otherwise passwords would end up in chat transcripts and provider logs, and the model could widen what the server can reach.

### 6. Measure quality with a script, not by hand

"Passes about 30 prompts" has no pass rule. Running 30 prompts × 2 models × 3 agents by hand is about 180 runs per round, which won't keep happening at 5–10 hours a week. Results inside an agent also mix the agent's own overhead with the quality of this design.

The eval:

* is a plain script that talks to models directly through an OpenAI-compatible API, and uses the same tool definitions and checking code as the server;
* uses at least one local model (about 30B through Ollama) plus one hosted model family;
* scores each prompt on three things: valid within 3 retries, executable, and query results that match the stored correct results;
* runs each prompt 3 times, with model version, quantization, context size, temperature and seed all pinned;
* records retries and tokens per prompt.

The three agents get only a short scripted smoke test, run through `claude -p`, `codex exec` and `opencode run`. It checks that the package installs, the tools are listed, a dashboard can be created, its URL opens, it can be edited, and a bad edit gets fixed.

### Main contradiction and how it's resolved

Every feature added to the spec costs tokens and creates new ways for a small model to fail. The fix is to split the work:

* All the analysis lives in SQL, which models of every size know far better than any chart format.
* The chart part of the spec stays flat and tiny.
* The model chooses columns and chart types from lists the server built by inspecting the data, so it never has to recall names.
* The server turns the spec into Vega-Lite, an existing chart format, and fills in data types, sort order and layout.

A model can't see the dashboard it made. Instead, the server describes what it rendered: row count, number of distinct x values, empty y values, the first few rows. Problems come back as warnings with a suggested fix.

**Ideal end result:** the model only states what it wants, using the column names of your own data. The server does the rest: encoding, layout, checking, repair, refresh, and confirming the result makes sense. A successful tool call means the dashboard shows something sensible. Most small-model mistakes get fixed without a retry.

### Other decisions from the review

* **Spec v1:**
  * The top level has `version`, `title` and `panels[]`.
  * Each panel has `id`, `title`, `source`, `sql`, `type`, `x` and `y`, plus optional `series` and `width` (full or half).
  * `type` is one of: kpi, table, bar, line, area, scatter.
  * A 5-panel dashboard is about 1–2 KB.
  * The JSON schema, the tool descriptions and the renderer's types are all generated from one definition.
  * `version` is required from the first commit.
* **Error format:**
  * Errors come back as a normal tool result marked `isError: true`, not as a protocol error, which some agents never show to the model.
  * At most 3–5 errors per reply, most important first. Each gives the JSON path, what was expected, what was received, the allowed values or real column names, and a one-line fix.
  * DuckDB's own errors pass through unchanged, because they already list similar column names.
  * Snapshot tests fix the wording, because changing it changes eval scores.
* **Context budget for small models:**
  * Each tool's input schema stays shallow: a `name` string plus a `spec` object or string. All real checking happens on the server.
  * All tool descriptions together stay around 1.5–2k tokens, and each tool reply around 1k tokens.
  * Full reference docs and examples sit behind a `get_spec_reference` tool.
  * Setup docs require an Ollama context size (`num_ctx`) of at least 16–32k.
* **Updates:**
  * `save_dashboard` creates or fully replaces a dashboard, and keeps the last few versions on disk so you can undo.
  * Panels have stable ids from day one, so per-panel edit tools can be added later if the eval shows small models dropping panels.
  * Never JSON Patch.
* **"Live" means:**
  * queries re-run when the page loads and when you press refresh;
  * an open tab watches the dashboard file and reloads when the model edits it;
  * there are no websockets, schedules or caches in v1.

  "Refresh" means new data and "edit" means a changed spec.
* **Postgres:** the extension that reads Postgres from DuckDB pulls rows over the network and aggregates them locally. Panels can use `postgres_query()` so the aggregation runs inside Postgres.
* **Broken dashboards:** each panel shows its own error (source, query, DuckDB message) while the other panels still render. The page shows the last refresh time. `get_dashboard` returns each panel's last error so the next session's model can fix it.
* **Debugging:**
  * Logs go only to stderr and a log file, because any stray output on stdout breaks the MCP connection. A CI test enforces this.
  * A local JSONL log records every tool call.
  * A `doctor` command checks extensions, the web server, each data source, and prints a setup snippet for each agent.
  * Nothing is sent home.
* **Structure:**
  * One core library holds the config, DuckDB access, checking, file storage and rendering.
  * The CLI, the MCP tools and the eval script all call that same library.
  * The CLI also works as a fallback in any agent whose MCP support is unreliable.

### Claims to verify before they go into the design doc

The reviewers had no web access, so these come from memory:

* how Vizro-MCP and Rill's MCP server work;
* whether AntV's chart MCP server sends data to a hosted renderer by default;
* Ollama's default context size;
* Codex's MCP startup timeout;
* the exact DuckDB setting names (`enable_external_access`, `allowed_directories` or `allowed_paths`, `lock_configuration`) in the pinned version.

## Goals vs. Non-Goals

* **In-Scope Goals:**
  * MCP tools:
    * `describe_data`: sources, tables, columns, types, row counts, and samples only if allowed;
    * `preview_query`: about 50 rows;
    * `save_dashboard(name, spec)`: create or replace, with full checking; returns the URL or a list of errors;
    * `get_dashboard`: the spec plus each panel's last error;
    * `get_spec_reference`, optional.
  * Data sources declared in a user config file and referred to by alias. CSV and Parquet first, then SQLite, then Postgres.
  * Spec v1 as described above, with SQL inside each panel.
  * A localhost renderer: one static HTML page using Vega-Lite, with libraries bundled locally (no CDN, no React or build step).
  * Dashboards stored as plain versioned JSON files that can be edited by hand.
  * The SQL and web security baseline from day one.
  * Tested in Claude Code, Codex CLI and OpenCode. Expected to work, but not tested, in Cursor, Goose and Claude Desktop.
  * Scripted eval with the three levels (valid, executable, correct), at least one local model of about 30B, and one hosted model family.
  * **Success at 6 months:**
    * the author uses it every week on their own data;
    * it passes the smoke tests in all three agents;
    * the eval meets a target score, to be set after the first measurement.
* **Out-of-Scope Non-Goals:**
  * User accounts, sharing and permissions.
  * Scheduled reports.
  * A hosted cloud version.
  * Filters, parameters, cross-filtering, grid layouts, themes, export, caching, websockets.
  * Screenshot feedback to the model.
  * Inline UI inside the agent (MCP Apps).
  * A raw Vega-Lite escape hatch.
  * Any vendor branding in package, tool, UI or doc names, enforced by a CI check.
  * Claiming 7–8B models as a success criterion. That stays a stretch goal, measured on a set of simple prompts.

## Alternatives Weighed

* **Raw Vega-Lite or ECharts as the spec:** rejected. The schema is far too large for small models, its errors are unreadable, and saved files would be tied to library versions.
* **Model writes HTML, Streamlit or notebook code:** rejected. It is unchecked code running with no structured error signal. Avoiding this is the main idea of the project.
* **ECharts as the renderer:** rejected for v1. It looks better, but has no official schema, so the compiler would do more work. Only one renderer will be supported.
* **Evidence-style Markdown plus SQL:** rejected for v1. Checking is weaker, it needs a Node build, and it copies data at build time. The SQL-first idea is borrowed.
* **Building on Vizro-MCP or Lumen, or generating Rill YAML:** not decided yet. These are the closest existing tools. One evening of comparison testing decides it (see staging).
* **Grafana with its MCP server:** rejected. The dashboard JSON is huge, it is heavy to run, and it needs data-source plugins.
* **Metabase or Superset:** rejected. They are heavy servers built around accounts and permissions, which are non-goals. Metabase is AGPL-licensed.
* **Vanna (text-to-SQL):** rejected. The agent's model already writes SQL.
* **Chart-image MCP servers (AntV, Vega-Lite MCP):** rejected as a base. They make one-off charts with the data passed in the call. Kept as prior art to study.
* **One long-running daemon speaking MCP over HTTP:** rejected for v1. Setup differs per agent and it needs an always-on service. Files plus stdio are simpler.
* **A daemon that owns the dashboard store:** rejected. Shared files avoid an API between the processes and survive crashes.
* **A step-by-step wizard of small tools:** rejected as the main path. It means many round trips and more tool text in the context. It may come back later as a fallback for very small models.
* **A structured query form (dimensions and measures instead of SQL):** deferred. A field is reserved so it can be added later without breaking files.
* **JSON Patch updates:** rejected. Small models get it wrong. Full replace now, per-panel edits later if needed.
* **DuckDB-WASM in the browser:** rejected. It copies data into the browser.

## Key Decisions & Staging for Next Steps

**Decide before writing code:**

1. Spec v1 shape and its `version` field.
2. Error format.
3. Eval scoring rule.
4. Files plus two processes layout.
5. SQL sandbox rules.
6. **Language.** Still open. Python has the most mature DuckDB binding, plus Pydantic, FastMCP and `uvx` installs. TypeScript has one language for the server and the browser, the MCP TypeScript SDK, `@duckdb/node-api` and ajv. Pick the one you are fastest in.

**Stages.** Each stage ends with something that works:

* **Weeks 1–4:**
  * Spec v1, the checker and error format, and a CLI `validate` command.
  * CSV and Parquet test data, and about 10 prompts with stored correct results.
  * The eval script, run against Ollama plus one hosted model.
  * A comparison against Vizro-MCP and against an agent writing Evidence or Rill files directly.
  * **Gate:** a measured score. If an existing tool already passes, change direction to a thin layer on top of it.
* **Weeks 5–8:**
  * The MCP front end: stdio, stderr-only logging, a call log.
  * The `describe_data` and `preview_query` tools.
  * Working in Claude Code first.
* **Weeks 9–12:**
  * `serve` and the Vega-Lite renderer, with per-panel errors.
  * **Gate:** the author uses it weekly on real data.
* **Weeks 13–18:**
  * The repair layer and warnings, tuned from eval failures.
  * Smoke tests in Codex CLI and OpenCode.
  * SQLite support.
* **Weeks 19–26:**
  * Postgres: read-only, `postgres_query()` passthrough, and `doctor` for extensions.
  * Grow the suite to 30 prompts and add the second model family.
  * Per-panel edit tools only if the eval shows they are needed.
