# Changelog

## 0.1.0 (preview)

The first public release. Overlook is an MCP server and CLI. It lets any coding
agent, with any model, build live dashboards from local data and open them in
the browser at `http://127.0.0.1:4777`.

*   **Tools:**
    *   `auto_dashboard`: one call finds the data, builds a dashboard, checks
        every query, saves it and opens it.
    *   `describe_data`, `preview_query`, `save_dashboard`, `get_dashboard` and
        `list_dashboards`: for dashboards the model writes itself. Each save
        runs every query and checks every chart column, then returns numbered
        fixes if anything is wrong.
    *   `add_source`: registers data the agent found in the project. It accepts
        only paths inside the project folder.
    *   `get_spec_reference`: the spec format.
*   **Data:**
    *   **Files:** CSV, TSV, Parquet and JSON files or globs, plus SQLite and
        DuckDB databases.
    *   **Databases:** Postgres and MySQL, which are **experimental**.
    *   **Engine:** all read through a locked-down, read-only DuckDB.
*   **Harnesses:**
    *   `overlook setup` writes the MCP entry for Claude Code, Claude
        Desktop, Codex, Cursor, Windsurf, Gemini CLI, VS Code, OpenCode, Cline
        and Zed.
    *   `overlook auto` covers agents without MCP.
    *   A Claude Code plugin adds a `/overlook:dashboard` skill.
*   **Dashboard page:**
    *   KPI tiles with trends.
    *   Line, area, bar, scatter and table panels.
    *   Filters bound to SQL parameters.
    *   The SQL behind every number.
    *   CSV export, light and dark themes, and phone layouts.

**Known limits of this preview:**

*   **Tested end to end:**
    *   Codex and Claude Code (with the plugin) on Windows.
    *   Linux (Ubuntu under WSL) through the CLI and MCP over stdio.
*   **Configured but not yet run:** the other harnesses that `setup`
    configures.
*   **Never run:** macOS has had no run. Postgres and MySQL have not been run
    against a live server.
