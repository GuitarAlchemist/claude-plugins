#!/usr/bin/env node
// Starts IX's MCP server, ix-mcp, for Claude Code or Codex. stdout carries the MCP protocol, so
// everything this script says goes to stderr.
//
//   node ix-mcp.mjs [--bin <ix-mcp>] [--root <ix clone>]
//
// The binary: --bin, else IX_MCP_BIN, else ix-mcp on PATH; otherwise it stops and says how to get
// one. The IX root: --root, else IX_ROOT, else the ix clone the binary was built in. ix-mcp reads
// the Demerzel constitution and the other governance files under <root>/governance/demerzel.
import { spawn } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";

const EXE = process.platform === "win32" ? "ix-mcp.exe" : "ix-mcp";
const REPO = "https://github.com/GuitarAlchemist/ix";
const HOW = [
  "Get it one of two ways:",
  `  - build it in a clone: git clone --recurse-submodules ${REPO}`,
  "    then, in the clone: cargo build --release -p ix-agent --bin ix-mcp",
  `    and set IX_MCP_BIN to <clone>/target/release/${EXE};`,
  `  - or install it on PATH: cargo install --git ${REPO} ix-agent --bin ix-mcp`,
  "    and set IX_ROOT to an ix clone, for the governance tools.",
  "In Claude Code the plugin's ix_mcp_bin and ix_root options do the same as the two variables.",
];

const say = (line) => process.stderr.write(`ix plugin: ${line}\n`);
function fail(...lines) {
  say(lines.join("\n"));
  process.exit(1);
}

// An option Claude Code has no value for arrives empty, or as its unexpanded `${user_config.…}`.
const given = (v) => (v && !v.startsWith("${") ? v : undefined);
function option(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 1 ? given(process.argv[i + 1]) : undefined;
}

const kind = (p) => {
  try {
    const s = statSync(p);
    return s.isFile() ? "file" : s.isDirectory() ? "dir" : undefined;
  } catch {
    return undefined;
  }
};
const read = (p) => {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return "";
  }
};

function onPath() {
  for (const dir of (process.env.PATH || "").split(delimiter)) {
    if (dir && kind(join(dir, EXE)) === "file") return join(dir, EXE);
  }
}

// The nearest ancestor that is an ix clone, by the rule ix-mcp applies to its own location.
function cloneHolding(file) {
  for (let dir = dirname(file); ; dir = dirname(dir)) {
    if (kind(join(dir, "crates", "ix-agent", "Cargo.toml")) === "file"
        && read(join(dir, "Cargo.toml")).includes("[workspace]")) return dir;
    if (dirname(dir) === dir) return undefined;
  }
}

const binSource = option("bin") ? "the ix_mcp_bin option" : "IX_MCP_BIN";
const named = option("bin") ?? given(process.env.IX_MCP_BIN);
const bin = named ? resolve(named) : onPath();
if (named && kind(bin) !== "file") fail(`${binSource} names ${bin}, which is not a file.`, ...HOW);
if (!bin) fail(`cannot find ${EXE}: the ix_mcp_bin option and IX_MCP_BIN are unset, and it is not on PATH.`, ...HOW);

const rootNamed = option("root") ?? given(process.env.IX_ROOT);
const root = rootNamed ? resolve(rootNamed) : cloneHolding(bin);
if (rootNamed && kind(root) !== "dir") fail(`the IX root ${root} is not a directory.`);
const env = { ...process.env };
if (root) {
  env.IX_ROOT = root;
  if (kind(join(root, "governance", "demerzel", "constitutions", "default.constitution.md")) !== "file") {
    say(`${root} has no Demerzel constitution, so the governance tools will fail; ` +
        "in that clone run: git submodule update --init governance/demerzel");
  }
} else {
  say("no IX root: set IX_ROOT to an ix clone. Until then the governance tools fail, " +
      "and the tools that take a path refuse it.");
}

const child = spawn(bin, [], { stdio: "inherit", env, cwd: root ?? process.cwd() });
child.on("error", (e) => fail(`cannot start ${bin}: ${e.message}`));
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
for (const s of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(s, () => child.kill(s));
