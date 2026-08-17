// Analyse déterministe de l'historique : agrégats, garde-fou "pas assez de données",
// et condensé injecté au playbook.
import test from "node:test";
import assert from "node:assert/strict";
import { analyzePosts, summarizeAnalysis, playbookInsights } from "../src/analyze.mjs";

test("historique vide -> count 0, résumé neutre, aucun insight", () => {
  const a = analyzePosts([]);
  assert.equal(a.count, 0);
  assert.match(summarizeAnalysis(a), /Aucun post/i);
  assert.equal(playbookInsights(a), null);
});

test("< 3 posts avec métriques -> pas de tendance, pas d'insight (jamais de fausse certitude)", () => {
  const a = analyzePosts([
    { date: "2026-09-01", theme: "x", format: "texte", metriques: { reactions: 10 } },
    { date: "2026-09-02", theme: "y", format: "image" }, // sans métriques
  ]);
  assert.equal(a.count, 2);
  assert.equal(a.withMetrics, 1);
  assert.match(summarizeAnalysis(a), /pas encore assez/i);
  assert.equal(playbookInsights(a), null);
});

test("classe les formats par engagement moyen et pondère la conversation", () => {
  const hist = [
    { date: "2026-09-01", theme: "a", format: "carrousel", metriques: { reactions: 10, commentaires: 10 } }, // 30
    { date: "2026-09-03", theme: "b", format: "carrousel", metriques: { reactions: 20, commentaires: 5 } }, // 30
    { date: "2026-09-05", theme: "c", format: "texte", metriques: { reactions: 5 } }, // 5
  ];
  const a = analyzePosts(hist);
  assert.equal(a.withMetrics, 3);
  assert.equal(a.byFormat[0].key, "carrousel");
  assert.equal(a.byFormat[0].avgScore, 30);
  assert.equal(a.byFormat[a.byFormat.length - 1].key, "texte");
  // Meilleur post : score max (carrousel avec commentaires).
  assert.equal(a.best.format, "carrousel");
});

test("cadence : posts par semaine sur la période", () => {
  const a = analyzePosts([
    { date: "2026-09-01", theme: "a", metriques: { reactions: 1 } },
    { date: "2026-09-08", theme: "b", metriques: { reactions: 1 } },
    { date: "2026-09-15", theme: "c", metriques: { reactions: 1 } },
  ]);
  assert.equal(a.cadence.first, "2026-09-01");
  assert.equal(a.cadence.last, "2026-09-15");
  assert.equal(a.cadence.spanDays, 14);
  assert.equal(a.cadence.perWeek, 1.5); // 3 posts sur 2 semaines
});

test("playbookInsights : recos actionnables quand assez de données", () => {
  const hist = [
    { date: "2026-09-01", theme: "preuve", format: "carrousel", metriques: { reactions: 30, commentaires: 10 } },
    { date: "2026-09-03", theme: "preuve", format: "carrousel", metriques: { reactions: 25, commentaires: 8 } },
    { date: "2026-09-05", theme: "annonce", format: "texte", metriques: { reactions: 3 } },
  ];
  const ins = playbookInsights(analyzePosts(hist));
  assert.ok(Array.isArray(ins) && ins.length > 0);
  assert.ok(ins.some((s) => /carrousel/i.test(s)), "recommande le format gagnant");
  assert.ok(ins.some((s) => /preuve/i.test(s)), "cite le thème gagnant");
});

test("robustesse : entrées non-objet ignorées", () => {
  const a = analyzePosts([null, 42, { date: "2026-09-01", theme: "ok", metriques: { reactions: 1 } }]);
  assert.equal(a.count, 1);
});
