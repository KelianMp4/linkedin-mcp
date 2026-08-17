// Flow "connect LinkedIn" cote MCP (distinct de la demo web).
//
// Probleme : l'outil connect_linkedin() s'execute dans le contexte d'un client
// (son token lkm_), mais le callback OAuth LinkedIn arrive dans un simple onglet
// navigateur, sans session MCP. Il faut donc router le callback vers le bon client.
// Solution : on encode un state opaque a usage unique (prefixe mcpc_) qui mappe
// vers le token client, avec un TTL court, en memoire. Le callback lit ce state,
// retrouve le client, echange le code et stocke le token LinkedIn dans son dossier.
//
// On reutilise le MEME redirect_uri que la demo (/demo/linkedin/callback) pour ne
// pas avoir a enregistrer une 2e URL dans le portail LinkedIn : le serveur dispatche
// sur le prefixe du state (cf. server.mjs). Mono-process, en memoire (cf. decision 4).

import { randomBytes } from "node:crypto";
import { authorizeUrl, exchangeCode, getMember } from "./linkedin.mjs";
import { resolveToken, setLinkedin } from "./store.mjs";

const PREFIX = "mcpc_";
const TTL_MS = 10 * 60 * 1000; // 10 min pour autoriser, sinon le state expire.
const pending = new Map(); // state -> { token, exp }

function sweep() {
  const now = Date.now();
  for (const [k, v] of pending) if (v.exp < now) pending.delete(k);
}

// Demarre un flow : cree un state a usage unique lie au token client, renvoie l'URL
// d'autorisation LinkedIn a ouvrir dans un navigateur.
export function startLinkedinConnect(token) {
  sweep();
  const state = PREFIX + randomBytes(18).toString("base64url");
  pending.set(state, { token, exp: Date.now() + TTL_MS });
  return { url: authorizeUrl(state), state };
}

// Le callback appartient-il a un flow MCP en cours ? (sinon la demo le gere)
export function isConnectState(state) {
  sweep();
  return typeof state === "string" && state.startsWith(PREFIX) && pending.has(state);
}

// Termine le flow : valide le state (usage unique), echange le code, recupere
// l'identite du membre et stocke le token LinkedIn dans data/<token>/linkedin.json.
export async function completeLinkedinConnect({ code, state }) {
  sweep();
  const entry = pending.get(state);
  if (!entry) throw new Error("etat de connexion inconnu ou expire");
  pending.delete(state); // usage unique
  if (!code) throw new Error("code d'autorisation manquant");
  const ctx = await resolveToken(entry.token);
  if (!ctx) throw new Error("token client invalide"); // ex : donnees effacees entre-temps
  const tok = await exchangeCode(String(code));
  const member = await getMember(tok.access_token);
  await setLinkedin(ctx, {
    accessToken: tok.access_token,
    urn: member.urn,
    name: member.name,
    scope: tok.scope || null,
    connectedAt: new Date().toISOString(),
    expiresAt: tok.expires_in ? new Date(Date.now() + tok.expires_in * 1000).toISOString() : null,
  });
  return { client: ctx.client, name: member.name };
}

// Expose pour les tests (verifier l'expiration / le vidage).
export function _pendingSize() {
  return pending.size;
}
