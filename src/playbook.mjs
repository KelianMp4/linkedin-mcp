// Methode de redaction fournie au Claude du client (il redige, pas le serveur).
// Module a part = pur et testable, sans demarrer le serveur HTTP.
export function playbook(brand) {
  const v = brand.voice || {};
  const p = v.produit || {};
  const lines = [
    `Tu rediges un post LinkedIn pour la marque "${brand.client}".`,
    ``,
    `# Voix`,
    `Registre : ${v.registre || "sobre"}. Langue : ${v.langue || "fr"}.`,
  ];
  if ((v.regles || []).length) {
    lines.push(`Regles non negociables :`, ...v.regles.map((r) => `- ${r}`));
  }
  if (p.nom) {
    lines.push(
      ``,
      `# Produit`,
      `Nom : ${p.nom}. Pitch : ${p.pitch || ""}.`,
      `Cible : ${p.cible || ""}. Prix : ${p.prix || ""}. URL : ${p.url || ""}.`,
      p.preuve ? `Preuve a citer : ${p.preuve}.` : ``
    );
  }
  lines.push(
    ``,
    `# Bonnes pratiques canal (dures)`,
    `1. Accroche forte en premiere ligne. Jamais de lien dans le corps (algo -30/-60%) : finir par "Lien en commentaire".`,
    `2. Preuve par les chiffres, pas de jargon.`,
    `3. Fin orientee conversation (question / invitation au DM), jamais un lien externe. Le DM vend.`,
    ``,
    `Visuel : appelle render_carousel (plan de slides) ou render_image (une slide).`,
    `Police on-brand : si le brand book indique une police precise, appelle register_font`,
    `  une fois par role (title / body) — source = nom de famille Google Fonts OU URL https`,
    `  du fichier. Sans ca, les visuels sortent en police systeme neutre.`,
    `Apres publication, loggue avec log_post (metriques saisies a la main, jamais inventees).`
  );
  if (brand._default) {
    lines.push(
      ``,
      `NOTE : aucune identite de marque enregistree. Lance d'abord l'outil setup_brand ` +
        `pour capturer voix + charte, sinon les visuels sortent en charte neutre.`
    );
  }
  return lines.filter((l) => l !== undefined).join("\n");
}
