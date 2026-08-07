// Construction du HTML on-brand a partir d'un plan de slides + config visuelle.
// Un seul fichier HTML : une <div class="slide"> par page, saut de page CSS entre
// chaque (format PDF multi-pages exige par LinkedIn pour les carrousels).
//
// Deux garanties on-brand (revue eng T1/T2) :
//   - Polices LOCALES : si le client a enregistre une police (data/<token>/fonts/),
//     on l'injecte en @font-face file://. Aucune requete reseau au rendu. Sinon
//     fallback system-ui (charte neutre tant que le client n'a pas fait register_font).
//   - Auto-fit : chaque taille de police est multipliee par var(--scale). Un script
//     embarque attend document.fonts.ready puis reduit --scale par slide tant que le
//     contenu deborde. Jamais de texte coupe en silence.

import { join } from "node:path";

function esc(s = "") {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// file:// URL a partir d'un chemin disque (Windows: backslashes -> slashes).
function fileUrl(path) {
  return `file://${String(path).replace(/\\/g, "/")}`;
}

// slide = { titre?, corps?, chiffre?, note?, cta? }
function renderSlide(slide) {
  const parts = [];
  if (slide.chiffre) parts.push(`<div class="chiffre">${esc(slide.chiffre)}</div>`);
  if (slide.titre) parts.push(`<h1>${esc(slide.titre)}</h1>`);
  if (slide.corps) parts.push(`<p>${esc(slide.corps)}</p>`);
  if (slide.cta) parts.push(`<div class="cta">${esc(slide.cta)}</div>`);
  if (slide.note) parts.push(`<div class="note">${esc(slide.note)}</div>`);
  // .fit = conteneur mesure par l'auto-fit (scrollHeight vs hauteur slide).
  return `<div class="slide"><div class="fit">${parts.join("\n")}</div></div>`;
}

// @font-face pour les polices locales du client. Genere une famille par role
// (titre / corps) uniquement si un fichier est enregistre dans le brand.
function fontFaces(visual, fontsDir) {
  if (!fontsDir) return { css: "", titleFamily: null, bodyFamily: null };
  const faces = [];
  let titleFamily = null;
  let bodyFamily = null;
  if (visual.titleFontFile) {
    titleFamily = "brandTitle";
    faces.push(
      `@font-face{font-family:"brandTitle";src:url("${fileUrl(
        join(fontsDir, visual.titleFontFile)
      )}");font-display:block;}`
    );
  }
  if (visual.bodyFontFile) {
    bodyFamily = "brandBody";
    faces.push(
      `@font-face{font-family:"brandBody";src:url("${fileUrl(
        join(fontsDir, visual.bodyFontFile)
      )}");font-display:block;}`
    );
  }
  return { css: faces.join("\n"), titleFamily, bodyFamily };
}

export function buildHtml(slides, visual, fontsDir) {
  const v = visual;
  const body = slides.map((s) => renderSlide(s)).join("\n");
  const { css: faceCss, titleFamily, bodyFamily } = fontFaces(v, fontsDir);
  // Familles effectives : police locale du client si dispo, sinon system-ui.
  const titleStack = `${titleFamily ? `"${titleFamily}", ` : ""}system-ui, sans-serif`;
  const bodyStack = `${bodyFamily ? `"${bodyFamily}", ` : ""}system-ui, sans-serif`;

  return `<!doctype html><html lang="fr"><head><meta charset="utf-8">
<style>
  ${faceCss}
  @page { size: ${v.width}px ${v.height}px; margin: 0; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { background: ${v.bg}; }
  .slide {
    width: ${v.width}px; height: ${v.height}px;
    --scale: 1;
    background: ${v.bg}; color: ${v.fg};
    padding: 96px 88px;
    display: flex; flex-direction: column; justify-content: center;
    page-break-after: always; break-after: page;
    font-family: ${bodyStack};
    position: relative; overflow: hidden;
  }
  .slide:last-child { page-break-after: auto; break-after: auto; }
  .fit { display: flex; flex-direction: column; justify-content: center; width: 100%; }
  h1 {
    font-family: ${titleStack};
    font-size: calc(84px * var(--scale)); line-height: 1.02; margin-bottom: 28px;
  }
  p { font-size: calc(40px * var(--scale)); line-height: 1.35; opacity: 0.92; }
  .chiffre {
    font-family: ${titleStack};
    font-size: calc(220px * var(--scale)); line-height: 1; color: ${v.accent}; margin-bottom: 16px;
  }
  .cta {
    margin-top: 40px; font-size: calc(44px * var(--scale)); font-weight: 800; color: ${v.accent};
  }
  .note { margin-top: 32px; font-size: calc(30px * var(--scale)); opacity: 0.6; }
</style></head><body>
${body}
<script>
  // Auto-fit : attendre les polices (sinon on mesure avec la mauvaise police),
  // puis reduire --scale par slide tant que le contenu deborde de la page.
  (async () => {
    try { if (document.fonts && document.fonts.ready) await document.fonts.ready; } catch (e) {}
    const MIN = 0.45;
    for (const slide of document.querySelectorAll(".slide")) {
      let scale = 1;
      // Marge de securite de 2px pour eviter les faux positifs d'arrondi.
      let guard = 0;
      while (slide.scrollHeight > slide.clientHeight + 2 && scale > MIN && guard < 60) {
        scale -= 0.03;
        slide.style.setProperty("--scale", scale.toFixed(3));
        guard++;
      }
    }
    document.documentElement.setAttribute("data-fit-done", "1");
  })();
</script>
</body></html>`;
}
