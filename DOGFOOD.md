# Dogfood — utiliser linkedin-mcp pour les posts de Stacko-leads

But : brancher ce MCP sur TON Claude et t'en servir pour produire les posts LinkedIn
de Stacko-leads (au lieu de la skill manuelle). Tu manges ton propre plat avant Andrea.

## 1. Minter ton token + lancer le serveur

```bash
cd linkedin-mcp
npm run mint -- "Stacko-leads"          # note le token lkm_...
DATA_DIR=./data PORT=3000 npm start      # laisse tourner ; http://localhost:3000/mcp
```

Vérif : `curl localhost:3000/health` -> `{"ok":true,...}`.

## 2. Brancher ton Claude (le plus simple = Claude Code)

```bash
claude mcp add --transport http linkedin-mcp http://localhost:3000/mcp \
  --header "Authorization: Bearer lkm_TON_TOKEN"
```

(Claude Desktop veut du https public : pour du local, passe par Claude Code.)

## 3. Enregistrer la marque (une fois) — appelle `setup_brand` avec ceci

```json
{
  "voice": {
    "registre": "manifeste",
    "langue": "fr",
    "regles": [
      "Jamais de tiret cadratin",
      "Preuve par les chiffres, jamais de jargon marketing ni de superlatif creux",
      "Phrases courtes qui claquent, direct et sans detour",
      "Le vous, sur de soi mais jamais condescendant",
      "Fin orientee conversation ou DM, jamais un lien externe"
    ],
    "produit": {
      "nom": "Stacko-leads",
      "pitch": "listes de prospects B2B verifies, en libre-service : tu telecharges toi-meme ta liste prete a appeler",
      "cible": "courtiers en assurance",
      "prix": "60 euros/mois, jusqu'a 1000 lignes par liste",
      "url": "leads.stacko.fr",
      "preuve": "moins de 10% de donnees mortes garanties (SIRENE + BODACC + INPI + verif email), plancher tenu a 90% de contacts vivants"
    }
  },
  "visual": {
    "bg": "#1A1A1A",
    "fg": "#F2F2F2",
    "accent": "#634670",
    "accent2": "#D8A24A",
    "titleFont": "Lilita One",
    "bodyFont": "Inter",
    "width": 1080,
    "height": 1350
  }
}
```

Note : la vraie police corps de la charte = **Switzer** (pas sur Google Fonts).
En attendant le bundle des polices (dette prod), on rend en Inter (grotesque proche).

## 4. Produire un post

Dans ton Claude, branche : `get_playbook` (il te sort voix + methode) -> tu rediges ->
`render_image` (une slide) ou `render_carousel` (5-8 slides) pour le visuel on-brand ->
apres publication `log_post` pour le suivi, `list_posts` pour le bilan.

## Ce que le dogfood doit valider avant Andrea
- Le playbook te donne assez pour ecrire sans te battre avec l'outil.
- Les visuels sortent on-brand du premier coup (sinon on ajuste le template).
- Le suivi (log_post/list_posts) remplace bien history.json a la main.
- Verdict : est-ce que TU l'utiliserais chaque semaine ? Si non, Andrea non plus.
