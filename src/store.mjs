// Store par token : chaque client = un dossier data/<token>/ avec
//   brand.json    (voix + design tokens, pose une fois au setup)
//   history.json  (suivi des posts)
// Taille : quelques Ko par client. Le token (Bearer) EST l'identite : le serveur
// en deduit le dossier, le client ne peut pas taper dans celui d'un autre.

import { readFile, writeFile, mkdir, readdir, rm, rename, unlink } from "node:fs/promises";
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
// Ecriture atomique : on ecrit d'abord un fichier temp dans LE MEME dossier, puis
// rename() par-dessus la cible (rename est atomique sur un meme systeme de fichiers).
// Un crash en plein milieu laisse la cible intacte (jamais un JSON tronque). Si
// l'ecriture echoue, on nettoie le temp pour ne pas laisser de residu .tmp.
async function writeJson(path, val) {
  const tmp = path + ".tmp-" + process.pid + "-" + randomBytes(6).toString("hex");
  try {
    await writeFile(tmp, JSON.stringify(val, null, 2), { encoding: "utf8", mode: 0o600 });
    await rename(tmp, path);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
}

// Mutex en memoire par chemin de fichier : on chaine les operations sur un meme
// fichier via une Map<path, Promise> pour qu'elles s'executent l'une apres l'autre
// (les read-modify-write comme appendPost/updateVisual ne se marchent pas dessus).
// Des fichiers differents restent en parallele. Mono-process : le file lock
// multi-instance est hors scope (cf. decision 4).
const locks = new Map();
function withLock(path, fn) {
  const prev = locks.get(path) || Promise.resolve();
  const next = prev.then(fn, fn); // on enchaine meme si la precedente a rejete
  // On garde la file propre : on retire l'entree quand c'est la derniere.
  locks.set(
    path,
    next.then(
      () => {
        if (locks.get(path) === next) locks.delete(path);
      },
      () => {
        if (locks.get(path) === next) locks.delete(path);
      }
    )
  );
  return next;
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
  // Read-modify-write serialise par fichier (sinon deux patchs concurrents se
  // clobbent : read A, read B, write A, write B -> B ecrase A).
  return withLock(path, async () => {
    const base = (await readJson(path, null)) || { client: ctx.client, voice: {}, visual: {} };
    base.client = ctx.client;
    base.visual = { ...(base.visual || {}), ...patch };
    await writeJson(path, base);
    return base;
  });
}

// Fusion profonde : b ecrase a, les objets sont fusionnes recursivement, les
// tableaux et scalaires sont remplaces tels quels. Sert au patch partiel du brand
// (voice.produit imbrique) sans ecraser le reste.
function deepMerge(a, b) {
  if (b === null || typeof b !== "object" || Array.isArray(b)) return b;
  const out = a && typeof a === "object" && !Array.isArray(a) ? { ...a } : {};
  for (const k of Object.keys(b)) out[k] = deepMerge(out[k], b[k]);
  return out;
}

// Patch partiel du brand (voix + charte) avec archivage de la version precedente
// dans brand_history.json (audit / rollback). Serialise par fichier (comme
// updateVisual). Ne remet jamais un JSON tronque en cas de crash (writeJson atomique).
export async function updateBrand(ctx, patch) {
  const path = join(ctx.dir, "brand.json");
  return withLock(path, async () => {
    const base = (await readJson(path, null)) || { client: ctx.client, voice: {}, visual: {} };
    // Archive la version pre-patch (seulement si un brand existait deja).
    if (Object.keys(base).length && base.voice) {
      const histPath = join(ctx.dir, "brand_history.json");
      const arr = await readJson(histPath, []);
      arr.push({ at: new Date().toISOString(), brand: base });
      await writeJson(histPath, arr);
    }
    const merged = deepMerge(base, patch);
    merged.client = ctx.client;
    merged.updatedAt = new Date().toISOString();
    await writeJson(path, merged);
    return merged;
  });
}

// --- Suivi des posts ---
export async function appendPost(ctx, entry) {
  const path = join(ctx.dir, "history.json");
  // Read-modify-write serialise par fichier (sinon des appends concurrents se
  // perdent : read A, read B, write A, write B -> B ecrase l'ajout de A).
  return withLock(path, async () => {
    const hist = await readJson(path, []);
    hist.push(entry);
    await writeJson(path, hist);
    return hist.length;
  });
}

export async function listPosts(ctx) {
  return readJson(join(ctx.dir, "history.json"), []);
}

// Met a jour un post deja loggue, repere par son id 1-base (celui renvoye par
// appendPost / log_post). Fusionne les metriques et laisse patcher quelques champs
// libres. Serialise par fichier. Renvoie { ok, count, entry? }.
export async function updatePost(ctx, id, patch) {
  const path = join(ctx.dir, "history.json");
  return withLock(path, async () => {
    const hist = await readJson(path, []);
    const i = Number(id) - 1;
    if (!Number.isInteger(i) || i < 0 || i >= hist.length) return { ok: false, count: hist.length };
    const entry = hist[i];
    if (patch.metriques) entry.metriques = { ...(entry.metriques || {}), ...patch.metriques };
    for (const k of ["resultat_business", "notes", "theme", "angle", "format"]) {
      if (patch[k] !== undefined) entry[k] = patch[k];
    }
    await writeJson(path, hist);
    return { ok: true, count: hist.length, entry };
  });
}

// --- Connexion LinkedIn par client (data/<token>/linkedin.json, 0600) ---
// Stocke l'access token LinkedIn du membre + son URN person, pose apres le flow
// connect_linkedin. Efface avec le reste du dossier au droit a l'effacement.
export async function setLinkedin(ctx, data) {
  await writeJson(join(ctx.dir, "linkedin.json"), data);
  return data;
}

export async function getLinkedin(ctx) {
  return readJson(join(ctx.dir, "linkedin.json"), null);
}

export async function clearLinkedin(ctx) {
  await unlink(join(ctx.dir, "linkedin.json")).catch(() => {});
}

export { DATA_DIR };
