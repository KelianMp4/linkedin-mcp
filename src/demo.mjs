// Surface web de démo pour la review LinkedIn (Community Management API).
// Objectif : un reviewer se logge (compte de test), connecte SON LinkedIn,
// rédige un post, l'APPROUVE explicitement, et on le publie. Human-in-the-loop,
// rien d'automatique. Moche assumé — c'est une démo de review, pas le produit.
//
// Auth démo = simple porte (DEMO_USER/DEMO_PASS) distincte de l'auth MCP.
// Session en mémoire + cookie sid. CSRF sur les POST.

import { Router } from "express";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { render } from "./render.mjs";
import { DEFAULT_VISUAL, DATA_DIR, appendPost, listPosts } from "./store.mjs";
import { authorizeUrl, exchangeCode, getMember, publishText, publishImage, getSocialActions, isConfigured } from "./linkedin.mjs";

const sessions = new Map(); // sid -> { authed, csrf, linkedin:{accessToken,urn,name}|null, oauthState }
const rid = (p) => `${p}_${randomBytes(24).toString("base64url")}`;

// Echappe le HTML (texte de post, nom LinkedIn) avant injection dans la page.
const esc = (v) =>
  String(v ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

// Historique des posts publiés via la démo : persisté dans data/_demo/ (volume
// Docker persistant), en réutilisant le store par-dossier. Isolé du store client
// (chaque client = data/<token>/) : la démo n'a pas de token, elle a son dossier.
const DEMO_DIR = join(DATA_DIR, "_demo");
async function demoCtx() {
  await mkdir(DEMO_DIR, { recursive: true, mode: 0o700 });
  return { client: "demo", dir: DEMO_DIR };
}
async function appendDemoPost(entry) {
  return appendPost(await demoCtx(), entry);
}
async function listDemoPosts() {
  try {
    return await listPosts(await demoCtx());
  } catch {
    return [];
  }
}
async function clearDemoPosts() {
  await rm(join(DEMO_DIR, "history.json"), { force: true });
}

// Exemples ÉTIQUETÉS pour montrer à quoi ressemble le suivi une fois rempli.
// JAMAIS présentés comme de la donnée API : badge « exemple », engagement marqué
// illustratif. On ne trompe pas le reviewer — on illustre la structure du suivi.
const DEMO_SAMPLE_POSTS = [
  { date: "2026-08-04", text: "3 signaux qui montrent qu'un DSI externe vous ferait gagner 6 mois de roadmap.", reactions: 42, comments: 7 },
  { date: "2026-08-01", text: "On a migré un client vers un stack self-hosté en 2 semaines. Le vrai coût caché n'était pas la techno.", reactions: 28, comments: 4 },
  { date: "2026-07-28", text: "La question qu'aucun prestataire IT ne veut que vous posiez avant de signer.", reactions: 63, comments: 12 },
];

const trunc = (t, n = 64) => (t.length > n ? t.slice(0, n) + "…" : t);

// Tableau « suivi des publications » : vrais posts publiés via la démo (engagement
// lu en direct via l'API, lien par ligne) + exemples étiquetés (illustratifs).
function publicationsTable(realPosts) {
  const realRows = realPosts
    .slice()
    .reverse()
    .map(
      (p) => `<tr>
        <td class="muted">${esc((p.date || "").slice(0, 10))}</td>
        <td>${esc(trunc(p.text || ""))}</td>
        <td><span class="tag tag-live">publié</span></td>
        <td>${p.urn ? `<a href="/demo/stats?urn=${encodeURIComponent(p.urn)}" style="color:#8ab">voir l'engagement</a>` : '<span class="muted">—</span>'}</td>
      </tr>`
    )
    .join("");
  const sampleRows = DEMO_SAMPLE_POSTS.map(
    (p) => `<tr>
      <td class="muted">${esc(p.date)}</td>
      <td>${esc(trunc(p.text))}</td>
      <td><span class="tag tag-ex">exemple</span></td>
      <td class="muted">${p.reactions} · ${p.comments} <span class="muted">(illustratif)</span></td>
    </tr>`
  ).join("");
  return `<table class="pub">
      <thead><tr><th>Date</th><th>Post</th><th>Type</th><th>Engagement</th></tr></thead>
      <tbody>${realRows}${sampleRows}</tbody>
    </table>
    <p class="muted" style="margin-top:10px">Lignes <b>publié</b> : vrais posts de cette démo, engagement lu
    en direct via l'API LinkedIn. Lignes <b>exemple</b> : illustration du suivi — chiffres NON issus de l'API.</p>`;
}

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
  .wrap{max-width:680px;width:100%}
  .card{background:#232323;border-radius:14px;padding:28px;margin-bottom:16px}
  table.pub{width:100%;border-collapse:collapse;font-size:13px;margin-top:6px}
  table.pub th,table.pub td{text-align:left;padding:8px 10px;border-bottom:1px solid #333;vertical-align:top}
  table.pub th{opacity:.55;font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:.03em}
  .tag{display:inline-block;padding:2px 9px;border-radius:999px;font-size:11px;font-weight:700}
  .tag-ex{background:#3a3320;color:#D8A24A} .tag-live{background:#1f3a28;color:#7DBE8A}
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

  // Tableau de bord : statut LinkedIn + rédaction + suivi des publications.
  r.get("/demo/app", async (req, res) => {
    const s = getSession(req, res);
    if (!s.authed) return res.redirect("/demo");
    const li = s.linkedin;
    const connected = Boolean(li);
    const realPosts = await listDemoPosts();
    res.send(
      page(
        "Démo — tableau de bord",
        `<div class="card">
          <h1>Espace de démonstration</h1>
          <p class="muted">Connecté (compte de test). <a href="/demo/logout" style="color:#8ab">Se déconnecter</a></p>
          <h2>1. Compte LinkedIn</h2>
          ${connected
            ? `<p class="ok">✔ Connecté : ${esc(li.name || li.urn)}</p>`
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
        </div>
        <div class="card">
          <h2>3. Publications &amp; suivi de l'engagement</h2>
          <p class="muted">Historique des posts publiés via la démo et leur engagement (réactions,
          commentaires, impressions), lu via l'API — capability « monitor engagement » de la
          Community Management API. Clique une ligne « publié » pour voir l'engagement en direct.</p>
          ${publicationsTable(realPosts)}
        </div>
        <div class="card">
          <h2>Confidentialité — droit à l'effacement (RGPD art. 17)</h2>
          <p class="muted">Cette démo conserve ta connexion LinkedIn (en mémoire de session) et
          l'historique des posts que tu publies (côté serveur). Aucune donnée n'est vendue ni
          partagée. Le bouton ci-dessous efface les deux immédiatement et définitivement.</p>
          <form method="post" action="/demo/delete">
            <input type="hidden" name="csrf" value="${s.csrf}">
            <button type="submit" style="background:#7a2b2b">Supprimer mes données</button>
          </form>
        </div>`
      )
    );
  });

  // Droit a l'effacement (RGPD art. 17) cote demo : purge la connexion LinkedIn
  // de la session (jeton d'acces, urn, nom) ET l'historique des posts persiste
  // sur disque (data/_demo/history.json). Les exemples etiquetes, eux, sont des
  // constantes de code (pas de la donnee personnelle) et restent.
  r.post("/demo/delete", async (req, res) => {
    const s = getSession(req, res);
    if (!s.authed) return res.redirect("/demo");
    if (!safeEqual((req.body || {}).csrf, s.csrf)) {
      return res.status(403).send(page("Erreur", '<div class="card"><p class="warn">Jeton de sécurité invalide.</p></div>'));
    }
    s.linkedin = null;
    s.lastPost = null;
    await clearDemoPosts();
    res.send(
      page(
        "Données supprimées",
        `<div class="card"><h1 class="ok">✔ Données supprimées</h1>
          <p>La connexion LinkedIn de ta session et l'historique des posts publiés ont été
          effacés immédiatement et définitivement. Droit à l'effacement (RGPD art. 17) exercé.</p>
          <p class="muted">(Les lignes « exemple » du tableau sont des illustrations statiques,
          pas de la donnée personnelle — elles subsistent.)</p>
          <p style="margin-top:16px"><a href="/demo/app" style="color:#8ab">Retour</a></p>
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
      s.lastPost = { urn: result.id, url: result.url, text: caption };
      // Persiste dans l'historique de suivi (data/_demo/) — apparait dans le
      // tableau « Publications » du tableau de bord.
      await appendDemoPost({ date: new Date().toISOString().slice(0, 10), text: caption, url: result.url, urn: result.id });
      res.send(
        page(
          "Publié",
          `<div class="card"><h1 class="ok">✔ Publié sur LinkedIn</h1>
            <p>Le post a été publié sur le profil connecté et ajouté au suivi des publications.</p>
            ${result.url ? `<a class="btn" href="${result.url}" target="_blank" rel="noopener">Voir le post</a>` : '<p class="muted">(Post créé — id retourné par LinkedIn.)</p>'}
          </div>
          <div class="card">
            <h2>Suivi de l'engagement (analytics)</h2>
            <p class="muted">Lecture des réactions/commentaires du post via l'API (capability « monitor engagement »).</p>
            <a class="btn" href="/demo/stats?urn=${encodeURIComponent(result.id)}">Voir l'engagement du post</a>
            <p style="margin-top:16px"><a href="/demo/app" style="color:#8ab">Retour au tableau de bord</a></p>
          </div>`
        )
      );
    } catch (e) {
      res.status(502).send(page("Échec", `<div class="card"><h1 class="warn">Publication échouée</h1><p>${e.message}</p><a href="/demo/app">Retour</a></div>`));
    }
  });

  // Engagement d'un post : ?urn=<post> (depuis le tableau de suivi), sinon le
  // dernier post publié. Lit le vrai engagement via l'API ; si l'API refuse
  // (tier pas encore accordé), affiche "en attente" — JAMAIS de faux chiffres.
  r.get("/demo/stats", async (req, res) => {
    const s = getSession(req, res);
    if (!s.authed) return res.redirect("/demo");
    const wantUrn = String(req.query.urn || "");
    const history = await listDemoPosts();
    let post = null;
    if (wantUrn) {
      post =
        history.find((p) => p.urn === wantUrn) ||
        (s.lastPost && s.lastPost.urn === wantUrn ? s.lastPost : null);
    } else {
      post = s.lastPost || history[history.length - 1] || null;
    }
    // Aucun post : on montre QUAND MEME la page, pour que le reviewer voie
    // l'emplacement et la capability « monitor engagement ». Aucun chiffre inventé.
    if (!post) {
      return res.send(
        page(
          "Analytics",
          `<div class="card"><h1>Suivi de l'engagement (analytics)</h1>
            <p class="warn">⏳ Aucun post publié pour le moment</p>
            <p>Cette page lit l'engagement d'un post publié — réactions, commentaires,
            impressions — via l'API LinkedIn, au titre de la capability « monitor engagement »
            de la Community Management API.</p>
            <p>Le déroulé : publie un post à l'étape 2, puis reviens ici. Les chiffres du post
            s'afficheront à cet emplacement, lus en direct via l'API (aucune valeur inventée).</p>
            <p class="muted">C'est exactement l'endroit où l'implémentation de l'analytics se branche.</p>
            <p style="margin-top:16px"><a href="/demo/app" style="color:#8ab">Retour — publier un post</a></p>
          </div>`
        )
      );
    }
    const back = `<p style="margin-top:16px"><a href="/demo/app" style="color:#8ab">Retour</a>${post.url ? ` · <a href="${esc(post.url)}" target="_blank" rel="noopener" style="color:#8ab">Voir le post</a>` : ""}</p>`;
    // Il faut un LinkedIn connecté pour lire l'engagement live du post.
    if (!s.linkedin) {
      return res.send(
        page(
          "Analytics",
          `<div class="card"><h1>Engagement du post</h1>
            <p class="warn">Connecte LinkedIn pour lire l'engagement de ce post en direct via l'API.</p>
            <a class="btn" href="/demo/linkedin/start">Connecter LinkedIn</a>${back}
          </div>`
        )
      );
    }
    try {
      const stats = await getSocialActions(s.linkedin.accessToken, post.urn);
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
