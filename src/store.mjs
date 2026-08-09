// Store par token : chaque client = un dossier data/<token>/ avec
//   brand.json    (voix + design tokens, pose une fois au setup)
//   history.json  (suivi des posts)
// Taille : quelques Ko par client. Le token (Bearer) EST l'identite : le serveur
// en deduit le dossier, le client ne peut pas taper dans celui d'un autre.

import { readFile, writeFile, mkdir, readdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || join(__dirname, "..", "data");
const REGISTRY = join(DATA_DIR, "tokens.json");

// Charte neutre par defaut tant que le client n'a pas fait setup_brand.
export const DEFAULT_VISUAL = {
  bg: "#111111",
  fg: "#FFFFFF",
  accent: "#FFB800",
  accent2: "#3355FF",
  titleFont: "Lilita One",
  bodyFont: "Inter",
  width: 1080,
  height: 1350,
};

async function readJson(path, fallback) {
  const raw = await readFile(path, "utf8").catch(() => null);
  if (raw == null) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

// Donnees clients (tokens, brand, historiques) : fichiers en 0600 (audit CSO F3).
async function writeJson(path, val) {
  await writeFile(path, JSON.stringify(val, null, 2), { encoding: "utf8", mode: 0o600 });
}

// Registre des tokens : { "<token>": { client, created } }.
export async function loadRegistry() {
  return readJson(REGISTRY, {});
}

export async function resolveToken(token) {
  const reg = await loadRegistry();
  const entry = reg[token];
  if (!entry) return null;
  const dir = join(DATA_DIR, token);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  return { token, client: entry.client, dir };
}

// Mint : cree un token, l'enregistre, prepare son dossier. Utilise par le CLI.
export async function mintToken(client) {
  await mkdir(DATA_DIR, { recursive: true, mode: 0o700 });
  const reg = await loadRegistry();
  const token = "lkm_" + randomBytes(24).toString("base64url");
  reg[token] = { client, created: new Date().toISOString() };
  await writeJson(REGISTRY, reg);
  await mkdir(join(DATA_DIR, token), { recursive: true, mode: 0o700 });
  return token;
}

export async function listTokens() {
  const reg = await loadRegistry();
  return Object.entries(reg).map(([t, v]) => ({ token: t, ...v }));
}

// Droit a l'effacement (RGPD art. 17) : efface DEFINITIVEMENT toutes les donnees
// d'un client — son dossier data/<token>/ (brand + historique + polices) et son
// entree de registre. Le token devient invalide (resolveToken renverra null, ce
// qui fait tomber aussi ses tokens OAuth via resolveBearer). Irreversible.
// Renvoie { removed: bool, client } ; removed=false si le token n'existait pas.
export async function deleteClientData(token) {
  const reg = await loadRegistry();
  const entry = reg[token];
  if (!entry) return { removed: false, client: null };
  await rm(join(DATA_DIR, token), { recursive: true, force: true });
  delete reg[token];
  await writeJson(REGISTRY, reg);
  return { removed: true, client: entry.client };
}

// --- Brand ---
export async function getBrand(ctx) {
  const b = await readJson(join(ctx.dir, "brand.json"), null);
  if (!b) return { client: ctx.client, voice: {}, visual: DEFAULT_VISUAL, _default: true };
  return { ...b, visual: { ...DEFAULT_VISUAL, ...(b.visual || {}) } };
}

export async function setBrand(ctx, brand) {
  const clean = { client: ctx.client, ...brand };
  await writeJson(join(ctx.dir, "brand.json"), clean);
  return clean;
}

// Merge partiel dans visual (sans ecraser le reste du brand). Utilise par
// register_font pour poser titleFontFile / bodyFontFile apres coup.
export async function updateVisual(ctx, patch) {
  const path = join(ctx.dir, "brand.json");
  const base = (await readJson(path, null)) || { client: ctx.client, voice: {}, visual: {} };
  base.client = ctx.client;
  base.visual = { ...(base.visual || {}), ...patch };
  await writeJson(path, base);
  return base;
}

// --- Suivi des posts ---
export async function appendPost(ctx, entry) {
  const path = join(ctx.dir, "history.json");
  const hist = await readJson(path, []);
  hist.push(entry);
  await writeJson(path, hist);
  return hist.length;
}

export async function listPosts(ctx) {
  return readJson(join(ctx.dir, "history.json"), []);
}

export { DATA_DIR };
