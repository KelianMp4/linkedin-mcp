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
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { render } from "./render.mjs";
import {
  resolveToken,
  getBrand,
  setBrand,
  appendPost,
  listPosts,
  listTokens,
} from "./store.mjs";

const PORT = Number(process.env.PORT || 3000);

// Methode de redaction fournie au Claude du client (il redige, pas le serveur).
function playbook(brand) {
  const v = brand.voice || {};
  const p = v.produit || {};
  const lines = [
    `Tu rediges un post LinkedIn pour la marque "${brand.client}".`,
    ``,
    `# Voix`,
    `Registre : ${v.registre || "sobre"}. Langue : ${v.langue || "fr"}.`,
  ];
  if ((v.regles || []).length) {
    lines.push(`Regles non negociables :`, ...v.regles.map((r) => `- ${r}`));
  }
  if (p.nom) {
    lines.push(
      ``,
      `# Produit`,
      `Nom : ${p.nom}. Pitch : ${p.pitch || ""}.`,
      `Cible : ${p.cible || ""}. Prix : ${p.prix || ""}. URL : ${p.url || ""}.`,
      p.preuve ? `Preuve a citer : ${p.preuve}.` : ``
    );
  }
  lines.push(
    ``,
    `# Bonnes pratiques canal (dures)`,
    `1. Accroche forte en premiere ligne. Jamais de lien dans le corps (algo -30/-60%) : finir par "Lien en commentaire".`,
    `2. Preuve par les chiffres, pas de jargon.`,
    `3. Fin orientee conversation (question / invitation au DM), jamais un lien externe. Le DM vend.`,
    ``,
    `Visuel : appelle render_carousel (plan de slides) ou render_image (une slide).`,
    `Apres publication, loggue avec log_post (metriques saisies a la main, jamais inventees).`
  );
  if (brand._default) {
    lines.push(
      ``,
      `NOTE : aucune identite de marque enregistree. Lance d'abord l'outil setup_brand ` +
        `pour capturer voix + charte, sinon les visuels sortent en charte neutre.`
    );
  }
  return lines.filter((l) => l !== undefined).join("\n");
}

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
    async ({ slides }) => {
      const brand = await getBrand(ctx);
      const out = await render(slides, brand.visual, "pdf");
      return {
        content: [
          { type: "text", text: `Carrousel rendu : ${out.slides} slides, ${brand.client}.` },
          { type: "resource", resource: { uri: "carousel.pdf", mimeType: out.mimeType, blob: out.base64 } },
        ],
      };
    }
  );

  server.registerTool(
    "render_image",
    {
      title: "Rendu image seule (PNG on-brand)",
      description: "Rend une image LinkedIn seule (1080x1350) on-brand en PNG.",
      inputSchema: { slide: slideShape },
    },
    async ({ slide }) => {
      const brand = await getBrand(ctx);
      const out = await render([slide], brand.visual, "png");
      return {
        content: [
          { type: "text", text: `Image rendue : ${brand.client}.` },
          { type: "resource", resource: { uri: "image.png", mimeType: out.mimeType, blob: out.base64 } },
        ],
      };
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

app.get("/health", async (_req, res) => {
  res.json({ ok: true, clients: (await listTokens()).length });
});

// Sessions Streamable HTTP : le client s'initialise (Bearer token verifie a ce
// moment => identite figee pour la session), puis reutilise le mcp-session-id.
const transports = {};

async function tokenCtx(req) {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  return token ? resolveToken(token) : null;
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
