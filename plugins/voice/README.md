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
