# Consolidated EGM review: Overlook

*   **Target:** [docs/designs/overlook.md](../designs/overlook.md)
*   **Mode:** consolidated report, all review rubrics, run without stopping
*   **Date:** 2026-11-19

Every stage ran in a fresh context. Each stage's findings were resolved in the
design, and where they named code, in the code, before the next stage started.
Claims about DuckDB behavior were checked against the pinned DuckDB 2.0.0
before acting on them.

| Stage | Report | Blockers | Majors | Nits | Result |
| --- | --- | --- | --- | --- | --- |
| 5. Initial zoom out | [zoom_out_report.md](zoom_out_report.md) | 0 | 9 | 9 | All majors adopted |
| 6. Comprehension | [comprehension_report.md](comprehension_report.md) | 0 | 5 | 12 | All fixed |
| 7. Critic (design, structure, style) | [critic_report.md](critic_report.md) | 1 | 22 | 30 | Blocker and majors fixed; M3 disproved by test |
| 8. Intermediate zoom out | (returned in session) | 0 | 2 | 5 | Both majors adopted |
| 9. Implementation readiness | [implementation_readiness_report.md](implementation_readiness_report.md) | 4 | 24 | 30 | B1 disproved by measurement; B2–B4 and the majors fixed |

## Decisions that changed the design

1.  **Postgres is deferred.** (Stage 5) It is the only networked, credentialed
    source.
2.  **No extension downloads at start-up.** (Stage 5) The `sqlite` extension is
    installed only by `source add` or `doctor --install`. Auto-install and
    auto-load are turned off before any source attaches (Stage 9 M7).
3.  **A fixed port, with health and version checks.** (Stages 5 and 8)
    `serve.lock` and its shutdown token were later removed (Stage 8 Nit 1).
4.  **Unset filters bind NULL.** (Stage 5) A panel without the `IS NULL` guard
    gets a warning.
5.  **The save budget matches the page.** (Stages 5 and 7) The page limit is 15
    s per query, and a save has 40 s in total.
6.  **Idle close after 20 s.** (Stage 7 B1) Confirmed by probe: a read-only
    attach of a `.duckdb` file blocks other writers.
7.  **Spill files go under `OVERLOOK_HOME`.** (Stage 7 M2) Confirmed: DuckDB's
    default `temp_directory` is `.tmp` in the working directory.
8.  **A streaming row cap instead of a SQL wrapper.** (Stage 7 M4)
9.  **Edit-distance column repair removed.** (Stage 8 M2) Only case-only
    matches are repaired; everything else gets an error with "did you mean".
10. **Eval runs use 3 seeds at temperature 0.3.** (Stage 8 M1)
11. **The upgrade gate attacks DuckDB directly.** (Stage 9 B2) Raw-connection
    tests prove `allowed_paths`, `lock_configuration` and the extension lock
    hold without Overlook's own checks.

## Findings disproved by evidence

*   **Stage 7 M3** said stale views break panels after a file changes. A probe
    and `test/security.test.ts` show DuckDB re-detects the columns on each
    query. Only queries on a removed column fail.
*   **Stage 9 B1** said a refused loopback connect takes 1–2 s on Windows, so
    the server would never start. It was measured on Windows 10 at 31 ms with
    `fetch` and 3 ms with TCP. `probe()` now does a TCP connect first anyway,
    so the result cannot depend on timing.

## Code bugs found by review and fixed

*   **Engine:**
    *   `inflight` leaked when `connect()` failed.
    *   A replaced engine could close under a caller that still held it.
    *   A failed source never recovered.
    *   Auto-load was turned off only after sources attached.
*   **Web server:** a browser cancel did not stop the query on the server.
*   **Check:** `options_sql` could return several columns and still pass, and
    its queries ran outside the save budget.
*   **MCP tools:**
    *   `get_dashboard` skipped the version guard.
    *   `preview_query` failed to count rows when the SQL ended in `;`.
    *   Only saves were logged.
*   **Config:** `config.json` lost unknown keys and had no version guard.
*   **CLI:** `--type` could not override an unknown extension.
*   **Eval:** the eval declared its own tools, which differed from the MCP
    ones. It now uses the MCP definitions.
*   **UI:**
    *   Scatter "Other" summed points from different series into points that
        do not exist.
    *   CSV export allowed formula injection.
*   **Errors:** zod errors lacked the received value.
*   **Found in the browser check:** files with a UTF-8 BOM were rejected, series
    colors leaked between charts, the Reset button was always shown, and
    horizontal bar labels were cut off.

## Final verification

*   `npm test`: 110 tests in 6 files pass. They cover the engine, the checks,
    the security gate, the store and lifecycle, the web server, and the MCP
    server end to end over stdio.
*   `npm run typecheck` is clean for `src/` and `ui/`.
*   `node scripts/bench.mjs`, against the targets:

    | Measure | Result | Target |
    | --- | --- | --- |
    | MCP `initialize` | 352 ms | 1 s |
    | Grouped query, 1M rows | 191 ms | 2 s |
    | 8-panel check | 801 ms | 4 s |

*   **Manual browser check:**
    *   both themes and 400 px;
    *   tooltips and the crosshair;
    *   filters synced to the URL;
    *   the Source drawer;
    *   a per-panel error card and the empty state;
    *   live reload on a file edit.
*   **Not done:** the full model eval, because no local model endpoint was
    available. The prompts were checked with `--dry`.
