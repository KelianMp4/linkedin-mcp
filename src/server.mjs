#!/usr/bin/env node
// Serveur MCP LinkedIn (Streamable HTTP, distant). V1 sans UI : les tokens sont
// mintes a la main (npm run mint) et envoyes au client. Le Bearer token = identite :
// le serveur en deduit data/<token>/ (brand + suivi). Le client ne voit que son dossier.
//
// Modele economique : aucun appel LLM cote serveur. Le Claude du client redige
// (avec get_playbook + son Projet) => zero token sur la facture Stacko. Cout = juste
// l'hebergement (rendu Chrome + quelques Ko de JSON par client).

import express from "express";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { render, beginShutdown, shutdownRenders, activeRenderCount } from "./render.mjs";
import { registerFont } from "./fonts.mjs";
import { playbook } from "./playbook.mjs";
import { lintPost } from "./lint.mjs";
import { createOAuth } from "./oauth.mjs";
import { demoRouter } from "./demo.mjs";
import { isConfigured, publishText, publishImage } from "./linkedin.mjs";
import { startLinkedinConnect, completeLinkedinConnect, isConnectState } from "./connect.mjs";
import { createSessionStore } from "./sessions.mjs";
import {
  resolveToken,
  getBrand,
  setBrand,
  updateBrand,
  updateVisual,
  appendPost,
  listPosts,
  updatePost,
  getLinkedin,
  listTokens,
  deleteClientData,
  DATA_DIR,
} from "./store.mjs";

const PORT = Number(process.env.PORT || 3000);
// URL publique (https derriere Caddy). Sert d'issuer + resource dans les
// metadonnees OAuth. En prod : PUBLIC_URL=https://mcp.stacko.fr.
const PUBLIC_URL = process.env.PUBLIC_URL || `http://localhost:${PORT}`;

const slideShape = z.object({
  titre: z.string().optional(),
  corps: z.string().optional(),
  chiffre: z.string().optional().describe("chiffre cle mis en avant"),
  cta: z.string().optional(),
  note: z.string().optional(),
});

const brandInput = z.object({
  voice: z
    .object({
      registre: z.string().optional(),
      langue: z.string().optional(),
      regles: z.array(z.string()).optional(),
      produit: z
        .object({
          nom: z.string().optional(),
          pitch: z.string().optional(),
          url: z.string().optional(),
          prix: z.string().optional(),
          cible: z.string().optional(),
          preuve: z.string().optional(),
        })
        .optional(),
    })
    .optional(),
  visual: z
    .object({
      bg: z.string().optional(),
      fg: z.string().optional(),
      accent: z.string().optional(),
      accent2: z.string().optional(),
      titleFont: z.string().optional(),
      bodyFont: z.string().optional(),
      width: z.number().optional(),
      height: z.number().optional(),
    })
    .optional(),
});

// Message d'erreur lisible pour le client (jamais une stack brute).
function humanRenderError(e) {
  const msg = String(e?.message || e);
  if (/introuvable|ENOENT|exit|echoue/i.test(msg))
    return "le moteur de rendu (Chrome) n'a pas repondu. Reessaie ; si ca persiste, previens l'hebergeur.";
  return msg;
}

// Rendu partage entre render_image (png) et render_carousel (pdf) : un seul
// endroit pour le rendu, l'erreur lisible et le passage du dossier polices.
async function renderTool(ctx, slides, format, label) {
  try {
    const brand = await getBrand(ctx);
    const fontsDir = join(ctx.dir, "fonts");
    const out = await render(slides, brand.visual, format, fontsDir);
    const uri = format === "pdf" ? "carousel.pdf" : "image.png";
    const detail = format === "pdf" ? `${out.slides} slides, ` : "";
    return {
      content: [
        { type: "text", text: `${label} : ${detail}${brand.client}.` },
        { type: "resource", resource: { uri, mimeType: out.mimeType, blob: out.base64 } },
      ],
    };
  } catch (e) {
    return {
      isError: true,
      content: [{ type: "text", text: `Rendu echoue : ${humanRenderError(e)}` }],
    };
  }
}

function buildServer(ctx) {
  const server = new McpServer({ name: "linkedin-mcp", version: "1.0.0" });

  server.registerTool(
    "setup_brand",
    {
      title: "Enregistrer l'identite de marque (onboarding)",
      description:
        "Interroge le client (brand book, voix, couleurs, polices, faits produit) puis appelle ceci UNE fois pour enregistrer son identite. Reutilisee ensuite par tous les rendus.",
      inputSchema: brandInput.shape,
    },
    async (input) => {
      const saved = await setBrand(ctx, input);
      return { content: [{ type: "text", text: `Identite enregistree pour ${saved.client}.` }] };
    }
  );

  server.registerTool(
    "get_playbook",
    {
      title: "Methode de redaction LinkedIn on-brand",
      description:
        "Retourne la methode + la voix enregistree de la marque pour que TU rediges le post (aucun texte genere cote serveur). Appelle ceci avant d'ecrire.",
      inputSchema: {},
    },
    async () => {
      const brand = await getBrand(ctx);
      return { content: [{ type: "text", text: playbook(brand) }] };
    }
  );

  server.registerTool(
    "lint_post",
    {
      title: "Verifier un post avant publication (regles de canal)",
      description:
        "Controle DETERMINISTE d'un brouillon de post LinkedIn : accroche en 1re ligne, aucun lien dans le corps, pas de tiret cadratin (signature IA), repere de coupe (~210 car). Aucun texte genere : renvoie les problemes a corriger. Appelle ceci AVANT de publier.",
      inputSchema: { texte: z.string().describe("le brouillon de post a verifier") },
    },
    async ({ texte }) => {
      const r = lintPost(texte);
      const head = r.ok
        ? r.warnings
          ? `✅ Aucune erreur bloquante, ${r.warnings} avertissement(s) a corriger.`
          : "✅ Post conforme aux regles de canal."
        : `❌ ${r.errors} probleme(s) bloquant(s), ${r.warnings} avertissement(s).`;
      const list = r.issues.map((i) => `- [${i.level}] ${i.rule} : ${i.message}`);
      const stats = `Stats : ${r.stats.chars} car, accroche ${r.stats.firstLineChars} car, coupe ~${r.stats.foldAt} car.`;
      return { content: [{ type: "text", text: [head, ...list, "", stats].join("\n") }] };
    }
  );

  server.registerTool(
    "get_brand",
    {
      title: "Lire l'identite de marque enregistree",
      description:
        "Retourne l'identite de marque stockee (voix + charte visuelle) en JSON. Pratique avant un update_brand pour voir l'existant, ou pour verifier la config.",
      inputSchema: {},
    },
    async () => {
      const brand = await getBrand(ctx);
      return { content: [{ type: "text", text: JSON.stringify(brand, null, 2) }] };
    }
  );

  server.registerTool(
    "update_brand",
    {
      title: "Mettre a jour l'identite de marque (patch partiel)",
      description:
        "Applique un patch partiel a l'identite de marque : ne fournis QUE les champs a changer (fusion profonde, le reste est conserve). La version precedente est archivee. Utilise get_brand d'abord pour voir l'existant.",
      inputSchema: brandInput.shape,
    },
    async (patch) => {
      const saved = await updateBrand(ctx, patch);
      return {
        content: [
          { type: "text", text: `Identite mise a jour pour ${saved.client} (version precedente archivee).` },
        ],
      };
    }
  );

  server.registerTool(
    "render_carousel",
    {
      title: "Rendu carrousel (PDF multi-pages on-brand)",
      description:
        "Rend un carrousel LinkedIn on-brand en PDF (format exige par LinkedIn). 5 a 8 slides : slide 1 = accroche seule, derniere = CTA conversation.",
      inputSchema: { slides: z.array(slideShape).min(1).max(8) },
    },
    async ({ slides }) => renderTool(ctx, slides, "pdf", "Carrousel rendu")
  );

  server.registerTool(
    "render_image",
    {
      title: "Rendu image seule (PNG on-brand)",
      description: "Rend une image LinkedIn seule (1080x1350) on-brand en PNG.",
      inputSchema: { slide: slideShape },
    },
    async ({ slide }) => renderTool(ctx, [slide], "png", "Image rendue")
  );

  server.registerTool(
    "register_font",
    {
      title: "Enregistrer une police de marque (par client)",
      description:
        "Enregistre la police on-brand du client pour un role (titre ou corps). 'source' = un nom de famille Google Fonts (ex: \"Inter\") OU une URL https vers un fichier woff2/woff/ttf/otf. Le serveur telecharge et stocke la police localement ; les rendus l'utilisent ensuite sans requete reseau. A appeler apres setup_brand, une fois par role.",
      inputSchema: {
        role: z.enum(["title", "body"]).describe("title = police des titres/chiffres, body = police du corps"),
        source: z.string().describe("nom de famille Google Fonts OU URL https d'un fichier de police"),
      },
    },
    async ({ role, source }) => {
      try {
        const info = await registerFont(ctx, role, source);
        const key = role === "title" ? "titleFontFile" : "bodyFontFile";
        await updateVisual(ctx, { [key]: info.filename });
        return {
          content: [
            {
              type: "text",
              text: `Police ${role} enregistree (${info.ext}, ${info.bytes} octets). Les prochains rendus l'utiliseront.`,
            },
          ],
        };
      } catch (e) {
        return {
          isError: true,
          content: [{ type: "text", text: `Enregistrement police echoue : ${String(e?.message || e)}` }],
        };
      }
    }
  );

  server.registerTool(
    "log_post",
    {
      title: "Logger un post publie (suivi)",
      description:
        "Ajoute un post au suivi. Metriques saisies a la main par le client, jamais inventees ni recuperees via l'API LinkedIn.",
      inputSchema: {
        date: z.string().describe("YYYY-MM-DD"),
        theme: z.string(),
        angle: z.string().optional(),
        format: z.string().optional(),
        metriques: z
          .object({
            vues: z.number().optional(),
            reactions: z.number().optional(),
            commentaires: z.number().optional(),
            reposts: z.number().optional(),
            dm_recus: z.number().optional(),
          })
          .optional(),
        resultat_business: z.string().optional(),
        notes: z.string().optional(),
      },
    },
    async (entry) => {
      const n = await appendPost(ctx, entry);
      return { content: [{ type: "text", text: `Post logge (#${n}).` }] };
    }
  );

  server.registerTool(
    "list_posts",
    {
      title: "Suivi des posts",
      description: "Retourne l'historique des posts loggues (JSON) pour faire un bilan.",
      inputSchema: {},
    },
    async () => {
      const hist = await listPosts(ctx);
      return { content: [{ type: "text", text: JSON.stringify(hist, null, 2) }] };
    }
  );

  server.registerTool(
    "update_post_metrics",
    {
      title: "Mettre a jour les metriques d'un post loggue",
      description:
        "Complete un post deja loggue (repere par son id 1-base, celui renvoye par log_post) avec ses metriques a jour, saisies a la main par le client. Jamais de chiffres inventes ni recuperes via l'API.",
      inputSchema: {
        id: z.number().int().positive().describe("id 1-base du post (renvoye par log_post, ordre de list_posts)"),
        metriques: z
          .object({
            vues: z.number().optional(),
            reactions: z.number().optional(),
            commentaires: z.number().optional(),
            reposts: z.number().optional(),
            dm_recus: z.number().optional(),
          })
          .optional(),
        resultat_business: z.string().optional(),
        notes: z.string().optional(),
      },
    },
    async ({ id, metriques, resultat_business, notes }) => {
      const out = await updatePost(ctx, id, { metriques, resultat_business, notes });
      if (!out.ok) {
        return {
          isError: true,
          content: [{ type: "text", text: `Post #${id} introuvable (${out.count} post(s) loggue(s)).` }],
        };
      }
      return { content: [{ type: "text", text: `Post #${id} mis a jour.` }] };
    }
  );

  server.registerTool(
    "connect_linkedin",
    {
      title: "Connecter un compte LinkedIn (pour publier depuis Claude)",
      description:
        "Demarre l'autorisation LinkedIn : renvoie une URL a ouvrir dans un navigateur. Apres autorisation, le token LinkedIn du membre est stocke pour CE client et post_to_linkedin peut publier sur son profil. Publication uniquement apres validation humaine du texte.",
      inputSchema: {},
    },
    async () => {
      if (!isConfigured()) {
        return {
          isError: true,
          content: [
            { type: "text", text: "LinkedIn non configure cote serveur (LINKEDIN_CLIENT_ID/SECRET absents)." },
          ],
        };
      }
      const existing = await getLinkedin(ctx);
      const { url } = startLinkedinConnect(ctx.token);
      const note = existing
        ? `\n\n(Un compte est deja connecte : ${existing.name || "inconnu"}. Ouvrir ce lien le remplacera.)`
        : "";
      return {
        content: [
          {
            type: "text",
            text: `Ouvre ce lien dans un navigateur pour autoriser la publication sur ton profil LinkedIn (valable 10 min) :\n${url}\n\nUne fois l'autorisation faite, tu pourras publier avec post_to_linkedin.${note}`,
          },
        ],
      };
    }
  );

  server.registerTool(
    "post_to_linkedin",
    {
      title: "Publier un post sur LinkedIn (apres validation humaine)",
      description:
        "Publie le post sur le profil LinkedIn connecte (via connect_linkedin). Ne PUBLIE que du texte deja valide par le client (human-in-the-loop) — ne rien poster sans son accord explicite. Un 'visuel' optionnel rend une image on-brand jointe au post. Le post est ajoute au suivi automatiquement.",
      inputSchema: {
        texte: z.string().describe("le texte du post, deja valide par le client"),
        visuel: slideShape.optional().describe("optionnel : une slide on-brand rendue en image et jointe au post"),
      },
    },
    async ({ texte, visuel }) => {
      const li = await getLinkedin(ctx);
      if (!li) {
        return {
          isError: true,
          content: [
            { type: "text", text: "Aucun compte LinkedIn connecte. Lance d'abord connect_linkedin." },
          ],
        };
      }
      try {
        let result;
        if (visuel) {
          const brand = await getBrand(ctx);
          const out = await render([visuel], brand.visual, "png", join(ctx.dir, "fonts"));
          const img = Buffer.from(out.base64, "base64");
          result = await publishImage(li.accessToken, li.urn, texte, img, "image/png");
        } else {
          result = await publishText(li.accessToken, li.urn, texte);
        }
        // Ajout au suivi (metriques laissees vides : saisies a la main plus tard).
        await appendPost(ctx, {
          date: new Date().toISOString().slice(0, 10),
          theme: texte.split(/\r?\n/)[0].slice(0, 80),
          format: visuel ? "image" : "texte",
          url: result.url,
          urn: result.id,
          source: "post_to_linkedin",
        });
        return {
          content: [
            {
              type: "text",
              text: `Publie sur LinkedIn (${li.name || "profil connecte"}) et ajoute au suivi.${result.url ? `\n${result.url}` : ""}`,
            },
          ],
        };
      } catch (e) {
        return {
          isError: true,
          content: [{ type: "text", text: `Publication echouee : ${String(e?.message || e)}` }],
        };
      }
    }
  );

  server.registerTool(
    "delete_my_data",
    {
      title: "Supprimer toutes mes donnees (droit a l'effacement, RGPD art. 17)",
      description:
        "Efface DEFINITIVEMENT toutes les donnees du client : identite de marque, historique des posts, polices, et l'entree de registre associee au token. Action irreversible : exige confirm=true. Apres suppression le token devient invalide.",
      inputSchema: {
        confirm: z
          .boolean()
          .describe("doit valoir true pour confirmer la suppression definitive et irreversible"),
      },
    },
    async ({ confirm }) => {
      if (!confirm) {
        return {
          content: [
            {
              type: "text",
              text: "Suppression annulee : rappelle delete_my_data avec confirm=true pour effacer definitivement toutes tes donnees.",
            },
          ],
        };
      }
      const out = await deleteClientData(ctx.token);
      return {
        content: [
          {
            type: "text",
            text: out.removed
              ? `Toutes les donnees de ${out.client} ont ete supprimees definitivement (identite, historique, polices, token). Le droit a l'effacement (RGPD art. 17) est exerce.`
              : "Aucune donnee a supprimer pour ce token.",
          },
        ],
      };
    }
  );

  return server;
}

const app = express();
app.use(express.json({ limit: "4mb" }));
app.use(express.urlencoded({ extended: false }));

// --- OAuth 2.1 (Claude Desktop/web/Team exigent le flow). Claude Code garde le
// Bearer lkm_ direct via resolveBearer. Le SDK fournit discovery/register/token/
// revoke ; oauth.mjs porte la logique (pont sur lkm_, isolation par client).
const oauth = createOAuth({ dataDir: DATA_DIR, resolveToken, publicUrl: PUBLIC_URL });
await oauth.hydrate();

app.use(
  mcpAuthRouter({
    provider: oauth.provider,
    issuerUrl: new URL(PUBLIC_URL),
    resourceServerUrl: new URL(PUBLIC_URL),
    resourceName: "linkedin-mcp",
  })
);

// Soumission de la page de consentement (/authorize a cree la session serveur) :
// relit la session (params valides), verifie CSRF, valide le lkm_, emet un code
// usage unique et redirige. Ne fait JAMAIS confiance aux params du formulaire.
app.post("/authorize/consent", async (req, res) => {
  const b = req.body || {};
  const out = await oauth.grantCodeFromSession({
    sessionId: b.sid,
    csrf: b.csrf,
    lkmToken: b.lkm_token,
  });
  if (out.error) {
    const status = out.sessionId ? 400 : 410; // 410 si la session a disparu
    res
      .status(status)
      .set("content-type", "text/html; charset=utf-8")
      .send(
        oauth.consentPage({
          sessionId: out.sessionId,
          csrf: out.csrf,
          redirectHost: out.redirectHost,
          error: out.error,
        })
      );
    return;
  }
  const u = new URL(out.redirectUri);
  u.searchParams.set("code", out.code);
  if (out.state) u.searchParams.set("state", out.state);
  res.redirect(302, u.toString());
});

// Callback OAuth LinkedIn du flow MCP (connect_linkedin). On partage le meme
// redirect_uri que la demo (pas de 2e URL a enregistrer dans le portail) : on
// dispatche sur le prefixe du state. Si le state n'est PAS un flow MCP en cours,
// on passe la main (next) au routeur demo, qui gere son propre callback de session.
function callbackPage(title, bodyHtml) {
  return `<!doctype html><meta charset="utf-8"><title>${title}</title>
<body style="font-family:system-ui,sans-serif;background:#1A1A1A;color:#F2F2F2;display:flex;justify-content:center;padding:48px 16px">
<div style="max-width:520px;background:#232323;border-radius:14px;padding:28px">${bodyHtml}</div></body>`;
}

app.get("/demo/linkedin/callback", async (req, res, next) => {
  const { code, state, error, error_description } = req.query;
  if (!isConnectState(state)) return next(); // flow demo (session) -> demoRouter
  if (error) {
    res.status(400).send(callbackPage("LinkedIn", `<h1>Autorisation refusee</h1><p>${error}: ${error_description || ""}</p>`));
    return;
  }
  try {
    const { client, name } = await completeLinkedinConnect({ code, state });
    res.send(
      callbackPage(
        "LinkedIn connecte",
        `<h1 style="color:#7DBE8A">✔ Compte LinkedIn connecte</h1>
         <p>${name ? `<b>${name}</b> est connecte` : "Connexion reussie"} pour <b>${client}</b>.</p>
         <p>Reviens dans Claude et utilise <b>post_to_linkedin</b> pour publier. Tu peux fermer cet onglet.</p>`
      )
    );
  } catch (e) {
    res.status(502).send(callbackPage("LinkedIn", `<h1 style="color:#D8A24A">Connexion echouee</h1><p>${String(e?.message || e)}</p>`));
  }
});

// Surface web de démo (review LinkedIn) : /demo/*. Login de test + OAuth LinkedIn.
app.use(demoRouter());

app.get("/health", async (_req, res) => {
  res.json({ ok: true, clients: (await listTokens()).length });
});

// Sessions Streamable HTTP : le client s'initialise (Bearer token verifie a ce
// moment => identite figee pour la session), puis reutilise le mcp-session-id.
// Le store borne la memoire : TTL d'inactivite (SESSION_TTL_MS) + plafond LRU
// (SESSION_MAX). Sans ca, un client qui ne DELETE jamais sa session fuit lentement.
const SESSION_TTL_MS = Number(process.env.SESSION_TTL_MS || 30 * 60 * 1000); // 30 min
const SESSION_MAX = Number(process.env.SESSION_MAX || 1000);
const SESSION_SWEEP_MS = Number(process.env.SESSION_SWEEP_MS || 60 * 1000); // 1 min
const sessions = createSessionStore({ ttlMs: SESSION_TTL_MS, max: SESSION_MAX });

function closeTransport(t) {
  try {
    t?.close?.();
  } catch {
    // fermeture best-effort : ne jamais faire tomber le sweeper
  }
}

// Balayage periodique : ferme les sessions inactives depuis > TTL (leur onclose
// les retire aussi du store, idempotent). unref() pour ne pas retenir l'event loop.
const sweeper = setInterval(() => {
  for (const { value } of sessions.reapExpired()) closeTransport(value);
}, SESSION_SWEEP_MS);
if (typeof sweeper.unref === "function") sweeper.unref();

async function tokenCtx(req) {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  // Double chemin : lkm_ brut (Claude Code) OU access token OAuth (Desktop/web).
  return token ? oauth.resolveBearer(token) : null;
}

app.post("/mcp", async (req, res) => {
  const sid = req.headers["mcp-session-id"];
  let transport = sid ? sessions.get(sid) : undefined; // get() rafraichit l'activite

  if (!transport) {
    if (sid || !isInitializeRequest(req.body)) {
      res.status(400).json({ error: "no valid session" });
      return;
    }
    // Nouvelle session : le token doit exister dans le registre.
    const ctx = await tokenCtx(req);
    if (!ctx) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    // Avant d'ajouter : evince les plus anciennes si on depasse le plafond (LRU).
    for (const { value } of sessions.reapOverflow()) closeTransport(value);
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        sessions.set(id, transport);
      },
    });
    transport.onclose = () => {
      if (transport.sessionId) sessions.delete(transport.sessionId);
    };
    const server = buildServer(ctx);
    await server.connect(transport);
  }

  try {
    await transport.handleRequest(req, res, req.body);
  } catch (e) {
    if (!res.headersSent) res.status(500).json({ error: String(e?.message || e) });
  }
});

// GET = flux SSE serveur->client ; DELETE = fin de session.
async function replaySession(req, res) {
  const sid = req.headers["mcp-session-id"];
  const transport = sid ? sessions.get(sid) : undefined; // get() rafraichit l'activite
  if (!transport) {
    res.status(400).send("no valid session");
    return;
  }
  await transport.handleRequest(req, res);
}
app.get("/mcp", replaySession);
app.delete("/mcp", replaySession);

const httpServer = app.listen(PORT, () => {
  console.log(`[linkedin-mcp] up on :${PORT}`);
});

// Arret propre (decision 5) : sur SIGTERM (rebuild Docker au deploy) ou SIGINT
// (Ctrl-C en dev), on (1) bloque tout de suite l'admission de nouveaux rendus et
// on rejette la FILE, (2) stoppe l'ecoute HTTP, (3) laisse un court delai de grace
// aux rendus EN VOL pour finir, (4) tue les process Chrome restants -> aucun
// orphelin sur Linux (les childs sont detached), puis on sort. Idempotent, avec un
// hard-exit de secours pour ne JAMAIS bloquer un deploy.
// verif manuelle : demarrer le serveur, lancer un rendu, `kill -TERM <pid>` ->
// sortie propre et aucun process chrome/chromium restant (`ps aux | grep chrome`).
const SHUTDOWN_GRACE_MS = Number(process.env.SHUTDOWN_GRACE_MS || 5000);
let shuttingDown = false;

async function gracefulShutdown(signal) {
  if (shuttingDown) return; // idempotent : un 2e signal ne relance rien
  shuttingDown = true;
  console.log(`[linkedin-mcp] ${signal} recu, arret en cours...`);
  // Filet anti-hang : quoi qu'il arrive, on force la sortie apres la grace + 1 s.
  const hardExit = setTimeout(() => process.exit(0), SHUTDOWN_GRACE_MS + 1000);
  if (typeof hardExit.unref === "function") hardExit.unref();
  try {
    clearInterval(sweeper); // stoppe le balayage des sessions
    beginShutdown(); // (1) plus de nouveau rendu, la file est rejetee
    httpServer.close(); // (2) on n'accepte plus de connexions
    // (3) on laisse finir les rendus en vol, borne par le delai de grace
    const deadline = Date.now() + SHUTDOWN_GRACE_MS;
    while (activeRenderCount() > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
  } finally {
    shutdownRenders(); // (4) tue les rendus encore en vol -> aucun Chrome orphelin
    process.exit(0);
  }
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
