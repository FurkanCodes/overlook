# Goldfish Review Report: Stage 5, Initial Zoom Out Review

**Target:** `C:\Users\Furkan\overlook\docs\designs\overlook.md` (lines 1-725)

**Mode:** REVIEW. **GoldfishContext:** none.

## Reviewer Status

| Reviewer | Status |
| --- | --- |
| `egm-zoom-out` | completed |
| `egm-inventive-catalyst` | completed |

## Severity Breakdown

| Severity | Count |
| --- | --- |
| Blocker | 0 |
| Major | 9 |
| Nit | 9 |

Neither reviewer raised a Blocker. The zoom-out lens found that the document passes the context-sufficiency check (Standard section 0): the problem, goals, non-goals and CUJs are clear, and the core shape is right (a small checked JSON spec, SQL doing the analysis, plain files as the shared record).

Both lenses said these choices need no change: the two-process split over plain files, d3 instead of Vega-Lite, 2-second polling instead of push, the DuckDB lockdown order with the single-SELECT check, row cap and bound parameters, the lazy DuckDB open, and CLI-only source registration.

Synthesizer notes:
* I checked every line reference below against the target and normalized it.
* One reviewer claim was wrong and has been corrected (Nit 8): `package.json` already declares the d3, esbuild and vitest devDependencies.
* One catalyst Major was moved down to Nit (Nit 9). The reason is given in that finding.
* Where the two lenses recommended opposite fixes (Major 2), the report gives a single resolution.

---

## Prioritized Findings (Blockers -> Major -> Nits)

### Blockers

None.

### Major 1: Downloading extensions at start-up breaks the "Data stays local" goal - Severity: Major
* **Reviewer Lens:** `egm-inventive-catalyst` (primary). `egm-zoom-out` raised the same point inside its Postgres finding.
* **Affected Scope:**
  * Goals, "Data stays local" (L86-88)
  * Data sources, lockdown step 2 (L294-296)
  * Security & Privacy (L536-541)
* **Discrepancy Description:**
  * The goal (L86-87) says DuckDB's only network access is to Postgres sources the user registered.
  * Lockdown step 2 (L294-296) installs the sqlite and postgres extensions "at this point", which is every time `mcp` or `serve` starts. That is a download from DuckDB's extension repository, not from a registered source.
  * The download happens inside the process the design calls locked down, and nothing tells the user. Offline machines are not covered at all.
* **Rationale & Recommendation:**
  * Only install extensions in explicit CLI steps the user runs: `overlook source add` for a sqlite, duckdb or postgres source, and `overlook doctor --install`.
  * At `mcp` or `serve` start, only LOAD extensions that are already installed. If one is missing, return an actionable error ("run `overlook doctor --install`") and never fetch.
  * Rewrite L294-296 to say this.
  * Add a `doctor` check that installed extension versions match the bundled DuckDB.
  * Add a test that start-up makes no network call when an extension is missing.
  * State how extensions get onto an offline machine.

### Major 2: The detached server works like a daemon, but nothing manages its lifecycle - Severity: Major
* **Reviewer Lens:** `egm-zoom-out`, `egm-inventive-catalyst` (merged).
* **Affected Scope:**
  * Web server and page (L385-393)
  * CUJ 1 URL (L129-130)
  * lockdown step 5 (L301-304)
  * Version guard (L380-381)
  * Alternative D (L505-511)
  * Rollout & Rollback (L546-549)
  * file 9 (L645-652)
* **Discrepancy Description:** Three mechanisms work together: a scan of the next nine ports, a `serve.lock` file holding `{pid, port, token, startedAt}`, and a detached spawn that waits 3 seconds for the lock. Even so, the server's lifecycle is undefined in five ways:
  * **Stale sources.** After `SET lock_configuration = true` (L301), a running server can never see a source added later with `overlook source add`. The new alias passes `save_dashboard` in the MCP process but fails on the page.
  * **Stale builds.** After an npm upgrade, an old server keeps running the old build. It refuses newer spec versions (L380-381), and the version-based rollback story (L547) then works against the user.
  * **Races.** Two agents starting at the same moment can both fail the health check (L391-392) and spawn servers on 4777 and 4778. The later one overwrites `serve.lock`, and the earlier one is orphaned.
  * **Broken links.** CUJ 1 promises `127.0.0.1:4777` (L129). After a port fallback, bookmarked or shared links point at the wrong port or at nothing.
  * **No exit.** There is no `stop` command and no idle exit. The `token` field is never used.

  Alternative D rejects a daemon because it "would need an API between the processes" (L508). The chosen design already has that API.
* **Rationale & Recommendation:** The zoom-out lens recommended removing machinery. The catalyst recommended hardening it with an exclusive-create lock and token checks. The simpler fix covers both:
  * **Fixed port.** Use one port, overridable with `--port` or an env var. Fail loudly if something that is not Overlook holds it. Drop the nine-port scan. A fixed port also removes the two-server race, because the second bind fails.
  * **Health check.** Have `GET /api/health` return `{app: "overlook", buildVersion, specVersion, configMtime, pid}`. In `ensureServer()`, replace the server when its build is older or `config.json` is newer than `configMtime`. Alternatively, have the server open a fresh locked DuckDB instance when `config.json` changes.
  * **Lock file.** Drop `serve.lock`, or keep it only for the pid. Either way, drop `token`.
  * **Stop path.** Add `overlook stop` and/or an idle exit after N hours.
  * **Version rule.** State the version-mismatch rule in one sentence.
  * **Alternative D.** Reword it to admit that the design keeps a disposable daemon whose only durable state is the folder.

### Major 3: `get_dashboard` only sees panel errors if someone opened the page - Severity: Major
* **Reviewer Lens:** `egm-zoom-out`, `egm-inventive-catalyst` (merged).
* **Affected Scope:**
  * CUJ 3 (L145-155)
  * MCP tools table, `get_dashboard` (L362)
  * Observability, Panel errors (L450-452)
  * Components diagram and the "only shared record" claim (L184-201)
  * file 8, `readPanelState()/writePanelState()` (L643)
* **Discrepancy Description:**
  * `get_dashboard` returns "each panel's last error from the server". Only the web server writes `~/.overlook/state/<slug>.json`, so the next agent session in CUJ 3 sees the broken panel only if a browser loaded the page after the data changed. Otherwise it gets "no error", or an old error the user already fixed.
  * The state file is a second store with a different writer. It is missing from the diagram, and it weakens the claim at L199-201 that neither process holds state the other needs.
  * It also has a likely race: up to 24 concurrent panel requests per page load doing read-modify-write on one file per slug.
  * The `logs/` folder is missing from the diagram too.
* **Rationale & Recommendation:**
  * The MCP process already has its own locked-down engine and `checkDashboard`. Have `get_dashboard` run the stored spec's query and field checks (pipeline steps 3-5, using the unset-filter rule from Major 4) and return each panel's current status.
  * This deletes the `state/` folder, the read/write state functions and the server's in-memory error log, and CUJ 3 then works even if the page was never opened.
  * The cost is a slower `get_dashboard`, kept bounded by the time budget in Major 5.
  * If the state file stays, write one atomic file per panel and add `state/` and `logs/` to the diagram.

### Major 4: Binding unset filters to an empty string fails correct dashboards and passes broken ones - Severity: Major
* **Reviewer Lens:** `egm-zoom-out`, `egm-inventive-catalyst` (merged).
* **Affected Scope:**
  * Filter spec (L228-236)
  * Bound filters (L314-315)
  * pipeline step 4 (L332-333)
  * CUJ 4 (L157-166)
* **Discrepancy Description:** Step 4 binds filters without a default to `''`. That breaks the query check in four ways:
  * **Date filters.** `WHERE d >= $start` hits a conversion error, so a correct dashboard cannot be saved.
  * **Select filters.** `WHERE region = $region` returns zero rows. Step 6 treats that as only a warning, so the field check (step 5) runs on an empty result and passes without checking anything against real rows.
  * **No selection.** Neither the spec nor the page defines what "no selection" or "All" means, or how the model should write SQL for it.
  * **`options_sql`.** These queries are not run by the query check at all.
* **Rationale & Recommendation:**
  * Define one rule in "The spec" and in `get_spec_reference`: an unset filter binds `NULL`, with the documented idiom `($region IS NULL OR region = $region)`. Bind values typed by filter kind, so a `date` filter binds a DATE.
  * Validate each panel with all filters unset. Also validate once with a sample value: the `default`, the first `options` entry, or the first row of `options_sql`.
  * Run every `options_sql` in step 4.
  * The zoom-out lens offered a simpler alternative: require `default` on every filter. Choose one approach and state it once.

### Major 5: Save checks have no total time budget - Severity: Major
* **Reviewer Lens:** `egm-inventive-catalyst`.
* **Affected Scope:**
  * Goals, "Three levels of checking" (L73-78)
  * Timeout (L313)
  * pipeline steps 4-5 (L332-341)
  * MCP start-up notes (L366-369)
  * Performance (L542-545)
* **Discrepancy Description:**
  * Every save runs every panel query, each with a 15 s timeout, across up to 24 panels.
  * The design gives no ordering, concurrency or overall cap, so a slow source can hold `save_dashboard` for minutes. Agent harnesses have tight timeouts; the document itself cites Codex's 10 s start-up timeout.
  * L313 interrupts "the connection". If requests share one connection, one timeout kills unrelated queries already in flight.
* **Rationale & Recommendation:**
  * The design already prepares every statement to check its type (L308-310). A prepared statement exposes result column names and types without running, so the reference, field and type checks can run bind-only. Binder errors for missing columns also show up at this point.
  * Then run the panels in parallel under one total save budget, for example 30-45 s. A panel that runs past the budget returns a warning ("validated by binding only; execution timed out"), not a hang.
  * State that each query and each HTTP panel request gets its own DuckDB connection.
  * Bind-only checks miss runtime cast and CSV parse errors, and the zero-row and truncation warnings still need execution.

### Major 6: Staged checking with a five-error cap can use up the three-try budget - Severity: Major
* **Reviewer Lens:** `egm-inventive-catalyst`.
* **Affected Scope:**
  * Goals, "Clear errors" and "Works with mid-size local models" (L81-85)
  * The checking pipeline (L319-349)
  * Eval pass rule (L470-474)
* **Discrepancy Description:**
  * The pipeline runs ordered stages over the whole spec, and each reply holds at most five errors, sorted by panel (L348-349).
  * A spec with mistakes in several panels and stages reveals them in batches: schema errors first, then SQL errors on the next call, then field errors. That can use up the three tries the 8-of-10 goal allows.
  * The document never says whether a failed stage stops later stages for that one panel or for the whole spec.
* **Rationale & Recommendation:**
  * Run steps 3-5 per panel, so a schema error in one panel does not hide a SQL error in another.
  * Merge identical errors into one entry that lists every path, for example `column "revenu" not found in panels[1], panels[3], panels[5]`.
  * End every capped reply with "N more errors not shown".
  * State the stage-stop scope explicitly.

### Major 7: The field-name auto-repair threshold can silently change a chart's meaning - Severity: Major
* **Reviewer Lens:** `egm-inventive-catalyst`.
* **Affected Scope:**
  * CUJ 2 (L134-143)
  * Panel fields `x`/`y`/`series`/`value`/`compare` (L244-245)
  * pipeline step 5 (L336-341)
* **Discrepancy Description:**
  * A fixed edit-distance threshold of 2 swaps short names that mean different things, such as `cost` to `count` or `id` to `ip`.
  * The swapped column still passes the numeric type check, so the dashboard goes live with wrong numbers. The only trace is a `repairs[]` entry the user never sees.
  * The root cause is that the model has to repeat, in `x`/`y`/`value`, column names its own SQL already defines.
* **Rationale & Recommendation:**
  * Minimum fix: scale the threshold with name length (distance 1 for names of 5 characters or fewer), and mark auto-repaired panels in the page's "Source" view.
  * Larger option: make the axis fields optional with position-based defaults. For bar, line and area, `x` is the first column and `y` is every other numeric column. For KPI, `value` is the first numeric column. Explicit names stay as an override.
  * The larger option makes column order matter and needs a short section in the reference. Weigh it against the 1,800-token description budget (L366).

### Major 8: Postgres widens v1 scope and is the only exception to "Data stays local" - Severity: Major
* **Reviewer Lens:** `egm-zoom-out`.
* **Affected Scope:**
  * Problem (L42-45)
  * Goals (L70-72, L86-88)
  * source types (L285-286)
  * lockdown step 2 (L294-296) and the claim at L303-304
  * Open Question 2 (L112-113)
  * NFR (L539)
  * Future Improvements (L565)
* **Discrepancy Description:**
  * The problem statement is about data on the user's machine.
  * Postgres is the only source that needs network access and credentials (from env vars) and a remote attachment. It is the reason for the carve-out in the privacy goal, for Open Question 2 and for the "Faster Postgres" future item.
  * It also makes Major 2 (reconnecting attachments on restart) and Nit 9 (a time-based cache) harder.
* **Rationale & Recommendation:**
  * Ship v1 with file, SQLite and DuckDB sources, and move Postgres to Future Improvements next to its result cache.
  * If Postgres must stay in v1, say in the Problem section why local-only is not enough, and follow Major 1 for extension installs.

### Major 9: The eval cannot answer Open Question 1, which is supposed to be settled by eval data - Severity: Major
* **Reviewer Lens:** `egm-inventive-catalyst`.
* **Affected Scope:**
  * Open Question 1 (L109-111)
  * Eval (L457-476)
  * CUJ 5 (L168-174)
  * Future Improvements (L562-563)
* **Discrepancy Description:**
  * The question is whether models drop panels when they rewrite the whole spec, and the document says to decide it from eval data.
  * Every eval prompt creates a dashboard from scratch, and the pass rule only checks that the required panels exist. The question can never be answered as designed.
  * The only fix the document considers is more tools, and those would spend part of the description budget.
* **Rationale & Recommendation:**
  * Have `save_dashboard` compare old and new panel ids and warn, for example "removed panels: kpi-total, by-region (restore them if this was not intended)". No new tool is needed.
  * Add 3-4 edit prompts to `eval/prompts.json` that start from a fixture dashboard and check that untouched panels survive.

### Nit 1: The eval goes around the MCP layer it is meant to test - Severity: Nit
* **Reviewer Lens:** `egm-zoom-out`, `egm-inventive-catalyst` (merged).
* **Affected Scope:**
  * MCP tools, flat inputs (L353-355)
  * Eval (L459-462)
  * file 13 (L679-683)
  * e2e test (L697-699)
* **Discrepancy Description:**
  * `eval/run.ts` calls the core functions directly, which is a second adapter to keep in sync.
  * It never exercises what users actually run: the stdio server, the real tool descriptions, the flat schema, `spec` sent as a JSON string, `isError`, and the lazy engine start-up. The 8-of-10 goal (L83-85) therefore does not measure the shipped surface.
* **Rationale & Recommendation:**
  * Have the eval runner start `overlook mcp` with the SDK client the e2e test already uses, map `listTools` output to chat-completions tools, and forward the calls.
  * Log transport failures separately from model failures.

### Nit 2: History copies are written, but nothing can read them - Severity: Nit
* **Reviewer Lens:** `egm-zoom-out`.
* **Affected Scope:** Storage, History (L378-379); CUJ 5 (L174); NFR "History copies allow undo" (L548).
* **Discrepancy Description:** The design keeps 20 copies per dashboard, but no tool or command lists or restores them, so "undo" means copying files by hand.
* **Rationale & Recommendation:**
  * Either add `overlook restore <name> [--list]`, or drop the "allow undo" claim and keep a smaller fixed number of copies, such as 5.
  * Do not add a tool for this on the model side. Major 9 reuses the history copy for the panel-removal warning.

### Nit 3: The lenient-repair alias map is speculative, and the `pie` refusal is in the wrong step - Severity: Nit
* **Reviewer Lens:** `egm-zoom-out`.
* **Affected Scope:** pipeline step 1 (L322-325); file 3 (L593-597).
* **Discrepancy Description:**
  * The aliases `column` to `bar` and `number` to `kpi` are guesses made before any eval data exists.
  * Refusing `pie` is a schema error, not a repair.
* **Rationale & Recommendation:**
  * Limit step 1 to structural coercion: a spec sent as a JSON string, boolean strings, and lower-casing.
  * Handle `pie` in the zod enum error, which already lists the allowed values (L327-328), and add a fix hint.
  * Add aliases only when the tool-call log (L448) shows they occur.

### Nit 4: Optional spec fields go beyond what the eval and the parity behaviours need - Severity: Nit
* **Reviewer Lens:** `egm-zoom-out`.
* **Affected Scope:** Dashboard `description` (L224); Panel spec (L244-251).
* **Discrepancy Description:**
  * `unit` overlaps with `format: "currency"`.
  * `compact`, `horizontal`, `note` and `description` each add to the reference text that small models must read, to the zod variants and to the UI code.
* **Rationale & Recommendation:**
  * Keep only the fields the 10 eval prompts and the five parity behaviours (L34-38) need, and list the rest under Future Improvements.
  * Adding an optional field later is backward-compatible under `version: 1`, so deferring costs nothing.

### Nit 5: The implementation plan names internal helper functions - Severity: Nit
* **Reviewer Lens:** `egm-zoom-out`.
* **Affected Scope:** Files 4-8 (L599-643). Examples: `closest()`, `formatErrors()`, `overlookHome()`, `slugify()`, `checkSingleSelect()`, `loadConfig()/saveConfig()`.
* **Discrepancy Description:** These are internal helpers, not interfaces between components. They will change during implementation and add noise to review.
* **Rationale & Recommendation:**
  * For each module, name its public interface (for example `Engine.open/describe/run`, `checkDashboard`, and the store's save/load/list) and its responsibility, and drop the helper names.
  * Keep the DuckDB-to-JSON value mapping (L617-618), because it is a data-contract decision.

### Nit 6: Logs grow without limit, and the tool-call log has no stated destination - Severity: Nit
* **Reviewer Lens:** `egm-zoom-out`.
* **Affected Scope:** Observability, Logs and Tool-call log (L445-449).
* **Discrepancy Description:**
  * Logs go to stderr, to a log file and to a JSON-lines tool-call log.
  * The document does not say whether the tool-call log goes to the same file, and there is no size cap or rotation.
* **Rationale & Recommendation:**
  * Use one stderr logger that writes tool-call entries as single JSON lines.
  * Mirror it to a file only behind `--log-file` or an env var. If the file stays on by default, cap it at one rotated file.

### Nit 7: Two CLI commands have no user journey - Severity: Nit
* **Reviewer Lens:** `egm-zoom-out`.
* **Affected Scope:** file 11 (L667-668).
* **Discrepancy Description:**
  * `validate <file>` assumes a user who writes spec files by hand, and no CUJ covers that.
  * `open <name>` repeats the URL that `save_dashboard` and `list_dashboards` already return.
* **Rationale & Recommendation:**
  * Keep `validate` only if it is the CI or eval entry point, and say so.
  * Otherwise defer both commands. The core CLI is `mcp`, `serve`, `source add|list|remove` and `doctor`.

### Nit 8: The plan's file list does not match the repository - Severity: Nit
* **Reviewer Lens:** `egm-zoom-out`. The synthesizer checked this against the repository and corrected it.
* **Affected Scope:**
  * file 1 (L574-581)
  * Language and dependencies (L208-216)
  * Components diagram (L185-190)
* **Discrepancy Description:** `C:\Users\Furkan\overlook\package.json` already exists. It differs from the plan in five ways:
  * **Create vs Modify.** The plan says "Create" for a file that already exists.
  * **Build script.** `build` calls `scripts/build-ui.mjs`, which is not in the plan.
  * **Eval script.** `eval` runs `dist/eval/run.js`, but the plan says `tsc` builds only `src/`.
  * **`dev` script.** The plan names a `dev` script that `package.json` lacks.
  * **Diagram.** The diagram leaves out the `state/` and `logs/` folders.

  The reviewer also said the devDependencies are undeclared. That is wrong: `package.json` declares the d3, esbuild and vitest packages.
* **Rationale & Recommendation:**
  * Mark `package.json` as Modify and list `scripts/build-ui.mjs`.
  * Include `eval/` in the tsc build, or run the eval through a TS runner.
  * Add or remove the `dev` script.
  * Show every folder under `~/.overlook` in the diagram. If Major 3 is adopted, `state/` goes away.

### Nit 9: File-source results could be cached by file version - Severity: Nit
* **Reviewer Lens:** `egm-inventive-catalyst`. Raised as Major; the synthesizer moved it to Nit.
* **Affected Scope:**
  * Overview (L20-21)
  * Open Question 2 (L112-113)
  * lockdown step 1 (L291-293)
  * Performance (L544)
  * Future Improvements (L565)
* **Discrepancy Description:**
  * Each panel scans its source file again, and for CSV detects the format again. That means 12 or more full scans of a 1M-row CSV per page load.
  * For file sources, freshness can be checked exactly, so the "fresh vs fast" trade-off in Open Question 2 does not apply.
  * The Performance NFR only bounds a single panel, not a whole page load.
* **Rationale & Recommendation:**
  * I moved this down because the design explicitly defers caching, and the zoom-out standard argues against adding optimizations before measurement shows a need.
  * At minimum, add a page-load target to Performance.
  * If that target is missed, cache results keyed by (SQL, bound params, mtime and size of each matched file), with a size cap. That keeps the "live" promise.
