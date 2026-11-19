# Goldfish Review Report: Stage 9, Implementation Readiness

**Target:** `C:\Users\Furkan\overlook\docs\designs\overlook.md`. Lines 904-1121 (Detailed Implementation Plan) were reviewed. Lines 1-903 were used as context only.
**Standard:** `resources/document_standards/implementation-readiness-standard.md`. egm-style used its persona's default rules.
**Code checked against:** `C:\Users\Furkan\overlook` (`src/`, `ui/`, `test/`, `eval/`, `scripts/`, `examples/`, `package.json`).

## Reviewer Status

| Reviewer | Instances | Status |
| --- | --- | --- |
| `egm-implementation-readiness` | 1 | completed |
| `egm-codebase-details` | 2: A covered the backend core (engine, check, spec, storage, config); B covered the outward surface (server, control, MCP, CLI, UI, eval, tests) | completed |
| `egm-style` | 1 | completed |

**Severity breakdown after deduplication:** 4 Blockers, 24 Majors, 30 Nits.

**Verdict: not ready.** Every file in the Target Files list exists. Codebase A and B found no missing, extra or renamed files under `src/`, `ui/`, `test/`, `eval/`, `scripts/` or `examples/`. The plan, though, is a table of contents rather than a set of contracts: a new engineer could not rebuild modules that fit together without making many decisions of their own. The code also has several bugs where it does not do what the design promises.

The synthesizer re-read these code findings to confirm them: B1 (`control.ts:34-46`), M7 (`engine.ts:155-174`), M8 and M9 (`engine.ts:237-239, 443-449`, `server.ts:272-282`), and M4 (`log.event` appears only at `tools.ts:97`).

---

## Blockers

### B1. On Windows, `probe()` probably mistakes an empty port for "another program", so the server never auto-starts (verify on Windows)
* **Lens:** `egm-codebase-details` (B)
* **Location:** `src/server/control.ts:34-46` (the `TimeoutError` becomes `other`), `control.ts:68-72` (the shutdown wait loop), `control.ts:91-100` (`ensureServer`); design lines 575-592; plan line 995.
* **Problem:**
  * `probe()` treats a fetch timeout (800 ms, or 300 ms while polling) as "something answered but is not Overlook".
  * On Windows, a connection to a closed loopback port usually takes about 1-2 s to be refused, because Windows retries the SYN after an RST. The timeout fires first, so the result is `other`, not `none`.
  * `ensureServer()` then replies "port 4777 is used by another program" and never spawns the server. This breaks CUJ 1 step 4 on the user's platform.
  * The same misreading has two more effects:
    * `shutdownServer()` never sees `none`, so an older server is reported as "could not be replaced".
    * `doctor` reports the port as used by another program.
  * No test covers this path, because the e2e test and the eval both set `OVERLOOK_NO_SERVE=1`.
* **Fix:**
  * Classify the port in two steps:
    1. `net.connect` to 127.0.0.1:port. A refusal, an error or a connect timeout means `none`.
    2. Only after a connection succeeds, send `GET /api/health` with its own timeout. A timeout or a body that is not Overlook's means `other`.
  * State this algorithm in plan item 8.
  * Add `test/control.test.ts` with a case where nothing listens on the port.
  * Quick check first: on Windows, time `fetch('http://127.0.0.1:4777/api/health')` with nothing listening.

### B2. The DuckDB upgrade gate never exercises DuckDB's own enforcement
* **Lens:** `egm-implementation-readiness`, `egm-style`
* **Location:** plan lines 1057, 1064-1072, 1089-1091; design lines 397-399; `test/engine.test.ts:63-78`, `test/security.test.ts:20-30`, `src/engine/engine.ts:104-114, 212`.
* **Problem:**
  * Overlook's own checks stop every COPY, ATTACH, INSTALL, LOAD, SET and PRAGMA attack in the tests before DuckDB sees it. Those checks are the leading-keyword check and the one-statement check.
  * As a result, DuckDB's `allowed_paths` write behaviour, `lock_configuration` and the extension lock are never tested.
  * A DuckDB upgrade that let `COPY ... TO` write under `allowed_paths`, or that ignored `lock_configuration`, would still pass the suite the design names as the gate for moving the pin.
  * "14 lockdown cases" (line 1057) is a count with no list, so an implementer would have to invent the cases.
* **Fix:**
  * List every attack case in the plan, each with the layer expected to stop it.
  * Add a test-only hook that runs raw statements on a locked-down instance, bypassing `checkSqlText` and `prepareSingle`. For example, move the lockdown steps into an exported function the test can call.
  * With that hook, assert each of these:
    * `SET enable_external_access=true` fails.
    * `COPY (SELECT 1) TO '<allowed path>.out'` fails.
    * `ATTACH` fails.
    * `LOAD` of an uninstalled extension fails.
    * `current_setting('lock_configuration')` is true.
    * `allowed_paths` cannot be bypassed by another spelling of an allowed file: backslashes, a different letter case on Windows, or `..` segments.
    * A leading `/* */` comment before `COPY` is rejected.
  * Rewrite lines 1089-1091 as: "**Upgrade gate.** Every test in `test/security.test.ts` (the attack suite) must pass before the DuckDB pin moves."

### B3. The data contracts between modules are missing
* **Lens:** `egm-implementation-readiness`, `egm-codebase-details` (A)
* **Location:** plan lines 942-987; `src/engine/engine.ts:12-29, 50, 67-77, 121-137`; `src/spec/errors.ts:4-22`; `src/check.ts:33-62`; `src/config.ts:6-18`.
* **Problem:** The plan names `Engine.run`, `checkDashboard → CheckResult` and `SpecError`, but defines none of the types involved:
  * **Engine types:** `QueryResult {columns, rows, truncated, ms}`; `ColumnInfo {name, type, kind}` and the rule that maps DuckDB types to `kind`; the `QueryError` kinds (`rejected | duckdb | timeout | params`); `SourceDescription` and `TableDescription`.
  * **DuckDB-to-JSON value conversion:** BIGINT and DECIMAL become JS numbers, and values past 2^53 lose precision. DATE and TIMESTAMP become ISO text. The UI, `preview_query` and the eval's number matching all depend on this rule. Stage 7 asked for it to be kept in the plan, and it is now in neither the design nor the plan.
  * **Check types:** `SpecError {path, message, fix?}`, `SpecWarning`, `SpecRepair {path, from, to, reason}`, `PanelCheck`, and `CheckOptions {budgetMs, perQueryMs, concurrency, skipQueries}` with its defaults (40 s and 15 s).
  * **`config.json` schema:** `{version: 1, sources, port?, samples?}`.
  * **Exports other modules use:** `Engine.aliases()` and `Engine.sourceErrors` (used by `check.ts`), and `DATE_RE` (exported by `check.ts`, used at `server.ts:11`).
* **Fix:**
  * Add an "Interfaces" subsection with the exact TypeScript declarations.
  * Add a table from DuckDB type to `kind` and to the JSON value.
  * Decide whether to accept precision loss for BIGINT and DECIMAL values past 2^53, or to send them as strings.

### B4. The HTTP API contract is missing
* **Lens:** `egm-implementation-readiness`, `egm-codebase-details` (B), `egm-style`
* **Location:** plan lines 993-994 ("with the routes, safety rules and a 4-query limit") and 1079 ("the invalid-file 422"); design lines 596-634; `src/server/server.ts:19-29, 58, 175, 264-309`.
* **Problem:** `ui/main.ts` and `server.ts` cannot be built separately from this plan. It does not give:
  * **Status codes:**
    * 403 for a bad Host or a bad Origin.
    * 405 for any other method.
    * 415 for a non-JSON POST.
    * 413 for a body over 64 KB.
    * 400 for bad JSON, a data request for a text panel, a filter value over 200 characters, or a date that is not in `YYYY-MM-DD` form.
    * 404 for an unknown dashboard, panel or filter.
    * 422 for an invalid file or a newer spec version. No route in the design returns 422.
    * A panel query error is returned as 200 with `{error, kind}`.
  * **Response bodies:**
    * `/api/dashboards` returns `{dashboards}`.
    * `/api/d/<slug>` returns `{slug, spec, mtimeMs, sources}`. The `sources` map is not in the design.
    * `/mtime` returns `{mtimeMs | null}`.
    * `/options/<id>` returns `{options, error?}`.
    * `/api/health` returns `{app, version, pid}`.
  * **Request body:** the panel POST takes `{params}`.
  * **Patterns and allowlists:** the id pattern in URLs is `[A-Za-z0-9_]+`, and only three assets are served.
  * **Drift from the design:**
    * The code accepts `http://localhost:<port>` as an Origin (`server.ts:175`), but design line 626 says only the server's own origin.
    * The CSP and headers add `font-src`, `base-uri 'none'`, `form-action 'none'` and COOP, none of which are in design lines 627-634.
* **Fix:**
  * Add a route table with these columns: method, path, request body, success body, each error status with its body, size limits.
  * List the exact header values.
  * Reconcile the CSP and the Origin rule with design lines 626-634.

---

## Major

### M1. The plan has no phases or checkpoints
* **Lens:** `egm-implementation-readiness`
* **Location:** plan lines 906-1098.
* **Problem:** The standard requires incremental phases, each leaving the code buildable and testable. The plan is one flat list of "Create" entries with no order between modules.
* **Fix:** Group the work into phases, each with a verification step:
  1. Build setup and core utilities.
  2. Spec and errors, with `check.test` passing under `skipQueries`.
  3. Engine, with `engine.test` and `security.test` passing.
  4. Check and store.
  5. Server and control, with `server.test` passing.
  6. MCP and CLI, with `mcp.e2e` passing.
  7. UI bundle, checked by the manual visual check.
  8. Eval, examples and docs.

### M2. The status note contradicts itself
* **Lens:** `egm-style`
* **Location:** plan lines 906-908.
* **Problem:** The note says "every file below exists" while every entry is labelled "(Create)". It also says the plan "names module interfaces", but most entries name neither signatures nor types (see B3).
* **Fix:** Either "Every file below is new in v1 and is marked (Create)", or relabel the entries "(Exists)" and say what is being verified. Drop the interfaces claim, or make it true by fixing B3.

### M3. Dependencies, build layout and the lockfile are unspecified
* **Lens:** `egm-implementation-readiness`, `egm-codebase-details` (B), `egm-style`
* **Location:** plan lines 912-925; `package.json:20, 24`; `tsconfig.json:19`.
* **Problem:**
  * Only `@duckdb/node-api` is pinned. The plan does not name:
    * `@modelcontextprotocol/sdk`.
    * zod v4. The code needs it for `z.toJSONSchema` (`schema.ts:219`) and `z.core.$ZodIssue` (`errors.ts:57`).
    * The d3 modules and their `@types` packages. `d3-axis` and `d3-selection` are declared but never imported.
    * esbuild, typescript and vitest.
  * `package-lock.json` exists but is not in the file list.
  * These settings exist only in code:
    * `bin` points to `dist/src/cli.js` and needs a shebang.
    * `tsconfig.json` uses `rootDir "."` and includes `eval`.
    * `tsconfig.ui.json` uses `noEmit`, bundler module resolution and the DOM lib.
    * `vitest.config.ts` needs `pool: 'forks'` and `fileParallelism: false`, because the tests change `OVERLOOK_HOME`.
    * The `build:ui` and `prepublishOnly` scripts.
  * "tsc for both" and "pretest: the build" are shorthand.
  * `test/` is never type-checked.
* **Fix:**
  * List every dependency with its version range.
  * Add `package-lock.json` to item 1.
  * State the tsconfig and vitest settings and write out the exact script commands.
  * Decide whether `test/` is type-checked.

### M4. The tool-call log the design promises is mostly missing
* **Lens:** `egm-codebase-details` (A and B), `egm-implementation-readiness`
* **Location:** design lines 674-675, which Alternative H (lines 815-816) relies on as evidence; `src/mcp/tools.ts:97` (the only `log.event` call); `src/mcp/server.ts:17-27`.
* **Problem:**
  * Only `save_dashboard` is logged, with the fields `{tool, slug, ok, errors, repairs, ms}`. There is no "stage reached".
  * The other five tools are never logged.
  * Only counts are recorded, not error kinds or repair reasons, so the log cannot show which typos or aliases are common.
* **Fix:**
  * Log every tool call once, in `wrap()` (`src/mcp/server.ts:17`).
  * Add `stage` to `CheckResult` (repair, schema, reference, query, field, done).
  * Record repair reasons and error codes as well as counts.
  * Name this log event in plan item 9.

### M5. Zod errors do not always carry the received value and a fix
* **Lens:** `egm-codebase-details` (A)
* **Location:** design lines 94-95 and 450-452; `src/spec/errors.ts:63-69, 84-88`.
* **Problem:** `too_small`, `too_big`, `invalid_format` (for example an id that fails `IDENT_RE`) and every other zod code pass zod's bare message through, with no received value and no `fix`. `invalid_type` with a value present also has no `fix`.
* **Fix:** Give each zod code a message with `describeValue(received)` and a `fix`, for example "use 1-64 letters, digits or _, starting with a letter". Add a check test for each code.

### M6. A source that fails to open stays failed until the instance re-opens
* **Lens:** `egm-codebase-details` (A)
* **Location:** design Risks row at line 840; `src/engine/engine.ts:155-162, 466-471`.
* **Problem:**
  * `sourceErrors` is fixed when the instance opens.
  * While queries keep arriving within 20 s of each other, a source that was locked or missing at open time keeps failing after it becomes available.
* **Fix:** In `EngineHolder.get()`, treat an engine with non-empty `sourceErrors` as stale after about 5 s, or retry failed aliases on demand. Add a test.

### M7. Auto-install and auto-load are turned off only after the sources are attached
* **Lens:** `egm-codebase-details` (A)
* **Location:** design lines 372-395 (step order) and 380-382 ("never touches the network"); `src/engine/engine.ts:155-172`.
* **Problem:**
  * `CREATE VIEW ... read_*` and `ATTACH` run while `autoinstall_known_extensions` and `autoload_known_extensions` still have their defaults.
  * During that window, DuckDB can auto-load or download an extension. Two ways this happens: a file attached with `--type duckdb` that is really SQLite, or any reader that is not statically linked.
* **Fix:**
  * Run both `SET ... = false` statements immediately after `useOwnExtensionDir`, before step 1. An explicit `LOAD sqlite` still works after that.
  * Update the design's step list to match.
  * Add a security test.

### M8. A replaced engine can be closed under a caller that still holds it
* **Lens:** `egm-codebase-details` (A and B)
* **Location:** design lines 270-271 ("closed only after its running queries finish"); `src/engine/engine.ts:194-203, 443-449, 473-480`; `src/server/server.ts:272-282, 304-306`; `src/check.ts:243-282`.
* **Problem:**
  * Callers hold an `Engine` across awaits:
    * The panel and options handlers call `engines.get()` and then wait in the `limit()` queue.
    * `checkDashboard` runs many queries in turn.
  * `parameters()` does not count as in-flight work.
  * When a config change or the 60 s glob refresh re-opens the instance, `closeWhenIdle(old)` closes the old one as soon as `inflight === 0`. That can happen in a gap between queries, so the queued `run()` fails on a closed database. The user sees a spurious error card or a refused save.
* **Fix:**
  * Add leases to `EngineHolder`, either `acquire()`/`release()` with a refcount or `holder.use(fn)`. Close only at refcount 0.
  * In `server.ts`, call `engines.get()` inside the `limit()` callback.
  * Count `parameters()` as in-flight.

### M9. `inflight` leaks if `connect()` throws, which stops the idle close for good
* **Lens:** `egm-codebase-details` (A)
* **Location:** `src/engine/engine.ts:237-239`. The increment and `await this.instance.connect()` sit outside the `try` that starts near line 249.
* **Problem:** If `connect()` throws, `inflight` is never decremented. The idle timer (line 493) then never closes the engine, so the `.duckdb` lock and up to 2 GB of memory are held until the process exits. `closeWhenIdle` also polls forever (line 446).
* **Fix:** Increment only after `connect()` succeeds, or move both inside the `try`/`finally`.

### M10. Cancelling in the browser does not cancel the server-side work
* **Lens:** `egm-codebase-details` (B)
* **Location:** design lines 663-664 and the Risks row at line 844; `src/server/server.ts:154-167, 264-289`; `ui/main.ts:254-256, 404-416`.
* **Problem:**
  * The page aborts its fetch, but the server ignores the client disconnect.
  * Requests queued in the 4-slot limiter still start later, and running queries continue for up to 15 s.
  * Rapid filter changes therefore fill the queue with dead queries.
  * An mtime-triggered reload does not abort the old views' in-flight requests.
* **Fix:**
  * Watch `req.on('close')` and skip queued work once the request has been aborted.
  * Pass an `AbortSignal` to `Engine.run` that calls `conn.interrupt()`.
  * In `render()`, abort the old views' requests.
  * Write this behaviour into plan items 8 and 11.

### M11. `options_sql` is checked more loosely than the design says
* **Lens:** `egm-codebase-details` (A), `egm-implementation-readiness`
* **Location:** design lines 458-466; `src/check.ts:297-307`.
* **Problem:**
  * More than one column produces only a warning, but the design says it is an error.
  * The `options_sql` queries run one after another after the panels, each with at least 1000 ms (line 301). A save can therefore overrun the 40 s budget by up to about 6 s, and these queries never get the "not checked in time" error.
  * Their errors have no `fix`.
  * `$params` inside `options_sql` are not checked against the declared filters.
* **Fix:**
  * Either make more than one column an error, or change the design to "warns; the first column is used".
  * Run `options_sql` inside `runLimited` under the same budget.
  * Apply the undeclared-parameter check to it.

### M12. `get_dashboard` bypasses the version guard
* **Lens:** `egm-codebase-details` (A)
* **Location:** design lines 550-551; `src/mcp/tools.ts:132`; `src/store.ts:51-54, 58-63`.
* **Problem:** `loadRaw` skips the newer-version check, so a version-2 file is reported as schema errors instead of the "upgrade overlook-dash" message.
* **Fix:** Apply the version check in `loadRaw`, or in `get_dashboard`, and return the `StoreError` text.

### M13. `config.json` has no version guard and loses unknown fields on rewrite
* **Lens:** `egm-codebase-details` (A)
* **Location:** design line 872 ("Every file has a version"); `src/config.ts:50-67, 111-114`.
* **Problem:**
  * `loadConfig` ignores `version`.
  * `source add` and `source remove` rewrite the file as version 1 and drop unknown keys, so an older build silently downgrades a newer config.
  * Entries are not validated at load. A hand-edited relative path resolves against each process's own working directory.
* **Fix:**
  * Refuse `version > 1` with a message.
  * Keep unknown keys when saving.
  * Validate each entry at load and record failures in `sourceErrors`.

### M14. `source add --type` cannot override an unrecognized extension; the network claim is also wrong
* **Lens:** `egm-codebase-details` (A), `egm-style`
* **Location:** plan lines 1012-1014; `src/cli.ts:72-76`.
* **Problem:**
  * `inferSource(target)` throws before the `--type` override is applied, so `source add x data.bin --type duckdb` fails.
  * "downloaded only when a sqlite source is added" contradicts line 1011 and design lines 380-381: `doctor --install` also downloads the extension.
* **Fix:**
  * When `--type` is given, build `{type, path}` directly and skip `inferSource`.
  * Reword the plan: "`source add` downloads the `sqlite` extension when the new source is SQLite. `doctor --install` also downloads it. No other command touches the network."

### M15. The `EngineHolder` re-open rule is misstated
* **Lens:** `egm-style`
* **Location:** plan lines 969-970; design lines 259-261.
* **Problem:** "re-opens on a config or glob change" does not match the design. There is no "glob change" trigger. The rule is a refresh when any source is a glob and the instance is older than 60 s.
* **Fix:** "re-opens on the next query after `config.json` changes, or when any source is a glob and the instance is older than 60 s; closes after 20 s idle (`OVERLOOK_IDLE_MS`)."

### M16. The eval tests a different tool surface, and its data and setup are underspecified
* **Lens:** `egm-codebase-details` (B), `egm-implementation-readiness`, `egm-style`
* **Location:** plan lines 1003-1004 and 1032-1038; design lines 98 and 686-689; `eval/run.ts:39, 44-47, 126-132, 141-146`; `src/mcp/server.ts:13-15`.
* **Problem:**
  * **Different tool surface:**
    * Plan line 1003 says the eval uses `tools.ts`, and design line 687 says it uses "the same tool definitions". In fact `eval/run.ts:126-132` re-declares five tools with different descriptions, types `spec` as an object only, and leaves out `list_dashboards`.
    * The server instructions are not sent to the model.
  * **Data location:** fixtures are in `eval/fixtures/` per design line 689, but in `examples/data` per plan line 1037 and the code.
  * **Context size:** the reference model needs a 32k context, and nothing sets `num_ctx`. Ollama's OpenAI-compatible endpoint cannot set it per request.
  * **Missing from the plan:**
    * The `prompts.json` schema.
    * The eval environment variables.
    * The seeds, `MAX_TURNS`, the canonicalization and mapping rules, and the results format.
    * The `make-examples.mjs` dataset schemas, row counts and PRNG seed.
* **Fix:**
  * Export one tool table (name, description, zod input shape) from `src/mcp/`. Register it in the MCP server, and convert it to JSON Schema for the eval with `z.toJSONSchema`.
  * Send the server instructions as the eval's system message.
  * Change design line 689 to `examples/data`.
  * State how the 32k context is set, for example `OLLAMA_CONTEXT_LENGTH=32768` or the native `/api/chat` endpoint with `options.num_ctx`.
  * Add the prompt schema, the environment variables and the dataset schemas.

### M17. Chart folding is undefined, and scatter folding invents data points
* **Lens:** `egm-codebase-details` (B), `egm-style`
* **Location:** plan lines 1024-1025; design line 485; `ui/charts.ts:85, 139-162`.
* **Problem:**
  * "folding into 'Other' past 8 series" does not say how series are ranked or whether 7 or 8 named series are kept.
  * Scatter has an undocumented cap of 3 series. Extra series are merged by summing `y` per x value, so points from different series that share an x become one fake point. The user is not told.
  * Line charts drop extra series instead of folding them, with the note "only the 7 largest are drawn".
* **Fix:**
  * Define the folding rule per chart type in plan item 11. For example: the 7 series with the largest total `y` are drawn, and the rest are summed into "Other".
  * For scatter, keep every point and only recolor folded series as "Other".
  * Document the scatter cap.

### M18. The lenient-repair rules are not listed
* **Lens:** `egm-implementation-readiness`, `egm-codebase-details` (A), `egm-style`
* **Location:** plan line 947 ("The lenient front door"); design line 446; `src/spec/repair.ts:96-195`; `src/check.ts:141-143, 214`.
* **Problem:**
  * The design lists four repairs. The code does many more:
    * Strips code fences.
    * Unwraps `{dashboard}` and treats a bare array as the panels list.
    * Fills a missing `version`.
    * Parses `panels` sent as a JSON string.
    * Maps about 30 type aliases and gives advice for 6 unsupported types.
    * Maps width aliases.
    * Generates missing ids from the title.
    * Renames `query` to `sql` and strips a trailing `;`.
  * Unknown types are lower-cased without a repair record, so the later error quotes the rewritten value instead of the original.
  * Unknown fields produce a warning and are dropped. That policy is not stated anywhere.
  * Generated ids interact with the dropped-panel warning and with the eval's `keep_ids`.
* **Fix:**
  * List every repair as input pattern → output → repair text, plus the id-generation rule and the unknown-field policy.
  * Record a repair for type lower-casing.
  * Replace "lenient front door" with "Lenient repair (pipeline step 1)".

### M19. The MCP tool contract is unspecified
* **Lens:** `egm-implementation-readiness`, `egm-codebase-details` (B)
* **Location:** plan lines 997-1004, 1083; design lines 504, 518-524; `src/mcp/server.ts:51-67`; `src/mcp/tools.ts:69-85, 101-106, 132-144`; `test/mcp.e2e.test.ts:47-48`.
* **Problem:**
  * **Input schemas:** none are given. Also:
    * `preview_query.source` is optional in the code but required in design line 518.
    * `params` is an object, while design line 504 says inputs are flat strings.
  * **Description budget:** the 1,800-token budget is measured in the test as fewer than 7,200 characters. The plan does not state this conversion.
  * **Unspecified wording and rules:**
    * Reply strings that the tests assert ("The dashboard was NOT saved. N problems to fix:", "Created/Replaced dashboard").
    * The `isError` rules.
    * How uncaught exceptions are wrapped.
  * **`preview_query` row count:**
    * The design says it returns a total row count. The code computes it only when the result is truncated.
    * The trailing `;` is not stripped before the SQL is wrapped, so with a `;` the count always fails (`tools.ts:80`).
  * **`get_dashboard` replies:**
    * A failing check shows only the summary, not each panel's status (design line 520).
    * A passing check drops the warnings.
    * The reply reuses the text "Warnings (saved anyway)".
  * **Bad existing file:** if the file holds invalid JSON, the reply says "Created" when the file is actually replaced (`tools.ts:101-106`).
* **Fix:**
  * Specify each tool's zod input schema, description text, reply format and `isError` rule.
  * State the chars-per-token rule.
  * Strip the `;` before counting rows, and either always count or change the design.
  * Make the `get_dashboard` output match design line 520.
  * Make design and code agree on whether `source` is optional.

### M20. CLI behaviour is unspecified
* **Lens:** `egm-implementation-readiness`, `egm-codebase-details` (B)
* **Location:** plan lines 1006-1014; `src/cli.ts:56, 117, 192, 198-201`.
* **Problem:** The plan gives command names only. It omits:
  * Argument syntax and flags: `serve --port N --quiet`, `mcp --verbose`, `validate <file> --json`, `source add <name> <path> --type`.
  * Exit codes: `validate` and `doctor` exit 1 on failure.
  * What `open` and `stop` do and print.
  * The text of the `doctor` setup snippets.
* **Fix:** Add a usage table with arguments, flags, side effects, stdout and stderr output, and exit code for each command.

### M21. Environment variables and config keys are used but never documented
* **Lens:** `egm-implementation-readiness`, `egm-codebase-details` (A and B)
* **Location:** `src/engine/engine.ts:464`, `src/server/control.ts:18, 49`, `src/server/server.ts:44`, `src/config.ts:17, 181-185`, `eval/run.ts:44-47`; design line 555.
* **Problem:** These appear in code but not in the plan:
  * `OVERLOOK_IDLE_MS`, and the `EngineHolder(idleMs)` argument that the idle-close test relies on.
  * `OVERLOOK_PORT`. It overrides the config `port` and is documented in the README, but not in the design, which names only the config key.
  * `OVERLOOK_CLI`, `OVERLOOK_UI_DIR`, `OVERLOOK_SAMPLES=1`, and the config key `samples`.
  * The five `OVERLOOK_EVAL_*` variables.
* **Fix:** Add a Configuration table with name, default, precedence and purpose for each.

### M22. Tests are missing for several risky behaviours
* **Lens:** `egm-implementation-readiness`, `egm-codebase-details` (B)
* **Location:** plan lines 1049-1091; `test/server.test.ts:57`.
* **Problem:** No planned test covers:
  * **`control.ts`:** replacement of an older version, the "exits quietly" path, a foreign program on the port, the 3 s start wait, `OVERLOOK_NO_SERVE`, and the B1 case.
  * **`serveCommand`:** handling of `EADDRINUSE`.
  * **`EngineHolder`:**
    * Re-open after a config change.
    * The 60 s glob refresh, which needs an injectable clock.
    * Retiring an old instance only after its queries finish (M8).
  * **Store:**
    * Keeping only 20 history copies.
    * History file names without colons.
    * The rename retry on `EPERM`/`EBUSY`.
    * Refusing to overwrite a newer version.
  * **Server:**
    * The 4-query limit.
    * The full header set; today only `script-src` is checked.
    * `localhost:<port>` accepted as a Host.
    * The date-filter 400 and the length 400.
    * The options route.
    * `/api/shutdown`.
  * **Check:** the 8-error cap with its "N more" line, the warning cap, and the one-column rule for `options_sql`.
  * **MCP:** the total-row count from `preview_query`.
  * **UI:**
    * Nothing is tested.
    * The untested parts include security-relevant markdown rules: text nodes only, `http(s)` links only, `rel=noopener`, `javascript:` refused.
* **Fix:**
  * Add named cases with expected assertions to item 14.
  * Add `test/control.test.ts` and `test/store.test.ts`.
  * Add a DOM-free `test/ui.test.ts` for `markdown.ts`, `format.ts` and `charts.ts` `prepare()`.

### M23. The UI entries are too vague to build to the visual baseline
* **Lens:** `egm-implementation-readiness`, `egm-style`, `egm-codebase-details` (B)
* **Location:** plan lines 1016-1030; `ui/panels.ts:41`; `ui/styles.css:239-241`; `ui/main.ts:160-162, 306-308, 319-326, 442-446, 495-497`.
* **Problem:**
  * **Visual values missing:**
    * The 8 palette hex values for light and dark.
    * The axis, tick, tooltip and crosshair rules.
    * "end labels" and "role tokens" are used but not defined, and "light and dark steps" seems to mean themes.
  * **`format.ts` rules missing:** the default currency, the compact-number thresholds, percent precision, local midnight for dates, and how the date format is chosen.
  * **Page behaviour missing:**
    * The theme-storage key and the URL parameter names.
    * The 2 s poll and the 15 s "time ago" tick.
    * Which API calls each page makes.
  * **Undocumented constants:** a 500-row table display cap, a 960 px breakpoint, and an options query timeout of 10 s rather than 15 s.
  * `ui/dom.ts` and `ui/favicon.svg` are listed without a description.
  * CSV formula injection (cells starting with `=`, `+`, `-`, `@`) has no decision.
  * **Behaviour that does not match the design:**
    * The error card shows only the message. CUJ 3 (line 198) says it shows the source, the SQL and the DuckDB message.
    * A failed `options_sql` shows as an empty list.
    * The text filter does not refresh the Reset button state.
    * A failed reload after an mtime change leaves the page stale with no message.
* **Fix:**
  * Add a spec for each file with these values, and define the terms.
  * Decide how CSV cells are escaped.
  * Fix the error card, the options error, the Reset state and the stale-page banner, or change the CUJ text to match.

### M24. The Verification Plan cannot be run as written
* **Lens:** `egm-implementation-readiness`, `egm-style`, `egm-codebase-details` (B)
* **Location:** plan lines 1103-1116 and 1088; design lines 96-98, 119-125, 863-870; `scripts/demo.mjs:3, 9`; `test/mcp.e2e.test.ts:106`.
* **Problem:**
  * **The demo check shows nothing:**
    * "`node scripts/demo.mjs`, then `serve`" runs against the wrong home. The demo writes to `./.demo`, so the server must start with `OVERLOOK_HOME=.demo`.
    * The build has to run first.
  * **Unnamed baseline:** "against the visual baseline" names no artifact.
  * **No eval procedure:** "the full eval ... when one is available" gives no command and no pass threshold.
  * **`initialize` timing:** the plan's 3 s (line 1088) contradicts the NFR's 1 s (line 865).
  * **Untested performance targets:**
    * Grouped query under 2 s.
    * 8 panels drawn under 4 s.
    * Bundle under 150 KB gzipped.
  * **Coverage rule:** "every pipeline stage and every lockdown rule has at least one test" cannot be checked without a list mapping rules to tests.
  * **Example dashboard:**
    * Line 1046 says "both filter types", but there are three (`select`, `text`, `date`).
    * The example has no `text` filter, so the manual check never exercises one.
* **Fix:**
  * Write the exact commands for both shells:
    * PowerShell: `npm run build; node scripts/demo.mjs; $env:OVERLOOK_HOME='.demo'; node dist/src/cli.js serve`.
    * POSIX: the same steps with `OVERLOOK_HOME=.demo`.
  * Turn Goals lines 119-125 into a checklist.
  * Give the eval command (`OVERLOOK_EVAL_MODEL=... npm run eval`) and its threshold (10 of 12).
  * Use one `initialize` threshold, for example "target 1 s, CI tolerance 3 s".
  * Add a benchmark or manual procedure for each performance target, and a gzip check on `dist/ui/app.js`.
  * Add a table mapping each rule to its test.
  * Add a `text` filter to the example and name all three filter types.

---

## Nits

1. **Diverging design promises** (`egm-implementation-readiness`, `egm-codebase-details` A).
   * Design line 282 says zod produces the JSON Schema shown to the model, but `dashboardJsonSchema()` (`src/spec/schema.ts:218-220`) has no callers.
   * SQLite side files include `-journal` (`engine.ts:387`), which design line 385 omits.
   * `extension_directory` is set before step 1 (`engine.ts:151`), not at step 4.
   * Fix: update the design, or delete the dead export.
2. **Alternative G's library claim is wrong** (`egm-codebase-details` A).
   * Design lines 826-828 say the library does not expose a prepared statement's result columns. `@duckdb/node-api` 2.0.0-r.1 does expose them: `columnCount`, `columnName`, `columnType` (`DuckDBPreparedStatement.js:40-49`).
   * Fix: remove that bullet. The rejection still stands on its other grounds.
3. **Idle close timing** (`egm-codebase-details` A). The check interval is `min(5000, idleMs/4)` (`engine.ts:500`), so a close lands 20-25 s after the last query, not "at most 20". Fix: check every `min(1000, idleMs/4)`, or change the wording.
4. **Fetching a spec opens DuckDB** (`egm-codebase-details` A). `GET /api/d/<slug>` calls `engines.get()` (`server.ts:249`), which opens DuckDB and takes `.duckdb` locks with no query run. Fix: read the source types from `loadConfig()`.
5. **`checkSqlText` message and pattern** (`egm-codebase-details` A). The message names only SELECT, WITH and FROM, but `VALUES` and `(` are also allowed (`engine.ts:104-112`). The pattern has no word boundary, so `SELECTX` passes. Fix: correct the message and add `\b`.
6. **`kindOf('INTEGER[]')` returns `number`** (`egm-codebase-details` A, `engine.ts:67`). List, STRUCT and MAP columns therefore pass the numeric field checks. Fix: anchor the pattern.
7. **`parameters()` has no timeout** (`engine.ts:194-203`), and each panel is prepared twice (`egm-codebase-details` A). Fix: put the timer on the prepare, or reuse one prepared statement.
8. **`CheckOptions` JSDoc gives wrong defaults** (`egm-implementation-readiness`, `egm-codebase-details` A). It says 30 s and 10 s (`check.ts:54-57`); the code uses 40 s and 15 s (lines 114-115).
9. **Field checks the design does not list** (`egm-codebase-details` A).
   * `compare` must be numeric (`check.ts:339`).
   * A scatter `x` that is neither a number nor a date is an error (lines 396-398).
   * The `IS NULL` regex (line 265) misreads cast forms.
   * The dropped-panel warning is emitted by `tools.ts:108-109`, outside `CheckResult`.
   * Warnings are capped with no "N more" line (line 436).
   * Fix: document these rules or align the code.
10. **Spec limits exist only in `schema.ts`** (`egm-codebase-details` A): the identifier regex and the length and count caps. The spec reference also has one example (`reference.ts:56-73`), where design line 522 says two. Fix: add the limits to the design's spec block.
11. **Leftover `state/` folder** (all three lenses). `ensureHome` creates `state/` (`config.ts:35`), against design lines 236 and 677-678, and does not create `tmp/` or `extensions/`. Fix: list the folders under `OVERLOOK_HOME`.
12. **Logging and storage details** (`egm-codebase-details` A). Each of these needs one sentence in the design:
    * In MCP mode, stderr logging is off unless `--verbose` is passed (`cli.ts:192`), which contradicts design line 671.
    * `writeFileAtomic` blocks on `Atomics.wait` for up to about 6.4 s (`config.ts:78-99`).
    * Saves to one slug from two processes are last-writer-wins.
    * `.txt` is accepted as CSV (`config.ts:116`).
    * Glob expansion uses the experimental `fs.globSync`, and a literal path containing `[` or `{` is treated as a glob (`config.ts:121, 132`).
13. **Null POST body** (`egm-codebase-details` B). A body of `null` makes `body.params` throw, giving a 500 (`server.ts:266`). Fix: return 400.
14. **`ensureServer` can wait longer than 3 s** (`egm-codebase-details` B). The loop is 30 × (100 ms + a probe of up to 300 ms), up to about 12 s (`control.ts:118-122`). Fix: use a deadline.
15. **Eval matching** (`egm-codebase-details` B).
    * Numbers are rounded to 6 places and compared as strings (`run.ts:73`), not with the 1e-6 tolerance in design line 708.
    * The mapping check is skipped silently when column counts differ (`run.ts:114`).
16. **`openBrowser` on Windows** (`egm-codebase-details` B) passes a literal `'""'` argument (`cli.ts:56`). Fix: pass `''`.
17. **Duplicate file** (`egm-codebase-details` B). `C:\Users\Furkan\overlook\concepts_brief.md` duplicates `docs/concepts_brief.md`. Fix: delete it.
18. **Atomic write wording** (`egm-style`, line 958). Replace with: "write a temp file in the same folder, then rename it over the target; retry a failed rename up to 8 times with backoff (see Storage)."
19. **"capped at 8"** (`egm-style`, line 946). Write "at most 8 errors per reply, sorted by panel, duplicates merged, plus a count of the rest".
20. **"4-query limit"** (`egm-style`, line 994). Write "at most 4 concurrent queries; the rest wait".
21. **"description budget"** (`egm-style`, line 1083). Write "the six tool descriptions total under 1,800 tokens (under 7,200 characters)".
22. **Compressed phrasing** (`egm-style`).
    * Line 1067: "the row cap preserves the query's own `ORDER BY` and accepts a trailing `;` and a trailing `-- comment`".
    * Line 1078: "filter values not declared in the dashboard are ignored".
    * Line 1065: "a bypass attempt starting with each allowed keyword (`SELECT`, `WITH`, `FROM`, `VALUES`, `(`)".
23. **One warning, two names** (`egm-style`). Line 987 says "dropped-panel comparison" and line 1086 says "removed-panel warning". Use "dropped-panel warning" in both.
24. **Three names for one suite** (`egm-style`). "Upgrade gate", "attack suite" and "security test suite" name the same tests (lines 128, 398, 838, 1064, 1089). Use one name. Lines 1089-1091 also repeat themselves (see B2).
25. **Test file count** (all three lenses). Line 1103 says "six test files"; there are five, because `helpers.ts` is not a test. Line 1115 also uses `node dist/eval/run.js` where line 924 uses the `eval` script; use `npm run eval -- --dry`.
26. **Entries with no description** (`egm-style`): `tsconfig.ui.json`, `vitest.config.ts`, `.gitignore`, `installExtensions()`, `ui/dom.ts`, `ui/favicon.svg`, `test/helpers.ts`. Add one line each.
27. **Globs for known file names** (`egm-implementation-readiness`, `egm-style`).
    * `examples/data/*` is `orders.csv` and `traffic.csv`.
    * `docs/reviews/*` can name its report files, or say they are generated.
    * Listing this design as "(Create)" inside itself is circular.
    * "setup for each agent" should name the agents (line 682).
28. **Script details** (`egm-implementation-readiness`, `egm-style`, lines 931-936).
    * `build-ui.mjs` also copies `favicon.svg` and builds a minified es2022 IIFE.
    * `demo.mjs` reads `revenue-overview.json`, imports from `dist/`, and uses `./.demo` as `OVERLOOK_HOME`.
29. **`control.ts` return types and timeouts** (`egm-implementation-readiness`, line 995). Add `EnsureResult`, the `probe()` result union, and the timeouts: 800 ms probe, 2 s shutdown, 3 s start.
30. **Example description** (`egm-style`, lines 1044-1046). "A full example dashboard" is filler, and "a stacked area" is missing its noun. Fix: "a stacked area chart".
