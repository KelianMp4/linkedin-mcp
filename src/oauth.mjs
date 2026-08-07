// OAuth 2.1 pour MCP (revue : brique auth Claude Desktop/web/Team).
//
// Approche A : PONT sur le token lkm_ existant. Au /authorize, une page demande
// au client de coller son token lkm_ (celui envoye par mail). Valide -> code a
// usage unique -> access_token OAuth mappe sur le MEME dossier client. On garde
// le modele 1 token/client ; OAuth n'est qu'une enveloppe pour les clients qui
// exigent le flow (Desktop/web), pendant que Claude Code garde le Bearer direct.
//
// Le SDK (@modelcontextprotocol/sdk) fournit les handlers du protocole
// (discovery, register/DCR, token, revoke) ET valide le PKCE lui-meme.
//
// Durcissement (audit CSO) :
//   F1 : la page de consentement AFFICHE le domaine demandeur (anti-phishing de
//        consentement via client DCR malveillant).
//   F2 : /authorize cree une SESSION serveur (params valides, usage unique, TTL)
//        + jeton CSRF ; la page ne porte qu'un id opaque ; le consent RELIT les
//        params stockes (jamais confiance au formulaire).
//   F3 : fichiers tokens/clients en 0600, dossier oauth en 0700.
//   F4 : access token borne a la resource du serveur (RFC 8707).
//   Isolation par client, codes usage-unique + expiry, redirect_uri validee.

import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

const CODE_TTL_MS = 60 * 1000; // 60s : round-trip navigateur -> /token.
const SESSION_TTL_MS = 10 * 60 * 1000; // 10min : le temps que l'humain colle son token.
const ACCESS_TTL_S = 3600; // 1h
const REFRESH_TTL_S = 30 * 24 * 3600; // 30j

const rid = (prefix) => `${prefix}_${randomBytes(32).toString("base64url")}`;
const nowS = () => Math.floor(Date.now() / 1000);

// Comparaison constante des jetons CSRF (evite le timing side-channel).
function safeEqual(a, b) {
  const ba = Buffer.from(String(a || ""));
  const bb = Buffer.from(String(b || ""));
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

async function readJson(path, fallback) {
  const raw = await readFile(path, "utf8").catch(() => null);
  if (raw == null) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function esc(s = "") {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function hostOf(uri) {
  try {
    return new URL(uri).host;
  } catch {
    return "(inconnu)";
  }
}

// Page de consentement : ne porte QU'un id de session opaque + un jeton CSRF, et
// AFFICHE le domaine qui demande l'acces (F1). Aucun parametre OAuth reinjecte.
function consentPage({ sessionId, csrf, redirectHost, error }) {
  const hidden = (n, v) => `<input type="hidden" name="${n}" value="${esc(v)}">`;
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Connexion linkedin-mcp</title>
<style>
  body{font-family:system-ui,sans-serif;background:#1A1A1A;color:#F2F2F2;display:flex;
    min-height:100vh;align-items:center;justify-content:center;margin:0}
  .card{max-width:440px;width:100%;padding:32px;background:#232323;border-radius:14px}
  h1{font-size:20px;margin:0 0 8px} p{opacity:.8;font-size:14px;line-height:1.5;margin:0 0 16px}
  .who{background:#1A1A1A;border:1px solid #444;border-radius:8px;padding:12px 14px;margin:0 0 20px;font-size:14px}
  .who b{color:#D8A24A}
  label{display:block;font-size:13px;margin-bottom:6px;opacity:.8}
  input[type=password]{width:100%;padding:12px;border-radius:8px;border:1px solid #444;
    background:#1A1A1A;color:#F2F2F2;font-size:15px;box-sizing:border-box}
  button{width:100%;margin-top:16px;padding:12px;border:0;border-radius:8px;background:#634670;
    color:#fff;font-size:15px;font-weight:600;cursor:pointer}
  .err{color:#E5736F;font-size:13px;margin-top:10px}
</style></head><body>
  <form class="card" method="post" action="/authorize/consent">
    <h1>Connecter linkedin-mcp</h1>
    <div class="who">Cette demande d'acces provient de : <b>${esc(redirectHost)}</b>.<br>
      Ne connecte que si tu reconnais cette destination.</div>
    <p>Colle ton token d'acces (recu par mail, format <code>lkm_...</code>).</p>
    <label for="tok">Token d'acces</label>
    <input id="tok" type="password" name="lkm_token" autocomplete="off" autofocus placeholder="lkm_...">
    ${error ? `<div class="err">${esc(error)}</div>` : ""}
    ${hidden("sid", sessionId)}
    ${hidden("csrf", csrf)}
    <button type="submit">Connecter</button>
  </form>
</body></html>`;
}

// deps: { dataDir, resolveToken, publicUrl }
export function createOAuth({ dataDir, resolveToken, publicUrl }) {
  const oauthDir = join(dataDir, "oauth");
  const clientsPath = join(oauthDir, "clients.json");
  const tokensPath = join(oauthDir, "tokens.json");
  const RESOURCE = publicUrl ? new URL(publicUrl).href.replace(/\/$/, "") : undefined;

  let clients = {}; // client_id -> OAuthClientInformationFull
  let tokens = { access: {}, refresh: {} }; // token -> { lkmToken, clientId, exp }
  const codes = new Map(); // code -> { clientId, codeChallenge, redirectUri, lkmToken, resource, exp }
  const sessions = new Map(); // sid -> { clientId, redirectUri, codeChallenge, state, resource, scope, csrf, redirectHost, exp }

  async function ensureDir() {
    await mkdir(oauthDir, { recursive: true, mode: 0o700 });
  }
  async function persistClients() {
    await ensureDir();
    await writeFile(clientsPath, JSON.stringify(clients, null, 2), { encoding: "utf8", mode: 0o600 });
  }
  async function persistTokens() {
    await ensureDir();
    await writeFile(tokensPath, JSON.stringify(tokens, null, 2), { encoding: "utf8", mode: 0o600 });
  }
  async function hydrate() {
    clients = await readJson(clientsPath, {});
    tokens = await readJson(tokensPath, { access: {}, refresh: {} });
    tokens.access ||= {};
    tokens.refresh ||= {};
  }

  const clientsStore = {
    async getClient(clientId) {
      return clients[clientId];
    },
    async registerClient(client) {
      const full = { ...client, client_id: rid("client"), client_id_issued_at: nowS() };
      clients[full.client_id] = full;
      await persistClients();
      return full;
    },
  };

  // Consent (F2) : relit la session serveur, verifie CSRF, valide le lkm_, emet
  // le code depuis les params STOCKES (jamais ceux du formulaire).
  // Retourne { redirectUri, code, state } | { error, sessionId, csrf, redirectHost }.
  async function grantCodeFromSession({ sessionId, csrf, lkmToken }) {
    const s = sessions.get(sessionId);
    if (!s || Date.now() > s.exp) {
      if (s) sessions.delete(sessionId);
      return { error: "session expiree, relance la connexion depuis Claude." };
    }
    const reRender = { sessionId, csrf: s.csrf, redirectHost: s.redirectHost };
    if (!safeEqual(csrf, s.csrf)) return { error: "jeton de securite invalide.", ...reRender };

    const ctx = await resolveToken(String(lkmToken || "").trim());
    if (!ctx) return { error: "token invalide. Verifie le lkm_ recu par mail.", ...reRender };

    const code = rid("code");
    codes.set(code, {
      clientId: s.clientId,
      codeChallenge: s.codeChallenge,
      redirectUri: s.redirectUri,
      lkmToken: String(lkmToken).trim(),
      resource: s.resource,
      exp: Date.now() + CODE_TTL_MS,
    });
    sessions.delete(sessionId); // session usage unique
    return { redirectUri: s.redirectUri, code, state: s.state };
  }

  const provider = {
    get clientsStore() {
      return clientsStore;
    },

    // F2 : cree la session serveur avec les params VALIDES par le SDK, rend la page.
    async authorize(client, params, res) {
      const sid = rid("sess");
      const csrf = rid("csrf");
      sessions.set(sid, {
        clientId: client.client_id,
        redirectUri: params.redirectUri,
        codeChallenge: params.codeChallenge,
        state: params.state,
        resource: params.resource ? String(params.resource) : undefined,
        scope: (params.scopes || []).join(" ") || undefined,
        csrf,
        redirectHost: hostOf(params.redirectUri),
        exp: Date.now() + SESSION_TTL_MS,
      });
      res
        .status(200)
        .set("content-type", "text/html; charset=utf-8")
        .send(consentPage({ sessionId: sid, csrf, redirectHost: hostOf(params.redirectUri) }));
    },

    async challengeForAuthorizationCode(client, authorizationCode) {
      const rec = codes.get(authorizationCode);
      if (!rec || rec.clientId !== client.client_id) throw new Error("code invalide");
      if (Date.now() > rec.exp) {
        codes.delete(authorizationCode);
        throw new Error("code expire");
      }
      return rec.codeChallenge;
    },

    async exchangeAuthorizationCode(client, authorizationCode, _verifier, redirectUri) {
      const rec = codes.get(authorizationCode);
      if (!rec || rec.clientId !== client.client_id) throw new Error("code invalide");
      codes.delete(authorizationCode); // USAGE UNIQUE
      if (Date.now() > rec.exp) throw new Error("code expire");
      if (redirectUri && redirectUri !== rec.redirectUri) throw new Error("redirect_uri incoherente");
      return issueTokens(rec.lkmToken, client.client_id);
    },

    async exchangeRefreshToken(client, refreshToken) {
      const rec = tokens.refresh[refreshToken];
      if (!rec) throw new Error("refresh token invalide");
      if (rec.exp && nowS() > rec.exp) {
        delete tokens.refresh[refreshToken];
        await persistTokens();
        throw new Error("refresh token expire");
      }
      return issueTokens(rec.lkmToken, rec.clientId, { keepRefresh: refreshToken });
    },

    async verifyAccessToken(token) {
      const rec = tokens.access[token];
      if (!rec) throw new Error("access token invalide");
      if (rec.exp && nowS() > rec.exp) {
        delete tokens.access[token];
        await persistTokens();
        throw new Error("access token expire");
      }
      return {
        token,
        clientId: rec.clientId,
        scopes: [],
        expiresAt: rec.exp,
        resource: RESOURCE ? new URL(RESOURCE) : undefined, // F4 : audience = ce serveur
        extra: { lkmToken: rec.lkmToken },
      };
    },

    async revokeToken(client, request) {
      const t = request.token;
      if (tokens.access[t]) delete tokens.access[t];
      if (tokens.refresh[t]) delete tokens.refresh[t];
      await persistTokens();
    },
  };

  async function issueTokens(lkmToken, clientId, { keepRefresh } = {}) {
    const access_token = rid("at");
    tokens.access[access_token] = { lkmToken, clientId, exp: nowS() + ACCESS_TTL_S };
    let refresh_token = keepRefresh;
    if (!refresh_token) {
      refresh_token = rid("rt");
      tokens.refresh[refresh_token] = { lkmToken, clientId, exp: nowS() + REFRESH_TTL_S };
    }
    await persistTokens();
    return { access_token, token_type: "bearer", expires_in: ACCESS_TTL_S, refresh_token };
  }

  // Resout un Bearer arbitraire vers un ctx client : lkm_ brut (Claude Code)
  // sinon access token OAuth (Desktop/web). Null si aucun.
  async function resolveBearer(bearer) {
    if (!bearer) return null;
    const direct = await resolveToken(bearer);
    if (direct) return direct;
    const rec = tokens.access[bearer];
    if (!rec) return null;
    if (rec.exp && nowS() > rec.exp) {
      delete tokens.access[bearer];
      await persistTokens();
      return null;
    }
    return resolveToken(rec.lkmToken);
  }

  return { provider, hydrate, grantCodeFromSession, resolveBearer, consentPage };
}
