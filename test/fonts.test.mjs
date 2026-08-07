// Garde-fou SSRF : le serveur fetch une URL fournie par le client. On verifie
// qu'il refuse http et les adresses internes. (Pas de fetch reseau reel ici.)
import test from "node:test";
import assert from "node:assert/strict";
import { assertSafeUrl, resolveFont } from "../src/fonts.mjs";

test("assertSafeUrl refuse le http (https only)", async () => {
  await assert.rejects(() => assertSafeUrl("http://fonts.gstatic.com/x.woff2"), /https/);
});

test("assertSafeUrl refuse localhost (adresse interne, anti-SSRF)", async () => {
  await assert.rejects(() => assertSafeUrl("https://localhost/x.woff2"), /interne/);
});

test("assertSafeUrl refuse une IP privee 127.0.0.1", async () => {
  await assert.rejects(() => assertSafeUrl("https://127.0.0.1/x.woff2"), /interne/);
});

test("assertSafeUrl refuse une URL malformee", async () => {
  await assert.rejects(() => assertSafeUrl("pas-une-url"), /invalide|https/);
});

test("resolveFont refuse une source vide", async () => {
  await assert.rejects(() => resolveFont("   "), /vide/);
});
