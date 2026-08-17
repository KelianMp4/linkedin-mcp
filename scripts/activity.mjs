#!/usr/bin/env node
// KPI d'activité par client (rétention). Usage : npm run activity
// Lit DATA_DIR (tokens + historiques), agrège, affiche le tableau. Opérateur only —
// à lancer sur le VPS (n'expose aucune surface réseau).
import { listTokens, resolveToken, listPosts } from "../src/store.mjs";
import { activityReport, formatActivity } from "../src/activity.mjs";

const tokens = await listTokens();
const clients = [];
for (const t of tokens) {
  const ctx = await resolveToken(t.token);
  const posts = ctx ? await listPosts(ctx) : [];
  clients.push({ client: t.client, token: t.token, created: t.created, posts });
}

console.log(formatActivity(activityReport(clients)));
