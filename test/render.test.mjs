// Smoke de rendu : Chrome doit produire un fichier non-vide. Depend d'un binaire
// chromium ; si absent (CI sans navigateur), le test se skip proprement.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

// --- Durcissement (T1 timeout, T2 retry, T3 semaphore) ---------------------
//
// On teste SANS vrai Chrome : un faux binaire "chrome" pilotable via CHROME_BIN.
// Le faux chrome doit ecrire un fichier de sortie (--screenshot=... / --print-to-
// pdf=...) pour que render() lise un buffer non-vide en cas de succes. On pointe
// CHROME_BIN sur `node` (process.execPath) et on passe le script via CHROME_ARGV0
// -> render() spawn UN SEUL process natif killable, sans wrapper shell/.cmd. Un
// wrapper .cmd laisserait, au timeout kill(), le node petit-fils orphelin avec son
// stdio pipe : l'event loop du test ne draine jamais et node ne sort plus.

// Recree un environnement de faux chrome jetable. behavior :
//   "sleep"    -> ne rend jamais la main (declenche le timeout)
//   "exit1"    -> sortie immediate code 1 (deterministe, pas de retry)
//   "flake"    -> N premieres invocations = sleep, ensuite = succes (retry)
//   "ok"       -> ecrit le fichier de sortie et sort 0
// Chaque invocation logue une ligne "start\n" puis "end\n" (concurrence/compte).
function makeFakeChrome(behavior) {
  const dir = mkdtempSync(join(tmpdir(), "fake-chrome-"));
  const logFile = join(dir, "log.txt");
  const scriptFile = join(dir, "fake-chrome.mjs");
  const script = `
import { appendFileSync, writeFileSync, readFileSync, existsSync } from "node:fs";
const LOG = ${JSON.stringify(logFile)};
const behavior = ${JSON.stringify(behavior)};
// Repere le fichier de sortie demande par render() (--screenshot / --print-to-pdf).
let outPath = null;
for (const a of process.argv.slice(2)) {
  const m = a.match(/^--(?:screenshot|print-to-pdf)=(.*)$/);
  if (m) outPath = m[1];
}
function writeOut() {
  if (outPath) writeFileSync(outPath, Buffer.alloc(4096, 1));
}
// Compteur d'invocations atomique-ish (mono-thread par process, suffisant ici).
const idxFile = LOG + ".n";
let n = 0;
if (existsSync(idxFile)) n = Number(readFileSync(idxFile, "utf8")) || 0;
n++;
writeFileSync(idxFile, String(n));
appendFileSync(LOG, "start\\n");
if (behavior === "exit1") {
  process.exit(1);
} else if (behavior === "sleep") {
  setInterval(() => {}, 1e9); // hang pour toujours
} else if (behavior === "flake") {
  // 1re invocation hang (timeout), 2e reussit.
  if (n <= 1) { setInterval(() => {}, 1e9); }
  else { writeOut(); appendFileSync(LOG, "end\\n"); process.exit(0); }
} else if (behavior === "ok") {
  // Reste "en vol" un court instant pour rendre la concurrence observable.
  setTimeout(() => { writeOut(); appendFileSync(LOG, "end\\n"); process.exit(0); }, 150);
}
`;
  writeFileSync(scriptFile, script);
  return {
    // bin = node lui-meme ; argv0 = script -> render() spawn "node fake-chrome.mjs
    // <flags>", un unique process natif que kill() termine sans laisser d'orphelin.
    bin: process.execPath,
    argv0: scriptFile,
    dir,
    invocations() {
      // On compte les lignes "start" du journal (appendFileSync est atomique par
      // ligne) plutot que le compteur .n (read-modify-write racy entre process).
      if (!existsSync(logFile)) return 0;
      return readFileSync(logFile, "utf8").split("\n").filter((l) => l === "start").length;
    },
    log() {
      return existsSync(logFile) ? readFileSync(logFile, "utf8") : "";
    },
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

// Importe render.mjs frais avec CHROME_BIN + CHROME_ARGV0 + RENDER_TIMEOUT_MS
// forces, puis restaure l'env. Le module lit ces variables au chargement.
async function freshRender(fake, timeoutMs) {
  const prevBin = process.env.CHROME_BIN;
  const prevArgv0 = process.env.CHROME_ARGV0;
  const prevTo = process.env.RENDER_TIMEOUT_MS;
  process.env.CHROME_BIN = fake.bin;
  process.env.CHROME_ARGV0 = fake.argv0;
  if (timeoutMs != null) process.env.RENDER_TIMEOUT_MS = String(timeoutMs);
  try {
    const mod = await import(`../src/render.mjs?bust=${Math.random()}`);
    return mod.render;
  } finally {
    if (prevBin === undefined) delete process.env.CHROME_BIN;
    else process.env.CHROME_BIN = prevBin;
    if (prevArgv0 === undefined) delete process.env.CHROME_ARGV0;
    else process.env.CHROME_ARGV0 = prevArgv0;
    if (prevTo === undefined) delete process.env.RENDER_TIMEOUT_MS;
    else process.env.RENDER_TIMEOUT_MS = prevTo;
  }
}

test("T1 — un rendu qui hang est tue par le timeout et rejette (pas d'∞)", async () => {
  const fake = makeFakeChrome("sleep");
  try {
    const render = await freshRender(fake, 300);
    const started = Date.now();
    await assert.rejects(
      () => render([{ titre: "x" }], V, "png"),
      /timeout/i,
      "doit rejeter avec une erreur de timeout"
    );
    const elapsed = Date.now() - started;
    // 300ms timeout, 1 retry (aussi timeout) -> ~600ms ; marge large mais borne.
    assert.ok(elapsed < 5000, `render a hang trop longtemps (${elapsed}ms)`);
  } finally {
    fake.cleanup();
  }
});

test("T2 — timeout transitoire => 1 retry (2 tentatives de spawn)", async () => {
  const fake = makeFakeChrome("sleep");
  try {
    // On compte cote render (mod._spawnAttempts), synchrone et deterministe : pas
    // de course entre le timeout et le boot du faux chrome (qui rendait ce test flaky).
    const mod = await freshMod(fake, 300);
    await assert.rejects(() => mod.render([{ titre: "x" }], V, "png"));
    assert.equal(mod._spawnAttempts(), 2, "le timeout doit declencher exactement 1 retry");
  } finally {
    fake.cleanup();
  }
});

test("T2 — flake transitoire : 1re tentative timeout, 2e reussit", async () => {
  const fake = makeFakeChrome("flake");
  try {
    // Timeout genereux : le chemin SUCCES (2e invocation) doit boot + ecrire sa
    // sortie + sortir 0 avant que le timeout ne le tue, meme sous charge.
    const mod = await freshMod(fake, 4000);
    const out = await mod.render([{ titre: "x" }], V, "png");
    assert.equal(out.mimeType, "image/png");
    assert.equal(mod._spawnAttempts(), 2, "1 timeout + 1 succes = 2 tentatives");
  } finally {
    fake.cleanup();
  }
});

test("T2 — exit non-zero deterministe : AUCUN retry (1 seule invocation)", async () => {
  const fake = makeFakeChrome("exit1");
  try {
    const render = await freshRender(fake, 5000);
    await assert.rejects(() => render([{ titre: "x" }], V, "png"), /code 1/);
    assert.equal(fake.invocations(), 1, "un exit non-zero ne doit jamais etre reessaye");
  } finally {
    fake.cleanup();
  }
});

// Comme freshRender mais renvoie le MODULE entier (meme instance) pour tester les
// exports de shutdown (activeRenderCount / beginShutdown / shutdownRenders) sur le
// meme etat module que le render() lance.
async function freshMod(fake, timeoutMs) {
  const prevBin = process.env.CHROME_BIN;
  const prevArgv0 = process.env.CHROME_ARGV0;
  const prevTo = process.env.RENDER_TIMEOUT_MS;
  process.env.CHROME_BIN = fake.bin;
  process.env.CHROME_ARGV0 = fake.argv0;
  if (timeoutMs != null) process.env.RENDER_TIMEOUT_MS = String(timeoutMs);
  try {
    return await import(`../src/render.mjs?bust=${Math.random()}`);
  } finally {
    if (prevBin === undefined) delete process.env.CHROME_BIN;
    else process.env.CHROME_BIN = prevBin;
    if (prevArgv0 === undefined) delete process.env.CHROME_ARGV0;
    else process.env.CHROME_ARGV0 = prevArgv0;
    if (prevTo === undefined) delete process.env.RENDER_TIMEOUT_MS;
    else process.env.RENDER_TIMEOUT_MS = prevTo;
  }
}

// --- Arret propre (T5) : hook de shutdown cote render ----------------------

test("T5 — shutdownRenders tue un rendu EN VOL et vide activeRenderCount", async () => {
  const fake = makeFakeChrome("sleep");
  try {
    // Timeout render tres haut : c'est shutdownRenders(), pas le timeout, qui tue.
    const mod = await freshMod(fake, 30000);
    assert.equal(mod.activeRenderCount(), 0, "aucun rendu au depart");
    const p = mod.render([{ titre: "x" }], V, "png");
    p.catch(() => {}); // on gere le rejet plus bas, evite un unhandledRejection
    // Attendre que le child Chrome soit bien spawne (compte = 1).
    const deadline = Date.now() + 3000;
    while (mod.activeRenderCount() === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.equal(mod.activeRenderCount(), 1, "un rendu doit etre en vol");
    mod.shutdownRenders(); // tue le child
    await assert.rejects(() => p, "le rendu en vol tue doit rejeter");
    assert.equal(mod.activeRenderCount(), 0, "plus aucun rendu apres shutdown");
  } finally {
    fake.cleanup();
  }
});

test("T5 — beginShutdown rejette vite tout nouveau rendu (kind shutdown)", async () => {
  const fake = makeFakeChrome("ok");
  try {
    const mod = await freshMod(fake, 10000);
    mod.beginShutdown();
    await assert.rejects(
      () => mod.render([{ titre: "x" }], V, "png"),
      (e) => e.kind === "shutdown",
      "un rendu demande apres beginShutdown doit etre refuse"
    );
    assert.equal(mod.activeRenderCount(), 0, "aucun Chrome ne doit avoir demarre");
  } finally {
    fake.cleanup();
  }
});

test("T3 — semaphore : 4 rendus concurrents => jamais plus de 2 en vol", async () => {
  const fake = makeFakeChrome("ok");
  try {
    const render = await freshRender(fake, 10000);
    await Promise.all([
      render([{ titre: "a" }], V, "png"),
      render([{ titre: "b" }], V, "png"),
      render([{ titre: "c" }], V, "png"),
      render([{ titre: "d" }], V, "png"),
    ]);
    // Reconstruit le pic de concurrence depuis le journal start/end ordonne.
    const events = fake.log().trim().split("\n").filter(Boolean);
    let cur = 0;
    let peak = 0;
    for (const ev of events) {
      if (ev === "start") cur++;
      else if (ev === "end") cur--;
      if (cur > peak) peak = cur;
    }
    assert.equal(fake.invocations(), 4, "les 4 rendus doivent tous s'executer");
    assert.ok(peak <= 2, `pic de concurrence ${peak} > cap 2`);
    assert.ok(peak >= 2, `attendu 2 en parallele, observe ${peak} (test non representatif)`);
  } finally {
    fake.cleanup();
  }
});
