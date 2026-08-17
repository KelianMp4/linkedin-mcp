// Isolation par token = le test le plus important (securite multi-client).
// On fixe DATA_DIR AVANT d'importer le store (il lit l'env au chargement).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, readFile } from "node:fs/promises";
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

test("RGPD art. 17 : deleteClientData efface le dossier et invalide le token", async () => {
  const t = await store.mintToken("A effacer");
  const ctx = await store.resolveToken(t);
  await store.setBrand(ctx, { voice: { registre: "sensible" }, visual: {} });

  const out = await store.deleteClientData(t);
  assert.equal(out.removed, true);
  assert.equal(out.client, "A effacer");

  // Token invalide apres suppression : resolveToken renvoie null.
  assert.equal(await store.resolveToken(t), null);
  // Absent du registre.
  const reg = await store.loadRegistry();
  assert.equal(reg[t], undefined);
});

test("deleteClientData sur token inconnu ne casse pas (removed=false)", async () => {
  const out = await store.deleteClientData("lkm_jamais_vu");
  assert.equal(out.removed, false);
  assert.equal(out.client, null);
});

test("updateBrand : patch partiel fusionne sans ecraser + archive l'ancienne version", async () => {
  const t = await store.mintToken("Patch");
  const ctx = await store.resolveToken(t);
  await store.setBrand(ctx, {
    voice: { registre: "sobre", produit: { nom: "P", prix: "49" } },
    visual: { bg: "#000", fg: "#fff" },
  });

  await store.updateBrand(ctx, { voice: { produit: { prix: "59" } }, visual: { accent: "#f00" } });

  const b = await store.getBrand(ctx);
  assert.equal(b.voice.registre, "sobre", "champ non touche conserve");
  assert.equal(b.voice.produit.nom, "P", "sous-objet non touche conserve");
  assert.equal(b.voice.produit.prix, "59", "champ imbrique patche");
  assert.equal(b.visual.bg, "#000");
  assert.equal(b.visual.accent, "#f00");
  assert.ok(b.updatedAt, "updatedAt pose");

  // Version precedente archivee.
  const hist = await import("node:fs/promises").then((fs) =>
    fs.readFile(join(ctx.dir, "brand_history.json"), "utf8")
  );
  const arr = JSON.parse(hist);
  assert.equal(arr.length, 1);
  assert.equal(arr[0].brand.voice.produit.prix, "49");
});

test("updatePost : met a jour les metriques d'un post loggue par id", async () => {
  const t = await store.mintToken("Metrics");
  const ctx = await store.resolveToken(t);
  await store.appendPost(ctx, { date: "2026-09-01", theme: "lancement" });

  const out = await store.updatePost(ctx, 1, { metriques: { vues: 1200, reactions: 40 }, resultat_business: "3 DM" });
  assert.equal(out.ok, true);
  const hist = await store.listPosts(ctx);
  assert.equal(hist[0].metriques.vues, 1200);
  assert.equal(hist[0].metriques.reactions, 40);
  assert.equal(hist[0].resultat_business, "3 DM");
  assert.equal(hist[0].theme, "lancement", "champs existants conserves");
});

test("updatePost : id hors bornes -> ok=false", async () => {
  const t = await store.mintToken("MetricsKo");
  const ctx = await store.resolveToken(t);
  await store.appendPost(ctx, { date: "2026-09-01", theme: "x" });
  const out = await store.updatePost(ctx, 9, { metriques: { vues: 1 } });
  assert.equal(out.ok, false);
  assert.equal(out.count, 1);
});

test("setLinkedin/getLinkedin : roundtrip, efface avec le dossier client", async () => {
  const t = await store.mintToken("LI");
  const ctx = await store.resolveToken(t);
  assert.equal(await store.getLinkedin(ctx), null);
  await store.setLinkedin(ctx, { accessToken: "AT", urn: "urn:li:person:z", name: "N" });
  const li = await store.getLinkedin(ctx);
  assert.equal(li.accessToken, "AT");
  assert.equal(li.urn, "urn:li:person:z");

  // Le droit a l'effacement emporte aussi linkedin.json (efface tout le dossier).
  await store.deleteClientData(t);
  assert.equal(await store.resolveToken(t), null);
});

// --- Concurrence : le mutex par token empeche les pertes d'ecriture ---

test("CONCURRENCE : N appends simultanes ne perdent aucune entree", async () => {
  const t = await store.mintToken("Concurrent");
  const ctx = await store.resolveToken(t);
  const N = 20;

  await Promise.all(
    Array.from({ length: N }, (_, i) =>
      store.appendPost(ctx, { date: "2026-09-01", theme: "post-" + i })
    )
  );

  const hist = await store.listPosts(ctx);
  assert.equal(hist.length, N, "aucune perte : longueur == N");
  // Toutes les entrees distinctes sont bien presentes (aucun clobber).
  const themes = new Set(hist.map((h) => h.theme));
  assert.equal(themes.size, N);

  // history.json est un JSON valide et parseable.
  const raw = await readFile(join(ctx.dir, "history.json"), "utf8");
  assert.doesNotThrow(() => JSON.parse(raw));
});

test("CONCURRENCE : updateVisual simultanes conservent toutes les cles", async () => {
  const t = await store.mintToken("VisualConcurrent");
  const ctx = await store.resolveToken(t);
  await store.setBrand(ctx, { voice: { registre: "manifeste" }, visual: { bg: "#000" } });

  await Promise.all([
    store.updateVisual(ctx, { k1: "v1" }),
    store.updateVisual(ctx, { k2: "v2" }),
    store.updateVisual(ctx, { k3: "v3" }),
    store.updateVisual(ctx, { k4: "v4" }),
    store.updateVisual(ctx, { k5: "v5" }),
  ]);

  const b = await store.getBrand(ctx);
  for (const [k, v] of Object.entries({ k1: "v1", k2: "v2", k3: "v3", k4: "v4", k5: "v5" })) {
    assert.equal(b.visual[k], v, `cle ${k} preservee`);
  }
  // La voix et le champ initial ne sont pas ecrases.
  assert.equal(b.voice.registre, "manifeste");
  assert.equal(b.visual.bg, "#000");
});

test("ATOMICITE : pas de residu .tmp apres des ecritures concurrentes", async () => {
  const t = await store.mintToken("NoResidu");
  const ctx = await store.resolveToken(t);

  await Promise.all([
    ...Array.from({ length: 10 }, (_, i) => store.appendPost(ctx, { i })),
    store.updateVisual(ctx, { x: "1" }),
    store.updateVisual(ctx, { y: "2" }),
  ]);

  const files = await readdir(ctx.dir);
  const residus = files.filter((f) => f.includes(".tmp"));
  assert.deepEqual(residus, [], "aucun fichier .tmp laisse derriere");
});
