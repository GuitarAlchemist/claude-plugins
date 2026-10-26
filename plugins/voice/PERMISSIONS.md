# Windows permissions and lifecycle

The voice plugin can be evaluated alone. It declares no plugin dependency and
does not install other marketplace plugins or Git/guard hooks. Its own Mods
handlers register commands, session lifecycle, prompt/turn and UI events only
while this plugin is loaded. No user settings hook is written by the setup.

| Action | Resources used |
|---|---|
| Load plugin | Bundled piper-voice.exe in stdio MCP mode; local environment/path reads, command/UI registration and voice state files. MCP is control, not a WebRTC audio transport |
| `setup` | Offline printed dependency plan; no network, device, data-folder write or service startup |
| `setup --apply` | Approved HTTPS publisher/CDN requests; hash-checked cache/partials, staging and active pointer under PIPER_VOICE_HOME or LOCALAPPDATA/piper-voice; never starts audio |
| Explicit `serve`/speech | Loopback127.0.0.1:59126 HTTP; owned warm Piper child processes and temporary sentence WAVs; default output device via Oto. Text sent for synthesis remains local to this service |
| `/speak on` | Sends this session's prose reply to the loopback voice service; `/speak off` disables it. Recognized or typed text supplied to Claude Code can go to its configured provider |
| `/listen` | Starts the existing PowerShell/whisper-stream child chain on Windows, opens microphone, transcribes locally and writes small listener state files. Preview is default; autoSend is opt-in. Missing STT dependencies cause a refusal rather than an automatic download |
| Optional call/scene options | Reads configured Windows process/audio-session state for call coexistence; optional explicitly configured scene file routing. No employer account or backend credential is required |
| Optional voice-avatar | Separate existing UI adapter; reads state/usage, writes listener control files, opens the details pane, can submit a chosen response. It is not automatically installed by voice |

No administrator, login startup, registry, firewall, router or paid service change
is required by default. `piper-voice install` is an explicit legacy opt-in for
HKCU Run autostart; the plugin does not invoke it during setup or load.

The listener's event log records lengths/timing/state rather than utterance
text. Recognized text still enters the Claude session and its normal history;
do not describe the whole interaction as offline or promise no text storage.
This patch enables no recording option or export of user audio.

For removal: stop this session's listener (`/listen stop`) and speech mode
(`/speak off`), then unload the session-only plugin or uninstall voice in its
exact installation scope. Keep unrelated plugins/hooks. Do not kill a shared
Piper service used by Delta/IX or another session merely because one plugin is
unloaded. If this installation explicitly registered logon startup, use its
`uninstall` command to remove that registration. Ask whether to retain its model
caches; do not delete shared data or another installation's configured folder.

Prepared release limitations: see README. Clean Windows install, integrated
bidirectional WebRTC and acoustic/AEC acceptance are not complete. Network and
microphone access in a disposable Sandbox require their own approved profile;
installation ability is not employer IT approval.
