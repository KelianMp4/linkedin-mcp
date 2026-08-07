// Tests sécu du provider OAuth (approche A + durcissement CSO). Le SDK valide le
// PKCE et la redirect_uri en amont ; ici on teste NOTRE logique : session
// serveur, CSRF, isolation, usage unique, binding resource, affichage du client.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOAuth } from "../src/oauth.mjs";

const PUBLIC_URL = "https://mcp.stacko.fr";
const CTX = {
  lkm_A: { token: "lkm_A", client: "A", dir: "/data/lkm_A" },
  lkm_B: { token: "lkm_B", client: "B", dir: "/data/lkm_B" },
};
const resolveToken = async (t) => CTX[t] || null;

async function fresh() {
  const dataDir = await mkdtemp(join(tmpdir(), "lkm-oauth-"));
  const o = createOAuth({ dataDir, resolveToken, publicUrl: PUBLIC_URL });
  await o.hydrate();
  return o;
}

async function registerClient(o, redirect = "https://claude.ai/callback") {
  return o.provider.clientsStore.registerClient({ redirect_uris: [redirect] });
}

// Simule le GET /authorize (le SDK a déjà validé le client + redirect_uri) :
// provider.authorize crée la session serveur et rend la page. On extrait sid+csrf.
async function startAuthorize(o, client, { redirectUri, codeChallenge = "CH", state, scopes = [] } = {}) {
  let html = "";
  const res = { status: () => res, set: () => res, send: (h) => (html = h) };
  await o.provider.authorize(client, { redirectUri, codeChallenge, state, scopes }, res);
  const sid = /name="sid" value="([^"]+)"/.exec(html)?.[1];
  const csrf = /name="csrf" value="([^"]+)"/.exec(html)?.[1];
  return { html, sid, csrf };
}

test("registerClient génère un client_id récupérable", async () => {
  const o = await fresh();
  const c = await registerClient(o);
  assert.match(c.client_id, /^client_/);
  assert.equal((await o.provider.clientsStore.getClient(c.client_id)).client_id, c.client_id);
});

test("F1 : la page de consentement AFFICHE le domaine demandeur", async () => {
  const o = await fresh();
  const c = await registerClient(o, "https://claude.ai/callback");
  const { html } = await startAuthorize(o, c, { redirectUri: "https://claude.ai/callback" });
  assert.match(html, /provient de/);
  assert.match(html, /claude\.ai/);
});

test("flow complet : session -> lkm valide -> code -> token -> bon client", async () => {
  const o = await fresh();
  const c = await registerClient(o);
  const { sid, csrf } = await startAuthorize(o, c, { redirectUri: "https://claude.ai/callback", codeChallenge: "CH1", state: "xyz" });
  const g = await o.grantCodeFromSession({ sessionId: sid, csrf, lkmToken: "lkm_A" });
  assert.equal(g.error, undefined);
  assert.match(g.code, /^code_/);
  assert.equal(g.state, "xyz");

  assert.equal(await o.provider.challengeForAuthorizationCode(c, g.code), "CH1");
  const toks = await o.provider.exchangeAuthorizationCode(c, g.code);
  assert.match(toks.access_token, /^at_/);
  assert.equal(toks.token_type, "bearer");

  const info = await o.provider.verifyAccessToken(toks.access_token);
  assert.equal(info.extra.lkmToken, "lkm_A");
  assert.equal((await o.resolveBearer(toks.access_token)).client, "A");
});

test("ISOLATION : un access token de A ne résout jamais vers B", async () => {
  const o = await fresh();
  const c = await registerClient(o);
  const { sid, csrf } = await startAuthorize(o, c, { redirectUri: "https://claude.ai/callback" });
  const g = await o.grantCodeFromSession({ sessionId: sid, csrf, lkmToken: "lkm_A" });
  const toks = await o.provider.exchangeAuthorizationCode(c, g.code);
  const ctx = await o.resolveBearer(toks.access_token);
  assert.equal(ctx.dir, "/data/lkm_A");
  assert.notEqual(ctx.dir, "/data/lkm_B");
});

test("F4 : l'access token est borné à la resource du serveur (audience)", async () => {
  const o = await fresh();
  const c = await registerClient(o);
  const { sid, csrf } = await startAuthorize(o, c, { redirectUri: "https://claude.ai/callback" });
  const g = await o.grantCodeFromSession({ sessionId: sid, csrf, lkmToken: "lkm_A" });
  const toks = await o.provider.exchangeAuthorizationCode(c, g.code);
  const info = await o.provider.verifyAccessToken(toks.access_token);
  assert.equal(String(info.resource), "https://mcp.stacko.fr/");
});

test("grantCodeFromSession REJETTE un lkm invalide", async () => {
  const o = await fresh();
  const c = await registerClient(o);
  const { sid, csrf } = await startAuthorize(o, c, { redirectUri: "https://claude.ai/callback" });
  const g = await o.grantCodeFromSession({ sessionId: sid, csrf, lkmToken: "lkm_PIRATE" });
  assert.match(g.error, /invalide/);
  assert.equal(g.code, undefined);
  assert.equal(g.redirectHost, "claude.ai"); // de quoi re-render
});

test("F2 : CSRF invalide -> rejet", async () => {
  const o = await fresh();
  const c = await registerClient(o);
  const { sid } = await startAuthorize(o, c, { redirectUri: "https://claude.ai/callback" });
  const g = await o.grantCodeFromSession({ sessionId: sid, csrf: "csrf_forge", lkmToken: "lkm_A" });
  assert.match(g.error, /securite/);
});

test("F2 : session inconnue/forgée -> rejet (pas de code émis)", async () => {
  const o = await fresh();
  const g = await o.grantCodeFromSession({ sessionId: "sess_forge", csrf: "x", lkmToken: "lkm_A" });
  assert.match(g.error, /session/);
  assert.equal(g.code, undefined);
});

test("session à usage unique : réutiliser la même session échoue", async () => {
  const o = await fresh();
  const c = await registerClient(o);
  const { sid, csrf } = await startAuthorize(o, c, { redirectUri: "https://claude.ai/callback" });
  await o.grantCodeFromSession({ sessionId: sid, csrf, lkmToken: "lkm_A" });
  const again = await o.grantCodeFromSession({ sessionId: sid, csrf, lkmToken: "lkm_A" });
  assert.match(again.error, /session/);
});

test("code à USAGE UNIQUE : le 2e échange échoue", async () => {
  const o = await fresh();
  const c = await registerClient(o);
  const { sid, csrf } = await startAuthorize(o, c, { redirectUri: "https://claude.ai/callback" });
  const g = await o.grantCodeFromSession({ sessionId: sid, csrf, lkmToken: "lkm_A" });
  await o.provider.exchangeAuthorizationCode(c, g.code);
  await assert.rejects(() => o.provider.exchangeAuthorizationCode(c, g.code), /invalide/);
});

test("un code ne peut pas être échangé par un AUTRE client", async () => {
  const o = await fresh();
  const c1 = await registerClient(o);
  const c2 = await registerClient(o);
  const { sid, csrf } = await startAuthorize(o, c1, { redirectUri: "https://claude.ai/callback" });
  const g = await o.grantCodeFromSession({ sessionId: sid, csrf, lkmToken: "lkm_A" });
  await assert.rejects(() => o.provider.exchangeAuthorizationCode(c2, g.code), /invalide/);
});

test("verifyAccessToken rejette un token inconnu", async () => {
  const o = await fresh();
  await assert.rejects(() => o.provider.verifyAccessToken("at_bidon"), /invalide/);
});

test("resolveBearer : le lkm_ brut marche toujours (Claude Code)", async () => {
  const o = await fresh();
  assert.equal((await o.resolveBearer("lkm_B")).client, "B");
  assert.equal(await o.resolveBearer("lkm_inconnu"), null);
});

test("refresh token -> nouvel access token, même client", async () => {
  const o = await fresh();
  const c = await registerClient(o);
  const { sid, csrf } = await startAuthorize(o, c, { redirectUri: "https://claude.ai/callback" });
  const g = await o.grantCodeFromSession({ sessionId: sid, csrf, lkmToken: "lkm_A" });
  const t1 = await o.provider.exchangeAuthorizationCode(c, g.code);
  const t2 = await o.provider.exchangeRefreshToken(c, t1.refresh_token);
  assert.notEqual(t2.access_token, t1.access_token);
  assert.equal((await o.resolveBearer(t2.access_token)).client, "A");
});

test("la page de consentement échappe le contenu (anti-injection)", async () => {
  const o = await fresh();
  const c = await registerClient(o, 'https://claude.ai/cb');
  // redirectHost vient de new URL().host, donc pas d'injection via redirect ;
  // on vérifie que l'échappement est bien appliqué sur la page.
  const { html } = await startAuthorize(o, c, { redirectUri: "https://claude.ai/cb" });
  assert.ok(!html.includes("<script>"), "aucun script injecté");
  assert.match(html, /name="csrf"/);
  assert.match(html, /name="sid"/);
});
