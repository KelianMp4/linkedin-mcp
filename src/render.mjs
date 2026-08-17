// Rendu headless Chrome, meme approche que l'agent linkedin-visuals :
// on ecrit le HTML sur disque puis on invoque chromium en --headless=new.
// PNG (image seule) via --screenshot, PDF (carrousel) via --print-to-pdf.
//
// Deux garanties on-brand cote rendu (T1/T2 de la revue eng) :
//   1. Polices LOCALES (data/<token>/fonts/) injectees en @font-face file:// —
//      aucune dependance reseau au moment du rendu.
//   2. --virtual-time-budget : Chrome execute le JS embarque (auto-fit +
//      document.fonts.ready) AVANT la capture. Sinon la capture part trop tot
//      et le texte sort en police systeme / tronque.

import { spawn } from "node:child_process";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildHtml } from "./templates.mjs";

// Binaire chromium : configurable (conteneur Linux = chromium ; Windows = chrome.exe).
const CHROME_BIN =
  process.env.CHROME_BIN ||
  (process.platform === "win32"
    ? "C:/Program Files/Google/Chrome/Application/chrome.exe"
    : "chromium");

// Couture de test : permet de faire precede les flags chrome d'un script. Les
// tests pointent CHROME_BIN sur `node` (process.execPath) et passent le faux
// chrome ici -> un SEUL process natif killable, sans wrapper shell/.cmd (evite
// aussi que le timeout kill() ne laisse un petit-fils orphelin). Vide en prod.
const CHROME_ARGV0 = process.env.CHROME_ARGV0 || null;

// Budget de temps virtuel : laisse tourner le JS embarque + le chargement des
// polices locales avant la capture. Configurable si un rendu complexe deborde.
const VTB_MS = Number(process.env.RENDER_VTB_MS || 8000);

// Timeout dur du process Chrome (decision 1) : 30 s ~= 4x la marge du VTB, ne
// tue que les vrais hangs, pas un rendu lent legitime. Surchargeable via
// RENDER_TIMEOUT_MS (aussi la couture de test : les tests le baissent tres bas).
const TIMEOUT_MS = Number(process.env.RENDER_TIMEOUT_MS || 30000);

// Semaphore de concurrence (decision 3) : cap 2 process Chrome simultanes ; les
// rendus en trop font la FILE (attendent leur tour), jamais rejetes. Module-level.
const MAX_CONCURRENT = 2;
let inFlight = 0;
const waiters = []; // file FIFO de resolvers en attente d'un jeton

// Shutdown (T5) : quand SIGTERM arrive, on arrete d'admettre de nouveaux rendus
// (ceux en FILE, pas encore demarres, sont rejetes vite) mais on laisse finir /
// on tue ceux EN VOL. children = set des process Chrome actuellement spawnes ;
// shutdownRenders() les tue (groupe sur Linux) pour ne laisser aucun orphelin.
let shuttingDown = false;
const children = new Set();

// Nombre de process Chrome actuellement en vol (couture testable pour server.mjs).
export function activeRenderCount() {
  return children.size;
}

// Compteur de tentatives de spawn (couture de test) : incremente a CHAQUE run(),
// de facon synchrone et deterministe — independant du temps de boot du process
// fils. Permet de verifier la logique de retry (ex : timeout => 2 tentatives) sans
// dependre du timing du faux chrome (qui, sous charge, peut etre tue avant meme
// d'avoir loggue son demarrage). Sans usage en prod.
let spawnAttempts = 0;
export function _spawnAttempts() {
  return spawnAttempts;
}

// Debut d'arret (appele en premier par le handler SIGTERM) : bloque tout nouveau
// rendu et rejette VITE ceux en file (pas encore demarres), SANS tuer ceux en vol
// -> on leur laisse le delai de grace du serveur pour finir proprement. Idempotent.
export function beginShutdown() {
  shuttingDown = true;
  // Reveille les rendus en file avec un flag de rejet -> acquire() les refuse
  // au lieu de spawn un nouveau Chrome pendant l'arret.
  while (waiters.length) waiters.shift()(true);
}

// Fin d'arret (appele apres le delai de grace) : bloque la file (via beginShutdown,
// idempotent) puis tue chaque child Chrome ENCORE en vol via killGroup() -> aucun
// orphelin (zygote/GPU) sur Linux. No-op si aucun rendu actif.
export function shutdownRenders() {
  beginShutdown();
  for (const p of children) killGroup(p);
}

function acquire() {
  // Shutdown en cours : ne pas demarrer de nouveau rendu (rejet rapide de la file).
  if (shuttingDown) return Promise.reject(shutdownError());
  if (inFlight < MAX_CONCURRENT) {
    inFlight++;
    return Promise.resolve();
  }
  // Plus de jeton libre : on s'endort dans la file jusqu'a un release(). Le
  // resolver recoit un booleen "rejected" (true = reveille par shutdownRenders).
  return new Promise((resolve, reject) => {
    waiters.push((rejected) => (rejected ? reject(shutdownError()) : resolve()));
  });
}

function shutdownError() {
  const e = new Error("serveur en cours d'arret, rendu refuse");
  e.kind = "shutdown";
  return e;
}

function release() {
  const next = waiters.shift();
  if (next) next(); // le suivant reprend le jeton (inFlight reste inchange)
  else inFlight--; // personne n'attend : on rend le jeton
}

// Tue le process Chrome ET ses enfants (zygote/GPU) sinon ils restent orphelins.
// Sur Linux (prod/Docker) : spawn { detached: true } cree un groupe de process
// dont le PID = celui du child ; kill(-pid) frappe tout le groupe. Sur Windows
// (dev) : pas de groupe POSIX, child.kill() suffit pour ce qu'on teste ici.
function killGroup(p) {
  if (process.platform === "win32") {
    p.kill();
    return;
  }
  try {
    process.kill(-p.pid, "SIGKILL");
  } catch {
    // le groupe a peut-etre deja disparu : fallback sur le PID parent.
    try {
      p.kill("SIGKILL");
    } catch {}
  }
}

function run(bin, args) {
  spawnAttempts++; // compte l'essai (synchrone) avant tout alea de boot du fils
  return new Promise((resolve, reject) => {
    let p;
    try {
      // detached sur non-win32 -> le child devient chef de son groupe de process,
      // ce qui permet de tuer tout le groupe au timeout via kill(-pid).
      // CHROME_ARGV0 (tests) : prepend un script devant les flags chrome ; on
      // spawn alors un seul binaire natif (node) sans shell -> kill() le tue net.
      const spawnArgs = CHROME_ARGV0 ? [CHROME_ARGV0, ...args] : args;
      p = spawn(bin, spawnArgs, {
        stdio: ["ignore", "ignore", "pipe"],
        detached: process.platform !== "win32",
      });
    } catch (e) {
      const err = new Error(`chrome introuvable (${bin}) : ${e.message}`);
      err.kind = "spawn";
      reject(err);
      return;
    }
    // Suivi du process EN VOL : permet a shutdownRenders() de le tuer sur SIGTERM
    // et a activeRenderCount() de le compter. Retire dans chaque chemin de settle.
    children.add(p);
    let err = "";
    let settled = false;
    p.stderr.on("data", (d) => (err += d));

    // Timeout dur : on tue le groupe et on rejette avec kind=timeout (transitoire).
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      children.delete(p);
      killGroup(p);
      const e = new Error(`chrome timeout (>${TIMEOUT_MS}ms), process tue`);
      e.kind = "timeout";
      reject(e);
    }, TIMEOUT_MS);
    // Ne pas garder l'event loop en vie juste pour ce timer.
    if (typeof timer.unref === "function") timer.unref();

    p.on("error", (e) => {
      if (settled) return;
      settled = true;
      children.delete(p);
      clearTimeout(timer);
      const err = new Error(`chrome introuvable ou illisible (${bin}) : ${e.message}`);
      err.kind = "spawn";
      reject(err);
    });
    p.on("close", (code) => {
      if (settled) return;
      settled = true;
      children.delete(p);
      clearTimeout(timer);
      if (code === 0) {
        resolve();
      } else {
        // Exit non-zero deterministe (input casse) : NON transitoire, pas de retry.
        const e = new Error(`chrome a echoue (code ${code}): ${err.slice(-500)}`);
        e.kind = "exit";
        reject(e);
      }
    });
  });
}

// Lance run() avec 1 retry auto UNIQUEMENT sur transitoires (decision 2/4) :
// timeout (tue par notre timer) ou echec de spawn. Un exit non-zero deterministe
// (kind=exit) echoue immediatement (evite ~60 s d'attente pour la meme erreur).
// Le rendu est une fonction pure de slides+brand -> le retry est sur.
async function runWithRetry(bin, args) {
  try {
    return await run(bin, args);
  } catch (e) {
    if (e.kind === "timeout" || e.kind === "spawn") {
      return await run(bin, args);
    }
    throw e;
  }
}

// slides: tableau de slides. visual: config visuelle (peut porter titleFontFile /
// bodyFontFile = fichiers dans fontsDir). fontsDir: dossier des polices du client
// (data/<token>/fonts). format: "pdf" | "png".
// Retourne { mimeType, base64, slides } — l'appelant renvoie le fichier au client.
export async function render(slides, visual, format, fontsDir) {
  // On prend un jeton du semaphore AVANT toute chose (attente non bornee dans la
  // file). Le timeout 30 s ne doit compter que le run Chrome reel, jamais le temps
  // passe en file -> acquire() ici, hors de toute horloge de timeout.
  await acquire();
  const dir = await mkdtemp(join(tmpdir(), "li-mcp-"));
  try {
    const html = buildHtml(slides, visual, fontsDir);
    const htmlPath = join(dir, "page.html");
    await writeFile(htmlPath, html, "utf8");
    const fileUrl = `file://${htmlPath.replace(/\\/g, "/")}`;
    const common = [
      "--headless=new",
      "--no-sandbox",
      "--hide-scrollbars",
      "--force-color-profile=srgb",
      `--virtual-time-budget=${VTB_MS}`,
      "--run-all-compositor-stages-before-draw",
      "--allow-file-access-from-files",
    ];

    if (format === "png") {
      const out = join(dir, "out.png");
      await runWithRetry(CHROME_BIN, [
        ...common,
        `--screenshot=${out}`,
        `--window-size=${visual.width},${visual.height}`,
        fileUrl,
      ]);
      const buf = await readFile(out);
      return { mimeType: "image/png", base64: buf.toString("base64"), slides: slides.length };
    }

    const out = join(dir, "out.pdf");
    await runWithRetry(CHROME_BIN, [...common, "--no-pdf-header-footer", `--print-to-pdf=${out}`, fileUrl]);
    const buf = await readFile(out);
    return { mimeType: "application/pdf", base64: buf.toString("base64"), slides: slides.length };
  } finally {
    // Le tmpdir est nettoye meme apres un kill (rejection) ; on rend toujours le
    // jeton du semaphore pour ne jamais bloquer la file.
    await rm(dir, { recursive: true, force: true });
    release();
  }
}
