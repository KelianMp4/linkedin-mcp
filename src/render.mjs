// Rendu headless Chrome, meme approche que l'agent linkedin-visuals :
// on ecrit le HTML sur disque puis on invoque chromium en --headless=new.
// PNG (image seule) via --screenshot, PDF (carrousel) via --print-to-pdf.

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

function run(bin, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    p.stderr.on("data", (d) => (err += d));
    p.on("error", reject);
    p.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`chrome exit ${code}: ${err.slice(-500)}`))
    );
  });
}

// slides: tableau de slides. visual: config visuelle. format: "pdf" | "png".
// Retourne { mimeType, base64, slides } — l'appelant renvoie le fichier au client.
export async function render(slides, visual, format) {
  const dir = await mkdtemp(join(tmpdir(), "li-mcp-"));
  try {
    const html = buildHtml(slides, visual);
    const htmlPath = join(dir, "page.html");
    await writeFile(htmlPath, html, "utf8");
    const fileUrl = `file://${htmlPath.replace(/\\/g, "/")}`;
    const common = ["--headless=new", "--no-sandbox", "--hide-scrollbars", "--force-color-profile=srgb"];

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
