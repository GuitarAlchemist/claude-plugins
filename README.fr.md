# Plugins Claude Code de GuitarAlchemist

[English](README.md)

Les plugins et les mods Claude Code de l'écosystème GuitarAlchemist, et la
marketplace qui les versionne. Pourquoi cette organisation :
[ADR 0001](docs/adr/0001-one-marketplace-for-the-ecosystem.fr.md).

| Plugin | Ce qu'il fait | Où il vit |
| --- | --- | --- |
| `fleet` | `/fleet:ai-scrum` : un tour de table de chaque session, sous-agent, lane réclamée et pull request ouverte, avec ce qui attend l'utilisateur | ici |
| `session-inbox` | un panneau `/inbox` pour les messages des autres sessions, et des groupes de travail | ici |
| `shared-repo-guard` | retient les commandes git globales dans les clones partagés ; `/lanes`, et un panneau `/prs` | ici |
| `ga` | les outils du DSL Guitar Alchemist ; ne fonctionne que dans une session démarrée dans un checkout de ga | [ga](https://github.com/GuitarAlchemist/ga/tree/main/plugins/ga) |

## Trois endroits où un plugin peut vivre

1. **Dans le repo auquel il appartient.** Un dossier de plugin dans
   `<repo>/.claude/skills/<nom>/` (contenant `.claude-plugin/plugin.json`) se
   charge tout seul dans chaque session démarrée dans ce repo, et se versionne
   avec lui. Pour un mod qui n'a de sens que là.
2. **Ici**, pour un plugin qui sert dans plusieurs repos.
3. **Référencé ici depuis son repo**, par une source `git-subdir` épinglée sur
   un sha, pour le plugin d'un repo que des sessions ailleurs doivent pouvoir
   installer.

## Utiliser la marketplace

```bash
claude plugin marketplace add GuitarAlchemist/claude-plugins
claude plugin install fleet@guitaralchemist
```

Un repo peut la déclarer pour tous ceux qui l'ouvrent, dans son
`.claude/settings.json` commité :

```json
{
  "extraKnownMarketplaces": {
    "guitaralchemist": { "source": { "source": "github", "repo": "GuitarAlchemist/claude-plugins" } }
  },
  "enabledPlugins": { "fleet@guitaralchemist": true }
}
```

### Sur la machine de l'auteur

Les plugins d'ici sont aussi liés dans `~/.claude/skills/<nom>` (des jonctions
de répertoire vers `plugins/<nom>`) : ils se chargent comme `<nom>@skills-dir`
et se rechargent quand un fichier est enregistré. Ne pas les installer aussi
depuis la marketplace sur cette machine : le même plugin se chargerait deux
fois.

## Versions

La version de chaque plugin est écrite deux fois, dans son
`.claude-plugin/plugin.json` et dans son entrée de
`.claude-plugin/marketplace.json`, et les deux doivent concorder. Une pull
request qui modifie les fichiers d'un plugin doit augmenter sa version
([semver](https://semver.org/lang/fr/) : un correctif est un patch, une
nouvelle commande ou un nouvel outil un minor, une commande retirée ou
renommée un major). `claude plugin tag plugins/<nom>` crée le tag
`<nom>--v<version>` après la fusion ; le plugin propre à un repo est référencé
ici épinglé sur un tel tag, ou sur un sha.

## Le contrôle

```bash
python scripts/check.py                        # ce que la CI exécute sur main
python scripts/check.py --base origin/main     # ce que la CI exécute sur une pull request
python scripts/check.py --also ~/.claude/skills/ga-chatbot   # ajouter des mods gardés ailleurs
```

Pour chaque plugin listé, il vérifie que les deux versions concordent, que
`claude plugin validate` passe, que `claude plugin test` passe là où il y a des
tests et, avec `--base`, qu'un plugin modifié a augmenté sa version. Pour un
plugin référencé depuis un autre repo, il lit `plugin.json` au sha épinglé.
Ensuite il vérifie qu'aucune commande slash et aucun panneau n'est revendiqué
par deux plugins : les outils et les skills n'en ont pas besoin, le moteur les
préfixe du nom de leur plugin.

Ce qu'il ne voit pas : une commande traitée par un hook sans matcher, et les
commandes d'un plugin référencé depuis un autre repo.

## Licence

MIT, voir [LICENSE](LICENSE). Un plugin référencé depuis un autre repo, comme
`ga`, relève de la licence de ce repo. Les modèles téléchargés gardent leurs
propres licences, comme les voix Piper qu'installe `voice`.
