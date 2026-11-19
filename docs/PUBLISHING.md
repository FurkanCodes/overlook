# Publishing a release

Overlook ships through three channels. Each one points at the same npm
package, so the order matters:

1. npm
2. the MCP Registry
3. the Claude Code plugin

| Channel | What it holds | Where it lives |
| :--- | :--- | :--- |
| npm (`overlook-dash`) | The code: the CLI, the MCP server and the web UI | `package.json`, `dist/` |
| MCP Registry (`io.github.furkancodes/overlook`) | Metadata only: name, description, how to start it | `server.json` |
| Claude Code plugin (`overlook`) | The MCP server entry, a `dashboard` skill and an icon | `plugin/`, `.claude-plugin/marketplace.json` |

The version appears in four places: `package.json`, `server.json` (twice),
`plugin/.claude-plugin/plugin.json`, and `VERSION` in `plugin/launch.mjs`.
`test/release.test.ts` fails if they differ, so bump all of them together.

## Before the first release

*   **GitHub account:** `furkancodes` is used as the GitHub account in
    `package.json`, `server.json` and the plugin files. If the repository
    lives elsewhere, replace it everywhere. The registry name must start with
    `io.github.<your-account>/` to publish with GitHub login.
*   **Repository:** push this repository to `github.com/furkancodes/overlook`.
    The plugin is installed from that repository.

## 1. npm

```bash
npm test
```

```bash
npm pack --dry-run
```

Check the file list: only `dist/src`, `dist/ui`, `README.md`, `LICENSE` and
`THIRD_PARTY_NOTICES.md`.

```bash
npm publish --access public
```

`prepublishOnly` builds and runs the tests again. Then check that the plugin's
launcher can fetch the published package:

```bash
npx -y overlook-dash@0.1.0 --help
```

## 2. MCP Registry

The registry checks that `mcpName` in the published `package.json` matches
`name` in `server.json`, so npm must go first. Install `mcp-publisher` (see the
[registry quickstart](https://modelcontextprotocol.io/registry/quickstart)),
then run:

```bash
mcp-publisher validate
```

```bash
mcp-publisher login github
```

```bash
mcp-publisher publish
```

To check the listing:

```bash
curl "https://registry.modelcontextprotocol.io/v0.1/servers?search=io.github.furkancodes/overlook"
```

Directories that read the registry, such as GitHub's MCP registry and
PulseMCP, pick it up from there.

## 3. Claude Code plugin

```bash
claude plugin validate ./plugin --strict
```

```bash
claude plugin validate . --strict
```

**Testing it locally**

*   Before pushing:

    ```text
    /plugin marketplace add ./
    /plugin install overlook@overlook
    ```

*   After pushing, anyone can install it in one step:

    ```text
    /plugin install overlook --marketplace furkancodes/overlook
    ```

**Anthropic's directory**

*   **Submitting:** submit the repository from the developer portal at
    claude.ai/directory/manage. This needs a paid plan.
*   **What the listing uses:** it reads `icon`, `documentationUrl` and
    `supportUrl` from `plugin/.claude-plugin/plugin.json`.
*   **The icon:** it is fixed at the first submission. Changing it later does
    not change the listing.

**How the plugin starts the server.** `plugin/launch.mjs` runs
`npx -y overlook-dash@<VERSION> mcp`. On Windows it goes through the shell,
because `npx` is a `.cmd` file there. It passes `OVERLOOK_PROJECT` from
Claude Code's project folder, so data discovery works whatever folder the
server starts in.

**Developing the plugin:** set `OVERLOOK_CLI_PATH` to a local
`dist/src/cli.js` to run a local build instead of the published package.

## Other directories

*   **Glama:** indexes public GitHub MCP servers on its own.
*   **mcp.so:** takes submissions through a web form.
*   **Cursor:** has its own marketplace.
*   **Docker MCP Catalog:** a poor fit. A container cannot see the user's
    project files without mounts.

## Checklist

- [ ] Versions bumped in all four places; `npm test` passes
- [ ] `npm publish`, then `npx -y overlook-dash@<version> --help` works
- [ ] `mcp-publisher validate` and `publish`
- [ ] `claude plugin validate` passes for `./plugin` and `.`
- [ ] Repository pushed; plugin installs with `/plugin install overlook --marketplace furkancodes/overlook`
- [ ] Plugin starts its MCP server on Windows and macOS or Linux (the `npx` path in `launch.mjs` only runs once the package is on npm)
