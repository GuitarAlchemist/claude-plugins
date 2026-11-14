"""What every agent in the ecosystem is doing, as one markdown snapshot for the AI scrum.

Reads, and never writes:
  - ~/.agents/claims.jsonl: the latest claim per (repo, lane) in the window;
  - the open pull requests of the GitHub organisation, and of the repos named with --repo, with
    their CI and review state (gh);
  - the session digests (state/digests/latest.md) written in the window, under the repos root.
Live sessions are not here: the model lists them itself (ListAgents).

    python snapshot.py [--hours 24] [--org GuitarAlchemist] [--repo OWNER/NAME ...] [--repos-root ~/source/repos]
"""
import argparse
import json
import os
import re
import subprocess
import sys
from datetime import datetime, timedelta, timezone

ACTIVE = {"claimed", "in-progress", "pr-open"}
# Learn lives outside the organisation, so it is named here; --repo replaces this list.
EXTRA_REPOS = ["spareilleux/learn"]
FAILED = {"FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"}


def when(ts):
    try:
        t = datetime.fromisoformat(str(ts).replace("Z", "+00:00"))
    except ValueError:
        return None
    return t if t.tzinfo else t.replace(tzinfo=timezone.utc)


def ago(t, now):
    h = (now - t).total_seconds() / 3600
    return f"{h:.0f} h" if h < 48 else f"{h / 24:.0f} d"


def one_line(s, n=140):
    s = " ".join(str(s or "").split())
    return s if len(s) <= n else s[: n - 1] + "…"


def claims(now, cut, stale_h):
    path = os.path.join(os.path.expanduser("~"), ".agents", "claims.jsonl")
    if not os.path.exists(path):
        return [f"_No claim ledger at {path}._"]
    latest, bad = {}, 0
    with open(path, encoding="utf-8") as f:
        for line in f:
            if not line.strip():
                continue
            try:
                c = json.loads(line)
            except json.JSONDecodeError:
                bad += 1
                continue
            t = when(c.get("ts"))
            if t is None:
                bad += 1
                continue
            repo = str(c.get("repo") or "?").rsplit("/", 1)[-1].lower()
            key = (repo, c.get("lane") or "?")
            if key not in latest or t >= latest[key][0]:
                latest[key] = (t, c)
    rows = sorted(((k, v) for k, v in latest.items() if v[0] >= cut), key=lambda kv: (kv[0][0], -kv[1][0].timestamp()))
    out = [f"{len(rows)} lanes touched in the window; {bad} unreadable ledger lines.", "",
           "| repo | lane | status | last | session | note |", "| --- | --- | --- | --- | --- | --- |"]
    for (repo, lane), (t, c) in rows:
        status = c.get("status") or "?"
        if status in ACTIVE and (now - t) > timedelta(hours=stale_h):
            status += f" (quiet > {stale_h} h)"
        session = one_line(c.get("session"), 12)
        note = one_line(c.get("note") or c.get("evidence")).replace("|", "/")
        out.append(f"| {repo} | {lane} | {status} | {ago(t, now)} ago | {session} | {note} |")
    busy = {}
    for (repo, lane), (t, c) in rows:
        if (c.get("status") or "") in ACTIVE:
            busy.setdefault(repo, []).append(lane)
    shared = {r: ls for r, ls in busy.items() if len(ls) > 1}
    if shared:
        out += ["", "Repos with more than one active lane (check they do not touch the same files):"]
        out += [f"- {r}: {', '.join(ls)}" for r, ls in sorted(shared.items())]
    return out


def gh(args):
    r = subprocess.run(["gh", *args], capture_output=True, text=True, encoding="utf-8")
    if r.returncode != 0:
        raise RuntimeError(one_line(r.stderr or r.stdout, 300))
    return json.loads(r.stdout or "null")


def ci(rollup):
    """pass, pending, none, or FAIL with the failing checks' names: a failing check may not be required."""
    if not rollup:
        return "none"
    states = [(c.get("conclusion") or c.get("state") or c.get("status") or "").upper() for c in rollup]
    failed = sorted({c.get("name") or c.get("context") or "?" for c, s in zip(rollup, states) if s in FAILED})
    if failed:
        return "FAIL: " + one_line(", ".join(failed), 60).replace("|", "/")
    if any(s in {"PENDING", "QUEUED", "IN_PROGRESS", "EXPECTED", "WAITING", ""} for s in states):
        return "pending"
    return "pass"


def org_repos(org):
    """The organisation's unarchived repos with an open pull request, read from the repos themselves:
    the search index lags, and a repo whose only pull request it has not indexed yet would be missed."""
    q = ("query($org:String!){organization(login:$org){repositories(first:100,isArchived:false){"
         "totalCount nodes{nameWithOwner pullRequests(states:OPEN){totalCount}}}}}")
    found = gh(["api", "graphql", "-f", f"query={q}", "-F", f"org={org}"])["data"]["organization"]["repositories"]
    names = [r["nameWithOwner"] for r in found["nodes"] if r["pullRequests"]["totalCount"]]
    return names, found["totalCount"] > len(found["nodes"])


def prs(org, extra, now):
    try:
        repos, truncated = org_repos(org)
    except (RuntimeError, OSError, KeyError, TypeError) as e:
        return [f"_Pull requests unavailable: {e}_"]
    repos = sorted(set(repos) | set(extra))
    count, listed = 0, set()
    out = ["| repo | PR | title | draft | CI | review | updated |", "| --- | --- | --- | --- | --- | --- | --- |"]
    for repo in repos:
        try:
            rows = gh(["pr", "list", "-R", repo, "--state", "open", "--limit", "100", "--json",
                       "number,title,isDraft,updatedAt,reviewDecision,statusCheckRollup"])
        except (RuntimeError, OSError) as e:
            out.append(f"| {repo} | ? | _unavailable: {e}_ | | | | |")
            continue
        count += len(rows)
        if rows:
            listed.add(repo)
        for p in sorted(rows, key=lambda p: p["updatedAt"], reverse=True):
            t = when(p["updatedAt"])
            out.append(f"| {repo.split('/')[-1]} | #{p['number']} | {one_line(p['title'], 70).replace('|', '/')} | "
                       f"{'yes' if p['isDraft'] else ''} | {ci(p.get('statusCheckRollup'))} | "
                       f"{(p.get('reviewDecision') or '').lower().replace('_', ' ')} | {ago(t, now)} ago |")
    head = [f"{count} open pull requests in {len(listed)} repos."]
    if truncated:
        head.append(f"_Only the first 100 repositories of {org} were read._")
    return head + [""] + out


def digests(root, cut, now):
    out = []
    try:
        dirs = sorted(os.listdir(root))
    except OSError as e:
        return [f"_Repos root unreadable: {e}_"]
    for d in dirs:
        path = os.path.join(root, d, "state", "digests", "latest.md")
        if not os.path.isfile(path):
            continue
        t = datetime.fromtimestamp(os.path.getmtime(path), timezone.utc)
        if t < cut:
            continue
        with open(path, encoding="utf-8", errors="replace") as f:
            text = f.read()
        branch = re.search(r"^branch:\s*(.+)$", text, re.M)
        nxt = re.search(r"^## Next action\s*\n+(.+)$", text, re.M)
        out.append(f"- **{d}** ({ago(t, now)} ago, {branch.group(1).strip() if branch else '?'}): "
                   f"{one_line(nxt.group(1)) if nxt else '_no next action written_'}")
    return out or ["_No digest written in the window._"]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--hours", type=float, default=24)
    ap.add_argument("--stale-hours", type=float, default=12)
    ap.add_argument("--org", default="GuitarAlchemist")
    ap.add_argument("--repo", action="append", help=f"a repo outside the organisation (repeatable; default {EXTRA_REPOS})")
    ap.add_argument("--repos-root", default=os.path.join(os.path.expanduser("~"), "source", "repos"))
    a = ap.parse_args()
    # A PR title can carry any character, and on Windows a piped stdout defaults
    # to cp1252: one "♭" in a title crashed the whole snapshot.
    sys.stdout.reconfigure(encoding="utf-8")
    extra = EXTRA_REPOS if a.repo is None else [r for r in a.repo if r]
    now = datetime.now(timezone.utc)
    cut = now - timedelta(hours=a.hours)
    print(f"# Fleet snapshot, {now:%Y-%m-%d %H:%M} UTC, last {a.hours:g} h\n")
    print("## Claimed lanes (~/.agents/claims.jsonl)\n")
    print("\n".join(claims(now, cut, a.stale_hours)))
    print(f"\n## Open pull requests ({', '.join([a.org, *extra])})\n")
    print("\n".join(prs(a.org, extra, now)))
    print(f"\n## Session digests ({a.repos_root})\n")
    print("\n".join(digests(a.repos_root, cut, now)))


if __name__ == "__main__":
    main()
