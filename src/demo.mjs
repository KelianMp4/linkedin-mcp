// Surface web de démo pour la review LinkedIn (Community Management API).
// UI en ANGLAIS : le reviewer LinkedIn est anglophone et teste la démo live.
// Le reviewer se logge (compte de test), connecte SON LinkedIn, rédige un post,
// l'APPROUVE explicitement, et on le publie. Human-in-the-loop, rien d'automatique.
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
// JAMAIS présentés comme de la donnée API : badge « example », engagement marqué
// illustratif. On ne trompe pas le reviewer — on illustre la structure du suivi.
const DEMO_SAMPLE_POSTS = [
  { date: "2026-08-04", text: "3 signals that a fractional CTO would save you 6 months of roadmap.", reactions: 42, comments: 7 },
  { date: "2026-08-01", text: "We moved a client to a self-hosted stack in 2 weeks. The real hidden cost wasn't the tech.", reactions: 28, comments: 4 },
  { date: "2026-07-28", text: "The question no IT vendor wants you to ask before you sign.", reactions: 63, comments: 12 },
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
        <td><span class="tag tag-live">published</span></td>
        <td>${p.urn ? `<a href="/demo/stats?urn=${encodeURIComponent(p.urn)}" style="color:#8ab">view engagement</a>` : '<span class="muted">—</span>'}</td>
      </tr>`
    )
    .join("");
  const sampleRows = examples
    .map(
      (p) => `<tr>
      <td class="muted">${esc(p.date)}</td>
      <td>${esc(trunc(p.text))}</td>
      <td><span class="tag tag-ex">example</span></td>
      <td class="muted">${p.reactions} · ${p.comments} <span class="muted">(illustrative)</span></td>
    </tr>`
    )
    .join("");
  return `<table class="pub">
      <thead><tr><th>Date</th><th>Post</th><th>Type</th><th>Engagement</th></tr></thead>
      <tbody>${realRows}${sampleRows}</tbody>
    </table>
    <p class="muted" style="margin-top:10px"><b>published</b> rows: real posts from this demo, engagement read
    live via the LinkedIn API. <b>example</b> rows: tracking illustration — numbers NOT from the API.</p>`;
}

// Ruban d'onboarding : où en est l'utilisateur (connect → publish → track).
function stepper(connected, hasPosts) {
  const s1 = connected ? "done" : "active";
  const s2 = hasPosts ? "done" : connected ? "active" : "";
  const s3 = hasPosts ? "active" : "";
  return `<div class="stepper">
    <div class="step ${s1}"><span class="n">${connected ? "✔" : "①"}</span>Connect LinkedIn</div>
    <div class="step ${s2}"><span class="n">${hasPosts ? "✔" : "②"}</span>Publish a post</div>
    <div class="step ${s3}"><span class="n">③</span>Track engagement</div>
  </div>`;
}

// Graphique d'engagement (SVG inline, zéro dépendance JS) : barres groupées
// réactions/commentaires par post-exemple. Données illustratives, jamais API.
function engagementChart(examples) {
  if (!examples.length) return `<div class="empty">No engagement data to display.</div>`;
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
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Engagement per post">
      <line x1="${padL}" y1="${padT + plotH}" x2="${W - padR}" y2="${padT + plotH}" stroke="#444" stroke-width="1"/>
      ${bars}
    </svg>
    <div class="legend"><span><i style="background:#634670"></i>Reactions</span><span><i style="background:#0a66c2"></i>Comments</span><span class="muted">illustrative examples</span></div>`;
}

// Tuiles KPI. Engagement agrégé sur les exemples (illustratif) — l'engagement
// réel des posts publiés se lit par post via l'API (colonne du tableau).
function kpiTiles(realPosts, examples) {
  const total = realPosts.length + examples.length;
  const reactions = examples.reduce((a, p) => a + p.reactions, 0);
  const comments = examples.reduce((a, p) => a + p.comments, 0);
  return `<div class="kpis">
      <div class="kpi"><b>${total}</b><span>Posts</span></div>
      <div class="kpi"><b>${reactions}</b><span>Reactions*</span></div>
      <div class="kpi"><b>${comments}</b><span>Comments*</span></div>
    </div>
    <p class="muted" style="margin-top:8px">* Aggregated over the illustrative examples. Real engagement of published posts is read per post via the API ("view engagement").</p>`;
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

// Favicon on-brand (mini bar chart violet/bleu) — SVG inline, servi par route.
const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#634670"/><rect x="8" y="17" width="4" height="7" rx="1" fill="#fff"/><rect x="14" y="12" width="4" height="12" rx="1" fill="#fff"/><rect x="20" y="8" width="4" height="16" rx="1" fill="#0a66c2"/></svg>`;

function page(title, bodyHtml) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title>
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
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

  // Favicon (sert /favicon.svg et /favicon.ico) — évite le 404 et l'icône moche.
  r.get(["/favicon.svg", "/favicon.ico"], (_req, res) => {
    res
      .set("Content-Type", "image/svg+xml")
      .set("Cache-Control", "public, max-age=86400")
      .send(FAVICON_SVG);
  });

  // Accueil : login ou redirection vers l'app.
  r.get("/demo", (req, res) => {
    const s = getSession(req, res);
    if (s.authed) return res.redirect("/demo/app");
    const configured = isConfigured();
    res.send(
      page(
        "linkedin-mcp demo",
        `<div class="card">
          <h1>linkedin-mcp — demo</h1>
          <p>Demo workspace: connect a LinkedIn account, write an on-brand post, approve it, publish.</p>
          ${configured ? "" : '<p class="warn">⚠️ LinkedIn not configured (LINKEDIN_CLIENT_ID/SECRET missing). Sign-in works, publishing will fail until it is set.</p>'}
          <form method="post" action="/demo/login">
            <input type="hidden" name="csrf" value="${s.csrf}">
            <label>Username</label><input name="user" autocomplete="username">
            <label>Password</label><input name="pass" type="password" autocomplete="current-password">
            <button type="submit">Sign in</button>
          </form>
        </div>`
      )
    );
  });

  r.post("/demo/login", (req, res) => {
    const s = getSession(req, res);
    const { user, pass, csrf } = req.body || {};
    if (!safeEqual(csrf, s.csrf)) return res.status(403).send(page("Error", '<div class="card"><p class="warn">Invalid security token. <a href="/demo">Try again</a></p></div>'));
    const U = process.env.DEMO_USER, P = process.env.DEMO_PASS;
    if (!U || !P) return res.status(500).send(page("Config", '<div class="card"><p class="warn">DEMO_USER / DEMO_PASS not configured on the server.</p></div>'));
    if (safeEqual(user, U) && safeEqual(pass, P)) {
      s.authed = true;
      return res.redirect("/demo/app");
    }
    res.status(401).send(page("Denied", '<div class="card"><p class="warn">Invalid credentials. <a href="/demo">Try again</a></p></div>'));
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
        "Demo — dashboard",
        `${wiped ? `<div class="banner">✔ All your data has been deleted: LinkedIn connection, published-post history, and the examples removed from view. Right to erasure (GDPR art. 17) exercised. &nbsp;<a href="/demo/examples/restore" style="color:#8ab">Show examples again</a></div>` : ""}
        <div class="card">
          <div class="bar">
            <h1 style="margin:0">LinkedIn content cockpit</h1>
            <span class="pill ${connected ? "on" : "off"}">${connected ? `● ${esc(li.name || "connected")}` : "○ Not connected"}</span>
          </div>
          <p class="muted" style="margin:2px 0 0">Demo account. <a href="/demo/logout" style="color:#8ab">Sign out</a></p>
          ${stepper(connected, hasPosts)}
          ${connected ? "" : `<a class="btn" href="/demo/linkedin/start">Connect LinkedIn</a>`}
        </div>

        <div class="card">
          <h2>Engagement</h2>
          ${engagementChart(examples)}
          ${kpiTiles(realPosts, examples)}
        </div>

        <div class="card">
          <h2>Publish</h2>
          <p class="muted">Nothing is published without your "Approve &amp; publish" click. Human-in-the-loop.</p>
          <details class="composer" ${composerOpen}>
            <summary>✍️ Write a new post</summary>
            <form method="post" action="/demo/publish">
              <input type="hidden" name="csrf" value="${s.csrf}">
              <label>LinkedIn post text</label>
              <textarea name="caption" placeholder="Your post..."></textarea>
              <label>On-brand visual title (optional — generates an image)</label>
              <input name="visualTitle" placeholder="Leave empty for a text-only post">
              <button type="submit" ${connected ? "" : "disabled"}>Approve &amp; publish${connected ? "" : " (connect LinkedIn first)"}</button>
            </form>
          </details>
        </div>

        <div class="card">
          <h2>Publications &amp; tracking</h2>
          <p class="muted">History of published posts and their engagement, read via the API — the
          "monitor engagement" capability of the Community Management API. Click a "published" row for live engagement.</p>
          ${totalRows
            ? publicationsTable(realPosts, examples)
            : `<div class="empty">No publications yet. Publish a post above, or <a href="/demo/examples/restore" style="color:#8ab">show the examples again</a>.</div>`}
        </div>

        <div class="card">
          <h2>Privacy — right to erasure (GDPR art. 17)</h2>
          <p class="muted">This demo stores your LinkedIn connection (session) and the history of published
          posts (server). No data is sold or shared. The button erases both immediately, and removes the
          examples from view to demonstrate the deletion.</p>
          <form method="post" action="/demo/delete">
            <input type="hidden" name="csrf" value="${s.csrf}">
            <button type="submit" style="background:#7a2b2b">Delete my data</button>
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
      return res.status(403).send(page("Error", '<div class="card"><p class="warn">Invalid security token.</p></div>'));
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
      res.status(500).send(page("Error", `<div class="card"><p class="warn">${e.message}</p></div>`));
    }
  });

  // Callback OAuth : échange le code, récupère l'identité, stocke en session.
  r.get("/demo/linkedin/callback", async (req, res) => {
    const s = getSession(req, res);
    if (!s.authed) return res.redirect("/demo");
    const { code, state, error, error_description } = req.query;
    if (error) return res.status(400).send(page("LinkedIn", `<div class="card"><p class="warn">LinkedIn: ${error} — ${error_description || ""}</p></div>`));
    if (!code || !state || state !== s.oauthState) {
      return res.status(400).send(page("LinkedIn", '<div class="card"><p class="warn">Invalid OAuth state. <a href="/demo/app">Back</a></p></div>'));
    }
    try {
      const tok = await exchangeCode(String(code));
      const member = await getMember(tok.access_token);
      s.linkedin = { accessToken: tok.access_token, urn: member.urn, name: member.name };
      s.oauthState = null;
      res.redirect("/demo/app");
    } catch (e) {
      res.status(502).send(page("LinkedIn", `<div class="card"><p class="warn">LinkedIn connection failed: ${e.message}</p><a href="/demo/app">Back</a></div>`));
    }
  });

  // Publication — SEULEMENT après approbation humaine (ce POST = le clic).
  r.post("/demo/publish", async (req, res) => {
    const s = getSession(req, res);
    if (!s.authed) return res.redirect("/demo");
    if (!safeEqual((req.body || {}).csrf, s.csrf)) return res.status(403).send(page("Error", '<div class="card"><p class="warn">Invalid security token.</p></div>'));
    if (!s.linkedin) return res.status(400).send(page("LinkedIn", '<div class="card"><p class="warn">Connect LinkedIn first. <a href="/demo/app">Back</a></p></div>'));
    const caption = String((req.body || {}).caption || "").trim();
    const visualTitle = String((req.body || {}).visualTitle || "").trim();
    if (!caption) return res.status(400).send(page("Empty", '<div class="card"><p class="warn">The post text is empty. <a href="/demo/app">Back</a></p></div>'));
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
          "Published",
          `<div class="card"><h1 class="ok">✔ Published on LinkedIn</h1>
            <p>The post was published to the connected profile and added to publications tracking.</p>
            ${result.url ? `<a class="btn" href="${result.url}" target="_blank" rel="noopener">View post</a>` : '<p class="muted">(Post created — id returned by LinkedIn.)</p>'}
          </div>
          <div class="card">
            <h2>Engagement tracking (analytics)</h2>
            <p class="muted">Reads the post's reactions/comments via the API ("monitor engagement" capability).</p>
            <a class="btn" href="/demo/stats?urn=${encodeURIComponent(result.id)}">View post engagement</a>
            <p style="margin-top:16px"><a href="/demo/app" style="color:#8ab">Back to dashboard</a></p>
          </div>`
        )
      );
    } catch (e) {
      res.status(502).send(page("Failed", `<div class="card"><h1 class="warn">Publishing failed</h1><p>${e.message}</p><a href="/demo/app">Back</a></div>`));
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
          `<div class="card"><h1>Engagement tracking (analytics)</h1>
            <p class="warn">⏳ No post published yet</p>
            <p>This page reads a published post's engagement — reactions, comments, impressions —
            via the LinkedIn API, under the "monitor engagement" capability of the Community
            Management API.</p>
            <p>How it works: publish a post at step 2, then come back here. The post's numbers will
            appear here, read live via the API (no fabricated values).</p>
            <p class="muted">This is exactly where the analytics implementation plugs in.</p>
            <p style="margin-top:16px"><a href="/demo/app" style="color:#8ab">Back — publish a post</a></p>
          </div>`
        )
      );
    }
    const back = `<p style="margin-top:16px"><a href="/demo/app" style="color:#8ab">Back</a>${post.url ? ` · <a href="${esc(post.url)}" target="_blank" rel="noopener" style="color:#8ab">View post</a>` : ""}</p>`;
    // Il faut un LinkedIn connecté pour lire l'engagement live du post.
    if (!s.linkedin) {
      return res.send(
        page(
          "Analytics",
          `<div class="card"><h1>Post engagement</h1>
            <p class="warn">Connect LinkedIn to read this post's engagement live via the API.</p>
            <a class="btn" href="/demo/linkedin/start">Connect LinkedIn</a>${back}
          </div>`
        )
      );
    }
    try {
      const stats = await getSocialActions(s.linkedin.accessToken, post.urn);
      res.send(
        page(
          "Stats",
          `<div class="card"><h1>Post engagement</h1>
            <p class="ok">✔ Live data via the LinkedIn API</p>
            <p style="font-size:22px"><b>${stats.likes}</b> reactions &nbsp;·&nbsp; <b>${stats.comments}</b> comments</p>
            <p class="muted">Refresh in a few minutes to watch engagement grow.</p>${back}
          </div>`
        )
      );
    } catch (e) {
      if (e.pending) {
        // Cas attendu en tier dev : l'accès analytics est justement ce qu'on demande.
        res.send(
          page(
            "Stats",
            `<div class="card"><h1>Post engagement</h1>
              <p class="warn">⏳ Analytics awaiting API access</p>
              <p>Reading engagement (reactions, comments, impressions) is part of the "monitor
              engagement" capability requested in the Community Management API. Once access is
              granted, these numbers will appear here, for the post above.</p>
              <p class="muted">No fabricated numbers: this is exactly where the analytics will plug in.</p>${back}
            </div>`
          )
        );
      } else {
        res.status(502).send(page("Stats", `<div class="card"><p class="warn">Failed to read stats: ${e.message}</p>${back}</div>`));
      }
    }
  });

  return r;
}
