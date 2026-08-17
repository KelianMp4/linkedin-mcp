// Activite par client : le KPI qui compte pour la RETENTION (thèse office-hours du
// HANDOFF : facturer quand au moins 1 vrai user poste chaque semaine). Purement
// deterministe, horloge injectable -> testable. L'IO (lecture des dossiers) vit
// dans scripts/activity.mjs ; ici on n'agrege que des donnees deja chargees.
//
// Entree : liste de clients [{ client, token, created?, posts: [...] }] où posts =
// l'historique (history.json). On ne compte que les posts dates (champ `date`).

const DAY = 86400000;

function daysAgo(dateStr, now) {
  const t = Date.parse(String(dateStr).slice(0, 10));
  if (Number.isNaN(t)) return null;
  return Math.floor((now - t) / DAY);
}

// Rapport par client : total, posts sur 7/30 jours, derniere date, actif (>=1/7j).
export function activityReport(clients, now = Date.now()) {
  const rows = (Array.isArray(clients) ? clients : []).map((c) => {
    const posts = Array.isArray(c.posts) ? c.posts : [];
    let last7 = 0;
    let last30 = 0;
    let lastDate = null;
    for (const p of posts) {
      const d = daysAgo(p?.date, now);
      if (d == null || d < 0) continue;
      if (d < 7) last7++;
      if (d < 30) last30++;
      if (!lastDate || String(p.date) > lastDate) lastDate = String(p.date).slice(0, 10);
    }
    return {
      client: c.client || "—",
      token: c.token || null,
      total: posts.length,
      last7,
      last30,
      lastDate,
      active: last7 > 0, // "actif" = a posté cette semaine
    };
  });

  const activeCount = rows.filter((r) => r.active).length;
  return {
    clients: rows.length,
    activeWeekly: activeCount,
    retentionWeekly: rows.length ? Math.round((activeCount / rows.length) * 100) : 0,
    rows: rows.sort((a, b) => b.last7 - a.last7 || b.total - a.total),
  };
}

// Rendu texte pour la CLI opérateur.
export function formatActivity(report) {
  if (!report.clients) return "Aucun client enregistré.";
  const lines = [
    `Clients : ${report.clients} · actifs cette semaine : ${report.activeWeekly} (${report.retentionWeekly}%)`,
    "",
    `${"Client".padEnd(24)} ${"7j".padStart(4)} ${"30j".padStart(5)} ${"Total".padStart(6)}  Dernier`,
    "-".repeat(58),
  ];
  for (const r of report.rows) {
    const flag = r.active ? "●" : "○";
    lines.push(
      `${flag} ${r.client.slice(0, 22).padEnd(22)} ${String(r.last7).padStart(4)} ${String(r.last30).padStart(5)} ${String(r.total).padStart(6)}  ${r.lastDate || "—"}`
    );
  }
  return lines.join("\n");
}
