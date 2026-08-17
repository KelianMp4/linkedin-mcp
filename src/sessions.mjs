// Registre des sessions MCP (Streamable HTTP) avec expiration + plafond.
//
// Probleme : la map des transports ne se vidait que sur onclose (DELETE /mcp). Un
// client qui ne ferme jamais proprement sa session laisse une entree s'accumuler
// -> fuite memoire lente sur un serveur long-vivant (cf. TODOS.md).
//
// Ce store borne les deux dimensions :
//   - TTL : une session inactive depuis > ttlMs est reapee (reapExpired()).
//   - Cap : au-dela de `max` sessions, les plus anciennes (LRU) sont evincees
//     a la creation d'une nouvelle (reapOverflow()).
// Les fonctions reap* RETIRENT les entrees et RENVOIENT les valeurs evincees pour
// que l'appelant ferme proprement le transport correspondant (transport.close()).
// Pur (horloge injectable `now`) => testable sans vrai serveur ni minuteur reel.

export function createSessionStore({ ttlMs, max, now = () => Date.now() }) {
  const map = new Map(); // id -> { value, lastSeen }

  return {
    // Enregistre / remplace une session et marque l'activite maintenant.
    set(id, value) {
      map.set(id, { value, lastSeen: now() });
    },
    // Lit une session ET rafraichit son horodatage d'activite (touch implicite).
    get(id) {
      const e = map.get(id);
      if (!e) return undefined;
      e.lastSeen = now();
      return e.value;
    },
    has(id) {
      return map.has(id);
    },
    delete(id) {
      return map.delete(id);
    },
    get size() {
      return map.size;
    },
    // Retire et renvoie [{ id, value }] des sessions inactives depuis > ttlMs.
    reapExpired() {
      const cutoff = now() - ttlMs;
      const dead = [];
      for (const [id, e] of map) if (e.lastSeen < cutoff) dead.push({ id, value: e.value });
      for (const { id } of dead) map.delete(id);
      return dead;
    },
    // Si au-dessus du plafond, retire et renvoie les [{ id, value }] les plus
    // anciens (LRU) jusqu'a repasser sous `max`. A appeler avant d'ajouter.
    reapOverflow() {
      if (map.size <= max) return [];
      const sorted = [...map.entries()].sort((a, b) => a[1].lastSeen - b[1].lastSeen);
      const excess = sorted.slice(0, map.size - max);
      for (const [id] of excess) map.delete(id);
      return excess.map(([id, e]) => ({ id, value: e.value }));
    },
  };
}
