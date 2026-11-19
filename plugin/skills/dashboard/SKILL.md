---
name: dashboard
description: Build a live dashboard of the user's data with Overlook and open it in the browser. Use when the user asks for a dashboard, KPIs, charts or an overview of their data, or says "use overlook".
argument-hint: "[what to show, or leave empty for an automatic overview]"
---

# Make a dashboard with Overlook

Overlook's MCP tools build dashboards from the data in this project, check every query, and serve the result at a local address (port 4777 unless the user changed it). Use the exact URL a tool returns.

What the user asked for: $ARGUMENTS

1. **No specifics** (empty above, or "a dashboard of my data"): call `auto_dashboard` with no arguments. It finds the data, builds a checked dashboard and saves it. If the user named a file, pass it as `path`.
2. **Specific views** ("monthly revenue by region"): call `describe_data`, then `get_spec_reference` once, check queries with `preview_query`, and save with `save_dashboard`. If the save returns numbered errors, fix them all and save again.
3. **No data found**: ask the user which file or database to use. Data in the project goes in with `add_source`; anything else the user adds with `npx overlook-dash source add <name> <path>`.
4. **Changing a dashboard**: `get_dashboard`, edit the spec keeping panel ids stable, then `save_dashboard` with the same name. The open page updates by itself.

Finish by giving the user the dashboard URL and one line on what it shows. Say it was opened in their browser only if the tool result says so.
