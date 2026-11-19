# Security

Overlook runs SQL against your local data and serves a web page on your
machine. The design keeps both inside tight limits. The README's "Security
model" section describes them:

*   **DuckDB:** read-only and locked down, with no network or file access beyond
    your registered sources.
*   **SQL:** single-SELECT queries only.
*   **Web server:** listens only on 127.0.0.1, with a Host-header check and a
    strict CSP.
*   **Sources:** the agent can only add sources from inside its project folder.

`test/security.test.ts` holds the attack suite that must pass on every DuckDB
upgrade.

## Reporting a vulnerability

Please report security problems privately through
[GitHub's private vulnerability reporting](https://github.com/furkancodes/overlook/security/advisories/new),
not in a public issue. Include:

*   the Overlook version (`overlook --help` prints it) and your OS;
*   what an attacker controls (the model's output, a data file, a web page you
    visit) and what they gain;
*   steps or a spec that reproduces it.

You should get a reply within a week. Fixes for confirmed issues ship as a patch
release, credited to you unless you ask otherwise.

## Supported versions

Only the latest release gets security fixes during the 0.x preview.
