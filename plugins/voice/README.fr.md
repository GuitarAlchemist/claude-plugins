# voice

[English](README.md)

La voix locale dans les deux sens. Claude parle grâce à **piper-voice**, un
service local de synthèse vocale en streaming sur
[Piper](https://github.com/rhasspy/piper), et vous écoute grâce à whisper.cpp,
qui transcrit sur la machine.

```text
/plugin install voice --marketplace GuitarAlchemist/claude-plugins
```

Le contrat HTTP du service, sa compilation, son démarrage à l'ouverture de
session et ses licences sont décrits dans le [README anglais](README.md).

## Tout reste en local

La voix est Piper, joint sur 127.0.0.1 seulement : un `PIPER_VOICE_URL` qui
n'est pas en boucle locale est ignoré. La transcription est whisper.cpp,
exécuté sur la machine. Ce plugin n'envoie ni son ni texte nulle part. Seul le
texte d'une phrase adressée à Claude sort de l'écoute, et il est remis à cette
session Claude Code comme si vous l'aviez tapé.

| Commande | Ce qu'elle fait |
| --- | --- |
| `/speak on` | les réponses de cette session sont dites à voix haute : leur premier paragraphe, sans code, liens ni chemins |
| `/speak off` | elles ne le sont plus ; `/speak stop` coupe la voix tout de suite ; `/speak` montre l'état |
| `/listen` | ouvre le micro et commence à écouter (Windows seulement). **Éteint par défaut** : rien n'écoute avant cette commande |
| `/listen stop` | arrête ; le micro est libéré aussitôt. Aussi `/listen pause`, `/listen resume`, `/listen status` |

Tant que l'écoute tourne, une ligne au-dessus du prompt le dit (`🎙 écoute
active … · /listen stop`), et la barre latérale de wmux aussi quand wmux est
là. L'écoute est un enfant de la session : elle finit avec elle. whisper-stream
tourne dans un job Windows qui le tue dès que l'écoute s'arrête, de quelque
façon que ce soit : le micro ne reste jamais ouvert derrière. Toutes les 10 s,
l'écoute vérifie aussi que whisper-stream n'a ouvert aucun socket, et s'arrête
s'il l'a fait.

Ce que vous dites est pour Claude jusqu'à ce que vous disiez autre chose :
« Top Claude » (pour Claude), « Top » (conversation ambiante, ignorée), « Top
Gaïa » (pour l'autre agent vocal, ignorée), « Claude, pause », « Claude, arrête
d'écouter ». Une phrase entendue pendant que Piper parle est ignorée : c'est sa
propre voix. Avec `autoSend` éteint (par défaut), chaque phrase attend dans le
prompt que vous appuyiez sur Entrée.

Seule la session qui l'a demandé parle : `/speak on` crée
`sessions/<id de session>` dans le dossier de données de piper-voice ; le
fichier `muted` à côté fait taire toutes les sessions.

## Options

Avec `/config` (ou `pluginConfigs` dans settings.json) :

| Option | Défaut | Ce que c'est |
| --- | --- | --- |
| `language` | `fr` | la langue de whisper ; les commandes parlées sont en français |
| `autoSend` | éteint | envoyer chaque phrase aussitôt au lieu de la laisser dans le prompt |
| `whisperStream` | vide | `whisper-stream.exe` ; vide : cherché dans le `PATH`, sinon sous `%LOCALAPPDATA%\voice-listen` |
| `whisperModel` | vide | un `ggml-*.bin` ; vide : le premier sous `%LOCALAPPDATA%\voice-listen\models`, large-v3-turbo d'abord |
| `callApp` | `ChatGPT` | le processus d'un autre agent vocal dont l'appel partage le micro : quand le micro de son appel est ouvert, ce que vous dites est pour lui, et sa voix n'est pas prise pour la vôtre. Vide : désactivé |
| `sceneSayFile` | vide (éteint) | un fichier que lit une scène 3D : quand sa fenêtre Godot a le focus, les réponses y sont écrites pour sa propre voix au lieu de piper-voice |

Variables d'environnement : `PIPER_VOICE_HOME` (le dossier de piper-voice),
`VOICE_LISTEN_HOME` (celui de l'écoute, par défaut `%LOCALAPPDATA%\voice-listen`),
`PIPER_VOICE_URL` (boucle locale seulement), `VOICE_LISTEN_WHISPER` et
`VOICE_LISTEN_MODEL`.

## Installer whisper (Windows)

Le plugin ne télécharge rien. Placez la version Windows de whisper.cpp et un
modèle sous `%LOCALAPPDATA%\voice-listen` (ou indiquez-les dans les options) :

1. Une archive de [whisper.cpp](https://github.com/ggml-org/whisper.cpp/releases)
   qui contient `whisper-stream.exe`, par exemple `whisper-blas-bin-x64.zip`,
   décompressée n'importe où sous `%LOCALAPPDATA%\voice-listen`. Vérifiez son
   SHA-256 avec celui de la release.
2. Un modèle dans `%LOCALAPPDATA%\voice-listen\models\`, depuis
   [ggerganov/whisper.cpp](https://huggingface.co/ggerganov/whisper.cpp), par
   exemple `ggml-large-v3-turbo-q5_0.bin` (environ 550 Mo ; un plus petit comme
   `ggml-base.bin` charge plus vite et entend moins bien).

S'il en manque un, `/listen` le dit et n'ouvre rien.

## Windows seulement

`/listen` (`listen/voice_listen.ps1` avec `Listen.cs` et `AudioPeek.cs` : Core
Audio, UI Automation, un job) et le guetteur de courtoisie ne tournent que sous
Windows. Ailleurs, `/listen` répond qu'il est réservé à Windows et ne lance rien ;
`/speak` et les outils MCP marchent partout où tourne piper-voice.

## Le guetteur de courtoisie (facultatif, Windows)

`listen/voice_courtesy.ps1` empêche Piper de parler par-dessus l'application d'un
autre agent vocal (`-Others`, ChatGPT par défaut). Il ne lit que les niveaux de
sortie, jamais le micro. Tant qu'il tourne, les réponses attendent dans
`courtesy\pending\` que l'autre agent se taise, et `courtesy\piper-speaking`
dit au plugin voice-avatar quand Piper joue. Un seul par machine, lancé à la
main :

```powershell
Start-Process -WindowStyle Hidden pwsh "-NoProfile -File `"<plugin>\listen\voice_courtesy.ps1`""
```

## Fichiers d'état

Dans le dossier de l'écoute, réécrits tant qu'elle tourne et supprimés quand
elle s'arrête : `state`, `level`, `last`, `target`, `call`, `focus`, `typed`,
`listen.pid` ; `pause` et `stop` sont lus. `listen.log` note les événements, les
longueurs et les latences, jamais ce qui a été dit. Le plugin voice-avatar lit
ces fichiers.

## Tests

`claude plugin test plugins/voice` teste le module avec des faux, sans micro,
sans PowerShell et sans piper-voice. Les tests du service Go sont décrits dans
le README anglais.
