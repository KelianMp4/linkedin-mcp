# linkedin-mcp

Moteur MCP de contenu LinkedIn, multi-client. Se branche au Claude d'une entreprise
(claude.ai Team/Enterprise, Claude Desktop, Claude Code) comme connecteur distant.

## Ce qu'il fait

Le **Bearer token = l'identite du client**. Le serveur en deduit `data/<token>/`
(brand + suivi). Outils :

- `setup_brand` — enregistre voix + charte du client (onboarding, une fois).
- `get_playbook` — fournit la methode + la voix pour que **le Claude du client redige**.
  Aucun texte genere cote serveur => **aucun cout de token pour l'hebergeur**.
- `register_font(role, source)` — enregistre la police on-brand du client (par role
  `title`/`body`). `source` = un nom de famille Google Fonts (le serveur resout et
  telecharge le woff2) **ou** une URL https d'un fichier woff2/woff/ttf/otf. La police
  est stockee dans `data/<token>/fonts/` et injectee en `@font-face` local : **aucune
  requete reseau au rendu**. Garde-fou SSRF (https + IP publique + type/taille controles).
- `render_carousel(slides)` — carrousel on-brand en **PDF** (format LinkedIn).
- `render_image(slide)` — image seule on-brand en **PNG** (1080x1350).
- `log_post` / `list_posts` — suivi des posts (metriques saisies a la main).

Rendu via **headless Chrome**. Le texte est **auto-ajuste** (aucune coupe : la police
retrecit jusqu'a ce que tout rentre) et la capture attend le chargement des polices
(`--virtual-time-budget`). Sans police enregistree, rendu en police systeme neutre.

## Tester

```bash
npm test   # node:test — isolation par token, rendu smoke, auto-fit, garde SSRF, playbook
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
