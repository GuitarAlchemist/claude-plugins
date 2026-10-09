# ADR 0001 — Une marketplace pour l'écosystème, les plugins là où ils appartiennent

[English](0001-one-marketplace-for-the-ecosystem.md)

- Statut : accepté, 2026-10-09
- Décidé par : l'auteur, parmi trois emplacements proposés par Claude

## Contexte

Au 2026-10-07, les extensions Claude Code de l'écosystème étaient éparpillées
et pour la plupart non versionnées :

- cinq mods que l'auteur utilise tous les jours (ga-chatbot, session-inbox,
  shared-repo-guard, observatory-guard, et le nouveau fleet) vivaient dans
  `~/.claude/skills/`, **sans aucun contrôle de version** ;
- notre seule marketplace, `guitar-alchemist`, était une source de type
  répertoire sur le checkout de ga, listait un seul plugin, et était recopiée
  dans chaque worktree de ga ;
- compound-engineering était installé depuis deux marketplaces, en deux
  versions (2.35.2 et 3.30.4) ;
- `ix/.claude/skills` contenait environ 110 skills, pour la plupart des copies
  vendorisées de skills compound-engineering et mattpocock que les plugins
  activés fournissent aussi ;
- deux mods revendiquaient la commande `/ga`.

Claude Code fournit déjà les pièces : un dossier de plugin dans
`.claude/skills/<nom>/` d'un repo se charge tout seul dans ce repo ; une
marketplace liste des plugins depuis des chemins relatifs ou des sources
`git-subdir` épinglées sur un sha ; `claude plugin validate`, `test` et `tag`
vérifient, testent et versionnent un plugin.

## Décision

1. Un repo privé dédié, `GuitarAlchemist/claude-plugins`, contient la
   marketplace `guitaralchemist` et les plugins qui servent dans plusieurs
   repos : fleet, session-inbox, shared-repo-guard.
2. Un plugin qui appartient à un repo vit dans ce repo (dans
   `.claude/skills/<nom>/`, ou un `plugins/<nom>/` que le repo liste), et est
   référencé ici par une source `git-subdir` épinglée sur un sha quand des
   sessions ailleurs doivent pouvoir l'installer. Le plugin `ga` de ga est le
   premier. ga-chatbot et observatory-guard doivent rejoindre leurs repos.
3. Chaque plugin porte une version semver, écrite dans son `plugin.json` et
   dans son entrée de la marketplace. La CI refuse une pull request qui
   modifie un plugin sans augmenter sa version, ou qui laisse deux plugins
   revendiquer la même commande slash ou le même panneau.
4. Sur la machine de l'auteur, `~/.claude/skills/<nom>` est une jonction de
   répertoire vers `plugins/<nom>` de ce repo : l'édition garde son
   rechargement à chaud et chaque modification est dans git.

Les deux autres emplacements envisagés : étendre la marketplace de ga (rien à
créer, mais liée au rythme de ga et recopiée dans chaque worktree de ga), et
Demerzel (le repo de coordination, mais avec deux branches divergentes, et
extrait comme sous-module d'ix).

## Conséquences

- Les mods quotidiens de l'auteur ont un historique et une copie distante.
- Un repo s'y abonne par `extraKnownMarketplaces` et `enabledPlugins` dans son
  `.claude/settings.json` commité ; des identifiants comme
  `fleet@guitaralchemist` apparaissent alors dans plusieurs repos, ce qui rend
  coûteux le renommage de la marketplace.
- La marketplace répertoire `guitar-alchemist` de ga devient redondante dès que
  les réglages de ga pointent ici ; la retirer est une modification de ga.

## Réversibilité et réexamen

Surtout une porte à double sens : les plugins sont de simples dossiers, et les
déplacer de nouveau est une copie. La partie à sens unique est le nom de la
marketplace une fois que des repos y font référence. À réexaminer si une
deuxième machine ou un collaborateur se met à installer ces plugins (les
jonctions supposent un seul auteur), ou si un plugin référencé depuis son repo
doit être relu ici avant chaque montée de version.
