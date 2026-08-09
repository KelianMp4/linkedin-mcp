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
function publicationsTable(realPosts, examples) {
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
  const sampleRows = examples
    .map(
      (p) => `<tr>
      <td class="muted">${esc(p.date)}</td>
      <td>${esc(trunc(p.text))}</td>
      <td><span class="tag tag-ex">exemple</span></td>
      <td class="muted">${p.reactions} · ${p.comments} <span class="muted">(illustratif)</span></td>
    </tr>`
    )
    .join("");
  return `<table class="pub">
      <thead><tr><th>Date</th><th>Post</th><th>Type</th><th>Engagement</th></tr></thead>
      <tbody>${realRows}${sampleRows}</tbody>
    </table>
    <p class="muted" style="margin-top:10px">Lignes <b>publié</b> : vrais posts de cette démo, engagement lu
    en direct via l'API LinkedIn. Lignes <b>exemple</b> : illustration du suivi — chiffres NON issus de l'API.</p>`;
}

// Ruban d'onboarding : où en est l'utilisateur (connecter → publier → suivre).
function stepper(connected, hasPosts) {
  const s1 = connected ? "done" : "active";
  const s2 = hasPosts ? "done" : connected ? "active" : "";
  const s3 = hasPosts ? "active" : "";
  return `<div class="stepper">
    <div class="step ${s1}"><span class="n">${connected ? "✔" : "①"}</span>Connecter LinkedIn</div>
    <div class="step ${s2}"><span class="n">${hasPosts ? "✔" : "②"}</span>Publier un post</div>
    <div class="step ${s3}"><span class="n">③</span>Suivre l'engagement</div>
  </div>`;
}

// Graphique d'engagement (SVG inline, zéro dépendance JS) : barres groupées
// réactions/commentaires par post-exemple. Données illustratives, jamais API.
function engagementChart(examples) {
  if (!examples.length) return `<div class="empty">Aucune donnée d'engagement à afficher.</div>`;
  const W = 340, H = 150, padL = 10, padR = 10, padT = 8, padB = 26;
  const plotH = H - padT - padB;
  const max = Math.max(1, ...examples.flatMap((p) => [p.reactions, p.comments]));
  const groupW = (W - padL - padR) / examples.length;
  const barW = Math.min(24, groupW / 3);
  const yTop = (v) => padT + plotH - (v / max) * plotH;
  const bars = examples
    .map((p, i) => {
      const cx = padL + groupW * i + groupW / 2;
      const hR = (p.reactions / max) * plotH;
      const hC = (p.comments / max) * plotH;
      return `<rect x="${(cx - barW - 2).toFixed(1)}" y="${yTop(p.reactions).toFixed(1)}" width="${barW}" height="${hR.toFixed(1)}" rx="3" fill="#634670"/>
        <rect x="${(cx + 2).toFixed(1)}" y="${yTop(p.comments).toFixed(1)}" width="${barW}" height="${hC.toFixed(1)}" rx="3" fill="#0a66c2"/>
        <text x="${cx.toFixed(1)}" y="${H - 8}" fill="#F2F2F2" opacity="0.5" font-size="10" text-anchor="middle">${esc((p.date || "").slice(5))}</text>`;
    })
    .join("");
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Engagement par post">
      <line x1="${padL}" y1="${padT + plotH}" x2="${W - padR}" y2="${padT + plotH}" stroke="#444" stroke-width="1"/>
      ${bars}
    </svg>
    <div class="legend"><span><i style="background:#634670"></i>Réactions</span><span><i style="background:#0a66c2"></i>Commentaires</span><span class="muted">exemples illustratifs</span></div>`;
}

// Tuiles KPI. Engagement agrégé sur les exemples (illustratif) — l'engagement
// réel des posts publiés se lit par post via l'API (colonne du tableau).
function kpiTiles(realPosts, examples) {
  const total = realPosts.length + examples.length;
  const reactions = examples.reduce((a, p) => a + p.reactions, 0);
  const comments = examples.reduce((a, p) => a + p.comments, 0);
  return `<div class="kpis">
      <div class="kpi"><b>${total}</b><span>Publications</span></div>
      <div class="kpi"><b>${reactions}</b><span>Réactions*</span></div>
      <div class="kpi"><b>${comments}</b><span>Commentaires*</span></div>
    </div>
    <p class="muted" style="margin-top:8px">* Agrégés sur les exemples illustratifs. L'engagement réel des posts publiés se lit par post via l'API (« voir l'engagement »).</p>`;
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
    sessions.set(sid, { authed: false, csrf: rid("csrf"), linkedin: null, oauthState: null, examplesHidden: false });
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
  .bar{display:flex;align-items:center;justify-content:space-between;gap:12px}
  .pill{display:inline-flex;align-items:center;gap:6px;padding:5px 12px;border-radius:999px;font-size:12px;font-weight:600;background:#2A2A2A;white-space:nowrap}
  .pill.on{color:#7DBE8A} .pill.off{color:#D8A24A}
  .stepper{display:flex;gap:8px;margin:14px 0 4px}
  .step{flex:1;background:#2A2A2A;border-radius:10px;padding:12px 8px;text-align:center;font-size:12px;opacity:.45}
  .step.active{opacity:1;outline:2px solid #634670} .step.done{opacity:1;color:#7DBE8A}
  .step .n{display:block;font-size:18px;font-weight:800;margin-bottom:3px}
  .kpis{display:flex;gap:12px;margin-top:14px}
  .kpi{flex:1;background:#2A2A2A;border-radius:10px;padding:14px 8px;text-align:center}
  .kpi b{display:block;font-size:26px;font-weight:800;line-height:1.1}
  .kpi span{font-size:11px;opacity:.6;text-transform:uppercase;letter-spacing:.03em}
  .chart{width:100%;height:auto;display:block;margin-top:4px}
  .legend{display:flex;gap:16px;font-size:12px;opacity:.75;margin-top:6px;flex-wrap:wrap}
  .legend i{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:5px;vertical-align:middle}
  .empty{background:#2A2A2A;border:1px dashed #444;border-radius:10px;padding:26px;text-align:center;font-size:14px;opacity:.85}
  .banner{background:#1f3a28;color:#cdeccf;border-radius:12px;padding:14px 16px;margin-bottom:16px;font-size:14px;line-height:1.5}
  details.composer summary{cursor:pointer;list-style:none;font-weight:600;color:#0a66c2;padding:6px 0}
  details.composer summary::-webkit-details-marker{display:none}
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

  // Tableau de bord : onboarding + engagement (graphique) + publier + suivi + RGPD.
  r.get("/demo/app", async (req, res) => {
    const s = getSession(req, res);
    if (!s.authed) return res.redirect("/demo");
    const li = s.linkedin;
    const connected = Boolean(li);
    const realPosts = await listDemoPosts();
    const examples = s.examplesHidden ? [] : DEMO_SAMPLE_POSTS;
    const hasPosts = realPosts.length > 0;
    const totalRows = realPosts.length + examples.length;
    const wiped = req.query.wiped === "1";
    // Composer déplié par défaut quand connecté sans post : on guide l'action.
    const composerOpen = connected && !hasPosts ? "open" : "";
    res.send(
      page(
        "Démo — tableau de bord",
        `${wiped ? `<div class="banner">✔ Toutes tes données ont été supprimées : connexion LinkedIn, historique des posts publiés, et les exemples retirés de l'affichage. Droit à l'effacement (RGPD art. 17) exercé. &nbsp;<a href="/demo/examples/restore" style="color:#8ab">Réafficher les exemples</a></div>` : ""}
        <div class="card">
          <div class="bar">
            <h1 style="margin:0">Cockpit contenu LinkedIn</h1>
            <span class="pill ${connected ? "on" : "off"}">${connected ? `● ${esc(li.name || "connecté")}` : "○ Non connecté"}</span>
          </div>
          <p class="muted" style="margin:2px 0 0">Compte de démonstration. <a href="/demo/logout" style="color:#8ab">Se déconnecter</a></p>
          ${stepper(connected, hasPosts)}
          ${connected ? "" : `<a class="btn" href="/demo/linkedin/start">Connecter LinkedIn</a>`}
        </div>

        <div class="card">
          <h2>Engagement</h2>
          ${engagementChart(examples)}
          ${kpiTiles(realPosts, examples)}
        </div>

        <div class="card">
          <h2>Publier</h2>
          <p class="muted">Rien n'est publié sans ton clic « Approuver et publier ». Human-in-the-loop.</p>
          <details class="composer" ${composerOpen}>
            <summary>✍️ Rédiger un nouveau post</summary>
            <form method="post" action="/demo/publish">
              <input type="hidden" name="csrf" value="${s.csrf}">
              <label>Texte du post LinkedIn</label>
              <textarea name="caption" placeholder="Ton post..."></textarea>
              <label>Titre du visuel on-brand (optionnel — génère une image)</label>
              <input name="visualTitle" placeholder="Laisse vide pour un post texte seul">
              <button type="submit" ${connected ? "" : "disabled"}>Approuver et publier${connected ? "" : " (connecte LinkedIn d'abord)"}</button>
            </form>
          </details>
        </div>

        <div class="card">
          <h2>Publications &amp; suivi</h2>
          <p class="muted">Historique des posts publiés et leur engagement, lu via l'API — capability
          « monitor engagement » de la Community Management API. Clique une ligne « publié » pour l'engagement live.</p>
          ${totalRows
            ? publicationsTable(realPosts, examples)
            : `<div class="empty">Aucune publication. Publie un post ci-dessus, ou <a href="/demo/examples/restore" style="color:#8ab">réaffiche les exemples</a>.</div>`}
        </div>

        <div class="card">
          <h2>Confidentialité — droit à l'effacement (RGPD art. 17)</h2>
          <p class="muted">Cette démo conserve ta connexion LinkedIn (session) et l'historique des posts
          publiés (serveur). Aucune donnée n'est vendue ni partagée. Le bouton efface les deux
          immédiatement, et retire les exemples de l'affichage pour te montrer la suppression.</p>
          <form method="post" action="/demo/delete">
            <input type="hidden" name="csrf" value="${s.csrf}">
            <button type="submit" style="background:#7a2b2b">Supprimer mes données</button>
          </form>
        </div>`
      )
    );
  });

  // Réaffiche les exemples illustratifs (après une suppression de démo) pour
  // pouvoir continuer la démonstration / filmer. N'affecte que l'affichage.
  r.get("/demo/examples/restore", (req, res) => {
    const s = getSession(req, res);
    if (!s.authed) return res.redirect("/demo");
    s.examplesHidden = false;
    res.redirect("/demo/app");
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
    s.examplesHidden = true; // retire aussi les exemples de l'affichage (preuve visuelle)
    await clearDemoPosts();
    // Retour au tableau de bord vidé : le reviewer VOIT la suppression (graphique
    // vide, KPI à zéro, tableau vide), bannière de confirmation en haut.
    res.redirect("/demo/app?wiped=1");
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
