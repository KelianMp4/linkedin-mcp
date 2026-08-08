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
import { render } from "./render.mjs";
import { registerFont } from "./fonts.mjs";
import { playbook } from "./playbook.mjs";
import { createOAuth } from "./oauth.mjs";
import { demoRouter } from "./demo.mjs";
import {
  resolveToken,
  getBrand,
  setBrand,
  updateVisual,
  appendPost,
  listPosts,
  listTokens,
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
  const server = new McpServer({ name: "linkedin-mcp", version: "0.1.0" });

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

// Surface web de démo (review LinkedIn) : /demo/*. Login de test + OAuth LinkedIn.
app.use(demoRouter());

app.get("/health", async (_req, res) => {
  res.json({ ok: true, clients: (await listTokens()).length });
});

// Sessions Streamable HTTP : le client s'initialise (Bearer token verifie a ce
// moment => identite figee pour la session), puis reutilise le mcp-session-id.
const transports = {};

async function tokenCtx(req) {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  // Double chemin : lkm_ brut (Claude Code) OU access token OAuth (Desktop/web).
  return token ? oauth.resolveBearer(token) : null;
}

app.post("/mcp", async (req, res) => {
  const sid = req.headers["mcp-session-id"];
  let transport = sid ? transports[sid] : undefined;

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
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        transports[id] = transport;
      },
    });
    transport.onclose = () => {
      if (transport.sessionId) delete transports[transport.sessionId];
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
  const transport = sid ? transports[sid] : undefined;
  if (!transport) {
    res.status(400).send("no valid session");
    return;
  }
  await transport.handleRequest(req, res);
}
app.get("/mcp", replaySession);
app.delete("/mcp", replaySession);

app.listen(PORT, () => {
  console.log(`[linkedin-mcp] up on :${PORT}`);
});
