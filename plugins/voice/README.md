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

The `/voice` skill tells Claude when and how to use it. IX drives it through the
`ix-voice` crate. Both follow the contract below.

## HTTP contract v0.1

| Method and path | Body | Answer |
| --- | --- | --- |
| `GET /health` | | `{"ok", "version", "engine", "voice", "sample_rate"}` |
| `GET /v1/voices` | | `[{"id", "language", "quality", "sample_rate", "license"}]` |
| `POST /v1/say` | `{"text", "voice"?, "rate"?, "wait"?}` | `{"id", "sentences"}` once the text is queued. With `"wait": true`, it answers once the text has been played: `{"id", "sentences", "played_ms", "stopped"}` |
| `POST /v1/stop` | | `{"stopped": <utterances cut or dropped>}` |

How the fields work:

- `rate` is a speed, from 0.5 to 2, where 2 is twice as fast. The service passes
  `length_scale = 1/rate` to Piper.
- `text` is limited to 20,000 characters.
- Unknown fields are refused, so a typo in a field name shows up as an error.

Errors are `{"error": "<what is wrong>"}`:

- 400: the request is not valid;
- 403: the request came from a web page or a foreign host;
- 413: the text is too long;
- 503: the queue is full;
- 500: the engine failed during `wait`.

Next slice: `POST /v1/say/stream`, which speaks a chunked text body sentence by
sentence as it arrives, and `POST /v1/synthesize`, which streams WAV without
playing it.

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

Two environment variables change the defaults: `PIPER_VOICE_ADDR` (the address)
and `PIPER_VOICE_VOICE` (the default voice).

Setup pins the Windows amd64 release only. On other systems, put a `piper`
binary under `engine/piper/` yourself.

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
go test ./...              # no Piper, no sound card: a fake piper and a fake player
go test -tags nooto ./...  # without the audio library, as on a machine without sound
```
