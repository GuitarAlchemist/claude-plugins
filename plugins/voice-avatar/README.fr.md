# voice-avatar

[English](README.md)

Un petit visage au-dessus du prompt, et un panneau détaillé, pour le plugin
[voice](../voice/README.fr.md) : qui a la parole (Piper qui parle pour Claude,
un autre agent vocal, une scène 3D), si Claude écoute et pour qui, le niveau du
micro, ce qu'est devenue la dernière phrase entendue, et ce que fait Claude
(l'outil en cours, la durée du tour, les jetons et le quota consommés).

```text
/plugin marketplace add GuitarAlchemist/claude-plugins
/plugin install voice-avatar@guitaralchemist
```

Il ne fait que lire : les fichiers d'état du plugin voice, dans le dossier de
données de piper-voice (`PIPER_VOICE_HOME`, sinon `%LOCALAPPDATA%\piper-voice`,
sinon `$XDG_CACHE_HOME`/`~/.cache`) et dans celui de l'écoute
(`VOICE_LISTEN_HOME`, sinon `voice-listen` à côté). Il n'en écrit que deux,
quand vous appuyez sur ses boutons : `pause` (⏸ pause, ▶ reprendre) et `stop`
(⏹ arrêter). Il n'ouvre aucun micro, ne lance rien et ne fait aucun appel
réseau. `👍 oui` / `👎 non` apparaissent quand le tour de Claude finit sur une
question fermée, et envoient ce mot comme votre réponse. `⤢ détails` ouvre le
panneau.

Sans l'écoute ni le guetteur de courtoisie du plugin voice (Windows), le
bandeau montre encore ce que fait Claude et ce que la session consomme.

## Options

| Option | Défaut | Ce que c'est |
| --- | --- | --- |
| `faceFile` | vide (éteint) | un fichier JSON qu'une scène 3D lit pour refléter l'avatar : `{v, t, state, tool, session}`, l'état parmi idle, working, waiting, done, failed, et le nom de l'outil, jamais un prompt, un argument ni un chemin |
| `faceSession` | `Claude` | la `session` que nomme ce fichier |

## Tests

`claude plugin test plugins/voice-avatar` : le visage, les libellés, le
vu-mètre, le bandeau et le panneau, à partir d'états fixés, sans lire de
fichier.
