# Démo LinkedIn — pour la review Community Management API

Surface web minimale (`/demo`) qui prouve à LinkedIn que ton intégration marche :
un reviewer se logge (compte de test), connecte SON LinkedIn, rédige un post,
**l'approuve explicitement**, et on le publie. Human-in-the-loop, rien d'automatique.

C'est ce qui débloque les 2 champs bloquants du formulaire : le **screen recording**
et le **login de test + lien produit**.

> ⚠️ **Non testé contre LinkedIn** (pas de credentials au moment du build). La
> structure suit l'API v2 (ugcPosts + assets). Au 1er vrai test, vérifier scopes
> + version dans le portail LinkedIn (section « Si ça échoue » plus bas).

---

## 1. Créer l'app LinkedIn (portail développeur)

1. https://developer.linkedin.com → **Create app**. LinkedIn exige d'associer
   l'app à une **Page entreprise** (crée une page Stacko si tu n'en as pas).
2. Onglet **Products** → demande :
   - **Sign In with LinkedIn using OpenID Connect** (donne `openid` + `profile`).
   - **Share on LinkedIn** (donne `w_member_social` = publier sur le profil).
   Ces deux-là sont en **accès développeur immédiat** : tu peux tester avec TON
   propre compte sans attendre l'approbation. (La Community Management API, elle,
   c'est ce que tu demandes dans le formulaire — pour l'après-démo.)
3. Onglet **Auth** → **Authorized redirect URLs** → ajoute :
   - `https://mcp.stacko.fr/demo/linkedin/callback` (prod)
   - `http://localhost:3000/demo/linkedin/callback` (local, pour tester)
4. Copie le **Client ID** et le **Client Secret**.

## 2. Variables d'environnement

| Variable | Rôle | Secret ? |
|----------|------|----------|
| `LINKEDIN_CLIENT_ID` | ID de l'app LinkedIn | non |
| `LINKEDIN_CLIENT_SECRET` | Secret de l'app LinkedIn | **OUI** |
| `LINKEDIN_REDIRECT_URI` | (optionnel) défaut = `$PUBLIC_URL/demo/linkedin/callback` | non |
| `LINKEDIN_SCOPES` | (optionnel) défaut = `openid profile w_member_social` | non |
| `DEMO_USER` | identifiant du login de test (à donner au reviewer) | non |
| `DEMO_PASS` | mot de passe du login de test | **OUI** |
| `PUBLIC_URL` | déjà posé en prod (`https://mcp.stacko.fr`) | non |

## 3. Tester en local

```bash
LINKEDIN_CLIENT_ID=xxx LINKEDIN_CLIENT_SECRET=yyy \
DEMO_USER=reviewer DEMO_PASS=un-mot-de-passe \
PUBLIC_URL=http://localhost:3000 DATA_DIR=./data \
npm start
# puis ouvre http://localhost:3000/demo
```
(Ajoute `http://localhost:3000/demo/linkedin/callback` dans les redirect URLs LinkedIn.)

## 4. Déployer en prod (VPS)

Les secrets ne vont **jamais** dans le compose commité. Sur le VPS, crée un
`.env` local à côté du service (non commité) :

```bash
# /var/www/stacko/apps/linkedin-mcp/.env   (gitignoré : data/, non tracké)
LINKEDIN_CLIENT_ID=xxx
LINKEDIN_CLIENT_SECRET=yyy
DEMO_USER=reviewer
DEMO_PASS=un-mot-de-passe-solide
```

Et référence-le dans le service compose du monorepo (à ajouter une fois) :
```yaml
  linkedin-mcp:
    # ... (build, container_name, volumes déjà là)
    environment:
      PUBLIC_URL: https://mcp.stacko.fr
    env_file:
      - ./apps/linkedin-mcp/.env    # secrets LinkedIn + démo, hors git
```
Puis : `docker compose up -d --build linkedin-mcp`.
Vérifie : `https://mcp.stacko.fr/demo` affiche la page de login (sans le warning
« non configuré » une fois les credentials posés).

## 5. Le screen recording (exactement quoi filmer)

Enregistre ton écran (Loom / OBS / QuickTime) en faisant, dans l'ordre :

1. Va sur `https://mcp.stacko.fr/demo` → montre la **page de login**.
2. Connecte-toi avec le **compte de test** (DEMO_USER / DEMO_PASS).
3. Clique **« Connecter LinkedIn »** → la page LinkedIn s'ouvre → **autorise**
   (avec TON compte LinkedIn en tier dev).
4. Retour sur l'app : montre **« ✔ Connecté : <ton nom> »**.
5. Écris un **texte de post** + un **titre de visuel** (pour générer une image
   on-brand). Montre que tu relis.
6. Clique **« Approuver et publier »**. **Insiste à voix haute : rien n'est publié
   sans ce clic** (human-in-the-loop).
7. Montre l'écran **« ✔ Publié sur LinkedIn »** → clique **« Voir le post »** →
   le post **réel** sur LinkedIn.
8. (Optionnel) Montre que sans le clic d'approbation, rien ne part.

Upload la vidéo (Loom / YouTube non-répertorié / Drive public) et colle le lien
dans le champ « screen recording ».

## 6. Ce que tu colles dans le formulaire

- **Screen recording** : le lien de la vidéo.
- **Test login details + product link** :
  ```
  Product URL: https://mcp.stacko.fr/demo
  Test login:  user = <DEMO_USER>   password = <DEMO_PASS>
  Notes: after logging in, click "Connecter LinkedIn" to authorize a LinkedIn
  account, then draft a post and click "Approuver et publier" to publish. Nothing
  is published without the explicit approval click (human-in-the-loop).
  ```

## 7. Si ça échoue au 1er vrai test (checklist)

- **Token exchange 400** → vérifie que le `redirect_uri` est **exactement** celui
  déclaré dans le portail (au caractère près).
- **userinfo 403** → le scope `openid`/`profile` n'est pas accordé : ajoute le
  produit « Sign In with LinkedIn using OpenID Connect ».
- **ugcPosts 403** → `w_member_social` absent : ajoute le produit « Share on
  LinkedIn », et vérifie que TON compte est bien membre autorisé de l'app en dev.
- **Publication image échoue** → l'upload d'asset peut demander un produit
  supplémentaire ; en attendant, laisse le **titre de visuel vide** → post texte
  seul (garanti de marcher). Tu filmes le texte, c'est suffisant pour la review.
- **Version d'API** → si LinkedIn te réclame un header `LinkedIn-Version`, le code
  utilise l'endpoint v2 classique (`/v2/ugcPosts`) qui ne l'exige pas ; sinon,
  bascule sur `/rest/posts` avec le header (petit ajustement dans `src/linkedin.mjs`).

## 8. Ce que la démo NE fait PAS (assumé)

- **Pas d'analytics** : lire l'engagement est sur un tier plus dur. La démo prouve
  la **publication avec consentement + approbation**. Le suivi métriques reste
  manuel (`log_post`) pour l'instant.
- **Pas d'auto-post planifié** : chaque publication = un clic humain. C'est
  volontaire (conformité LinkedIn + confiance client).

---

**Fichiers ajoutés** : `src/linkedin.mjs` (OAuth + publication), `src/demo.mjs`
(surface web), montés dans `src/server.mjs` sous `/demo`. Tests : `test/linkedin.test.mjs`,
`test/demo.test.mjs` (login, CSRF, session, URL OAuth). 47/47 verts.
