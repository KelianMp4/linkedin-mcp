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
