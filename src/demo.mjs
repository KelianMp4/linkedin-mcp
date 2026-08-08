// Surface web de démo pour la review LinkedIn (Community Management API).
// Objectif : un reviewer se logge (compte de test), connecte SON LinkedIn,
// rédige un post, l'APPROUVE explicitement, et on le publie. Human-in-the-loop,
// rien d'automatique. Moche assumé — c'est une démo de review, pas le produit.
//
// Auth démo = simple porte (DEMO_USER/DEMO_PASS) distincte de l'auth MCP.
// Session en mémoire + cookie sid. CSRF sur les POST.

import { Router } from "express";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { render } from "./render.mjs";
import { DEFAULT_VISUAL } from "./store.mjs";
import { authorizeUrl, exchangeCode, getMember, publishText, publishImage, getSocialActions, isConfigured } from "./linkedin.mjs";

const sessions = new Map(); // sid -> { authed, csrf, linkedin:{accessToken,urn,name}|null, oauthState }
const rid = (p) => `${p}_${randomBytes(24).toString("base64url")}`;

function safeEqual(a, b) {
  const ba = Buffer.from(String(a || ""));
  const bb = Buffer.from(String(b || ""));
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i > -1) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function getSession(req, res) {
  const secure = (process.env.PUBLIC_URL || "").startsWith("https");
  let sid = parseCookies(req).demo_sid;
  if (!sid || !sessions.has(sid)) {
    sid = rid("sid");
    sessions.set(sid, { authed: false, csrf: rid("csrf"), linkedin: null, oauthState: null });
    res.setHeader("Set-Cookie", `demo_sid=${sid}; HttpOnly; Path=/; SameSite=Lax${secure ? "; Secure" : ""}`);
  }
  return sessions.get(sid);
}

function page(title, bodyHtml) {
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title>
<style>
  body{font-family:system-ui,sans-serif;background:#1A1A1A;color:#F2F2F2;margin:0;
    display:flex;justify-content:center;padding:40px 16px}
  .wrap{max-width:560px;width:100%}
  .card{background:#232323;border-radius:14px;padding:28px;margin-bottom:16px}
  h1{font-size:22px;margin:0 0 6px} h2{font-size:16px;margin:0 0 12px;opacity:.9}
  p{opacity:.8;font-size:14px;line-height:1.5} label{display:block;font-size:13px;margin:14px 0 6px;opacity:.85}
  input,textarea{width:100%;box-sizing:border-box;padding:11px;border-radius:8px;border:1px solid #444;
    background:#1A1A1A;color:#F2F2F2;font-size:15px;font-family:inherit}
  textarea{min-height:120px;resize:vertical}
  button{margin-top:16px;padding:11px 18px;border:0;border-radius:8px;background:#634670;color:#fff;
    font-size:15px;font-weight:600;cursor:pointer}
  a.btn{display:inline-block;margin-top:8px;padding:11px 18px;border-radius:8px;background:#0a66c2;
    color:#fff;text-decoration:none;font-weight:600}
  .ok{color:#7DBE8A} .warn{color:#D8A24A} .muted{opacity:.6;font-size:13px}
  .chk{display:flex;align-items:center;gap:8px;margin-top:12px} .chk input{width:auto}
</style></head><body><div class="wrap">${bodyHtml}</div></body></html>`;
}

export function demoRouter() {
  const r = Router();

  // Accueil : login ou redirection vers l'app.
  r.get("/demo", (req, res) => {
    const s = getSession(req, res);
    if (s.authed) return res.redirect("/demo/app");
    const configured = isConfigured();
    res.send(
      page(
        "Démo linkedin-mcp",
        `<div class="card">
          <h1>linkedin-mcp — démo</h1>
          <p>Espace de démonstration : connecte un compte LinkedIn, rédige un post on-brand, approuve-le, publie.</p>
          ${configured ? "" : '<p class="warn">⚠️ LinkedIn non configuré (LINKEDIN_CLIENT_ID/SECRET manquants). Le login marche, la publication échouera tant que ce n\'est pas posé.</p>'}
          <form method="post" action="/demo/login">
            <input type="hidden" name="csrf" value="${s.csrf}">
            <label>Identifiant</label><input name="user" autocomplete="username">
            <label>Mot de passe</label><input name="pass" type="password" autocomplete="current-password">
            <button type="submit">Se connecter</button>
          </form>
        </div>`
      )
    );
  });

  r.post("/demo/login", (req, res) => {
    const s = getSession(req, res);
    const { user, pass, csrf } = req.body || {};
    if (!safeEqual(csrf, s.csrf)) return res.status(403).send(page("Erreur", '<div class="card"><p class="warn">Jeton de sécurité invalide. <a href="/demo">Réessayer</a></p></div>'));
    const U = process.env.DEMO_USER, P = process.env.DEMO_PASS;
    if (!U || !P) return res.status(500).send(page("Config", '<div class="card"><p class="warn">DEMO_USER / DEMO_PASS non configurés côté serveur.</p></div>'));
    if (safeEqual(user, U) && safeEqual(pass, P)) {
      s.authed = true;
      return res.redirect("/demo/app");
    }
    res.status(401).send(page("Refusé", '<div class="card"><p class="warn">Identifiants invalides. <a href="/demo">Réessayer</a></p></div>'));
  });

  r.get("/demo/logout", (req, res) => {
    const s = getSession(req, res);
    s.authed = false;
    s.linkedin = null;
    res.redirect("/demo");
  });

  // Tableau de bord : statut LinkedIn + rédaction.
  r.get("/demo/app", (req, res) => {
    const s = getSession(req, res);
    if (!s.authed) return res.redirect("/demo");
    const li = s.linkedin;
    const connected = Boolean(li);
    res.send(
      page(
        "Démo — rédiger",
        `<div class="card">
          <h1>Espace de démonstration</h1>
          <p class="muted">Connecté (compte de test). <a href="/demo/logout" style="color:#8ab">Se déconnecter</a></p>
          <h2>1. Compte LinkedIn</h2>
          ${connected
            ? `<p class="ok">✔ Connecté : ${li.name || li.urn}</p>`
            : `<p>Pas encore connecté.</p><a class="btn" href="/demo/linkedin/start">Connecter LinkedIn</a>`}
        </div>
        <div class="card">
          <h2>2. Rédige, approuve, publie</h2>
          <p class="muted">Rien n'est publié sans ton clic « Approuver et publier ». Human-in-the-loop.</p>
          <form method="post" action="/demo/publish">
            <input type="hidden" name="csrf" value="${s.csrf}">
            <label>Texte du post LinkedIn</label>
            <textarea name="caption" placeholder="Ton post..."></textarea>
            <label>Titre du visuel on-brand (optionnel — génère une image)</label>
            <input name="visualTitle" placeholder="Laisse vide pour un post texte seul">
            <button type="submit" ${connected ? "" : "disabled"}>Approuver et publier${connected ? "" : " (connecte LinkedIn d'abord)"}</button>
          </form>
        </div>`
      )
    );
  });

  // Démarre l'OAuth LinkedIn.
  r.get("/demo/linkedin/start", (req, res) => {
    const s = getSession(req, res);
    if (!s.authed) return res.redirect("/demo");
    try {
      s.oauthState = rid("st");
      res.redirect(authorizeUrl(s.oauthState));
    } catch (e) {
      res.status(500).send(page("Erreur", `<div class="card"><p class="warn">${e.message}</p></div>`));
    }
  });

  // Callback OAuth : échange le code, récupère l'identité, stocke en session.
  r.get("/demo/linkedin/callback", async (req, res) => {
    const s = getSession(req, res);
    if (!s.authed) return res.redirect("/demo");
    const { code, state, error, error_description } = req.query;
    if (error) return res.status(400).send(page("LinkedIn", `<div class="card"><p class="warn">LinkedIn : ${error} — ${error_description || ""}</p></div>`));
    if (!code || !state || state !== s.oauthState) {
      return res.status(400).send(page("LinkedIn", '<div class="card"><p class="warn">État OAuth invalide. <a href="/demo/app">Retour</a></p></div>'));
    }
    try {
      const tok = await exchangeCode(String(code));
      const member = await getMember(tok.access_token);
      s.linkedin = { accessToken: tok.access_token, urn: member.urn, name: member.name };
      s.oauthState = null;
      res.redirect("/demo/app");
    } catch (e) {
      res.status(502).send(page("LinkedIn", `<div class="card"><p class="warn">Connexion LinkedIn échouée : ${e.message}</p><a href="/demo/app">Retour</a></div>`));
    }
  });

  // Publication — SEULEMENT après approbation humaine (ce POST = le clic).
  r.post("/demo/publish", async (req, res) => {
    const s = getSession(req, res);
    if (!s.authed) return res.redirect("/demo");
    if (!safeEqual((req.body || {}).csrf, s.csrf)) return res.status(403).send(page("Erreur", '<div class="card"><p class="warn">Jeton de sécurité invalide.</p></div>'));
    if (!s.linkedin) return res.status(400).send(page("LinkedIn", '<div class="card"><p class="warn">Connecte LinkedIn d\'abord. <a href="/demo/app">Retour</a></p></div>'));
    const caption = String((req.body || {}).caption || "").trim();
    const visualTitle = String((req.body || {}).visualTitle || "").trim();
    if (!caption) return res.status(400).send(page("Vide", '<div class="card"><p class="warn">Le texte du post est vide. <a href="/demo/app">Retour</a></p></div>'));
    try {
      let result;
      if (visualTitle) {
        const out = await render([{ titre: visualTitle, corps: caption }], DEFAULT_VISUAL, "png");
        const img = Buffer.from(out.base64, "base64");
        result = await publishImage(s.linkedin.accessToken, s.linkedin.urn, caption, img, "image/png");
      } else {
        result = await publishText(s.linkedin.accessToken, s.linkedin.urn, caption);
      }
      s.lastPost = { urn: result.id, url: result.url };
      res.send(
        page(
          "Publié",
          `<div class="card"><h1 class="ok">✔ Publié sur LinkedIn</h1>
            <p>Le post a été publié sur le profil connecté.</p>
            ${result.url ? `<a class="btn" href="${result.url}" target="_blank" rel="noopener">Voir le post</a>` : '<p class="muted">(Post créé — id retourné par LinkedIn.)</p>'}
          </div>
          <div class="card">
            <h2>3. Suivi de l'engagement (analytics)</h2>
            <p class="muted">Lecture des réactions/commentaires du post via l'API (capability « monitor engagement »).</p>
            <a class="btn" href="/demo/stats">Voir les statistiques du post</a>
            <p style="margin-top:16px"><a href="/demo/app" style="color:#8ab">Rédiger un autre post</a></p>
          </div>`
        )
      );
    } catch (e) {
      res.status(502).send(page("Échec", `<div class="card"><h1 class="warn">Publication échouée</h1><p>${e.message}</p><a href="/demo/app">Retour</a></div>`));
    }
  });

  // Stats du dernier post publié : tente de lire le vrai engagement. Si l'API
  // refuse (tier), affiche un état "en attente d'accès" — JAMAIS de faux chiffres.
  r.get("/demo/stats", async (req, res) => {
    const s = getSession(req, res);
    if (!s.authed) return res.redirect("/demo");
    if (!s.linkedin || !s.lastPost) {
      return res.send(page("Stats", '<div class="card"><p class="warn">Aucun post publié dans cette session. <a href="/demo/app">Rédiger</a></p></div>'));
    }
    const back = `<p style="margin-top:16px"><a href="/demo/app" style="color:#8ab">Retour</a>${s.lastPost.url ? ` · <a href="${s.lastPost.url}" target="_blank" rel="noopener" style="color:#8ab">Voir le post</a>` : ""}</p>`;
    try {
      const stats = await getSocialActions(s.linkedin.accessToken, s.lastPost.urn);
      res.send(
        page(
          "Stats",
          `<div class="card"><h1>Engagement du post</h1>
            <p class="ok">✔ Données live via l'API LinkedIn</p>
            <p style="font-size:22px"><b>${stats.likes}</b> réactions &nbsp;·&nbsp; <b>${stats.comments}</b> commentaires</p>
            <p class="muted">Rafraîchis dans quelques minutes pour voir l'engagement monter.</p>${back}
          </div>`
        )
      );
    } catch (e) {
      if (e.pending) {
        // Cas attendu en tier dev : l'accès analytics est justement ce qu'on demande.
        res.send(
          page(
            "Stats",
            `<div class="card"><h1>Engagement du post</h1>
              <p class="warn">⏳ Analytics en attente de l'accès API</p>
              <p>La lecture de l'engagement (réactions, commentaires, impressions) fait partie
              de la capability « monitor engagement » demandée dans la Community Management API.
              Une fois l'accès accordé, ces chiffres s'afficheront ici, pour le post ci-dessus.</p>
              <p class="muted">Aucun chiffre inventé : c'est bien l'emplacement où l'analytics se branchera.</p>${back}
            </div>`
          )
        );
      } else {
        res.status(502).send(page("Stats", `<div class="card"><p class="warn">Lecture stats échouée : ${e.message}</p>${back}</div>`));
      }
    }
  });

  return r;
}
