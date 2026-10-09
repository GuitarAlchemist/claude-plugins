# ADR 0001 — One marketplace for the ecosystem, plugins where they belong

[Français](0001-one-marketplace-for-the-ecosystem.fr.md)

- Status: accepted, 2026-10-09
- Decided by: the author, choosing among three locations proposed by Claude

## Context

On 2026-10-07 the ecosystem's Claude Code extensions were spread out and mostly
unversioned:

- five mods the author uses every day (ga-chatbot, session-inbox,
  shared-repo-guard, observatory-guard, and the new fleet) lived in
  `~/.claude/skills/`, **under no version control at all**;
- the only marketplace of ours, `guitar-alchemist`, was a directory source on
  the ga checkout, listing one plugin, and copied into every ga worktree;
- compound-engineering was installed from two marketplaces at two versions
  (2.35.2 and 3.30.4);
- `ix/.claude/skills` held about 110 skills, most of them vendored copies of
  compound-engineering and mattpocock skills that the enabled plugins also
  provide;
- two mods claimed the `/ga` command.

Claude Code already provides the pieces: a plugin folder in a repo's
`.claude/skills/<name>/` loads by itself in that repo; a marketplace lists
plugins from relative paths or from `git-subdir` sources pinned to a sha;
`claude plugin validate`, `test` and `tag` check, test and version a plugin.

## Decision

1. A dedicated private repo, `GuitarAlchemist/claude-plugins`, holds the
   marketplace `guitaralchemist` and the plugins that work across repos:
   fleet, session-inbox, shared-repo-guard.
2. A plugin that belongs to one repo lives in that repo (in
   `.claude/skills/<name>/`, or a `plugins/<name>/` the repo lists), and is
   listed here with a `git-subdir` source pinned to a sha when sessions
   elsewhere should be able to install it. ga's `ga` plugin is the first.
   ga-chatbot and observatory-guard are to move into their repos.
3. Each plugin carries a semver version, written in its `plugin.json` and in
   its marketplace entry. CI refuses a pull request that changes a plugin
   without raising its version, or that lets two plugins claim the same slash
   command or pane.
4. On the author's machine, `~/.claude/skills/<name>` is a directory junction
   into this repo's `plugins/<name>`, so editing keeps its hot reload and every
   change is in git.

The two other locations considered: extending ga's marketplace (nothing to
create, but tied to ga's pace and copied into every ga worktree), and Demerzel
(the coordination repo, but with two diverging branches and checked out as a
submodule of ix).

## Consequences

- The author's daily mods have history and a remote copy.
- A repo opts in with `extraKnownMarketplaces` and `enabledPlugins` in its
  committed `.claude/settings.json`; plugin ids like `fleet@guitaralchemist`
  then appear in several repos, which makes renaming the marketplace costly.
- ga's directory marketplace `guitar-alchemist` is redundant once ga's
  settings point here; retiring it is a ga change.

## Reversibility and revisit

Mostly a two-way door: the plugins are plain folders, and moving them again is
a copy. The one-way part is the marketplace name once repos reference it.
Revisit if a second machine or a collaborator starts installing these plugins
(the junction setup assumes one author), or if a plugin listed from its repo
needs reviewing here before each bump.
