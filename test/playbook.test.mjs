import test from "node:test";
import assert from "node:assert/strict";
import { playbook } from "../src/playbook.mjs";

test("le playbook porte la voix et les regles de la marque", () => {
  const out = playbook({
    client: "Stacko-leads",
    voice: { registre: "manifeste", langue: "fr", regles: ["Jamais de tiret cadratin"] },
  });
  assert.ok(out.includes("Stacko-leads"));
  assert.ok(out.includes("manifeste"));
  assert.ok(out.includes("Jamais de tiret cadratin"));
});

test("le playbook expose les faits produit quand ils existent", () => {
  const out = playbook({
    client: "X",
    voice: { produit: { nom: "Stacko-leads", pitch: "listes B2B", preuve: "moins de 10% mort" } },
  });
  assert.ok(out.includes("# Produit"));
  assert.ok(out.includes("Stacko-leads"));
  assert.ok(out.includes("moins de 10% mort"));
});

test("le playbook guide vers register_font pour la police", () => {
  const out = playbook({ client: "X", voice: {} });
  assert.ok(out.includes("register_font"));
});

test("sans identite, le playbook renvoie vers setup_brand (_default)", () => {
  const out = playbook({ client: "X", voice: {}, _default: true });
  assert.ok(out.includes("setup_brand"));
});
