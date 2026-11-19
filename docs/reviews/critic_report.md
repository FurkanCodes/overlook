# Goldfish Review Report: Stage 7 (Critic Review)

**Target:** `C:\Users\Furkan\overlook\docs\designs\overlook.md` (lines 1-710, everything before `## Detailed Implementation Plan`)
**Standard:** `feature-spec-standard.md` (design, structural); style persona default (style)
**GoldfishContext:** none

## Reviewer Status

| Reviewer | Status |
| --- | --- |
| `egm-design` | completed |
| `egm-structural` | completed |
| `egm-style` | completed |

**Severity breakdown after deduplication:** 1 Blocker, 22 Major, 30 Nit.

Notes:
- Line numbers refer to the target file as it was on 2026-11-19.
- Several design findings (the Blocker, Major 2 and Major 3) rest on DuckDB behaviour the reviewer remembered but did not test. Each one says what to check before acting on it.
- Where reviewers overlapped, their findings are merged and every contributing lens is listed.

---

## Prioritized Findings (Blockers -> Major -> Nits)

## Blocker

### B1. The Overlook server holds locks on DuckDB source files, which can block the user's own writers - Severity: Blocker
* **Reviewer Lens:** `egm-design`
* **Affected Scope:** Technical Plan > Data sources and the DuckDB lockdown, step 2 (L329-333); Web server and page (L463-501); Components (L211-215)
* **Discrepancy Description:** DuckDB allows either one read-write process or several read-only processes on a file. `ATTACH ... (READ_ONLY)` still takes a lock that blocks a writer. `overlook serve` runs in the background and never stops by itself, and the MCP process stays open for the whole agent session. So once a user registers a `.duckdb` file that their pipeline or app writes to, that writer fails with "Conflicting lock is held" until `overlook stop` runs. The reverse also happens: if the user's writer has the file open, Overlook cannot attach it. The design does not say whether that failure affects one source or the whole instance.
* **Rationale & Recommendation:**
  - Do not keep DuckDB sources attached. Either attach for each query and detach afterwards, or close the instance after N idle seconds and re-open it on the next request.
  - State that a source that fails to open or attach fails alone: its panels show an error and every other source keeps working.
  - Add an idle exit, or an idle instance close, to `overlook serve`.
  - Add an integration test in which a second process writes the file while Overlook is running.
  - Verify the lock behaviour against the pinned DuckDB version, and record the risk in the new Risks section (M1).

## Major

### M1. The required Risks & Mitigations section is missing - Severity: Major
* **Reviewer Lens:** `egm-structural`, `egm-design`
* **Affected Scope:** Whole range. The new section fits between `## Alternatives Considered` (L607) and `## Non-Functional Requirements` (L663).
* **Discrepancy Description:** The standard's "Risks & Limits" rule requires the spec to name its failure modes, security implications and scale limits, and to say how each is handled. Some of this is scattered through the Technical Plan, CUJ 3 and the NFRs. Several risks appear nowhere:
  - the source-file locks (B1);
  - silent wrong-column repairs (M7);
  - DuckDB upgrades changing the sandbox (M12);
  - unauthenticated read routes on 127.0.0.1, which other local processes or other users on the machine can reach;
  - tool results going to a hosted model provider (M11);
  - two 2GB `memory_limit` instances, giving a combined ceiling of 4GB;
  - no limit on concurrent queries in the server;
  - the server process never exiting;
  - a `sqlite` extension download with no integrity check;
  - supply-chain exposure through `npx`;
  - no fallback if the 30B model misses the 10-of-12 eval target.
* **Rationale & Recommendation:** Add `## Risks & Mitigations` as a table with columns Risk, Category (security / failure mode / scalability / project), Impact and Mitigation or accepted limit. Link each row to the Technical Plan with one line instead of restating the mechanism. Also list the limits already stated: the 5,000-row cap, 24 panels, the 15s/30s timeouts, the glob re-open interval, and 2s polling per open tab.

### M2. Query spill files may be written into the user's project folder - Severity: Major
* **Reviewer Lens:** `egm-design`
* **Affected Scope:** Data sources and the DuckDB lockdown (L322-343)
* **Discrepancy Description:** An in-memory DuckDB writes overflow data to `temp_directory`, which defaults to `.tmp` in the current working directory. The MCP process runs in the user's repository, and the spawned server inherits that directory. A query over the 2GB `memory_limit` could therefore write files into the repo. That contradicts "only reads files", and the design never says whether spilling is allowed.
* **Rationale & Recommendation:** Before `lock_configuration`, set `temp_directory` to `$OVERLOOK_HOME/tmp` and cap `max_temp_directory_size`. Or disable spilling and accept out-of-memory errors. State which one. Also set `extension_directory` under `$OVERLOOK_HOME` (see N18). Check the default against the pinned DuckDB version.

### M3. Stale views can break every panel on a source after its file changes, which contradicts CUJ 3 - Severity: Major
* **Reviewer Lens:** `egm-design`
* **Affected Scope:** CUJ 3 (L156-166); When an instance re-opens (L217-221); lockdown step 1 (L325-328); L483-484
* **Discrepancy Description:**
  - DuckDB binds a view's column names and types when the view is created. If the underlying file changes shape, every query on the view can fail ("Contents of view were altered"), not only the panel that uses the renamed column. CUJ 3 promises that working panels keep working.
  - An instance re-opens only when `config.json` changes or, for globs, every 60s. Replacing a non-glob file never triggers a re-open.
  - Nothing says what happens to queries still running on the old instance.
* **Rationale & Recommendation:** Re-open the instance, or re-create the views, when a source file's mtime or size changes. Alternatively, define each source as a table macro that reads the file fresh on every query. Close the old instance only after its in-flight connections finish. Add an integration test for CUJ 3: rename a column and assert that only the dependent panel fails.

### M4. The row-cap wrapper breaks common model SQL and may not preserve ordering - Severity: Major
* **Reviewer Lens:** `egm-design`
* **Affected Scope:** Row cap (L355-356)
* **Discrepancy Description:** `SELECT * FROM (<sql>) LIMIT 5001` fails on two common model outputs. A trailing `;` produces `(...;)`. A trailing `-- comment` comments out the closing `) LIMIT 5001`. Each gives a confusing syntax error and costs the model one of its 3 tries. Line x-order, top-N tables and the KPI "first row" all depend on the inner `ORDER BY` surviving the wrapper, and the spec never says that is guaranteed.
* **Rationale & Recommendation:** Wrap the single statement that DuckDB's statement extraction returns, with trailing semicolons removed and a newline before the closing parenthesis. Or apply the cap by stopping the result stream at 5,001 rows instead of rewriting the SQL. Add tests for a trailing semicolon, a trailing line comment, and order surviving the cap.

### M5. Filter parameter binding is not fully specified - Severity: Major
* **Reviewer Lens:** `egm-design`
* **Affected Scope:** Bound filters (L360-363); query check (L386-388); CUJ 4 (L168-178); Filter spec (L248-256)
* **Discrepancy Description:**
  - **Extra parameters:** DuckDB rejects named parameters the statement does not use, but the spec implies every filter is bound to every panel.
  - **Types:** select and text values are strings, so `year = $year` on an INTEGER column may fail to bind or compare as text. `options` is `string[]`, but `options_sql` may return numbers.
  - **NULL guard:** `WHERE region = $region` without an `IS NULL` guard passes the save check with only a "zero rows" warning, and the page stays empty until a filter is chosen.
* **Rationale & Recommendation:** Bind only the parameters the prepared statement reports, and cast each filter value to the type the statement gives for it. State how `options_sql` values are turned into strings and back. Raise a specific warning or error when a panel uses a filter whose default is NULL without a NULL guard. Detect parameters from the prepared statement, not with a regex (see N12).

### M6. The save check runs every query in full, so slow dashboards can never be saved - Severity: Major
* **Reviewer Lens:** `egm-design`
* **Affected Scope:** Goals > Three levels of checking (L73-78); query check (L386-393); timeouts (L357-359)
* **Discrepancy Description:** A save gives each panel 10s, while the page gives it 15s, so a 12s panel works on the page but can never be saved. With 24 panels, 4 at a time, inside a 30s total budget, large sources produce "not checked in time" errors, and each one uses up a try. The field and type check only needs result column names and types, which DuckDB can supply without running the query (prepare, or `DESCRIBE <query>`).
* **Rationale & Recommendation:** Take "Executable" and "Fits its chart" from prepare/bind metadata. Run the query as a separate step, and make its timeout a warning instead of an error (row-count warnings are skipped in that case). Add this split as an Alternative, with its trade-off: runtime errors such as cast failures are caught later.

### M7. The typo fixer can silently map a name to a column with a different meaning - Severity: Major
* **Reviewer Lens:** `egm-design`
* **Affected Scope:** Field check (L394-403); CUJ 2 (L140-154)
* **Discrepancy Description:** With 2 edits allowed for names of 8 or more characters, `max_temp` becomes `min_temp` and `revenue_2024` becomes `revenue_2023`. The save succeeds with wrong numbers. The repair is reported, but a small model will likely ignore the report. This defeats the correct-numbers goal.
* **Rationale & Recommendation:** Never auto-repair when the edit changes a digit or swaps an antonym token (min/max, start/end, in/out, gross/net). Or allow at most 1 edit at any length, with case and `_`/space normalization handled separately. Add these examples as tests.

### M8. There is no rule for turning DuckDB values into JSON - Severity: Major
* **Reviewer Lens:** `egm-design`
* **Affected Scope:** Panel API (L508-509); type rules (L404-405); eval comparison (L598-603)
* **Discrepancy Description:** `@duckdb/node-api` returns BIGINT and HUGEINT as `BigInt`, and DECIMAL, DATE and TIMESTAMP as value objects. `JSON.stringify` throws on `BigInt`, so the first `COUNT(*)` panel would fail. A DATE sent as UTC midnight shows as the previous day in US time zones. "Numeric" is never defined.
* **Rationale & Recommendation:** Specify how each type is sent:
  - integers as numbers when they fit safely, otherwise as strings with a flag;
  - DECIMAL as a number;
  - DATE as a `YYYY-MM-DD` string drawn on a date-only scale;
  - TIMESTAMP and TIMESTAMPTZ with explicit time-zone handling.

  List the types accepted as numeric for `y` and `value`, and use the same conversion in the eval comparison.

### M9. `describe_data` with no `source` may scan every source in full - Severity: Major
* **Reviewer Lens:** `egm-design`
* **Affected Scope:** MCP tools table (L434)
* **Discrepancy Description:** Row counts on CSV, JSON and glob sources need a full scan. Every journey starts with this call, and it can take seconds or hit the 15s timeout on multi-GB data.
* **Rationale & Recommendation:** Report exact counts only where they are cheap (Parquet metadata, the DuckDB or SQLite catalog). Otherwise return "unknown" or an estimate, give the call a short time budget, and return partial results.

### M10. Supported operating systems are not stated, and Windows-specific failures are unhandled - Severity: Major
* **Reviewer Lens:** `egm-design`
* **Affected Scope:** Storage (L448-461); server start (L486-499); `serve.lock` (L468-470); Language and dependencies (L225-228)
* **Discrepancy Description:**
  - **Renames:** a rename-replace fails with EPERM/EBUSY while another process (the 2s poll, a panel request, antivirus) has the file open.
  - **History file names:** ISO timestamps with colons in `history/<slug>/<timestamp>.json` are not valid Windows file names.
  - **Slugs:** reserved names (`con`, `nul`, `aux`) and empty slugs (from names with no ASCII letters) are not handled.
  - **Server spawn:** spawning through `npx` opens a console window unless `windowsHide` is set. `npx` cold start can run past the 3s health wait, and the reply for that timeout is not defined.
  - **Lock file:** "readable only by the user" relies on POSIX file modes, which Windows does not apply.
* **Rationale & Recommendation:**
  - State the supported OS list.
  - Specify retry with backoff on rename, a safe timestamp format (for example `20261119T101500123Z`), a fallback slug and a reserved-name guard.
  - Spawn with `process.execPath` plus the script path and `windowsHide: true`, and define the tool's reply when the 3s wait times out.
  - Say how the lock file is protected on Windows.

### M11. The privacy goal and `OVERLOOK_SAMPLES=0` overstate what stays local - Severity: Major
* **Reviewer Lens:** `egm-design`, `egm-structural`, `egm-style`
* **Affected Scope:** Goals > Data stays local (L88-92); MCP tools (L434-435); NFR Security (L668-670)
* **Discrepancy Description:** `OVERLOOK_SAMPLES=0` removes only the 3 sample rows from `describe_data`. Other paths still send data to the model:
  - `preview_query` returns up to 20 rows of any SELECT;
  - DuckDB error messages often quote data values, and save and `get_dashboard` replies carry them.

  When the agent uses a hosted model, all of this goes to the provider, which sits awkwardly under a goal titled "Data stays local". Line 92 ("The model sees only what tool results contain.") is close to a tautology and does not tell the reader what is exposed.
* **Rationale & Recommendation:** State plainly that the model can read any registered data through `preview_query`, and that the flag only removes unprompted samples. Or add a strict mode that limits `preview_query` to column names, types and aggregates and removes values from error text. Rename or reword the goal, for example "Data reaches the model only through tool results; nothing is uploaded by Overlook itself". Record the risk in M1.

### M12. The sandbox depends on DuckDB behaviour that can change, with no version pin and no security tests - Severity: Major
* **Reviewer Lens:** `egm-design`, `egm-structural`
* **Affected Scope:** Lockdown (L334-343, L345-354); Goals > Tests (L96-97)
* **Discrepancy Description:** The lockdown relies on DuckDB details: `allowed_paths` exceptions, the `allowed_directories` probe result, PRAGMA reporting as SELECT, and what `query()`, `glob()` and `read_text` may do. These details change between releases. The Tests goal does not mention security tests, and the DuckDB version is not pinned.
* **Rationale & Recommendation:** Pin `@duckdb/node-api` to an exact version. Add a required attack suite in which every case must fail, and run it on every DuckDB upgrade:
  - reading an unregistered path;
  - `COPY TO`;
  - `ATTACH`;
  - `INSTALL`/`LOAD`;
  - an http read;
  - `glob('*')`;
  - `query('...')`;
  - `SET` through each allowed leading keyword;
  - PRAGMA.

### M13. Alternative rejection reasons lack concrete trade-offs (B, D, F) - Severity: Major
* **Reviewer Lens:** `egm-structural`, `egm-design`
* **Affected Scope:** Alternative B (L622), Alternative D (L634-640), Alternative F (L653-659)
* **Discrepancy Description:** The Alternatives Rule requires each rejection to state a concrete trade-off.
  - **B:** the reason says only "Rejected by author for the model-facing format."
  - **D:** the listed con, "data disappears if the daemon dies", applies equally to the chosen design. "We would need an API between the processes" is weak, because the server already has an HTTP JSON API and the MCP process already starts it. The real costs of the chosen design are not weighed: 2 DuckDB instances, double memory, double file locks (B1) and duplicated re-open logic.
  - **F:** the main con, passwords in transcripts, does not apply in v1, because no v1 source has credentials (Postgres is deferred, L319).
* **Rationale & Recommendation:** Rewrite each Reason against the chosen design. For D, compare one daemon with two in-memory instances plus a shared folder on memory, locks, crash recovery and coordination, and say why the MCP tools should not forward queries to the server they already start. For F, name the v1 concern (a model widening `allowed_paths` or pointing DuckDB at arbitrary files) and keep credentials as a later, Postgres-related concern. For B, state the actual format trade-off.

### M14. The local-model goal rests on an under-specified model and eval protocol - Severity: Major
* **Reviewer Lens:** `egm-design`, `egm-style`
* **Affected Scope:** Goals (L83-87); Eval (L579-605)
* **Discrepancy Description:** "A 30B-class local model" does not fix the model, parameter count, quantization, runtime or context size. "10 of 12" from a single run at an unspecified temperature is mostly noise, and one flaky prompt flips the result. The pass check compares numbers but not the `x`/`y` column mapping, so a chart with swapped axes passes.
* **Rationale & Recommendation:** Name the reference model or models, the quantization, the runtime and the context window (for example "<model> 30B, Q4_K_M, via Ollama, 32k context"). Fix the temperature and seed, run each prompt at least 3 times, and report the pass rate. Add a per-panel check on panel type and on which columns `x`, `y` and `value` use.

### M15. The performance targets have no reference machine, data size or benchmark - Severity: Major
* **Reviewer Lens:** `egm-design`, `egm-style`
* **Affected Scope:** NFR > Performance (L671-677)
* **Discrepancy Description:** "On a laptop" makes the 2s and 4s targets impossible to verify. Each page load runs a full CSV parse and type detection per panel. With 8 concurrent POSTs on one instance, that is 8 parallel 1M-row parses, with no server-side concurrency limit and no cancellation when a filter changes or another tab is opened. The trigger "If real use misses this" is vague.
* **Rationale & Recommendation:** Name the reference hardware (CPU class, RAM, SSD) and the CSV shape (column count, size in MB). Add a server-side concurrency limit, and cancel the previous run when a filter changes or the page is left. Make the targets a benchmark that runs in CI or the eval. Rewrite the trigger as "If the 8-panel target is missed on the reference machine, caching (Open Question 2) is next."

### M16. The concepts-brief reference does not resolve - Severity: Major
* **Reviewer Lens:** `egm-structural` (verified by the synthesizer: no `concepts_brief*.md` exists under `C:\Users\Furkan\overlook`)
* **Affected Scope:** Additional Resources (L688)
* **Discrepancy Description:** `../../concepts_brief.md` is a code span, not a link. From `docs/designs/` it points to `C:\Users\Furkan\overlook\concepts_brief.md`, which does not exist. The document cites this file as its multi-lens review, and it may hold risk analysis that M1 says is missing.
* **Rationale & Recommendation:** Commit the file or fix the path, and write the entry as `[Concepts brief](../../concepts_brief.md)`. If the brief will not ship with the repo, remove the entry.

### M17. "Server" means two different things - Severity: Major
* **Reviewer Lens:** `egm-style`
* **Affected Scope:** L177, L430; compare L17-21 and L463 onward
* **Discrepancy Description:** Most of the document uses "the server" for `overlook serve`. L430 ("All real checking happens on the server...") means the MCP server, so readers will take it to mean the web server. "real" is filler.
* **Rationale & Recommendation:** "All checking happens inside the MCP server (`checkDashboard`), so harnesses with strict or limited tool-schema support still work." Use "MCP server" or "MCP process" and "web server" every time, and never a bare "server" where both are in context.

### M18. The Overview names agents the design does not support - Severity: Major
* **Reviewer Lens:** `egm-style`
* **Affected Scope:** Overview (L12-13), compared with L70, L193 and L576-577
* **Discrepancy Description:** The Overview lists Cursor and Goose. The Goals, the diagram and the `doctor` snippets cover only Claude Code, Codex CLI and OpenCode, and the design gives no evidence or plan for the other two.
* **Rationale & Recommendation:** "Overlook targets any agent that supports MCP. v1 is tested with Claude Code, Codex CLI and OpenCode." Drop Cursor and Goose, or move them to an "expected to work, untested" note.

### M19. Claims about model ability are unsupported - Severity: Major
* **Reviewer Lens:** `egm-style`
* **Affected Scope:** L52, L613, L614-615
* **Discrepancy Description:** "Small and mid-size models write long free-form code badly", "it fails often on mid-size models" and "the one thing that makes small models dependable here" are stated as fact, with no source or measurement. "Dependable" claims a result the eval has not produced yet.
* **Rationale & Recommendation:** Cite the evidence (a run, a benchmark or the brief), or narrow the claim. For example: "Long free-form code gives a mid-size model more places to fail, and no checker reports the failure." For L614: "It removes the small, checked output this design depends on for mid-size models."

### M20. The "Looks good" goal cannot be tested - Severity: Major
* **Reviewer Lens:** `egm-style`
* **Affected Scope:** Goals (L93-95); Alternative C (L629-632)
* **Discrepancy Description:** "Looks good" and "readable" are judgments, not targets. Alternative C's rejection depends on "the visual quality goal", which nobody can test.
* **Rationale & Recommendation:** Rename the goal (for example "Visual baseline") and list checkable items: both themes, a layout that works at full width and at 400px, a tooltip on every chart, no layout shift, and palette contrast (moved from L549). In Alternative C, cite those items instead of "visual quality".

### M21. The three checking levels do not map to the pipeline steps - Severity: Major
* **Reviewer Lens:** `egm-style`
* **Affected Scope:** Goals (L73-78); The checking pipeline (L372-413)
* **Discrepancy Description:** The Goals name three levels (Valid, Executable, Fits its chart). The pipeline has six differently named steps (Lenient repair, Schema, Reference, Query, Field, Warnings). The Reference step belongs to none of the levels.
* **Rationale & Recommendation:** Open the pipeline section with the mapping, for example "Valid = steps 2-3, Executable = step 4, Fits its chart = step 5". Or rename the levels to match the steps. If M6 is adopted, update the mapping to match.

### M22. The instance re-open rule is stated twice, with conflicting wording - Severity: Major
* **Reviewer Lens:** `egm-style`, `egm-structural`
* **Affected Scope:** L217-221 and L483-484
* **Discrepancy Description:** L217-221 says an instance re-opens lazily, "on the next query after `config.json` changes". L483-484 says the web server re-opens "whenever the config file changes", which reads as eager. The two places also name the file differently.
* **Rationale & Recommendation:** Keep the rule only in Components. Replace L483-484 with "See 'When an instance re-opens'." Use "`config.json`" everywhere. Update the rule if M3 changes the re-open triggers.

## Nit

### N1. Additional Resources and Future Improvements nest under the NFRs - Severity: Nit
* **Reviewer Lens:** `egm-structural`
* **Affected Scope:** L684-707
* **Discrepancy Description:** Both are H3s after the `## Non-Functional Requirements` H2, so they nest under the NFRs in any outline. The horizontal rule at L684 shows a separate section was intended.
* **Rationale & Recommendation:** Promote both to `##`.

### N2. External links are bare URLs - Severity: Nit
* **Reviewer Lens:** `egm-structural`
* **Affected Scope:** L689-694
* **Discrepancy Description:** The DuckDB and Codex URLs are raw text in parentheses, and the DuckDB entry is split over 4 short lines.
* **Rationale & Recommendation:** Use `[Securing DuckDB](https://duckdb.org/docs/stable/operations_manual/securing_duckdb/overview)` and `[Codex MCP documentation](https://developers.openai.com/codex/mcp)`, each with a one-line note.

### N3. The feature-parity list sits in the Overview and conflicts with the Non-Goals - Severity: Nit
* **Reviewer Lens:** `egm-structural`, `egm-style`
* **Affected Scope:** Overview (L30-38); Goals (L68-97); Non-Goals (L103-104)
* **Discrepancy Description:** "Feature parity target" lists deliverables in the Overview. Two of them, filters and the full panel-type set, have no Goal. "Parity" also contradicts the Non-Goal that excludes data entry. "Useful" is subjective, and "own" adds nothing.
* **Rationale & Recommendation:** Keep one sentence in the Overview: "Reference product: the dashboard feature in Anthropic's Claude product. Overlook matches these behaviours, not its code, name or look." Move the list into Goals, or merge its items into existing goals.

### N4. Rules are restated in several sections - Severity: Nit
* **Reviewer Lens:** `egm-structural`
* **Affected Scope:**
  - eval pass definition: L83-87 and L598-603;
  - edit-distance thresholds: CUJ 2 (L146-154) and pipeline step 5 (L397-402);
  - per-panel tools: Open Question 1, L592 and L698;
  - caching: Open Question 2, L675 and L704.
* **Discrepancy Description:** Repeated rules drift apart when edited, and readers have to work out which copy is authoritative.
* **Rationale & Recommendation:** Keep each rule where it is defined and cross-reference it elsewhere. Mark Future Improvements entries that depend on an Open Question as "pending Open Question N".

### N5. Open Questions comes before the material it depends on, and refers to it vaguely - Severity: Nit
* **Reviewer Lens:** `egm-structural`, `egm-style`
* **Affected Scope:** L113-119
* **Discrepancy Description:** Question 1 depends on the Eval and Question 2 on the NFRs, both of which come later. "The page-load target below" does not say where.
* **Rationale & Recommendation:** Move the section after the NFRs or after the new Risks section. Or keep it in place and add explicit links ("Non-Functional Requirements > Performance").

### N6. Some design decisions have no evaluated alternative - Severity: Nit
* **Reviewer Lens:** `egm-structural`
* **Affected Scope:** Language and dependencies (L223-236); live editing (L558); fixed port (L466)
* **Discrepancy Description:** Three choices are justified only inline: TypeScript over Python, 2s polling over SSE or a file-watch push, and a fixed port over port discovery.
* **Rationale & Recommendation:** Add short Alternatives G, H and I with one-line Pros, Cons and Reason each, or state in the inline text what was considered and why it lost.

### N7. The architecture diagram is incomplete - Severity: Nit
* **Reviewer Lens:** `egm-structural`
* **Affected Scope:** L192-209
* **Discrepancy Description:** The diagram has three problems:
  - the folder tree omits `logs/overlook.log` (defined at L566);
  - the "reads JSON" connector (L203) ends at a border with no `┬` junction, so its origin is unclear;
  - the spawn and health-check path from the MCP process (L486-499) is not shown.
* **Rationale & Recommendation:** Add the log file to the tree, add the junction, and add a "spawns / health-checks if not running" arrow.

### N8. The spec block breaks its layout at `x?`, `y?` and `series?` - Severity: Nit
* **Reviewer Lens:** `egm-structural`
* **Affected Scope:** L264
* **Discrepancy Description:** These three fields share one line with no comments, while every other field has its own line and comment.
* **Rationale & Recommendation:** Give each field its own line and comment (for example, note that `series` is for long-format data only).

### N9. Horizontal rules are used inconsistently - Severity: Nit
* **Reviewer Lens:** `egm-structural`
* **Affected Scope:** L7, L661, L684, L709
* **Discrepancy Description:** The rules imply a grouping that the headings never state.
* **Rationale & Recommendation:** Keep rules only at named group boundaries, or remove the ones at L661 and L684 after N1 is fixed.

### N10. "Rejected by author." opens every Reason - Severity: Nit
* **Reviewer Lens:** `egm-structural` (`egm-style` noted the phrase comes from the template and did not flag it)
* **Affected Scope:** L614, L622, L630, L639, L649, L658
* **Discrepancy Description:** The phrase names who decided rather than why, and adds nothing to the reason.
* **Rationale & Recommendation:** Start each Reason with the trade-off. If the template requires the phrase, move it to the end.

### N11. The spec and the SQL rules disagree on allowed statements - Severity: Nit
* **Reviewer Lens:** `egm-design`
* **Affected Scope:** L263 compared with L348-349
* **Discrepancy Description:** The spec says "one SELECT or WITH", but the checks also accept `FROM`, `VALUES` and `(`.
* **Rationale & Recommendation:** Use one list in both places.

### N12. The `$name` detection method is not stated - Severity: Nit
* **Reviewer Lens:** `egm-design`
* **Affected Scope:** L383
* **Discrepancy Description:** A regex would misfire on `$` inside string literals, on `$$...$$` strings and on `$1`.
* **Rationale & Recommendation:** Take parameter names from the prepared statement (see M5).

### N13. KPI and percent formatting are ambiguous - Severity: Nit
* **Reviewer Lens:** `egm-design`
* **Affected Scope:** L269, L294-297
* **Discrepancy Description:** The spec does not say whether `percent` expects 0.12 or 12, and the change display for a `compare` of 0 or NULL is undefined.
* **Rationale & Recommendation:** Define both.

### N14. Response headers are missing - Severity: Nit
* **Reviewer Lens:** `egm-design`
* **Affected Scope:** Safety rules (L517-535)
* **Discrepancy Description:** There is no `X-Content-Type-Options: nosniff` and no `Referrer-Policy: no-referrer`, and Markdown links lack `rel="noopener noreferrer"`.
* **Rationale & Recommendation:** Add all three.

### N15. The filter-options route runs queries on GET - Severity: Nit
* **Reviewer Lens:** `egm-design`
* **Affected Scope:** L510
* **Discrepancy Description:** Any web page can trigger these queries blind, for example with an `<img>` tag. It cannot read the results, but it can create load.
* **Rationale & Recommendation:** Apply the same JSON-POST rule as the panel route, or cache the options.

### N16. One page load can show panels from two dashboard versions - Severity: Nit
* **Reviewer Lens:** `egm-design`
* **Affected Scope:** L508, L558-559
* **Discrepancy Description:** Panel requests look up the spec by slug and id on each call, so a save during a page load can mix panels from two versions.
* **Rationale & Recommendation:** Send the spec's mtime with each panel request and return 409 if it no longer matches.

### N17. The `spec` tool input schema is unspecified - Severity: Nit
* **Reviewer Lens:** `egm-design`
* **Affected Scope:** L428-430
* **Discrepancy Description:** The exact JSON Schema for "object or JSON string" is not given. Harnesses with strict schema handling may reject `oneOf`/`anyOf` or schemaless objects.
* **Rationale & Recommendation:** State the emitted schema and test it in each supported agent.

### N18. The sqlite extension must be reinstalled after DuckDB upgrades - Severity: Nit
* **Reviewer Lens:** `egm-design`
* **Affected Scope:** L329-333, L682
* **Discrepancy Description:** DuckDB stores extensions per DuckDB version, so an upgrade breaks SQLite sources until `doctor --install` runs.
* **Rationale & Recommendation:** Have `doctor`, or the first run after an upgrade, detect this and tell the user. Store extensions under `$OVERLOOK_HOME` (see M2).

### N19. Saving over an existing slug is silent - Severity: Nit
* **Reviewer Lens:** `egm-design`
* **Affected Scope:** L451-455
* **Discrepancy Description:** A model can replace a user's dashboard that has the same title, and nothing warns anyone.
* **Rationale & Recommendation:** On replace, return the old title and panel ids, or require `overwrite: true`.

### N20. `preview_query` runs the query twice - Severity: Nit
* **Reviewer Lens:** `egm-design`
* **Affected Scope:** L435
* **Discrepancy Description:** The total row count needs a second full run.
* **Rationale & Recommendation:** Count while streaming up to a cap, and report "5,000+" beyond it.

### N21. British and American spelling are mixed - Severity: Nit
* **Reviewer Lens:** `egm-style`
* **Affected Scope:** "behaviour" (L31, L595) and "favour" (L639), against "color" (L549) and "authorizes" (L470)
* **Rationale & Recommendation:** Pick one variant and apply it throughout.

### N22. Codex CLI is named inconsistently - Severity: Nit
* **Reviewer Lens:** `egm-style`
* **Affected Scope:** L193, L444
* **Rationale & Recommendation:** Use "Codex CLI" everywhere.

### N23. Numbers mix words and digits - Severity: Nit
* **Reviewer Lens:** `egm-style`
* **Affected Scope:** "three tries" (L86) vs "3 tries" (L600); "about two seconds" (L185) vs "every 2 seconds" (L558); "eight errors" (L82, L424) vs "8-panel" (L674)
* **Rationale & Recommendation:** Use digits for counts and quantities throughout.

### N24. The start-up timeout sentence is awkward - Severity: Nit
* **Reviewer Lens:** `egm-style`
* **Affected Scope:** L441-444
* **Discrepancy Description:** "so slow agent start-up timeouts are not hit" reads as if the timeouts are slow, and "kept under about 1,800 tokens" hedges twice.
* **Rationale & Recommendation:** "The six tool descriptions total at most 1,800 tokens. The MCP server answers `initialize` before DuckDB opens; DuckDB opens on the first tool call. This keeps start-up within agent timeouts (10 seconds by default in Codex CLI)."

### N25. "Figure" and "number" are used for provenance - Severity: Nit
* **Reviewer Lens:** `egm-style`
* **Affected Scope:** L36, L79
* **Discrepancy Description:** "Figure" can also mean a chart, and the provenance footer is shown per panel, not per number.
* **Rationale & Recommendation:** Write "every panel shows where its data came from" in both places.

### N26. Adjectives about other tools are subjective - Severity: Nit
* **Reviewer Lens:** `egm-style`
* **Affected Scope:** L47 ("obvious"), L62 ("heavy servers"), L620 ("far too large"), L648 ("a large install")
* **Rationale & Recommendation:** Drop "obvious". Replace the others with measurable facts (install size, required services, schema size in tokens) or remove them.

### N27. "Small" is never defined - Severity: Nit
* **Reviewer Lens:** `egm-style`
* **Affected Scope:** L23, L65, L615, L649
* **Discrepancy Description:** "Small spec" is the core argument for the design, but it is never measured.
* **Rationale & Recommendation:** Define it once (for example, "a spec whose schema and tool descriptions fit within 1,800 tokens") and refer back to that definition.

### N28. The eval overstates its role and repeats itself - Severity: Nit
* **Reviewer Lens:** `egm-style`
* **Affected Scope:** L592; L594-596 compared with L583
* **Discrepancy Description:** The eval informs Open Question 1 but does not answer it. "Calling the core functions directly" appears twice.
* **Rationale & Recommendation:** Write "which supplies data for Open Question 1." Merge the harness-isolation reasoning into the first paragraph and delete the repeated sentence.

### N29. Informal phrasing and vague references - Severity: Nit
* **Reviewer Lens:** `egm-style`
* **Affected Scope:** L486 ("decides ... like this"), L216 ("The folder")
* **Rationale & Recommendation:** "The MCP process runs these steps before it returns a URL:" and "`~/.overlook/` (or `OVERLOOK_HOME`) is the only shared record." (The vague "below" at L119 is covered in N5.)

### N30. CUJ 2 hides a second scenario, and the error cap is ambiguous - Severity: Nit
* **Reviewer Lens:** `egm-style`
* **Affected Scope:** L153-154; L424
* **Discrepancy Description:** "**Two close matches.**" is a second scenario inside the first scenario's Then list. "At most eight" does not say whether warnings and repairs count toward the cap.
* **Rationale & Recommendation:** Move the two-match case into its own "Variant:" block. Write "at most 8 errors (warnings and repairs are not capped)", or state the real rule.

### N31. The voice switches to "we" - Severity: Nit
* **Reviewer Lens:** `egm-style`
* **Affected Scope:** L627, L637
* **Discrepancy Description:** The rest of the document is impersonal.
* **Rationale & Recommendation:** Rewrite as "Overlook would have less control over look, tooltips and loading states" and "This needs an API between the processes" (or the stronger D reasoning from M13).
