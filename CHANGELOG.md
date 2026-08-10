# Changelog

Toutes les évolutions notables de ce projet sont documentées ici.
Format inspiré de [Keep a Changelog](https://keepachangelog.com/fr/1.0.0/) ;
versionnement [SemVer](https://semver.org/lang/fr/).

## [1.0.0] - 2026-08-10

Première version stable — **beta ouverte**. Durcissement du moteur pour un usage
en production : ne jamais figer, ne jamais perdre de données client.

### Ajouté
- **Timeout de rendu (30 s) + kill du groupe de process Chrome** : un rendu qui
  hang est tué et remonté en erreur lisible, jamais bloqué à l'infini. Aucun
  process Chrome orphelin (zygote/GPU) sur Linux.
- **Retry automatique (1×) sur échecs transitoires uniquement** (timeout / échec
  de spawn). Un exit Chrome déterministe (entrée cassée) échoue immédiatement, sans
  seconde tentative inutile.
- **Cap de concurrence (2 rendus simultanés) avec file d'attente** : protège le
  serveur d'une saturation de process Chrome ; les rendus en trop attendent leur
  tour au lieu d'être rejetés.
- **Écritures atomiques (temp + rename) + sérialisation par token** dans le store :
  un crash en pleine écriture ne corrompt plus `history.json` / `brand.json`, et des
  écritures concurrentes ne perdent aucune donnée.
- **Arrêt propre (SIGTERM / SIGINT)** : à chaque déploiement, on cesse d'accepter,
  on laisse finir les rendus en vol (délai de grâce), puis on tue les process
  restants — pas de Chrome zombie. Hard-exit de secours pour ne jamais bloquer un
  déploiement.
- **Intégration continue** : GitHub Actions installe Chromium et lance la suite de
  tests (rendu inclus) sur chaque push / pull request.

### Notes
- Aucune dépendance ajoutée : le durcissement reste sans lib externe.
- Aucun changement de comportement fonctionnel des outils MCP existants.

[1.0.0]: https://github.com/KelianMp4/linkedin-mcp/releases/tag/v1.0.0
