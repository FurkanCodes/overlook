# Stage 6: Comprehension Test

*   **Target:** `docs/designs/overlook.md`
*   **Reviewer:** egm-comprehension (fresh context, no document standard)
*   **Result:** 0 Blockers, 5 Majors, 12 Nits

## What this proposes

Overlook is a new open-source npm package, `overlook-dash`, with one command,
`overlook`. It lets any agent that supports MCP (Claude Code, Codex CLI,
OpenCode and others) build live dashboards over local CSV, Parquet, JSON,
SQLite or DuckDB files.

The model never writes HTML. It writes a small JSON spec: a title, optional
filters, and up to 24 panels. Each panel has one SQL SELECT, a chart type from a
fixed list, and the columns to plot.

When a dashboard is saved, a six-step pipeline checks it:

1.  Lenient repair.
2.  zod schema check.
3.  Reference check.
4.  Running every query in DuckDB.
5.  Checking that chart fields exist with suitable types.
6.  Warnings.

It fixes unambiguous typos and returns at most eight short errors the model can
act on.

Saved dashboards are plain JSON files under `~/.overlook/`. A local web server
on 127.0.0.1:4777 re-runs each panel's stored SQL every time the page loads,
draws the charts with d3, and polls for file changes so agent edits show up
live. Both processes run DuckDB locked down, so it has no network access and can
only read the registered files. An eval runner measures how well mid-size local
models (30B-class) can use the tools.

## How the existing system works, per this document

There is no existing Overlook system; this is a new build.

The reference for features is "Claude's dashboards", Anthropic's dashboard
type. It works only inside claude.ai, with Claude models, through cloud
connectors. Its useful behaviour includes:

*   live queries;
*   visible sources for every number;
*   filters;
*   KPI tiles, charts, tables and text;
*   errors reported back to the model.

Outside that product, the usual workaround is asking an agent to write HTML or a
Streamlit app. Nothing checks that output, mid-size models write it badly, and
every dashboard is a one-off program. Each existing tool covers only part of the
problem:

*   **Vizro-MCP** produces Dash code.
*   **AntV** renders on a hosted service.
*   **Grafana and Metabase** are heavy account-based servers.

## Findings

### Major

1.  **`columns` is not in the Panel spec.** The field check lists `columns`, but
    the Panel spec block doesn't include it, so a reader can't tell whether
    tables can choose which columns to show.
2.  **The repair-rule examples don't match the rule.**
    *   **CUJ 2's `rev_2023`/`rev_2024` example.** "revenu" is refused because
        there are no close matches, not because there are two.
    *   **`cost` vs `count`.** The 3-character rule doesn't apply to `cost`,
        which has 4 characters. The real reason is that the change takes 2
        edits, over the 1-edit limit.
    *   **Whose length?** The rule doesn't say whether the edit limit depends on
        the length of the name the model wrote or of the column.
3.  **Eval counts and pass criteria conflict.**
    *   The Goals say 12 prompts; the Detailed plan says 10.
    *   The goal measures "valid and executable", while the Eval section's pass
        requires matching `check_sql`.
    *   "Try" is never defined.
4.  **DuckDB in the MCP process is unclear.**
    *   The diagram shows DuckDB only under `serve`.
    *   It's unclear whether the MCP process reopens when `config.json` changes.
    *   Glob expansion happens at open time, so it matters when each process
        reopens.
5.  **The shutdown route and Origin rule are incomplete.**
    *   `POST /api/shutdown` is missing from the Routes list.
    *   The Origin rule ("requests that change state come from the page") does
        not fit shutdown, which comes from the MCP process.
    *   The document doesn't say why the panel route is a POST.

### Nit

6.  **Rows entered on the page.** "Rows people enter on the page" is unclear.
7.  **MCP Apps.** "MCP Apps" is not defined.
8.  **Filter `source` comment.** It says "options come from this query", but
    `source` is an alias.
9.  **`series` with a `y` array.** Whether the two can be combined is unclear.
    The `compare` display (absolute or percent) is also unclear.
10. **Index base.** Path indexes like `panels[1]` don't say whether they count
    from 0.
11. **How `source add` picks a type.**
    *   The command doesn't say how it chooses the source type, and `.db` is
        ambiguous.
    *   It doesn't say whether the extension download happens on every add.
12. **Server replacement.**
    *   The document doesn't say how a `serve` process that fails to bind tells
        Overlook apart from another program.
    *   Two agents on different versions would keep replacing each other's
        server.
    *   A stale lock after a crash is not handled.
13. **Run time on the panel.** The goal says panels show run time, but the
    footer omits it.
14. **"A shared link".** It works only on the same machine.
15. **Undo.** "History allows undo", but there is no restore command in v1.
16. **`checkDashboard` signature.** It differs between the Technical Plan and
    the Detailed plan.
17. **Detailed plan gaps.**
    *   The rule that turns bigints into numbers or strings is not stated.
    *   `dev` and `open` are undescribed.
    *   Additional Resources has no URLs.
    *   Two names can produce the same slug, so one dashboard can silently
        overwrite another.

## Resolution

All five Majors and every Nit were fixed in the design document before Stage 7.
