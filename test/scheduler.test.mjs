// Sélection des jobs dus + validation de la date (pur, horloge injectée).
import test from "node:test";
import assert from "node:assert/strict";
import { dueJobs, validateWhen } from "../src/scheduler.mjs";

const NOW = Date.parse("2026-09-15T12:00:00Z");

test("dueJobs : ne renvoie que les pending échus, triés par échéance", () => {
  const jobs = [
    { id: "a", status: "pending", when: "2026-09-15T10:00:00Z" }, // échu
    { id: "b", status: "pending", when: "2026-09-15T09:00:00Z" }, // échu, plus tôt
    { id: "c", status: "pending", when: "2026-09-16T00:00:00Z" }, // futur
    { id: "d", status: "sent", when: "2026-09-14T00:00:00Z" }, // déjà envoyé
    { id: "e", status: "canceled", when: "2026-09-14T00:00:00Z" }, // annulé
  ];
  const due = dueJobs(jobs, NOW);
  assert.deepEqual(due.map((j) => j.id), ["b", "a"]);
});

test("dueJobs : date invalide -> jamais due (ne part pas toute seule)", () => {
  const due = dueJobs([{ id: "x", status: "pending", when: "pas une date" }], NOW);
  assert.deepEqual(due, []);
});

test("dueJobs : entrée non-tableau -> []", () => {
  assert.deepEqual(dueJobs(null, NOW), []);
});

test("validateWhen : refuse une date invalide", () => {
  const v = validateWhen("bidon", NOW);
  assert.equal(v.ok, false);
  assert.match(v.error, /ISO 8601/);
});

test("validateWhen : refuse une date passée", () => {
  const v = validateWhen("2026-09-15T11:00:00Z", NOW);
  assert.equal(v.ok, false);
  assert.match(v.error, /passée/);
});

test("validateWhen : accepte le futur et normalise en ISO", () => {
  const v = validateWhen("2026-09-20T09:00:00Z", NOW);
  assert.equal(v.ok, true);
  assert.equal(v.when, "2026-09-20T09:00:00.000Z");
});
