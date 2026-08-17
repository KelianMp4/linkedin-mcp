# linkedin-mcp

Moteur MCP de contenu LinkedIn, multi-client. Se branche au Claude d'une entreprise
(claude.ai Team/Enterprise, Claude Desktop, Claude Code) comme connecteur distant.

> **v1.0.0 — beta ouverte.** Le moteur est stable et durci pour la production
> (timeout de rendu, cap de concurrence, écritures atomiques, arrêt propre). Il
> évolue selon les retours d'usage. Un bug, une idée, un manque ? Ouvrez une
> [issue GitHub](https://github.com/KelianMp4/linkedin-mcp/issues) — les retours
> orientent directement la feuille de route.

## Ce qu'il fait

Le **Bearer token = l'identite du client**. Le serveur en deduit `data/<token>/`
(brand + suivi). Outils :

**Identite de marque**
- `setup_brand` — enregistre voix + charte du client (onboarding, une fois).
- `get_brand` — relit l'identite stockee (voix + charte) en JSON.
- `update_brand` — patch partiel (fusion profonde), version precedente archivee.
- `register_font(role, source)` — enregistre la police on-brand du client (par role
  `title`/`body`). `source` = un nom de famille Google Fonts (le serveur resout et
  telecharge le woff2) **ou** une URL https d'un fichier woff2/woff/ttf/otf. La police
  est stockee dans `data/<token>/fonts/` et injectee en `@font-face` local : **aucune
  requete reseau au rendu**. Garde-fou SSRF (https + IP publique + type/taille controles).

**Rediger & verifier**
- `get_playbook` — fournit la methode + la voix pour que **le Claude du client redige**.
  Aucun texte genere cote serveur => **aucun cout de token pour l'hebergeur**. Injecte
  aussi « ce qui marche pour toi » a partir de l'historique du client.
- `lint_post(texte)` — controle deterministe avant publication : accroche en 1re ligne,
  aucun lien dans le corps, pas de tiret cadratin, repere de coupe (~210 car).

**Visuels on-brand**
- `render_carousel(slides)` — carrousel on-brand en **PDF** (format LinkedIn).
- `render_image(slide)` — image seule on-brand en **PNG** (1080x1350).
  Chaque slide accepte un `layout` : `hook`, `stat`, `quote`, `list` (+ `puces`), `cta`,
  `default` — auto-detecte selon les champs, ou explicite.

**Publier & suivre**
- `connect_linkedin()` — renvoie une URL d'autorisation ; apres accord du membre, son
  jeton LinkedIn est stocke **par client** pour publier sur son profil.
- `post_to_linkedin(texte, visuel?)` — publie (texte ou visuel on-brand) sur le profil
  connecte, **apres validation humaine du texte**. Ajoute au suivi automatiquement.
- `log_post` / `list_posts` — suivi des posts (metriques saisies a la main).
- `update_post_metrics(id)` — complete apres coup les metriques d'un post loggue.
- `analyze_posts` — bilan deterministe (cadence, format/themes les plus engageants,
  meilleur post), base uniquement sur les metriques saisies — aucune tendance inventee.
- `delete_my_data(confirm)` — droit a l'effacement (RGPD art. 17) : efface tout le
  dossier du client et invalide son token.

Rendu via **headless Chrome**. Le texte est **auto-ajuste** (aucune coupe : la police
retrecit jusqu'a ce que tout rentre) et la capture attend le chargement des polices
(`--virtual-time-budget`). Sans police enregistree, rendu en police systeme neutre.

> La publication LinkedIn (`connect_linkedin` / `post_to_linkedin`) requiert une app
> LinkedIn cote serveur (`LINKEDIN_CLIENT_ID` / `LINKEDIN_CLIENT_SECRET`). Sans elle,
> les autres outils (redaction, visuels, suivi) fonctionnent normalement.

## Tester

```bash
npm test   # node:test — isolation par token, rendu + gabarits, auto-fit, garde SSRF,
           # playbook, lint, analyse, connexion LinkedIn, bornage des sessions
```

## Modele

Open-core : ce moteur est **MIT**, generique. Aucune donnee client dans le code :
chaque marque vit dans `data/<token>/brand.json` (+ `history.json`), pose via `setup_brand`.

Qui paie quoi : le client paie sa conso Claude (la redaction tourne chez lui) ;
l'hebergeur paie juste le serveur (compute du rendu + quelques Ko de JSON par client).

## Lancer en local

```bash
npm install
npm run mint -- "Nom du client"   # cree un token, l'affiche
DATA_DIR=./data npm start          # http://localhost:3000/mcp
curl localhost:3000/health
```

## Onboarder un client (v1, sans UI)

1. `npm run mint -- "Nom du client"` => un token `lkm_...`.
2. Envoyer au client par mail : l'URL `https://mcp.stacko.fr/mcp` + `Authorization: Bearer <token>`.
3. Le client branche ce connecteur MCP dans son Claude, lance `setup_brand`
   (Claude l'interroge sur son brand book), puis genere ses posts + visuels.

## Deploiement (repo autonome, open-core)

Ce moteur reste un **repo separe** (MIT) : pas dans le monorepo Stacko prive.
Il se deploie comme **son propre service** (perf isolee : le rendu Chrome ne touche
aucun autre service). Build depuis la racine du repo (`docker build .`), route Caddy
(ex. `mcp.stacko.fr`). Variables : `PORT`, `CHROME_BIN`, `DATA_DIR` (volume persistant).

## Brancher cote client

Ajouter un connecteur MCP distant pointant sur `https://mcp.stacko.fr/mcp`,
header `Authorization: Bearer <token>`. 1 client = token partage suffit ;
plusieurs = passer a OAuth.
