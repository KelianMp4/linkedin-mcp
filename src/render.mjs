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

// Budget de temps virtuel : laisse tourner le JS embarque + le chargement des
// polices locales avant la capture. Configurable si un rendu complexe deborde.
const VTB_MS = Number(process.env.RENDER_VTB_MS || 8000);

function run(bin, args) {
  return new Promise((resolve, reject) => {
    let p;
    try {
      p = spawn(bin, args, { stdio: ["ignore", "ignore", "pipe"] });
    } catch (e) {
      reject(new Error(`chrome introuvable (${bin}) : ${e.message}`));
      return;
    }
    let err = "";
    p.stderr.on("data", (d) => (err += d));
    p.on("error", (e) =>
      reject(new Error(`chrome introuvable ou illisible (${bin}) : ${e.message}`))
    );
    p.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`chrome a echoue (code ${code}): ${err.slice(-500)}`))
    );
  });
}

// slides: tableau de slides. visual: config visuelle (peut porter titleFontFile /
// bodyFontFile = fichiers dans fontsDir). fontsDir: dossier des polices du client
// (data/<token>/fonts). format: "pdf" | "png".
// Retourne { mimeType, base64, slides } — l'appelant renvoie le fichier au client.
export async function render(slides, visual, format, fontsDir) {
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
      await run(CHROME_BIN, [
        ...common,
        `--screenshot=${out}`,
        `--window-size=${visual.width},${visual.height}`,
        fileUrl,
      ]);
      const buf = await readFile(out);
      return { mimeType: "image/png", base64: buf.toString("base64"), slides: slides.length };
    }

    const out = join(dir, "out.pdf");
    await run(CHROME_BIN, [...common, "--no-pdf-header-footer", `--print-to-pdf=${out}`, fileUrl]);
    const buf = await readFile(out);
    return { mimeType: "application/pdf", base64: buf.toString("base64"), slides: slides.length };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
