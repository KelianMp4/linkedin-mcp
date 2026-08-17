import test from "node:test";
import assert from "node:assert/strict";
import { buildHtml } from "../src/templates.mjs";

const V = {
  bg: "#111",
  fg: "#fff",
  accent: "#f80",
  accent2: "#08f",
  width: 1080,
  height: 1350,
};

test("esc echappe <, > et & (pas d'injection HTML)", () => {
  const html = buildHtml([{ titre: "A & B <script>alert(1)</script>" }], V);
  assert.ok(!html.includes("<script>alert(1)"));
  assert.ok(html.includes("&lt;script&gt;"));
  assert.ok(html.includes("A &amp; B"));
});

test("sans police enregistree : pas de @font-face, fallback system-ui", () => {
  const html = buildHtml([{ titre: "T" }], V);
  assert.ok(!html.includes("@font-face"));
  assert.ok(html.includes("system-ui"));
  assert.ok(!html.includes("fonts.googleapis.com"), "aucune dependance reseau au rendu");
});

test("avec police client : @font-face local file:// injecte", () => {
  const v = { ...V, titleFontFile: "title.woff2", bodyFontFile: "body.woff2" };
  const html = buildHtml([{ titre: "T", corps: "C" }], v, "/data/tok/fonts");
  assert.ok(html.includes("@font-face"));
  assert.ok(html.includes('font-family:"brandTitle"'));
  assert.ok(html.includes("file:///data/tok/fonts/title.woff2"));
});

test("le script d'auto-fit et --scale sont presents", () => {
  const html = buildHtml([{ titre: "T" }], V);
  assert.ok(html.includes("--scale"));
  assert.ok(html.includes("document.fonts"));
  assert.ok(html.includes("scrollHeight"));
});

test("les champs absents ne cassent pas le rendu", () => {
  const html = buildHtml([{}], V);
  assert.ok(html.includes('class="slide"'));
});

test("une slide par entree du plan", () => {
  const html = buildHtml([{ titre: "1" }, { titre: "2" }, { titre: "3" }], V);
  assert.equal((html.match(/class="slide"/g) || []).length, 3);
});

// --- Gabarits par slide (layout) ---

test("layout explicite respecte (data-layout)", () => {
  const html = buildHtml([{ layout: "quote", corps: "Une citation.", titre: "Auteur" }], V);
  assert.ok(html.includes('data-layout="quote"'));
  assert.ok(html.includes("<blockquote>Une citation.</blockquote>"));
  assert.ok(html.includes('class="cite"'));
});

test("auto-detection : puces -> gabarit list, une ligne par puce", () => {
  const html = buildHtml([{ titre: "Trois signaux", puces: ["Un", "Deux", "Trois"] }], V);
  assert.ok(html.includes('data-layout="list"'));
  assert.equal((html.match(/<li>/g) || []).length, 3);
  assert.ok(html.includes("<li>Un</li>"));
});

test("auto-detection : chiffre seul -> gabarit stat", () => {
  const html = buildHtml([{ chiffre: "42%", titre: "de gain" }], V);
  assert.ok(html.includes('data-layout="stat"'));
  assert.ok(html.includes('class="stat-label"'));
});

test("auto-detection : titre seul -> gabarit hook", () => {
  const html = buildHtml([{ titre: "Une accroche forte" }], V);
  assert.ok(html.includes('data-layout="hook"'));
});

test("default : titre + corps garde l'ordre historique", () => {
  const html = buildHtml([{ titre: "T", corps: "C" }], V);
  assert.ok(html.includes('data-layout="default"'));
  assert.ok(html.indexOf("<h1>T</h1>") < html.indexOf("<p>C</p>"));
});

test("les puces sont echappees (pas d'injection via la liste)", () => {
  const html = buildHtml([{ puces: ["<script>x</script>"] }], V);
  assert.ok(!html.includes("<script>x"));
  assert.ok(html.includes("&lt;script&gt;"));
});

test("le style des variantes reste pilote par --scale (auto-fit)", () => {
  const html = buildHtml([{ layout: "stat", chiffre: "9" }], V);
  // Le chiffre du gabarit stat utilise bien var(--scale).
  assert.ok(/data-layout="stat"\] \.chiffre \{ font-size: calc\(300px \* var\(--scale\)\)/.test(html));
});
