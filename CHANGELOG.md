# Changelog

Toutes les évolutions notables de ce projet sont documentées ici.
Format inspiré de [Keep a Changelog](https://keepachangelog.com/fr/1.0.0/) ;
versionnement [SemVer](https://semver.org/lang/fr/).

## [Non publié]

### Ajouté
- **Publication LinkedIn depuis le MCP** : deux outils `connect_linkedin` et
  `post_to_linkedin`. `connect_linkedin` renvoie une URL d'autorisation ; après
  accord du membre, son jeton LinkedIn est stocké **par client** (isolé, 0600) et
  `post_to_linkedin` publie sur son profil (texte ou visuel on-brand), uniquement
  après validation humaine du texte. Le post est ajouté au suivi automatiquement.
- **`lint_post`** : vérification déterministe d'un brouillon avant publication —
  accroche en 1ʳᵉ ligne, aucun lien dans le corps, pas de tiret cadratin, repère de
  coupe (~210 car). Aucun texte généré côté serveur : renvoie les corrections à faire.
- **CRUD identité de marque** : `get_brand` (lire l'identité stockée), `update_brand`
  (patch partiel par fusion profonde, version précédente archivée).
- **`update_post_metrics`** : compléter après coup les métriques d'un post déjà loggé
  (saisies à la main, jamais inventées).
- **`analyze_posts`** : bilan déterministe de l'historique (cadence, format et thèmes
  les plus engageants, meilleur post), basé uniquement sur les métriques saisies —
  aucune tendance inventée, et rien tant qu'il n'y a pas assez de données. Les mêmes
  signaux nourrissent `get_playbook` (« ce qui marche pour toi »), pour que le contenu
  s'améliore à partir des résultats réels du client.
- **Gabarits de slide** (`layout`) pour les visuels : `hook` (accroche), `stat`
  (chiffre qui domine), `quote` (citation), `list` (puces via le champ `puces`), `cta`,
  `default`. Auto-détecté selon les champs fournis, ou explicite. L'auto-fit anti-coupe
  s'applique à chaque variante.

### Interne
- **Sessions MCP bornées** : expiration d'inactivité + plafond LRU sur la table des
  sessions (ferme une fuite mémoire lente sur serveur long-vivant). Configurable par
  `SESSION_TTL_MS` / `SESSION_MAX` / `SESSION_SWEEP_MS`.
- **Test de rendu dé-flaké** : le retry sur timeout est vérifié via un compteur
  côté rendu (déterministe), plus via le timing du process fils.

### Notes
- Toujours aucune dépendance ajoutée.
- Le playbook renvoie désormais vers `lint_post` avant publication (source unique des
  règles de canal, vérifiées mécaniquement).

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
