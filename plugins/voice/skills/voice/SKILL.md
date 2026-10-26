---
name: voice
description: Speak aloud through the local piper-voice service (Piper text-to-speech on 127.0.0.1:59126) - say a text, stop speaking, check or set up the service. Use when the user asks Claude to talk, to read something aloud, to turn the voice on ("parle", "dis-le à voix haute"), or to be quiet ("stop", "tais-toi").
---

# Voice

`piper-voice` is a small Go service in this plugin's `service/` folder (two levels
up from this skill). It keeps a Piper voice warm, cuts text into sentences, and
plays each one while it synthesizes the next. It listens on 127.0.0.1 only and
refuses requests from web pages.

## When to speak

- Only once the user has asked for voice in this session. Voice is off by default.
- Say short things: one to three sentences in the user's language. Do not read
  code, paths, URLs or tables aloud, and never read secrets or personal data.
- Everything you say aloud also goes in your text answer. The voice is a second
  channel, never the only one.

## Replies and listening

- `/speak on` (the user's command) makes this session's replies be said aloud
  without any tool call: their first prose paragraph. Then do not also call
  `say` with the same text. `/speak off` ends it.
- `/listen` opens the microphone, transcribed locally by whisper.cpp (Windows
  only). It is the user's to start: never run it, start the listener script, or
  ask a tool to, on your own. Sentences heard arrive as the user's prompts.
## Tools first

This plugin's MCP server gives you four tools: `say` (`text`, and optionally
`voice`, `rate`, `wait`), `stop`, `voices` and `status`. Their names end in
`__say`, `__stop`, `__voices` and `__status`. Use them when they are listed. If
the server failed to connect, the binary has not been built yet: see "First use"
below. Then fall back to the commands.

## Commands

In a Windows release archive the binary is `bin/piper-voice.exe` relative to
this plugin's root. Its MCP entry uses that same bundled binary. A source
checkout must be built before use; a missing binary is not a running service.
Below, `piper-voice` means that path.

| Want | Run |
| --- | --- |
| is it running? | `piper-voice status` (prints `/health`; when nothing listens, it says so) |
| say something | `piper-voice say "<text>"`; add `--wait` to answer once it has been spoken, `--voice <id>` or `--rate 1.2` for another voice or speed |
| be quiet now | `piper-voice stop`: cuts the current sentence and empties the queue |
| list voices | `piper-voice voices` |

Anything that can POST JSON works as well: `POST http://127.0.0.1:59126/v1/say`
with `{"text": "..."}`. To speak text while you are still producing it, send
it as a chunked body to `POST /v1/say/stream`. The contract is in this plugin's
`README.md`.

## First use on a machine

Use the verified bundled binary. Developers can build it with Go 1.25 or
later from `service/`: `go build -o ../bin/piper-voice.exe .`.

`piper-voice setup` only prints a plan, without network or writes. It names
the pinned sources, versions, sizes and licenses. French Piper downloads total
85,683,405 bytes; `--english` adds 63,536,351 bytes. Explain that plan and obtain
the user's approval before running `setup --apply` with the same options.
It does not set up whisper.cpp or start the service.

Once dependencies are installed and the user requested speech, start the
bundled executable with `Start-Process -WindowStyle Hidden <binary> serve`.

Completion means the service reports ready and the requested text/stop action
has a successful receipt. A stop timeout is unacknowledged and requires a
service restart; do not say output has been purged. Do not infer working
full-duplex audio or echo cancellation from a loaded plugin or health check.

To start the service at every logon (no administrator rights needed), see
"Starting at logon" in the README: `piper-voice install`, and `uninstall` to
undo it. That changes the user's logon, so run it only when they ask for it.

