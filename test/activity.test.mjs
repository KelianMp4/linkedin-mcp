// KPI d'activité / rétention : agrégation déterministe (horloge injectée).
import test from "node:test";
import assert from "node:assert/strict";
import { activityReport, formatActivity } from "../src/activity.mjs";

// Horloge fixe : 2026-09-15T12:00:00Z.
const NOW = Date.parse("2026-09-15T12:00:00Z");

test("aucun client -> rapport vide", () => {
  const r = activityReport([], NOW);
  assert.equal(r.clients, 0);
  assert.equal(r.activeWeekly, 0);
  assert.equal(r.retentionWeekly, 0);
  assert.match(formatActivity(r), /Aucun client/);
});

test("compte les posts sur 7 et 30 jours, ignore les futurs et les non-datés", () => {
  const r = activityReport(
    [
      {
        client: "Actif",
        posts: [
          { date: "2026-09-14" }, // hier -> 7j & 30j
          { date: "2026-09-01" }, // 14j -> 30j seulement
          { date: "2026-07-01" }, // >30j -> total seulement
          { date: "2026-12-01" }, // futur -> ignoré
          { theme: "sans date" }, // non daté -> ignoré (des comptes)
        ],
      },
    ],
    NOW
  );
  const row = r.rows[0];
  assert.equal(row.last7, 1);
  assert.equal(row.last30, 2);
  assert.equal(row.total, 5); // total = longueur brute de l'historique
  assert.equal(row.lastDate, "2026-09-14"); // dernier post daté passé
  assert.equal(row.active, true);
});

test("rétention hebdo : proportion de clients ayant posté cette semaine", () => {
  const r = activityReport(
    [
      { client: "A", posts: [{ date: "2026-09-15" }] }, // aujourd'hui -> actif
      { client: "B", posts: [{ date: "2026-08-01" }] }, // vieux -> inactif
      { client: "C", posts: [] }, // jamais -> inactif
      { client: "D", posts: [{ date: "2026-09-10" }] }, // 5j -> actif
    ],
    NOW
  );
  assert.equal(r.clients, 4);
  assert.equal(r.activeWeekly, 2);
  assert.equal(r.retentionWeekly, 50);
});

test("tri : les plus actifs (7j) d'abord", () => {
  const r = activityReport(
    [
      { client: "Peu", posts: [{ date: "2026-09-14" }] },
      { client: "Beaucoup", posts: [{ date: "2026-09-14" }, { date: "2026-09-13" }, { date: "2026-09-12" }] },
    ],
    NOW
  );
  assert.equal(r.rows[0].client, "Beaucoup");
  assert.equal(r.rows[1].client, "Peu");
});

test("formatActivity : en-tête rétention + une ligne par client", () => {
  const out = formatActivity(
    activityReport([{ client: "A", posts: [{ date: "2026-09-15" }] }], NOW)
  );
  assert.match(out, /actifs cette semaine : 1/);
  assert.match(out, /A /);
});
