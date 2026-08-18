// Tests unitaires LinkedIn : config + construction de l'URL OAuth (pas d'appel
// réseau — les appels API LinkedIn ne sont pas testables sans credentials).
import test from "node:test";
import assert from "node:assert/strict";
import * as li from "../src/linkedin.mjs";

function withEnv(env, fn) {
  const saved = {};
  for (const k of Object.keys(env)) {
    saved[k] = process.env[k];
    if (env[k] === undefined) delete process.env[k];
    else process.env[k] = env[k];
  }
  try {
    return fn();
  } finally {
    for (const k of Object.keys(env)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

test("isConfigured false sans credentials", () => {
  withEnv({ LINKEDIN_CLIENT_ID: undefined, LINKEDIN_CLIENT_SECRET: undefined }, () => {
    assert.equal(li.isConfigured(), false);
  });
});

test("authorizeUrl throw si non configuré", () => {
  withEnv({ LINKEDIN_CLIENT_ID: undefined, LINKEDIN_CLIENT_SECRET: undefined }, () => {
    assert.throws(() => li.authorizeUrl("st"), /non configuré/);
  });
});

test("authorizeUrl bien formée avec credentials", () => {
  withEnv(
    { LINKEDIN_CLIENT_ID: "cid123", LINKEDIN_CLIENT_SECRET: "secret", PUBLIC_URL: "https://mcp.stacko.fr", LINKEDIN_REDIRECT_URI: undefined, LINKEDIN_SCOPES: undefined },
    () => {
      const u = new URL(li.authorizeUrl("state_abc"));
      assert.equal(u.origin + u.pathname, "https://www.linkedin.com/oauth/v2/authorization");
      assert.equal(u.searchParams.get("response_type"), "code");
      assert.equal(u.searchParams.get("client_id"), "cid123");
      assert.equal(u.searchParams.get("redirect_uri"), "https://mcp.stacko.fr/demo/linkedin/callback");
      assert.equal(u.searchParams.get("state"), "state_abc");
      assert.match(u.searchParams.get("scope"), /w_member_social/);
    }
  );
});

test("LINKEDIN_REDIRECT_URI override respecté", () => {
  withEnv(
    { LINKEDIN_CLIENT_ID: "c", LINKEDIN_CLIENT_SECRET: "s", LINKEDIN_REDIRECT_URI: "https://demo.example/cb" },
    () => {
      const u = new URL(li.authorizeUrl("x"));
      assert.equal(u.searchParams.get("redirect_uri"), "https://demo.example/cb");
    }
  );
});

// Mock de global.fetch pour tester getSocialActions sans réseau.
async function withFetch(stub, fn) {
  const real = global.fetch;
  global.fetch = stub;
  try {
    return await fn();
  } finally {
    global.fetch = real;
  }
}

test("getSocialActions : URN manquant -> throw", async () => {
  await assert.rejects(() => li.getSocialActions("tok", ""), /URN/);
});

test("getSocialActions : 403 -> erreur pending (en attente d'accès)", async () => {
  await withFetch(async () => ({ status: 403, ok: false, text: async () => "denied" }), async () => {
    await assert.rejects(
      () => li.getSocialActions("tok", "urn:li:share:123"),
      (e) => e.pending === true
    );
  });
});

test("getSocialActions : 200 -> parse likes + commentaires", async () => {
  await withFetch(
    async () => ({ status: 200, ok: true, json: async () => ({ likesSummary: { totalLikes: 7 }, commentsSummary: { count: 2 } }) }),
    async () => {
      const s = await li.getSocialActions("tok", "urn:li:share:123");
      assert.equal(s.likes, 7);
      assert.equal(s.comments, 2);
    }
  );
});

test("publishDocument : registerUpload -> PUT PDF -> ugcPost DOCUMENT, renvoie id/url", async () => {
  const calls = [];
  const stub = async (url, opts) => {
    const u = String(url);
    calls.push(u);
    if (u.includes("registerUpload")) {
      return {
        ok: true,
        json: async () => ({
          value: {
            asset: "urn:li:digitalmediaAsset:doc123",
            uploadMechanism: {
              "com.linkedin.digitalmedia.uploading.MediaUploadHttpRequest": { uploadUrl: "https://upload.linkedin/doc" },
            },
          },
        }),
      };
    }
    if (u === "https://upload.linkedin/doc") {
      assert.equal(opts.method, "PUT");
      assert.equal(opts.headers["content-type"], "application/pdf");
      return { ok: true };
    }
    if (u.includes("ugcPosts")) {
      // Vérifie qu'on poste bien en catégorie DOCUMENT avec l'asset uploadé.
      const body = JSON.parse(opts.body);
      const share = body.specificContent["com.linkedin.ugc.ShareContent"];
      assert.equal(share.shareMediaCategory, "DOCUMENT");
      assert.equal(share.media[0].media, "urn:li:digitalmediaAsset:doc123");
      return { ok: true, headers: { get: () => "urn:li:share:doc999" }, json: async () => ({}) };
    }
    throw new Error("URL inattendue: " + u);
  };

  await withFetch(stub, async () => {
    const out = await li.publishDocument("tok", "urn:li:person:x", "Mon carrousel", Buffer.from("%PDF-fake"), "Titre");
    assert.equal(out.id, "urn:li:share:doc999");
    assert.match(out.url, /feed\/update\/urn:li:share:doc999/);
  });
  // Les 3 étapes ont bien été appelées dans l'ordre.
  assert.equal(calls.length, 3);
});
