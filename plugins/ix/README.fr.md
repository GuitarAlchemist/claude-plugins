# ix

[English](README.md)

Le serveur MCP d'IX, `ix-mcp`, en plugin pour Claude Code et Codex : les outils
d'IX (ML, maths, graphes, recherche et gouvernance Demerzel) deviennent des
outils MCP dans n'importe quelle session, pas seulement dans un checkout d'ix.
Le plugin ne contient pas le serveur. Il contient un lanceur,
`scripts/ix-mcp.mjs`, qui trouve votre `ix-mcp` et le démarre.

## Ce qu'il faut

- **Node.js** dans le PATH, pour exécuter le lanceur.
- **Un binaire `ix-mcp`**, issu du crate `ix-agent`. Compilez-le dans un clone,
  qui apporte aussi les fichiers de gouvernance :

  ```bash
  git clone --recurse-submodules https://github.com/GuitarAlchemist/ix
  cd ix
  cargo build --release -p ix-agent --bin ix-mcp
  ```

  Ou installez-le dans le PATH (dans `~/.cargo/bin`) sans garder de clone :

  ```bash
  cargo install --git https://github.com/GuitarAlchemist/ix ix-agent --bin ix-mcp
  ```

- **Pour les outils de gouvernance, un clone d'ix avec `governance/demerzel`**,
  le sous-module Demerzel qui contient la constitution. Dans un clone fait sans
  `--recurse-submodules`, lancez `git submodule update --init governance/demerzel`.

## Comment le lanceur les trouve

Le binaire, d'après le premier de ces réglages qui est défini :

1. l'option `ix_mcp_bin` du plugin (Claude Code seulement) ;
2. la variable d'environnement `IX_MCP_BIN` ;
3. `ix-mcp` dans le PATH.

Si aucun ne donne de binaire, le serveur ne démarre pas, et son journal dit
comment en obtenir un. Un chemin donné en 1 ou 2 qui n'est pas un fichier
l'arrête aussi : le lanceur ne se rabat pas sur le PATH.

La racine IX, d'après le premier de ces réglages qui est défini :

1. l'option `ix_root` du plugin (Claude Code seulement) ;
2. la variable d'environnement `IX_ROOT` ;
3. le clone d'ix dans lequel le binaire a été compilé (`<clone>/target/release/ix-mcp`).

Le lanceur passe la racine à `ix-mcp` dans `IX_ROOT` et l'y démarre. `ix-mcp`
lit les fichiers de gouvernance dans `<racine>/governance/demerzel`. Sans
racine, les outils d'algorithmes fonctionnent toujours, les outils de
gouvernance échouent, et les outils qui prennent un chemin le refusent. Le
lanceur signale ces deux cas dans le journal du serveur.

Un clone compilé comme ci-dessus n'a donc besoin que de `IX_MCP_BIN`. Un
binaire installé par `cargo install` a besoin de `IX_ROOT` en plus.

## Claude Code

```bash
claude plugin marketplace add GuitarAlchemist/claude-plugins
claude plugin install ix@guitaralchemist
```

Claude Code demande les deux options quand le plugin est activé. Laissez-les
vides pour utiliser les variables d'environnement. Vous pourrez les changer
plus tard dans `/config`. Les outils s'appellent `mcp__plugin_ix_ix__<outil>`.

Une session démarrée dans le repo ix a déjà le serveur d'IX, par le
`.mcp.json` du repo. Le plugin y en démarrerait un second.

## Codex

```bash
codex plugin marketplace add GuitarAlchemist/claude-plugins
codex plugin add ix@guitaralchemist
```

Codex lit le `.claude-plugin/marketplace.json` de ce repo, puis le
`.codex-plugin/plugin.json` du plugin, dont le champ `mcpServers` pointe vers
`.mcp.json`. Codex ne passe à un serveur MCP que les variables d'environnement
que le serveur nomme. Ici ce sont `PATH`, `IX_MCP_BIN` et `IX_ROOT`.
Définissez-les là où Codex démarre : sous Windows, comme variables
d'environnement utilisateur, puis redémarrez Codex.

Le plugin n'a pas d'options dans Codex. Si `~/.codex/config.toml` démarre déjà
`ix-mcp` par une entrée `[mcp_servers.<nom>]` écrite à la main, retirez cette
entrée ou n'installez pas le plugin, pour qu'un seul serveur IX tourne.

## Fichiers

| Fichier | Pour |
| --- | --- |
| `.claude-plugin/plugin.json` | Claude Code : le manifeste, les deux options et le serveur `ix`. Claude Code lit aussi `.mcp.json`, et ce `ix`-ci remplace celui de ce fichier |
| `.codex-plugin/plugin.json` | Codex : le manifeste |
| `.mcp.json` | Codex : le serveur `ix`, lancé depuis le dossier du plugin (`cwd`), avec les variables qu'il transmet (`env_vars`) |
| `scripts/ix-mcp.mjs` | les deux : le lanceur |

La version figure dans les deux manifestes et dans l'entrée de la
marketplace. `scripts/check.py` échoue quand elles diffèrent.
