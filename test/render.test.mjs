// Smoke de rendu : Chrome doit produire un fichier non-vide. Depend d'un binaire
// chromium ; si absent (CI sans navigateur), le test se skip proprement.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { render } from "../src/render.mjs";

const CHROME_BIN =
  process.env.CHROME_BIN ||
  (process.platform === "win32"
    ? "C:/Program Files/Google/Chrome/Application/chrome.exe"
    : "chromium");

// chromium peut etre sur le PATH sans chemin absolu : on ne skip que si un chemin
// absolu est donne mais introuvable.
const looksAbsolute = /[\\/]/.test(CHROME_BIN);
const chromeMissing = looksAbsolute && !existsSync(CHROME_BIN);
const skip = chromeMissing ? `chrome introuvable (${CHROME_BIN})` : false;

const V = { bg: "#111", fg: "#fff", accent: "#f80", accent2: "#08f", width: 1080, height: 1350 };

test("render png produit un PNG non-vide", { skip }, async () => {
  const out = await render([{ titre: "Bonjour", corps: "test" }], V, "png");
  assert.equal(out.mimeType, "image/png");
  const buf = Buffer.from(out.base64, "base64");
  assert.ok(buf.length > 1000, "PNG trop petit / vide");
  // Signature PNG.
  assert.equal(buf.slice(0, 4).toString("hex"), "89504e47");
});

test("render pdf produit un PDF non-vide", { skip }, async () => {
  const out = await render(
    [{ titre: "S1" }, { titre: "S2", corps: "corps" }],
    V,
    "pdf"
  );
  assert.equal(out.mimeType, "application/pdf");
  assert.equal(out.slides, 2);
  const buf = Buffer.from(out.base64, "base64");
  assert.ok(buf.length > 500, "PDF trop petit / vide");
  assert.equal(buf.slice(0, 4).toString(), "%PDF");
});

test("render remonte une erreur si le binaire chrome est invalide", async () => {
  const prev = process.env.CHROME_BIN;
  process.env.CHROME_BIN = "/chemin/inexistant/chrome-bidon";
  // Le module lit CHROME_BIN au chargement -> on teste via un import frais.
  const mod = await import(`../src/render.mjs?bust=${Date.now()}`);
  await assert.rejects(() => mod.render([{ titre: "x" }], V, "png"));
  if (prev === undefined) delete process.env.CHROME_BIN;
  else process.env.CHROME_BIN = prev;
});
