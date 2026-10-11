---
name: ai-scrum
description: Run the AI scrum, a round table of the agent fleet across the GuitarAlchemist repos - what every live session, subagent, claimed lane and open pull request is doing, where two of them may collide, what has gone quiet, and what waits on the user - then propose the coordination moves. Use when the user asks for a "tour de table", an "AI scrum", a standup of the agents, what the sessions are working on, or to coordinate them.
---

# AI scrum

A round table of the fleet: Claude sessions, their subagents, Codex, Junie, and
the pull requests they leave behind, across every GuitarAlchemist repo. Its
product is a short report and a list of coordination moves the user approves.
It reads; it changes nothing on its own.

## 1. Gather

Run the snapshot, `scripts/snapshot.py` under this skill's base directory
(about 40 s; it calls `gh` once per repo with open pull requests):

```bash
python "<this skill's base directory>/scripts/snapshot.py" --hours 24
```

Options: `--hours` (the window, 24 by default), `--stale-hours` (an active lane
quieter than this is flagged, 12), `--org` (GuitarAlchemist), `--repo`
(a repo outside the organisation, repeatable; `spareilleux/learn` by default, and
`--repo ""` lists none), `--repos-root` (`~/source/repos`, where the session
digests are looked for).

It prints three sections: the latest claim per lane from `~/.agents/claims.jsonl`,
every open pull request with its CI (failing checks named, since a failing check
is not always a required one) and review state, and the session digests written
in the window.

Then add what the snapshot cannot see:

- **Live sessions and agents**: call `ListAgents`. Match each to a lane by its
  session id or repo; a live agent with no lane is worth a line, and so is an
  active lane whose session is not live.
- **Your own session**: what it is doing, in one line.

## 2. Report

In the user's language. Lead with what needs the user, then the rest:

1. **Waiting on you** - pull requests ready for the user's merge (CI green on
   the required checks, reviewed), holds the user put in place, questions an
   agent asked and nobody answered.
2. **Possible collisions** - two active lanes in one repo, or one branch or set
   of files claimed twice. Say what they share, if you can tell; say you cannot
   if you cannot.
3. **Gone quiet** - active lanes flagged `quiet`, pull requests open for weeks,
   drafts nobody touches. Name the owner session when the ledger has it.
4. **Failing** - pull requests with a failing check, and whether that check is
   required, if you know it.
5. **Round table** - one line per agent or lane: who, what, status, next.

Keep it to what changes a decision. Counts are fine where a list would be long
(eighteen green agent-blackbox drafts, 60 days old, are one line).

## 3. Propose the coordination moves

A numbered list, each move one line, each something the user can approve by
number: a message to a session (`SendMessage`, or a post to a working group
through the session-inbox `group_send` tool), a stale claim to release, a
pull request to close or rebase, a question to put to the user's own agenda.

Do none of them until the user says which. In particular:

- never merge, close, or mark ready a pull request, and never release or
  rewrite another session's claim, on your own;
- a message is a request, not a gate: another session may read it 20-40
  minutes later, or never;
- the ledger is append-only: releasing a lane is a new `released` line with a
  note, never an edit.

## When the data is missing

Say so in the report, with the reason the snapshot printed (no ledger, `gh` not
authenticated, a repos root that does not exist). A section that came back
empty is not the same as a fleet with nothing to report.
