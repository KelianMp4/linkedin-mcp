// Store de sessions MCP : TTL d'inactivite + plafond LRU. Horloge injectee pour
// un test deterministe (aucun minuteur reel).
import test from "node:test";
import assert from "node:assert/strict";
import { createSessionStore } from "../src/sessions.mjs";

// Fabrique une horloge pilotable.
function fakeClock(start = 0) {
  let t = start;
  return { now: () => t, advance: (ms) => (t += ms) };
}

test("set/get : get rafraichit l'activite (touch implicite)", () => {
  const clk = fakeClock();
  const s = createSessionStore({ ttlMs: 1000, max: 10, now: clk.now });
  s.set("a", { id: "a" });
  clk.advance(900);
  assert.equal(s.get("a").id, "a"); // touch -> lastSeen = 900
  clk.advance(900); // 1800 total, mais 900 depuis le dernier touch < ttl
  assert.deepEqual(s.reapExpired(), []);
  assert.equal(s.has("a"), true);
});

test("reapExpired : retire et renvoie les sessions inactives depuis > ttl", () => {
  const clk = fakeClock();
  const s = createSessionStore({ ttlMs: 1000, max: 10, now: clk.now });
  s.set("vieux", { id: "vieux" });
  clk.advance(500);
  s.set("recent", { id: "recent" });
  clk.advance(600); // vieux inactif depuis 1100 (> ttl), recent depuis 600 (< ttl)

  const dead = s.reapExpired();
  assert.equal(dead.length, 1);
  assert.equal(dead[0].id, "vieux");
  assert.equal(dead[0].value.id, "vieux");
  assert.equal(s.has("vieux"), false);
  assert.equal(s.has("recent"), true);
  assert.equal(s.size, 1);
});

test("reapExpired : rien a faire quand tout est actif", () => {
  const clk = fakeClock();
  const s = createSessionStore({ ttlMs: 1000, max: 10, now: clk.now });
  s.set("a", 1);
  s.set("b", 2);
  clk.advance(999);
  assert.deepEqual(s.reapExpired(), []);
  assert.equal(s.size, 2);
});

test("reapOverflow : evince les plus anciennes (LRU) au-dela du plafond", () => {
  const clk = fakeClock();
  const s = createSessionStore({ ttlMs: 1e9, max: 2, now: clk.now });
  s.set("a", "A");
  clk.advance(10);
  s.set("b", "B");
  clk.advance(10);
  s.set("c", "C"); // 3 > max 2

  const evicted = s.reapOverflow();
  assert.equal(evicted.length, 1);
  assert.equal(evicted[0].id, "a", "la plus ancienne est evincee");
  assert.equal(evicted[0].value, "A");
  assert.equal(s.has("a"), false);
  assert.equal(s.has("b"), true);
  assert.equal(s.has("c"), true);
  assert.equal(s.size, 2);
});

test("reapOverflow : un get recent protege une session de l'eviction LRU", () => {
  const clk = fakeClock();
  const s = createSessionStore({ ttlMs: 1e9, max: 2, now: clk.now });
  s.set("a", "A");
  clk.advance(10);
  s.set("b", "B");
  clk.advance(10);
  s.get("a"); // a redevient la plus recemment vue
  clk.advance(10);
  s.set("c", "C");

  const evicted = s.reapOverflow();
  assert.equal(evicted[0].id, "b", "b est desormais la plus ancienne, pas a");
  assert.equal(s.has("a"), true);
});

test("reapOverflow : sous le plafond -> rien", () => {
  const s = createSessionStore({ ttlMs: 1e9, max: 5 });
  s.set("a", 1);
  s.set("b", 2);
  assert.deepEqual(s.reapOverflow(), []);
});

test("delete retire la session", () => {
  const s = createSessionStore({ ttlMs: 1e9, max: 5 });
  s.set("a", 1);
  assert.equal(s.delete("a"), true);
  assert.equal(s.has("a"), false);
  assert.equal(s.get("a"), undefined);
});
