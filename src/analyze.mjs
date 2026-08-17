// Analyse DETERMINISTE de l'historique des posts (aucun LLM). Deux usages :
//   - l'outil analyze_posts renvoie un bilan lisible au client ;
//   - get_playbook injecte un condensé actionnable ("ce qui marche pour toi")
//     dans la méthode de rédaction -> valeur composée : le Claude du client
//     apprend de ses propres résultats.
//
// Règle d'or (comme partout ici) : jamais de fausse certitude. On ne compare des
// formats/thèmes QUE s'il y a assez de posts *avec métriques* saisies à la main.
// Sans données, on se tait plutôt que d'inventer une tendance.

// Score d'engagement : on pondère la conversation (commentaires, DM) plus fort que
// les réactions — c'est le DM qui vend (cf. playbook). Vues ignorées (volume ≠ signal).
function score(p) {
  const m = p.metriques || {};
  return (m.reactions || 0) + 2 * (m.commentaires || 0) + 3 * (m.dm_recus || 0);
}

function hasMetrics(p) {
  return p && p.metriques && typeof p.metriques === "object" && Object.keys(p.metriques).length > 0;
}

// Agrège par clé (format, thème…) : n posts, n avec métriques, score moyen.
function groupStats(posts, keyFn) {
  const groups = new Map();
  for (const p of posts) {
    const k = (keyFn(p) || "—").toString().trim() || "—";
    if (!groups.has(k)) groups.set(k, { key: k, n: 0, nWithMetrics: 0, totalScore: 0 });
    const g = groups.get(k);
    g.n++;
    if (hasMetrics(p)) {
      g.nWithMetrics++;
      g.totalScore += score(p);
    }
  }
  return [...groups.values()].map((g) => ({
    key: g.key,
    n: g.n,
    nWithMetrics: g.nWithMetrics,
    avgScore: g.nWithMetrics ? Math.round((g.totalScore / g.nWithMetrics) * 10) / 10 : null,
  }));
}

// Cadence : posts par semaine sur la période couverte (première→dernière date).
function cadence(dates) {
  const ds = dates.filter(Boolean).map((d) => String(d).slice(0, 10)).sort();
  if (ds.length < 2) return { first: ds[0] || null, last: ds[0] || null, spanDays: 0, perWeek: null };
  const first = ds[0];
  const last = ds[ds.length - 1];
  const spanDays = Math.max(1, Math.round((Date.parse(last) - Date.parse(first)) / 86400000));
  const perWeek = Math.round((ds.length / (spanDays / 7)) * 10) / 10;
  return { first, last, spanDays, perWeek };
}

export function analyzePosts(history) {
  const posts = Array.isArray(history) ? history.filter((p) => p && typeof p === "object") : [];
  const count = posts.length;
  if (!count) return { count: 0, withMetrics: 0 };

  const withMetrics = posts.filter(hasMetrics);
  const cad = cadence(posts.map((p) => p.date));

  // Classements (seulement les groupes qui ont des métriques, tri décroissant).
  const byFormat = groupStats(posts, (p) => p.format)
    .filter((g) => g.avgScore != null)
    .sort((a, b) => b.avgScore - a.avgScore);
  const byTheme = groupStats(posts, (p) => p.theme)
    .filter((g) => g.avgScore != null)
    .sort((a, b) => b.avgScore - a.avgScore)
    .slice(0, 3);

  const best = withMetrics.slice().sort((a, b) => score(b) - score(a))[0] || null;

  return {
    count,
    withMetrics: withMetrics.length,
    cadence: cad,
    byFormat,
    byTheme,
    best: best
      ? { theme: best.theme || "—", format: best.format || "—", date: best.date || null, score: score(best), metriques: best.metriques }
      : null,
  };
}

// Bilan lisible et complet (outil analyze_posts).
export function summarizeAnalysis(a) {
  if (!a.count) return "Aucun post loggé pour l'instant. Utilise log_post après tes publications, puis reviens ici.";
  const lines = [`Bilan : ${a.count} post(s) loggé(s), dont ${a.withMetrics} avec métriques.`];
  if (a.cadence.perWeek != null) {
    lines.push(`Cadence : ~${a.cadence.perWeek}/semaine (du ${a.cadence.first} au ${a.cadence.last}).`);
  }
  if (a.withMetrics < 3) {
    lines.push(
      "",
      "Pas encore assez de posts avec métriques pour dégager une tendance fiable (< 3).",
      "Continue à logger tes chiffres (update_post_metrics) — les comparaisons apparaîtront ici."
    );
    return lines.join("\n");
  }
  if (a.byFormat.length) {
    lines.push("", "Par format (score d'engagement moyen) :");
    for (const f of a.byFormat) lines.push(`- ${f.key} : ${f.avgScore} (${f.nWithMetrics} post(s))`);
  }
  if (a.byTheme.length) {
    lines.push("", "Meilleurs thèmes :");
    for (const t of a.byTheme) lines.push(`- ${t.key} : ${t.avgScore} (${t.nWithMetrics} post(s))`);
  }
  if (a.best) {
    lines.push("", `Meilleur post : "${a.best.theme}" (${a.best.format}), score ${a.best.score}.`);
  }
  return lines.join("\n");
}

// Condensé COURT injecté dans le playbook (valeur composée). Renvoie null si les
// données sont trop maigres pour une reco fiable -> le playbook n'ajoute rien.
export function playbookInsights(a) {
  if (!a || !a.count || a.withMetrics < 3) return null;
  const bits = [];
  if (a.byFormat.length >= 2) {
    const top = a.byFormat[0];
    const low = a.byFormat[a.byFormat.length - 1];
    if (top.avgScore > low.avgScore) {
      bits.push(`Format le plus engageant chez toi : ${top.key} (score ${top.avgScore} vs ${low.avgScore} pour ${low.key}). Privilégie-le.`);
    }
  }
  if (a.byTheme.length) {
    bits.push(`Thème qui performe : "${a.byTheme[0].key}" (score ${a.byTheme[0].avgScore}). Décline-le sous d'autres angles.`);
  }
  if (a.best) {
    bits.push(`Ton meilleur post à ce jour : "${a.best.theme}" — réutilise ce qui a marché (accroche, structure).`);
  }
  return bits.length ? bits : null;
}
