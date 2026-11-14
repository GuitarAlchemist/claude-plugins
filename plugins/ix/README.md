# ix

[Français](README.fr.md)

IX's MCP server, `ix-mcp`, as a plugin for Claude Code and Codex: IX's ML,
math, graph, search and Demerzel governance tools become MCP tools in any
session, not only in an ix checkout. The plugin carries no server. It carries
a launcher, `scripts/ix-mcp.mjs`, that finds the `ix-mcp` you have and starts
it.

## What you need

- **Node.js** on PATH, to run the launcher.
- **An `ix-mcp` binary**, from the `ix-agent` crate. Build it in a clone, which
  also gives you the governance files:

  ```bash
  git clone --recurse-submodules https://github.com/GuitarAlchemist/ix
  cd ix
  cargo build --release -p ix-agent --bin ix-mcp
  ```

  Or install it on PATH (in `~/.cargo/bin`) without keeping a clone:

  ```bash
  cargo install --git https://github.com/GuitarAlchemist/ix ix-agent --bin ix-mcp
  ```

- **For the governance tools, an ix clone with `governance/demerzel`**, the
  Demerzel submodule that holds the constitution. In a clone made without
  `--recurse-submodules`, run `git submodule update --init governance/demerzel`.

## How the launcher finds them

The binary, from the first of these that is set:

1. the plugin's `ix_mcp_bin` option (Claude Code only);
2. the `IX_MCP_BIN` environment variable;
3. `ix-mcp` on PATH.

When none gives a binary, the server does not start, and its log says how to
get one. A path given in 1 or 2 that is not a file also stops it: the launcher
does not fall back to PATH.

The IX root, from the first of these that is set:

1. the plugin's `ix_root` option (Claude Code only);
2. the `IX_ROOT` environment variable;
3. the ix clone the binary was built in (`<clone>/target/release/ix-mcp`).

The launcher passes the root to `ix-mcp` as `IX_ROOT` and starts it there.
`ix-mcp` reads the governance files under `<root>/governance/demerzel`. Without
a root, the algorithm tools still work, the governance tools fail, and the
tools that take a path refuse it. The launcher warns about both cases in the
server's log.

So a clone built as above needs only `IX_MCP_BIN`. A `cargo install` binary
needs `IX_ROOT` as well.

## Claude Code

```bash
claude plugin marketplace add GuitarAlchemist/claude-plugins
claude plugin install ix@guitaralchemist
```

Claude Code asks for the two options when the plugin is enabled. Leave them
empty to use the environment variables. You can change them later in
`/config`. The tools are named `mcp__plugin_ix_ix__<tool>`.

A session started inside the ix repo already has IX's server from the repo's
own `.mcp.json`. The plugin would start a second one there.

## Codex

```bash
codex plugin marketplace add GuitarAlchemist/claude-plugins
codex plugin add ix@guitaralchemist
```

Codex reads this repo's `.claude-plugin/marketplace.json`, then the plugin's
`.codex-plugin/plugin.json`, whose `mcpServers` points to `.mcp.json`. Codex
passes an MCP server only the environment variables the server names. Here
those are `PATH`, `IX_MCP_BIN` and `IX_ROOT`. Set them where Codex starts: on
Windows, as user environment variables, then restart Codex.

The plugin has no options in Codex. If `~/.codex/config.toml` already starts
`ix-mcp` from an `[mcp_servers.<name>]` entry written by hand, remove that
entry or skip the plugin, so that only one IX server runs.

## Files

| File | For |
| --- | --- |
| `.claude-plugin/plugin.json` | Claude Code: the manifest, the two options, and the `ix` server. Claude Code also reads `.mcp.json`, and this `ix` replaces the one there |
| `.codex-plugin/plugin.json` | Codex: the manifest |
| `.mcp.json` | Codex: the `ix` server, run from the plugin folder (`cwd`), with the variables it passes (`env_vars`) |
| `scripts/ix-mcp.mjs` | both: the launcher |

The version appears in both manifests and in the marketplace entry.
`scripts/check.py` fails when they differ.
