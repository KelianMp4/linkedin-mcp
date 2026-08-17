// Linter de post LinkedIn — DETERMINISTE, aucun appel LLM. Applique les regles
// dures du canal (retour reviewer #4 : le meilleur ROI) pour que le Claude du
// client corrige AVANT de publier. Source unique des regles : voir playbook.mjs
// (les "Bonnes pratiques canal" y sont enoncees ; ici on les verifie mecaniquement).
//
// Pur et testable : lintPost(texte) -> { ok, errors, warnings, stats, issues }.
// Niveaux : "error" (bloquant : casse la portee), "warn" (signature a corriger),
// "info" (contexte, pas une faute).

// Lien externe dans le corps : http(s), www., ou un domaine bien connu ecrit en
// clair. L'algo LinkedIn penalise un lien sortant dans le post (-30/-60% de portee).
const URL_RE = /\bhttps?:\/\/\S+|\bwww\.\S+|\b[a-z0-9-]+\.(?:com|fr|io|co|net|org|dev|app|ai)\b/i;
// Tiret cadratin (—) et demi-cadratin (–) : signature typographique "IA", que le
// reviewer #4 veut bannir. On ne touche pas au trait d'union simple (-).
const EM_DASH_RE = /[–—]/g;

const FOLD = 210; // LinkedIn tronque le post dans le fil vers ~210 car ("…voir plus").
const HOOK_MAX = 120; // au-dela, l'accroche n'est plus une accroche.

export function lintPost(texte) {
  const text = String(texte ?? "");
  const lines = text.split(/\r?\n/);
  const firstLine = (lines.find((l) => l.trim() !== "") || "").trim();
  const chars = [...text].length; // longueur en points de code (emoji compris)
  const issues = [];

  // 1. Accroche (premiere ligne non vide).
  if (!firstLine) {
    issues.push({ level: "error", rule: "hook", message: "Aucune accroche : la premiere ligne est vide." });
  } else if (firstLine.length > HOOK_MAX) {
    issues.push({
      level: "warn",
      rule: "hook",
      message: `Accroche longue (${firstLine.length} car). Vise une 1re ligne courte et percutante (< ${HOOK_MAX} car), elle doit retenir avant le "…voir plus".`,
    });
  }

  // 2. Pas de lien dans le corps.
  if (URL_RE.test(text)) {
    issues.push({
      level: "error",
      rule: "no-link",
      message: 'Lien dans le corps (l\'algo penalise -30/-60% de portee). Retire-le et termine par "Lien en commentaire".',
    });
  }

  // 3. Pas de tiret cadratin.
  const dashes = (text.match(EM_DASH_RE) || []).length;
  if (dashes) {
    issues.push({
      level: "warn",
      rule: "em-dash",
      message: `${dashes} tiret(s) cadratin (— / –) : signature "IA". Remplace par des phrases courtes, une virgule ou deux-points.`,
    });
  }

  // 4. Repere de coupe (fold) — contexte, pas une faute.
  if (chars > FOLD) {
    issues.push({
      level: "info",
      rule: "fold",
      message: `Post de ${chars} car ; LinkedIn coupe vers ${FOLD} ("…voir plus"). Verifie que l'essentiel de l'accroche tient avant.`,
    });
  }

  const errors = issues.filter((i) => i.level === "error").length;
  const warnings = issues.filter((i) => i.level === "warn").length;
  return {
    ok: errors === 0,
    errors,
    warnings,
    stats: { chars, lines: lines.length, foldAt: FOLD, firstLineChars: firstLine.length },
    issues,
  };
}
