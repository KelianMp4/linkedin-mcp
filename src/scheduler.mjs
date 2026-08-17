// Sélection déterministe des jobs de publication planifiés arrivés à échéance.
// Pur (aucune IO) -> testable sans serveur. L'exécution (publier, persister) vit
// dans server.mjs (worker) ; ici on ne fait que décider quoi doit partir.
//
// Un job = { id, when (ISO 8601 absolu), texte, visuel?, status, createdAt, ... }.
// Modèle human-in-the-loop : le client a validé le texte AU MOMENT de planifier
// (schedule_post) ; le worker ne fait qu'honorer cet accord à l'heure prévue.

// Renvoie les jobs "pending" dont l'échéance est passée (when <= now), triés par
// échéance croissante. Ignore les jobs déjà envoyés / échoués / annulés, et les
// jobs à date invalide (ils ne partent jamais tout seuls -> visibles via list).
export function dueJobs(jobs, now = Date.now()) {
  return (Array.isArray(jobs) ? jobs : [])
    .filter((j) => j && j.status === "pending")
    .filter((j) => {
      const t = Date.parse(j.when);
      return !Number.isNaN(t) && t <= now;
    })
    .sort((a, b) => Date.parse(a.when) - Date.parse(b.when));
}

// Validation d'une date de planification fournie par le client. Renvoie
// { ok, when } (ISO normalisé) ou { ok:false, error }.
export function validateWhen(when, now = Date.now()) {
  const t = Date.parse(when);
  if (Number.isNaN(t)) return { ok: false, error: "date invalide : fournis un horodatage ISO 8601 (ex: 2026-09-20T09:00:00Z)." };
  if (t <= now) return { ok: false, error: "la date de planification est déjà passée." };
  return { ok: true, when: new Date(t).toISOString() };
}
