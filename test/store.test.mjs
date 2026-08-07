// Isolation par token = le test le plus important (securite multi-client).
// On fixe DATA_DIR AVANT d'importer le store (il lit l'env au chargement).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DATA = await mkdtemp(join(tmpdir(), "lkm-store-"));
process.env.DATA_DIR = DATA;
const store = await import("../src/store.mjs");

test("resolveToken renvoie null pour un token inconnu", async () => {
  assert.equal(await store.resolveToken("lkm_inconnu"), null);
});

test("un token minte se resout vers son propre dossier", async () => {
  const t = await store.mintToken("Client A");
  const ctx = await store.resolveToken(t);
  assert.ok(ctx);
  assert.equal(ctx.client, "Client A");
  assert.ok(ctx.dir.includes(t));
});

test("ISOLATION : le brand de A n'est pas lisible via le contexte de B", async () => {
  const ta = await store.mintToken("A");
  const tb = await store.mintToken("B");
  const ca = await store.resolveToken(ta);
  const cb = await store.resolveToken(tb);

  await store.setBrand(ca, { voice: { registre: "secret-A" }, visual: {} });
  await store.setBrand(cb, { voice: { registre: "public-B" }, visual: {} });

  const brandB = await store.getBrand(cb);
  assert.equal(brandB.voice.registre, "public-B");
  assert.notEqual(brandB.voice.registre, "secret-A");
  assert.ok(ca.dir !== cb.dir, "chaque client a un dossier distinct");
});

test("getBrand renvoie la charte neutre (_default) sans brand.json", async () => {
  const t = await store.mintToken("Neuf");
  const ctx = await store.resolveToken(t);
  const b = await store.getBrand(ctx);
  assert.equal(b._default, true);
  assert.ok(b.visual.width > 0);
});

test("updateVisual pose un champ sans ecraser la voix", async () => {
  const t = await store.mintToken("Fonts");
  const ctx = await store.resolveToken(t);
  await store.setBrand(ctx, { voice: { registre: "manifeste" }, visual: { bg: "#000" } });
  await store.updateVisual(ctx, { titleFontFile: "title.woff2" });
  const b = await store.getBrand(ctx);
  assert.equal(b.visual.titleFontFile, "title.woff2");
  assert.equal(b.visual.bg, "#000");
  assert.equal(b.voice.registre, "manifeste");
});

test("append/list posts fait un roundtrip", async () => {
  const t = await store.mintToken("Suivi");
  const ctx = await store.resolveToken(t);
  await store.appendPost(ctx, { date: "2026-09-01", theme: "lancement" });
  const n = await store.appendPost(ctx, { date: "2026-09-02", theme: "preuve" });
  assert.equal(n, 2);
  const hist = await store.listPosts(ctx);
  assert.equal(hist.length, 2);
  assert.equal(hist[0].theme, "lancement");
});
