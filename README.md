# GuitarAlchemist Claude Code plugins

[Français](README.fr.md)

The Claude Code plugins and mods of the GuitarAlchemist ecosystem, and the
marketplace that versions them. Why it is laid out this way:
[ADR 0001](docs/adr/0001-one-marketplace-for-the-ecosystem.md).

| Plugin | What it does | Lives in |
| --- | --- | --- |
| `fleet` | `/fleet:ai-scrum`: a round table of every session, subagent, claimed lane and open pull request, with what waits on the user | here |
| `session-inbox` | an `/inbox` pane for messages from other sessions, and working groups | here |
| `shared-repo-guard` | holds blanket git commands in shared clones; `/lanes`, and a `/prs` pane | here |
| `voice` | full-duplex local voice: `/voice` and `/speak` make Claude speak through piper-voice, a local streaming text-to-speech service on Piper (Go, loopback only); `/listen` hears you, transcribed on the machine by whisper.cpp (Windows, off until asked) | here |
| `voice-avatar` | an avatar band above the prompt and a pane for `voice`: who speaks, whether Claude listens and to whom, the mic level, what Claude does | here |
| `ga` | Guitar Alchemist DSL tools; works only in a session started inside a ga checkout | [ga](https://github.com/GuitarAlchemist/ga/tree/main/plugins/ga) |

## Three places a plugin can live

1. **In the repo it belongs to.** A plugin folder at `<repo>/.claude/skills/<name>/`
   (holding `.claude-plugin/plugin.json`) loads by itself in every session
   started in that repo, and is versioned with it. Use this for a mod that only
   makes sense there.
2. **Here**, for a plugin that works across repos.
3. **Listed here from its repo**, with a `git-subdir` source pinned to a sha,
   for a repo's plugin that sessions elsewhere should be able to install.

## Using the marketplace

```bash
claude plugin marketplace add GuitarAlchemist/claude-plugins
claude plugin install fleet@guitaralchemist
```

A repo can declare it for everyone who opens it, in its committed
`.claude/settings.json`:

```json
{
  "extraKnownMarketplaces": {
    "guitaralchemist": { "source": { "source": "github", "repo": "GuitarAlchemist/claude-plugins" } }
  },
  "enabledPlugins": { "fleet@guitaralchemist": true }
}
```

### On the author's machine

The plugins here are also linked into `~/.claude/skills/<name>` (directory
junctions to `plugins/<name>`), so they load as `<name>@skills-dir` and reload
when a file is saved. Do not also install them from the marketplace on that
machine: the same plugin would load twice.

## Versions

Each plugin's version is written twice, in its `.claude-plugin/plugin.json` and
in its entry in `.claude-plugin/marketplace.json`, and the two must agree. A
pull request that changes a plugin's files must raise its version
([semver](https://semver.org): a fix is a patch, a new command or tool a minor,
a removed or renamed one a major). `claude plugin tag plugins/<name>` creates
the `<name>--v<version>` tag after the merge; a repo's own plugin is listed
here pinned to such a tag, or to a sha.

## The check

```bash
python scripts/check.py                        # what CI runs on main
python scripts/check.py --base origin/main     # what CI runs on a pull request
python scripts/check.py --also ~/.claude/skills/ga-chatbot   # add mods kept elsewhere
```

For every plugin listed, it checks the two versions agree,
`claude plugin validate` passes, `claude plugin test` passes where there are
tests, and with `--base`, that a changed plugin raised its version. For a
plugin listed from another repo it reads `plugin.json` at the pinned sha. Then
it checks that no slash command and no pane is claimed by two plugins: tools
and skills need no such check, since the engine prefixes them with their
plugin's name.

What it does not see: a command answered by a hook with no matcher, and the
commands of a plugin listed from another repo.
