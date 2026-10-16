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

## Commands

The binary is `%LOCALAPPDATA%\piper-voice\bin\piper-voice.exe` once it is built.
Below, `piper-voice` means that path.

| Want | Run |
| --- | --- |
| is it running? | `piper-voice status` (prints `/health`; when nothing listens, it says so) |
| say something | `piper-voice say "<text>"`; add `--wait` to answer once it has been spoken, `--voice <id>` or `--rate 1.2` for another voice or speed |
| be quiet now | `piper-voice stop`: cuts the current sentence and empties the queue |
| list voices | `piper-voice voices` |

Anything that can POST JSON works as well: `POST http://127.0.0.1:59126/v1/say`
with `{"text": "..."}`. The contract is in this plugin's `README.md`.

## First use on a machine

1. Build the service, which needs Go 1.25 or later:
   `go build -o "$env:LOCALAPPDATA\piper-voice\bin\piper-voice.exe" .`, run in the
   plugin's `service/` folder.
2. `piper-voice setup` downloads about 85 MB: the Piper engine (release
   2023.11.14-2) and the French voice. Every file is checked against a pinned
   SHA-256. `--english` adds the English voice.
3. Start the service in the background:
   `Start-Process -WindowStyle Hidden "$env:LOCALAPPDATA\piper-voice\bin\piper-voice.exe" serve`.

When `status` says it is not running and the user asked for voice, start it
(step 3). If setup has not been run, tell the user and ask before downloading.
