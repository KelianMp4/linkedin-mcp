// Resolution de police PAR CLIENT (revue eng T1). Deux sources acceptees :
//   1. Un nom de famille Google Fonts ("Inter", "Lilita One") -> le serveur
//      interroge l'API css2, extrait l'URL woff2 gstatic, la telecharge.
//   2. Une URL directe vers un fichier de police (woff2/woff/ttf/otf).
// Le fichier est stocke en local (data/<token>/fonts/) puis injecte en @font-face
// file:// au rendu : aucune requete reseau au moment du rendu.
//
// Garde-fou SSRF : https uniquement, resolution DNS + rejet des IP privees /
// loopback / link-local, plafond de taille, extension/type controles. Le serveur
// fetch une URL fournie par le client : sans ce garde-fou il pourrait taper des
// services internes.

import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { lookup } from "node:dns/promises";

const MAX_BYTES = 2 * 1024 * 1024; // 2 Mo : large pour un woff2, plafond anti-abus.
const EXT_BY_TYPE = {
  "font/woff2": "woff2",
  "font/woff": "woff",
  "font/ttf": "ttf",
  "font/otf": "otf",
  "application/font-woff2": "woff2",
  "application/font-woff": "woff",
  "application/x-font-ttf": "ttf",
  "application/x-font-otf": "otf",
  "application/octet-stream": null, // on retombe sur l'extension de l'URL
};
const ALLOWED_EXT = new Set(["woff2", "woff", "ttf", "otf"]);

// Hotes toujours autorises (chemin "nom de famille Google").
const GOOGLE_HOSTS = new Set(["fonts.googleapis.com", "fonts.gstatic.com"]);

function isPrivateIPv4(ip) {
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => Number.isNaN(n))) return true;
  const [a, b] = p;
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 0) return true;
  if (a === 169 && b === 254) return true; // link-local
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a >= 224) return true; // multicast / reserve
  return false;
}

function isPrivateIPv6(ip) {
  const x = ip.toLowerCase();
  if (x === "::1" || x === "::") return true;
  if (x.startsWith("fe80") || x.startsWith("fc") || x.startsWith("fd")) return true;
  if (x.startsWith("::ffff:")) return isPrivateIPv4(x.slice(7)); // IPv4-mapped
  return false;
}

// Verifie qu'une URL est sure a fetch : https + IP publique.
export async function assertSafeUrl(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`URL invalide : ${raw}`);
  }
  if (u.protocol !== "https:") throw new Error("seules les URL https sont acceptees");
  const { address, family } = await lookup(u.hostname);
  const priv = family === 6 ? isPrivateIPv6(address) : isPrivateIPv4(address);
  if (priv) throw new Error(`hote non autorise (adresse interne) : ${u.hostname}`);
  return u;
}

function extFromUrl(u) {
  const m = /\.(woff2|woff|ttf|otf)(?:$|\?)/i.exec(u.pathname);
  return m ? m[1].toLowerCase() : null;
}

// Telecharge un fichier de police depuis une URL sure, avec plafond de taille.
async function download(u) {
  const res = await fetch(u, { redirect: "follow", headers: { "user-agent": "linkedin-mcp/0.1" } });
  if (!res.ok) throw new Error(`telechargement police echoue (${res.status})`);
  const len = Number(res.headers.get("content-length") || 0);
  if (len && len > MAX_BYTES) throw new Error(`police trop lourde (${len} > ${MAX_BYTES} octets)`);
  const ct = (res.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  let ext = EXT_BY_TYPE[ct];
  if (ext === undefined && ct) throw new Error(`type de police non supporte : ${ct}`);
  if (!ext) ext = extFromUrl(u); // octet-stream ou type absent -> on lit l'extension
  if (!ext || !ALLOWED_EXT.has(ext)) throw new Error("format de police non reconnu (woff2/woff/ttf/otf attendu)");
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_BYTES) throw new Error(`police trop lourde (${buf.length} octets)`);
  if (buf.length === 0) throw new Error("fichier de police vide");
  return { buffer: buf, ext };
}

// Resout un nom de famille Google Fonts en URL woff2 gstatic.
async function resolveGoogleFamily(name) {
  const api = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(name)}:wght@600&display=swap`;
  // UA moderne => Google renvoie du woff2.
  const res = await fetch(api, {
    headers: {
      "user-agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
    },
  });
  if (!res.ok) throw new Error(`famille Google introuvable : ${name} (${res.status})`);
  const css = await res.text();
  const m = /url\((https:\/\/fonts\.gstatic\.com\/[^)]+\.woff2)\)/i.exec(css);
  if (!m) throw new Error(`aucun woff2 trouve pour la famille : ${name}`);
  return m[1];
}

// source : soit une URL https vers un fichier, soit un nom de famille Google.
// Retourne { buffer, ext }. Ne touche pas au disque (voir registerFont).
export async function resolveFont(source) {
  const src = String(source || "").trim();
  if (!src) throw new Error("source de police vide");
  let url;
  if (/^https?:\/\//i.test(src)) {
    url = await assertSafeUrl(src); // URL directe : garde-fou SSRF
  } else {
    const woff2 = await resolveGoogleFamily(src); // nom de famille -> gstatic
    if (!GOOGLE_HOSTS.has(new URL(woff2).hostname)) throw new Error("resolution Google inattendue");
    url = new URL(woff2);
  }
  return download(url);
}

// Enregistre une police pour un client : resout, ecrit data/<token>/fonts/<role>.<ext>,
// renvoie le nom de fichier a stocker dans brand.visual (title/bodyFontFile).
export async function registerFont(ctx, role, source) {
  if (role !== "title" && role !== "body") throw new Error(`role invalide : ${role} (title|body)`);
  const { buffer, ext } = await resolveFont(source);
  const fontsDir = join(ctx.dir, "fonts");
  await mkdir(fontsDir, { recursive: true });
  const filename = `${role}.${ext}`;
  await writeFile(join(fontsDir, filename), buffer);
  return { filename, bytes: buffer.length, ext };
}
