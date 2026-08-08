// Intégration LinkedIn (démo review Community Management API).
//
// Flow 3-legged : le membre autorise via LinkedIn OAuth, on récupère un access
// token, on publie SUR SON PROPRE profil (w_member_social) — uniquement après
// son approbation explicite côté UI (human-in-the-loop). openid/profile sert à
// identifier le membre (son URN person).
//
// IMPORTANT : ces appels ne sont PAS testables sans credentials LinkedIn. La
// structure suit l'API v2 classique (ugcPosts + assets). Au premier vrai test,
// vérifier scopes + version d'API dans le portail LinkedIn (cf. README-DEMO.md).

const AUTH_URL = "https://www.linkedin.com/oauth/v2/authorization";
const TOKEN_URL = "https://www.linkedin.com/oauth/v2/accessToken";
const USERINFO_URL = "https://api.linkedin.com/v2/userinfo";
const UGC_URL = "https://api.linkedin.com/v2/ugcPosts";
const ASSETS_URL = "https://api.linkedin.com/v2/assets?action=registerUpload";

// Scopes : identifier le membre (openid/profile) + publier sur son profil.
const DEFAULT_SCOPES = "openid profile w_member_social";

export function linkedinConfig() {
  const clientId = process.env.LINKEDIN_CLIENT_ID;
  const clientSecret = process.env.LINKEDIN_CLIENT_SECRET;
  // Redirect par défaut dérivé de PUBLIC_URL (doit matcher le portail LinkedIn).
  const base = (process.env.PUBLIC_URL || "http://localhost:3000").replace(/\/$/, "");
  const redirectUri = process.env.LINKEDIN_REDIRECT_URI || `${base}/demo/linkedin/callback`;
  const scopes = process.env.LINKEDIN_SCOPES || DEFAULT_SCOPES;
  return { clientId, clientSecret, redirectUri, scopes };
}

export function isConfigured() {
  const c = linkedinConfig();
  return Boolean(c.clientId && c.clientSecret);
}

// URL vers laquelle rediriger le membre pour qu'il autorise l'app.
export function authorizeUrl(state) {
  const c = linkedinConfig();
  if (!isConfigured()) throw new Error("LinkedIn non configuré (LINKEDIN_CLIENT_ID/SECRET absents)");
  const u = new URL(AUTH_URL);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", c.clientId);
  u.searchParams.set("redirect_uri", c.redirectUri);
  u.searchParams.set("scope", c.scopes);
  u.searchParams.set("state", state);
  return u.toString();
}

// Échange le code d'autorisation contre un access token.
export async function exchangeCode(code) {
  const c = linkedinConfig();
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: c.redirectUri,
    client_id: c.clientId,
    client_secret: c.clientSecret,
  });
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) throw new Error(`LinkedIn token échec (${res.status}): ${(await res.text()).slice(0, 300)}`);
  return res.json(); // { access_token, expires_in, scope, id_token? }
}

// Récupère l'identité du membre (OpenID userinfo) -> sub = base de l'URN person.
export async function getMember(accessToken) {
  const res = await fetch(USERINFO_URL, { headers: { authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new Error(`LinkedIn userinfo échec (${res.status}): ${(await res.text()).slice(0, 300)}`);
  const info = await res.json(); // { sub, name, email?, picture? }
  return { sub: info.sub, name: info.name, urn: `urn:li:person:${info.sub}` };
}

const UGC_HEADERS = (token) => ({
  authorization: `Bearer ${token}`,
  "content-type": "application/json",
  "x-restli-protocol-version": "2.0.0",
});

// Publie un post TEXTE sur le profil du membre.
export async function publishText(accessToken, authorUrn, text) {
  const payload = {
    author: authorUrn,
    lifecycleState: "PUBLISHED",
    specificContent: {
      "com.linkedin.ugc.ShareContent": {
        shareCommentary: { text },
        shareMediaCategory: "NONE",
      },
    },
    visibility: { "com.linkedin.ugc.MemberNetworkVisibility": "PUBLIC" },
  };
  const res = await fetch(UGC_URL, { method: "POST", headers: UGC_HEADERS(accessToken), body: JSON.stringify(payload) });
  if (!res.ok) throw new Error(`LinkedIn publish texte échec (${res.status}): ${(await res.text()).slice(0, 300)}`);
  const id = res.headers.get("x-restli-id") || (await res.json())?.id;
  return { id, url: postUrl(id) };
}

// Publie un post IMAGE : registerUpload -> PUT bytes -> ugcPost avec l'asset.
export async function publishImage(accessToken, authorUrn, text, imageBuffer, mime = "image/png") {
  // 1. Enregistre l'upload.
  const reg = await fetch(ASSETS_URL, {
    method: "POST",
    headers: UGC_HEADERS(accessToken),
    body: JSON.stringify({
      registerUploadRequest: {
        recipes: ["urn:li:digitalmediaRecipe:feedshare-image"],
        owner: authorUrn,
        serviceRelationships: [{ relationshipType: "OWNER", identifier: "urn:li:userGeneratedContent" }],
      },
    }),
  });
  if (!reg.ok) throw new Error(`LinkedIn registerUpload échec (${reg.status}): ${(await reg.text()).slice(0, 300)}`);
  const regJson = await reg.json();
  const asset = regJson.value.asset;
  const uploadUrl =
    regJson.value.uploadMechanism["com.linkedin.digitalmedia.uploading.MediaUploadHttpRequest"].uploadUrl;

  // 2. Upload des bytes de l'image.
  const put = await fetch(uploadUrl, {
    method: "PUT",
    headers: { authorization: `Bearer ${accessToken}`, "content-type": mime },
    body: imageBuffer,
  });
  if (!put.ok) throw new Error(`LinkedIn upload image échec (${put.status})`);

  // 3. Crée le post référençant l'asset.
  const payload = {
    author: authorUrn,
    lifecycleState: "PUBLISHED",
    specificContent: {
      "com.linkedin.ugc.ShareContent": {
        shareCommentary: { text },
        shareMediaCategory: "IMAGE",
        media: [{ status: "READY", media: asset, title: { text: "Visuel on-brand" } }],
      },
    },
    visibility: { "com.linkedin.ugc.MemberNetworkVisibility": "PUBLIC" },
  };
  const res = await fetch(UGC_URL, { method: "POST", headers: UGC_HEADERS(accessToken), body: JSON.stringify(payload) });
  if (!res.ok) throw new Error(`LinkedIn publish image échec (${res.status}): ${(await res.text()).slice(0, 300)}`);
  const id = res.headers.get("x-restli-id") || (await res.json())?.id;
  return { id, url: postUrl(id) };
}

function postUrl(id) {
  return id ? `https://www.linkedin.com/feed/update/${id}/` : null;
}

// Lit l'engagement (réactions + commentaires) d'un post que le membre a publié.
// Endpoint socialActions v2. En tier développement, peut renvoyer 403 (l'accès
// analytics fait partie de ce qu'on demande) -> on remonte une erreur typée que
// l'UI transforme en "en attente d'accès API", jamais en faux chiffres.
export async function getSocialActions(accessToken, shareUrn) {
  if (!shareUrn) throw new Error("URN du post manquant");
  const res = await fetch(`https://api.linkedin.com/v2/socialActions/${encodeURIComponent(shareUrn)}`, {
    headers: { authorization: `Bearer ${accessToken}`, "x-restli-protocol-version": "2.0.0" },
  });
  if (res.status === 403 || res.status === 401) {
    const err = new Error("accès analytics non accordé (tier)");
    err.pending = true; // <- l'UI affiche "en attente d'accès API"
    throw err;
  }
  if (!res.ok) throw new Error(`LinkedIn stats échec (${res.status}): ${(await res.text()).slice(0, 200)}`);
  const j = await res.json();
  // Champs défensifs (LinkedIn varie selon les versions).
  const likes = j?.likesSummary?.totalLikes ?? j?.likesSummary?.aggregatedTotalLikes ?? 0;
  const comments = j?.commentsSummary?.count ?? j?.commentsSummary?.aggregatedTotalComments ?? 0;
  return { likes, comments };
}
