# voice-avatar

[Français](README.fr.md)

A small face above the prompt, and a detailed pane, for the
[voice](../voice/README.md) plugin: who has the floor (Piper speaking for
Claude, another voice agent, a 3D scene), whether Claude listens and to whom,
the microphone's level, what became of the last sentence heard, and what Claude
is doing (the tool running, the turn's time, the tokens and quota used). Its
labels are in French or in English, per its `language` option.

```text
/plugin install voice-avatar --marketplace GuitarAlchemist/claude-plugins
```

It only reads: the voice plugin's state files under piper-voice's data folder
(`PIPER_VOICE_HOME`, else `%LOCALAPPDATA%\piper-voice`, else
`$XDG_CACHE_HOME`/`~/.cache`) and the listener's (`VOICE_LISTEN_HOME`, else
`voice-listen` beside it). It writes only two of them, when you press its
buttons: `pause` (⏸ pause, ▶ resume) and `stop` (⏹ stop). It opens no
microphone, starts nothing, and makes no network call. `👍 yes` / `👎 no`
appear when Claude's turn ended on a yes-or-no question, and submit that word as
your answer. `⤢ details` opens the pane.

Without the voice plugin's listener and courtesy watcher (Windows), the band
still shows what Claude is doing and what the session consumes.

## Options

| Option | Default | What it is |
| --- | --- | --- |
| `language` | `fr` | `fr` or `en`: the labels, the buttons and the pane. Set it as the voice plugin's `language`: each plugin has its own |
| `faceFile` | empty (off) | a JSON file a 3D scene polls to mirror the avatar: `{v, t, state, tool, session}`, the state one of idle, working, waiting, done, failed, and the tool's name, never a prompt, an argument or a path |
| `faceSession` | `Claude` | the `session` the face file names |

## In English

Set `language` to `en` (with `/config`, or `"language": "en"` under this
plugin's `pluginConfigs` entry), and set the voice plugin's `language` to `en`
too. The band and the pane then read English: `mic` and `voice` for the
meters, `listening`, `I hear you`, `🔊 Piper speaking`, `✓ received`,
`· not for me`, `Last turn`, `context … · 5 h quota … · week …`, and the
buttons `👍 yes` (hotkey `y`), `👎 no` (`n`), `⏸ pause` / `▶ resume` (`p`),
`⏹ stop` (`s`) and `⤢ details` (`d`). In French the hotkeys are `o` for oui and
`a` for arrêter. The yes-or-no buttons appear after an English question as
after a French one ("Should I push it?"), not after one that asks which, how,
why, where, when, who, what, or to choose ("Kokoro or Piper?").

## Tests

`claude plugin test plugins/voice-avatar`: the face, the labels, the meter, the
band and the pane, in French and in English, from fixed states, with no file read.
