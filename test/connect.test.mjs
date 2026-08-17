// Flow connect_linkedin cote MCP : state a usage unique -> callback -> stockage
// du token LinkedIn dans data/<token>/linkedin.json. On fixe DATA_DIR + les creds
// LinkedIn AVANT d'importer (store et linkedin lisent l'env au chargement).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DATA = await mkdtemp(join(tmpdir(), "lkm-connect-"));
process.env.DATA_DIR = DATA;
process.env.LINKEDIN_CLIENT_ID = "cid";
process.env.LINKEDIN_CLIENT_SECRET = "secret";
process.env.PUBLIC_URL = "https://mcp.stacko.fr";

const store = await import("../src/store.mjs");
const connect = await import("../src/connect.mjs");

async function withFetch(stub, fn) {
  const real = global.fetch;
  global.fetch = stub;
  try {
    return await fn();
  } finally {
    global.fetch = real;
  }
}

test("startLinkedinConnect : URL LinkedIn avec un state prefixe mcpc_", () => {
  const t = "lkm_fake";
  const { url, state } = connect.startLinkedinConnect(t);
  assert.ok(state.startsWith("mcpc_"));
  const u = new URL(url);
  assert.equal(u.origin + u.pathname, "https://www.linkedin.com/oauth/v2/authorization");
  assert.equal(u.searchParams.get("state"), state);
  assert.equal(connect.isConnectState(state), true);
  assert.equal(connect.isConnectState("mcpc_inexistant"), false);
});

test("completeLinkedinConnect : echange le code et stocke le token par client", async () => {
  const token = await store.mintToken("Client Connect");
  const { state } = connect.startLinkedinConnect(token);

  const stub = async (u) => {
    if (String(u).includes("accessToken")) {
      return { ok: true, json: async () => ({ access_token: "AT123", expires_in: 3600, scope: "w_member_social" }) };
    }
    if (String(u).includes("userinfo")) {
      return { ok: true, json: async () => ({ sub: "abc", name: "Jane Member" }) };
    }
    throw new Error("URL inattendue: " + u);
  };

  const out = await withFetch(stub, () => connect.completeLinkedinConnect({ code: "the_code", state }));
  assert.equal(out.client, "Client Connect");
  assert.equal(out.name, "Jane Member");

  // Le token est stocke dans le dossier du client.
  const ctx = await store.resolveToken(token);
  const li = await store.getLinkedin(ctx);
  assert.equal(li.accessToken, "AT123");
  assert.equal(li.urn, "urn:li:person:abc");
  assert.equal(li.name, "Jane Member");

  // State a usage unique : un 2e appel echoue.
  assert.equal(connect.isConnectState(state), false);
  await assert.rejects(() => connect.completeLinkedinConnect({ code: "x", state }), /inconnu ou expire/);
});

test("completeLinkedinConnect : state inconnu -> throw", async () => {
  await assert.rejects(() => connect.completeLinkedinConnect({ code: "x", state: "mcpc_nope" }), /inconnu ou expire/);
});
