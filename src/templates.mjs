// Construction du HTML on-brand a partir d'un plan de slides + config visuelle.
// Un seul fichier HTML : une <div class="slide"> par page, saut de page CSS entre
// chaque (format PDF multi-pages exige par LinkedIn pour les carrousels).

function esc(s = "") {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// slide = { titre?, corps?, chiffre?, note?, cta? }
function renderSlide(slide, v) {
  const parts = [];
  if (slide.chiffre) parts.push(`<div class="chiffre">${esc(slide.chiffre)}</div>`);
  if (slide.titre) parts.push(`<h1>${esc(slide.titre)}</h1>`);
  if (slide.corps) parts.push(`<p>${esc(slide.corps)}</p>`);
  if (slide.cta) parts.push(`<div class="cta">${esc(slide.cta)}</div>`);
  if (slide.note) parts.push(`<div class="note">${esc(slide.note)}</div>`);
  return `<div class="slide">${parts.join("\n")}</div>`;
}

export function buildHtml(slides, visual) {
  const v = visual;
  const body = slides.map((s) => renderSlide(s, v)).join("\n");
  // Polices via Google Fonts (fallback sans-serif si le conteneur n'a pas de reseau).
  const fontLink = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(
    v.titleFont
  )}&family=${encodeURIComponent(v.bodyFont)}:wght@400;600;800&display=swap`;
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="${fontLink}" rel="stylesheet">
<style>
  @page { size: ${v.width}px ${v.height}px; margin: 0; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { background: ${v.bg}; }
  .slide {
    width: ${v.width}px; height: ${v.height}px;
    background: ${v.bg}; color: ${v.fg};
    padding: 96px 88px;
    display: flex; flex-direction: column; justify-content: center;
    page-break-after: always; break-after: page;
    font-family: "${v.bodyFont}", system-ui, sans-serif;
    position: relative; overflow: hidden;
  }
  .slide:last-child { page-break-after: auto; break-after: auto; }
  h1 {
    font-family: "${v.titleFont}", system-ui, sans-serif;
    font-size: 84px; line-height: 1.02; margin-bottom: 28px;
  }
  p { font-size: 40px; line-height: 1.35; opacity: 0.92; }
  .chiffre {
    font-family: "${v.titleFont}", system-ui, sans-serif;
    font-size: 220px; line-height: 1; color: ${v.accent}; margin-bottom: 16px;
  }
  .cta {
    margin-top: 40px; font-size: 44px; font-weight: 800; color: ${v.accent};
  }
  .note { margin-top: 32px; font-size: 30px; opacity: 0.6; }
</style></head><body>
${body}
</body></html>`;
}
