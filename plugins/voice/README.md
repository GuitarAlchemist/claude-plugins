# voice

Lets Claude, and anything else on this machine, speak aloud through
**piper-voice**: a local, streaming text-to-speech service on
[Piper](https://github.com/rhasspy/piper). It costs nothing to run, and no text
leaves the machine.

- **Streaming.** Text is cut into sentences. Each sentence plays while the next
  one is being synthesized. On the author's machine the first sound comes about
  0.8 s after the request, and that includes loading the voice. Piper
  synthesizes about ten times faster than real time.
- **Barge-in.** `stop` cuts the current sentence and empties the queue.
- **Loopback only.** It listens on 127.0.0.1:59126 and refuses requests that
  carry an `Origin` header or a non-loopback `Host`, so a web page cannot make
  the machine talk.

The `/voice` skill tells Claude when to speak. Claude speaks through the plugin's
MCP server (`piper-voice mcp`: tools `say`, `stop`, `voices`, `status`). IX drives
the same service through the `ix-voice` crate. All of them follow the contract
below.

[Français](README.fr.md)

```text
/plugin install voice --marketplace GuitarAlchemist/claude-plugins
```

## Full duplex: /speak and /listen

Everything stays on the machine. The voice is Piper, reached on 127.0.0.1 only
(a `PIPER_VOICE_URL` that is not loopback is ignored). Speech-to-text is
whisper.cpp, run locally. No audio and no text is sent anywhere by this plugin:
the only thing that leaves the listener is the text of a sentence addressed to
Claude, handed to this Claude Code session as if you had typed it.

| Command | What it does |
| --- | --- |
| `/speak on` | this session's replies are said aloud: their first prose paragraph, without code, links or paths |
| `/speak off` | they are not; `/speak stop` cuts the voice now; `/speak` shows the state |
| `/listen` | opens the microphone and starts listening (Windows only). **Off by default**: nothing listens until you run it |
| `/listen stop` | stops; the microphone is released at once. Also `/listen pause`, `/listen resume`, `/listen status` |

While the listener runs, a line above the prompt says so (`🎙 écoute active … ·
/listen stop`), and the wmux sidebar too when wmux is there. The listener is a
child of the session: it ends with it, and whisper-stream runs in a Windows job
that kills it whenever the listener ends, so the microphone is never left open.
The listener also checks every 10 s that whisper-stream opened no socket, and
stops if it did.

What you say is for Claude until you say otherwise, in French: "Top Claude"
(for Claude), "Top" (ambient talk, dropped), "Top Gaïa" (for the other voice
agent, dropped), "Claude, pause", "Claude, arrête d'écouter". Sentences heard
while Piper speaks are dropped as Piper's own voice. With `autoSend` off (the
default) each sentence waits in the prompt box for Enter.

A sentence goes to Claude, and a reply to Piper, only in the session that asked:
`/speak on` writes `sessions/<session id>` in piper-voice's data folder; the file
`muted` beside it silences every session.

### Options

Set with `/config` (or `pluginConfigs` in settings.json):

| Option | Default | What it is |
| --- | --- | --- |
| `language` | `fr` | whisper's language; the spoken commands are French |
| `autoSend` | off | send each sentence at once instead of leaving it in the prompt box |
| `whisperStream` | empty | `whisper-stream.exe`; empty: found on `PATH`, else under `%LOCALAPPDATA%\voice-listen` |
| `whisperModel` | empty | a `ggml-*.bin`; empty: the first under `%LOCALAPPDATA%\voice-listen\models`, large-v3-turbo first |
| `callApp` | `ChatGPT` | the process of another voice agent whose call shares the mic: while its call's mic is open, what you say is for it, and its voice is not taken for yours. Empty turns it off |
| `sceneSayFile` | empty (off) | a file a 3D scene reads: while its Godot window has the focus, replies are written there for its own voice instead of piper-voice |

Environment: `PIPER_VOICE_HOME` (piper-voice's data folder), `VOICE_LISTEN_HOME`
(the listener's, by default `%LOCALAPPDATA%\voice-listen`), `PIPER_VOICE_URL`
(loopback only), `VOICE_LISTEN_WHISPER` and `VOICE_LISTEN_MODEL`.

### Setting up whisper (Windows)

The plugin downloads nothing. Put whisper.cpp's Windows build and one model under
`%LOCALAPPDATA%\voice-listen` (or point the options at them):

1. A release zip of [whisper.cpp](https://github.com/ggml-org/whisper.cpp/releases)
   with `whisper-stream.exe`, for example `whisper-blas-bin-x64.zip`, unpacked
   anywhere under `%LOCALAPPDATA%\voice-listen`. Check its SHA-256 against the
   release.
2. A model in `%LOCALAPPDATA%\voice-listen\models\`, from
   [ggerganov/whisper.cpp](https://huggingface.co/ggerganov/whisper.cpp), for
   example `ggml-large-v3-turbo-q5_0.bin` (about 550 MB; smaller ones such as
   `ggml-base.bin` load faster and hear less well).

When either is missing, `/listen` says so and opens nothing.

### Windows only

`/listen` (`listen/voice_listen.ps1` with `Listen.cs` and `AudioPeek.cs`: Core
Audio, UI Automation, a job object) and the courtesy watcher run on Windows only.
Elsewhere `/listen` answers that it is Windows only and starts nothing; `/speak`
and the MCP tools work wherever piper-voice runs.

### The courtesy watcher (optional, Windows)

`listen/voice_courtesy.ps1` keeps Piper from talking over another voice agent's
app (`-Others`, by default ChatGPT). It reads output levels only, never the
microphone. While it runs, replies wait in `courtesy\pending\` until the other
agent is quiet, and `courtesy\piper-speaking` tells the voice-avatar plugin when
Piper plays. Start one per machine, by hand:

```powershell
Start-Process -WindowStyle Hidden pwsh "-NoProfile -File `"<plugin>\listen\voice_courtesy.ps1`""
```

### State files

Under the listener's folder, rewritten while it runs and removed when it stops:
`state`, `level`, `last`, `target`, `call`, `focus`, `typed`, `listen.pid`;
`pause` and `stop` are read. `listen.log` records events, lengths and latencies,
never what was said. The voice-avatar plugin reads these files.

## HTTP contract v0.2

| Method and path | Body | Answer |
| --- | --- | --- |
| `GET /health` | | `{"ok", "version", "engine", "voice", "sample_rate"}` |
| `GET /v1/voices` | | `[{"id", "language", "quality", "sample_rate", "license"}]` |
| `POST /v1/say` | `{"text", "voice"?, "rate"?, "wait"?}` | `{"id", "sentences"}` once the text is queued. With `"wait": true`, it answers once the text has been played: `{"id", "sentences", "played_ms", "stopped"}` |
| `POST /v1/say/stream?voice=&rate=&wait=` | `text/plain`, usually chunked | Each sentence is queued as soon as the body completes it, so the first one plays while the caller is still writing, as with an LLM's token stream. Once the body ends, it answers as `/v1/say` does. |
| `POST /v1/synthesize` | `{"text", "voice"?, "rate"?}` | `audio/wav`, streamed: a header whose two sizes are `0xFFFFFFFF`, then each sentence's PCM as soon as it is made. It plays nothing. `X-Sentences` gives the count. A failure after the header ends the stream early and is named in the `X-Voice-Error` trailer. |
| `POST /v1/stop` | | `{"stopped": <utterances cut or dropped>}` |

How the fields work:

- `rate` is a speed, from 0.5 to 2, where 2 is twice as fast. The service passes
  `length_scale = 1/rate` to Piper.
- `text` is limited to 20,000 characters. For a stream, the limit counts the
  whole body: past it, the service answers 413 and stops that utterance.
- In `/v1/say/stream`, `wait` accepts `1`, `0`, `true` and `false`. Unknown
  query parameters are refused.
- Unknown fields are refused, so a typo in a field name shows up as an error.

Errors are `{"error": "<what is wrong>"}`:

- 400: the request is not valid;
- 403: the request came from a web page or a foreign host;
- 413: the text is too long;
- 503: the queue is full;
- 500: the engine failed during `wait`.


## Install

```powershell
cd plugins/voice/service
go build -o "$env:LOCALAPPDATA\piper-voice\bin\piper-voice.exe" .
& "$env:LOCALAPPDATA\piper-voice\bin\piper-voice.exe" setup            # add --english for en_US
Start-Process -WindowStyle Hidden "$env:LOCALAPPDATA\piper-voice\bin\piper-voice.exe" serve
```

The data folder is `%LOCALAPPDATA%\piper-voice\`, or `PIPER_VOICE_HOME` when it is set:

- `engine/` holds Piper;
- `voices/` holds the voices;
- `tmp/` holds one WAV file per sentence, deleted once it has been read.

Three environment variables change the defaults: `PIPER_VOICE_ADDR` (the address),
`PIPER_VOICE_VOICE` (the default voice) and `PIPER_VOICE_FX` (the voice effect,
below).

## Voice effect

`serve --fx warm`, or `PIPER_VOICE_FX=warm`, plays speech through a warm,
close-microphone effect with a very small room. The default, `none`, plays the
voice as Piper made it. The chain is:

- an EQ: more body at 210 Hz, presence at 3.2 kHz, and a softer top;
- a gentle compressor;
- a touch of saturation;
- a 3 % Freeverb room;
- a make-up gain that keeps the dry voice's level.

How it behaves:

- **Speech that is played.** The effect applies to `/v1/say` and `/v1/say/stream`.
  `/v1/synthesize` still returns Piper's sound unchanged.
- **One signal per utterance.** Its state runs on from one sentence to the next,
  so no pause is added between sentences. A 300 ms tail plays after the last
  sentence, unless the utterance was stopped.

Setup pins the Windows amd64 release only. On other systems, put a `piper`
binary under `engine/piper/` yourself.

## Claude: the MCP server

The plugin declares `piper-voice mcp` as its MCP server, at
`${LOCALAPPDATA}/piper-voice/bin/piper-voice.exe`, which Claude Code expands. It
has four tools: `say {text, voice?, rate?, wait?}`, `stop`, `voices` and `status`.

- **Over HTTP.** Each tool is one request to the running service at
  `PIPER_VOICE_ADDR`, and its JSON answer is the tool's text.
- **When the service is down,** a tool fails with "start it with: piper-voice serve".
- **Before the binary is built,** the server does not start, and the session
  reports that it failed to connect.

## Starting at logon

```powershell
cd plugins/voice/service
go build -ldflags "-H windowsgui" -o "$env:LOCALAPPDATA\piper-voice\bin\piper-voiced.exe" .
& "$env:LOCALAPPDATA\piper-voice\bin\piper-voice.exe" install --print   # shows what it would register
& "$env:LOCALAPPDATA\piper-voice\bin\piper-voice.exe" install           # piper-voice uninstall undoes it
```

`install` writes one value, `piper-voice`, under
`HKCU\Software\Microsoft\Windows\CurrentVersion\Run`. Windows starts that value
at logon. The value runs `piper-voiced.exe serve --log
%LOCALAPPDATA%\piper-voice\logs\service.log`. `piper-voiced.exe` is the same
program built with `-H windowsgui`, so no console window opens, and its log goes
to that file. The other options do not work here:

- a Windows service runs in session 0, which cannot reach the user's speakers;
- a logon task (`schtasks /SC ONLOGON`) needs administrator rights;
- a console program in the Run key opens a window at every logon.

`install` refuses to register anything until the windowless build and the
engine are both in place.

## How it drives Piper

Each voice and speed gets one `piper --json-input` process, kept warm, with at
most four at a time. For each sentence, the service writes one JSON line that
names its own `output_file`. Piper prints that path once the file has been
written, and that line marks where the sentence ends. Playback goes through
[oto](https://github.com/ebitengine/oto) on the default output device.

## Licences

| Part | Licence |
| --- | --- |
| this plugin | as this repository |
| Piper 2023.11.14-2 ([rhasspy/piper](https://github.com/rhasspy/piper), archived) | MIT; it links espeak-ng, which is GPL-3.0 |
| `fr_FR-siwis-medium` | trained on the [SIWIS French Speech Synthesis Database](https://datashare.is.ed.ac.uk/handle/10283/2353), CC-BY 4.0 |
| `en_US-ljspeech-medium` | trained on [LJ Speech](https://keithito.com/LJ-Speech-Dataset/), public domain |

Neither Piper nor any voice is vendored: `setup` downloads them onto the
machine, and the service talks to Piper over a pipe. The active fork of Piper,
[OHF-Voice/piper1-gpl](https://github.com/OHF-Voice/piper1-gpl), is GPL-3.0. It
is a candidate engine for a later slice, behind the same `Engine` interface.

## Tests

```powershell
cd plugins/voice/service
go test ./...              # no Piper, no sound card: a fake piper, a fake player, an in-memory MCP client
go test -tags nooto ./...  # without the audio library, as on a machine without sound
```

The module in `hooks/` is tested with fakes, without a microphone, PowerShell
or piper-voice: `claude plugin test plugins/voice`.
