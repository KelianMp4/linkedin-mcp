// Tests du linter deterministe : chaque regle de canal, plus les stats.
import test from "node:test";
import assert from "node:assert/strict";
import { lintPost } from "../src/lint.mjs";

test("post propre : ok, aucune erreur ni avertissement", () => {
  const r = lintPost("Accroche courte et forte.\n\nDeux idees claires.\n\nLien en commentaire.");
  assert.equal(r.ok, true);
  assert.equal(r.errors, 0);
  assert.equal(r.warnings, 0);
});

test("post vide (que du blanc) -> erreur bloquante hook", () => {
  const r = lintPost("   \n  \n");
  assert.equal(r.ok, false);
  assert.ok(r.issues.some((i) => i.rule === "hook" && i.level === "error"));
});

test("accroche trop longue -> avertissement hook", () => {
  const long = "x".repeat(140);
  const r = lintPost(long + "\ncorps");
  assert.ok(r.issues.some((i) => i.rule === "hook" && i.level === "warn"));
});

test("lien dans le corps -> erreur no-link", () => {
  const r = lintPost("Accroche.\n\nVoir https://exemple.com pour la suite.");
  assert.equal(r.ok, false);
  assert.ok(r.issues.some((i) => i.rule === "no-link" && i.level === "error"));
});

test("domaine en clair -> erreur no-link", () => {
  const r = lintPost("Accroche.\n\nRendez-vous sur stacko.fr.");
  assert.ok(r.issues.some((i) => i.rule === "no-link"));
});

test("tiret cadratin -> avertissement em-dash", () => {
  const r = lintPost("Accroche — la promesse.\n\nCorps.");
  assert.ok(r.issues.some((i) => i.rule === "em-dash" && i.level === "warn"));
});

test("trait d'union simple : pas de faux positif em-dash", () => {
  const r = lintPost("Accroche bien-pensee.\n\nCorps sans souci.");
  assert.ok(!r.issues.some((i) => i.rule === "em-dash"));
});

test("post long -> info fold, mais reste ok (non bloquant)", () => {
  const r = lintPost("Accroche.\n\n" + "mot ".repeat(120));
  assert.equal(r.ok, true);
  assert.ok(r.issues.some((i) => i.rule === "fold" && i.level === "info"));
  assert.ok(r.stats.chars > r.stats.foldAt);
});

test("stats : compte les caracteres et la longueur d'accroche", () => {
  const r = lintPost("Bonjour\ncorps");
  assert.equal(r.stats.firstLineChars, 7);
  assert.equal(r.stats.chars, "Bonjour\ncorps".length);
});
