# voice-avatar

[Français](README.fr.md)

A small face above the prompt, and a detailed pane, for the
[voice](../voice/README.md) plugin: who has the floor (Piper speaking for
Claude, another voice agent, a 3D scene), whether Claude listens and to whom,
the microphone's level, what became of the last sentence heard, and what Claude
is doing (the tool running, the turn's time, the tokens and quota used). Its
labels are in French.

```text
/plugin install voice-avatar --marketplace GuitarAlchemist/claude-plugins
```

It only reads: the voice plugin's state files under piper-voice's data folder
(`PIPER_VOICE_HOME`, else `%LOCALAPPDATA%\piper-voice`, else
`$XDG_CACHE_HOME`/`~/.cache`) and the listener's (`VOICE_LISTEN_HOME`, else
`voice-listen` beside it). It writes only two of them, when you press its
buttons: `pause` (⏸ pause, ▶ reprendre) and `stop` (⏹ arrêter). It opens no
microphone, starts nothing, and makes no network call. `👍 oui` / `👎 non`
appear when Claude's turn ended on a yes-or-no question, and submit that word as
your answer. `⤢ détails` opens the pane.

Without the voice plugin's listener and courtesy watcher (Windows), the band
still shows what Claude is doing and what the session consumes.

## Options

| Option | Default | What it is |
| --- | --- | --- |
| `faceFile` | empty (off) | a JSON file a 3D scene polls to mirror the avatar: `{v, t, state, tool, session}`, the state one of idle, working, waiting, done, failed, and the tool's name, never a prompt, an argument or a path |
| `faceSession` | `Claude` | the `session` the face file names |

## Tests

`claude plugin test plugins/voice-avatar`: the face, the labels, the meter, the
band and the pane, from fixed states, with no file read.
