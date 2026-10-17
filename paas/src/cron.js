// Une planification « à la crontab », en cinq champs :
//
//   minute  heure  jour-du-mois  mois  jour-de-la-semaine
//   0       3      *             *     *          → tous les jours à 3 h 00
//   */15    *      *             *     *          → tous les quarts d'heure
//   0       8      *             *     1-5        → du lundi au vendredi à 8 h
//
// Les raccourcis @hourly, @daily, @weekly, @monthly sont acceptés.
// L'heure est celle du serveur (UTC dans un conteneur par défaut).

const RACCOURCIS = {
  '@hourly': '0 * * * *',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@weekly': '0 0 * * 0',
  '@monthly': '0 0 1 * *',
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
};

const BORNES = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];
const NOMS = ['minute', 'heure', 'jour du mois', 'mois', 'jour de la semaine'];

/** Un champ (« toutes les 15 », « 1-5 », « 0,30 », « tout ») → l'ensemble des valeurs permises. */
function champ(texte, [min, max], quoi) {
  const out = new Set();
  for (const part of String(texte).split(',')) {
    const m = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part.trim());
    if (!m) throw new Error(`planification : « ${part} » n'est pas un ${quoi} valide`);
    const pas = m[2] ? Number(m[2]) : 1;
    if (pas < 1) throw new Error(`planification : pas nul pour le ${quoi}`);
    let a; let b;
    if (m[1] === '*') { a = min; b = max; } else if (m[1].includes('-')) { [a, b] = m[1].split('-').map(Number); } else {
      a = Number(m[1]);
      b = m[2] ? max : a; // « 5/10 » veut dire « de 5 à la fin, tous les 10 »
    }
    if (!Number.isInteger(a) || !Number.isInteger(b) || a < min || b > max || a > b) {
      throw new Error(`planification : ${quoi} hors bornes (${min}-${max}) dans « ${part} »`);
    }
    for (let v = a; v <= b; v += pas) out.add(v);
  }
  return out;
}

/** Analyse une planification. Lève une Error expliquant quoi corriger. */
export function parseCron(expr) {
  const texte = String(expr || '').trim();
  if (!texte) throw new Error('planification vide');
  const normalise = RACCOURCIS[texte.toLowerCase()] || texte;
  const parts = normalise.split(/\s+/);
  if (parts.length !== 5) throw new Error('planification : cinq champs attendus (minute heure jour mois jour-semaine), ou @daily');
  const [minute, hour, dom, month, dowRaw] = parts.map((p, i) => champ(p, BORNES[i], NOMS[i]));
  // Dimanche s'écrit 0 ou 7.
  const dow = new Set([...dowRaw].map((d) => (d === 7 ? 0 : d)));
  return {
    expr: normalise,
    minute, hour, dom, month, dow,
    // Comportement historique de cron : quand le jour du mois ET le jour de la
    // semaine sont tous deux restreints, l'un OU l'autre suffit.
    domRestreint: parts[2] !== '*',
    dowRestreint: parts[4] !== '*',
  };
}

/** La planification est-elle valide ? (pour valider une saisie sans lever) */
export function cronValid(expr) {
  try { parseCron(expr); return true; } catch { return false; }
}

/** Cette minute-là est-elle une minute d'exécution ? */
export function cronMatches(expr, date = new Date()) {
  const c = typeof expr === 'string' ? parseCron(expr) : expr;
  if (!c.minute.has(date.getMinutes()) || !c.hour.has(date.getHours()) || !c.month.has(date.getMonth() + 1)) return false;
  const jour = c.dom.has(date.getDate());
  const semaine = c.dow.has(date.getDay());
  if (c.domRestreint && c.dowRestreint) return jour || semaine;
  if (c.domRestreint) return jour;
  if (c.dowRestreint) return semaine;
  return true;
}

/** La prochaine exécution après `from`, ou null si rien dans les quatre ans. */
export function cronNext(expr, from = new Date()) {
  const c = parseCron(expr);
  const d = new Date(from.getTime());
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);
  const limite = 4 * 366 * 24 * 60; // quatre ans de minutes : « 31 février » n'arrive jamais
  for (let i = 0; i < limite; i++) {
    if (cronMatches(c, d)) return d;
    d.setMinutes(d.getMinutes() + 1);
  }
  return null;
}

/** Une phrase lisible pour les planifications courantes. */
export function cronWords(expr) {
  try {
    const c = parseCron(expr);
    const un = (s) => (s.size === 1 ? [...s][0] : null);
    const h = un(c.hour); const m = un(c.minute);
    const heure = h != null && m != null ? `${String(h).padStart(2, '0')} h ${String(m).padStart(2, '0')}` : null;
    if (c.expr === '* * * * *') return 'chaque minute';
    if (!c.domRestreint && !c.dowRestreint && c.month.size === 12) {
      if (heure) return `chaque jour à ${heure}`;
      if (h == null && m != null) return `chaque heure à la minute ${m}`;
      if (c.minute.size > 1 && c.hour.size === 24) return `${c.minute.size} fois par heure`;
    }
    if (c.dowRestreint && heure) {
      const jours = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];
      const liste = [...c.dow].sort().map((d) => jours[d]).join(', ');
      return `${liste} à ${heure}`;
    }
    if (c.domRestreint && heure) return `le ${[...c.dom].sort().join(', ')} du mois à ${heure}`;
    return c.expr;
  } catch { return String(expr || ''); }
}

/** Quelques planifications proposées dans l'interface. */
export const CRON_PRESETS = [
  { expr: '*/15 * * * *', label: 'Tous les quarts d’heure' },
  { expr: '0 * * * *', label: 'Chaque heure' },
  { expr: '0 3 * * *', label: 'Chaque nuit à 3 h' },
  { expr: '30 6 * * 1-5', label: 'En semaine à 6 h 30' },
  { expr: '0 4 * * 0', label: 'Chaque dimanche à 4 h' },
  { expr: '0 5 1 * *', label: 'Le 1er du mois à 5 h' },
];
