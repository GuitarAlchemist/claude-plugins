"""Checks the marketplace, every plugin it lists, and the plugins together.

    python scripts/check.py [--base REF] [--also DIR ...]

For each plugin in .claude-plugin/marketplace.json:
  - one in this repo: its plugin.json, and its Codex manifest .codex-plugin/plugin.json when it
    has one, have the entry's name and version, `claude plugin validate`
    passes, `claude plugin test` passes when it has tests, and, with --base, a plugin whose files
    changed since REF has a higher version than it had there;
  - one in another repo (git-subdir): its plugin.json at the pinned sha has the entry's name and
    version, and a ref named <name>--v<version> agrees with that version.
Then, across this repo's plugins and every --also folder (a mod elsewhere on this machine), no
slash command and no pane is claimed by two plugins. Tools and skills need no such check: the
engine prefixes them with their plugin's name.

Commands and panes are read from what `claude plugin validate` reports a module hooks, so one
answered by a hook without a matcher is not seen.
"""
import argparse
import json
import os
import re
import subprocess
import sys
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
problems = []


def fail(msg):
    problems.append(msg)
    print(f"  FAIL {msg}")


def run(args, cwd=ROOT):
    r = subprocess.run(args, cwd=cwd, capture_output=True, text=True, encoding="utf-8", errors="replace")
    return r.returncode, r.stdout + r.stderr


def semver(v):
    m = re.fullmatch(r"(\d+)\.(\d+)\.(\d+)(?:[-+].*)?", v or "")
    return tuple(int(x) for x in m.groups()) if m else None


def claims(output):
    """The commands and panes a plugin's modules hook, from `claude plugin validate`'s report."""
    hooked = " ".join(l for l in output.splitlines() if " hooks: " in l)
    commands = set(re.findall(r"command\.run\{command=([^,}\s]+)", hooked))
    panes = set(re.findall(r"component=Pane, requestId=([^,}\s]+)", hooked))
    return commands, panes


def check_local(entry, base):
    name, path = entry["name"], os.path.normpath(os.path.join(ROOT, entry["source"]))
    manifest = os.path.join(path, ".claude-plugin", "plugin.json")
    if not os.path.isfile(manifest):
        fail(f"{name}: no {os.path.relpath(manifest, ROOT)}")
        return None
    with open(manifest, encoding="utf-8") as f:
        pj = json.load(f)
    if pj.get("name") != name:
        fail(f"{name}: plugin.json names {pj.get('name')!r}")
    if pj.get("version") != entry.get("version"):
        fail(f"{name}: version {pj.get('version')!r} in plugin.json, {entry.get('version')!r} in marketplace.json")
    codex = os.path.join(path, ".codex-plugin", "plugin.json")
    if os.path.isfile(codex):
        with open(codex, encoding="utf-8") as f:
            cj = json.load(f)
        if (cj.get("name"), cj.get("version")) != (name, entry.get("version")):
            fail(f"{name}: .codex-plugin/plugin.json has {cj.get('name')} {cj.get('version')}, "
                 f"marketplace.json {name} {entry.get('version')}")
    code, out = run(["claude", "plugin", "validate", path])
    if code != 0:
        fail(f"{name}: claude plugin validate failed:\n{out}")
    has_tests = any(f.endswith((".test.ts", ".test.tsx")) for _, _, fs in os.walk(path) for f in fs)
    if has_tests:
        code, tests = run(["claude", "plugin", "test", path])
        summary = [l.strip() for l in tests.splitlines() if re.search(r"\d+ (pass|fail)", l)]
        print(f"  {name}: tests {', '.join(summary) or '?'}")
        if code != 0:
            fail(f"{name}: claude plugin test failed:\n{tests}")
    if base:
        rel = os.path.relpath(path, ROOT).replace("\\", "/")
        changed, _ = run(["git", "diff", "--quiet", base, "--", rel])
        if changed:
            code, old = run(["git", "show", f"{base}:{rel}/.claude-plugin/plugin.json"])
            old_v = json.loads(old).get("version") if code == 0 else None
            if old_v is not None and not (semver(pj.get("version")) or ()) > (semver(old_v) or ()):
                fail(f"{name}: files changed since {base} but the version stayed {old_v}; bump it in "
                     f"plugin.json and marketplace.json")
    commands, panes = claims(out)
    print(f"  {name} {pj.get('version')}: commands {sorted(commands) or '-'}, panes {sorted(panes) or '-'}")
    return commands, panes


def check_remote(entry):
    name, src = entry["name"], entry["source"]
    m = re.fullmatch(r"https://github\.com/([^/]+/[^/]+?)(?:\.git)?", src.get("url", ""))
    if src.get("source") != "git-subdir" or not m or not src.get("sha"):
        fail(f"{name}: only git-subdir sources on github.com, pinned to a sha, are checked")
        return
    url = f"https://raw.githubusercontent.com/{m.group(1)}/{src['sha']}/{src['path']}/.claude-plugin/plugin.json"
    try:
        with urllib.request.urlopen(url, timeout=30) as r:
            pj = json.loads(r.read().decode("utf-8"))
    except Exception as e:  # a private repo, a wrong path or sha
        fail(f"{name}: cannot read {url}: {e}")
        return
    if pj.get("name") != name or pj.get("version") != entry.get("version"):
        fail(f"{name}: {pj.get('name')} {pj.get('version')} at {src['sha'][:10]}, "
             f"{name} {entry.get('version')} in marketplace.json")
    tag = re.fullmatch(rf"{re.escape(name)}--v(.+)", src.get("ref", ""))
    if tag and tag.group(1) != entry.get("version"):
        fail(f"{name}: ref {src['ref']} but version {entry.get('version')}")
    print(f"  {name} {pj.get('version')}: from {m.group(1)}/{src['path']} at {src['sha'][:10]} ({src.get('ref')})")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", help="a git ref; a plugin changed since it must have a higher version")
    ap.add_argument("--also", nargs="*", default=[], help="other plugin folders to include in the conflict check")
    a = ap.parse_args()

    with open(os.path.join(ROOT, ".claude-plugin", "marketplace.json"), encoding="utf-8") as f:
        market = json.load(f)
    print(f"marketplace {market['name']}: {len(market['plugins'])} plugins")
    code, out = run(["claude", "plugin", "validate", ROOT])
    if code != 0:
        fail(f"marketplace: claude plugin validate failed:\n{out}")
    names = [p["name"] for p in market["plugins"]]
    for n in {n for n in names if names.count(n) > 1}:
        fail(f"marketplace: {n} listed twice")

    owners = {}
    for entry in market["plugins"]:
        if isinstance(entry.get("source"), str):
            got = check_local(entry, a.base)
            if got:
                owners[entry["name"]] = got
        else:
            check_remote(entry)
    for d in a.also:
        d = os.path.abspath(os.path.expanduser(d))
        code, out = run(["claude", "plugin", "validate", d])
        label = os.path.basename(d.rstrip("\\/")) + " (--also)"
        if code != 0:
            fail(f"{label}: claude plugin validate failed")
        owners[label] = claims(out)
        print(f"  {label}: commands {sorted(owners[label][0]) or '-'}, panes {sorted(owners[label][1]) or '-'}")

    for kind, i in (("command", 0), ("pane", 1)):
        seen = {}
        for plugin, got in owners.items():
            for x in got[i]:
                seen.setdefault(x, []).append(plugin)
        for x, ps in sorted(seen.items()):
            if len(ps) > 1:
                fail(f"{kind} {'/' if kind == 'command' else ''}{x} claimed by {', '.join(ps)}")

    print(f"{len(problems)} problem(s)")
    sys.exit(1 if problems else 0)


if __name__ == "__main__":
    main()
