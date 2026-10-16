// Toute valeur qui finit dans une commande, un chemin, un nom de domaine ou une
// règle de routage passe ici d'abord. On refuse plutôt qu'on n'échappe.
export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const bad = (m) => { throw new HttpError(400, m); };

export const NAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,28}[a-z0-9])?$/;
export function name(v, what = 'nom') {
  if (typeof v !== 'string' || !NAME_RE.test(v)) bad(`${what} invalide : minuscules, chiffres et tirets, 1 à 30 caractères`);
  return v;
}
export function repo(v) {
  if (typeof v !== 'string' || !/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(v) || v.includes('..')) bad('repo invalide : attendu « propriétaire/dépôt »');
  return v;
}
export function branch(v) {
  if (typeof v !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._\/-]{0,99}$/.test(v) || v.includes('..') || v.endsWith('/') || v.endsWith('.lock')) bad('branche invalide');
  return v;
}
// Sous-dossier du dépôt : relatif, sans « .. », sans caractère exotique.
export function relPath(v, what = 'chemin') {
  if (typeof v !== 'string' || v === '') bad(`${what} invalide`);
  const p = v.replace(/^\.\//, '').replace(/\/+$/, '') || '.';
  if (p.startsWith('/') || p.split('/').some((s) => s === '..') || !/^[A-Za-z0-9_.\/-]+$/.test(p)) bad(`${what} invalide : chemin relatif sans « .. »`);
  return p;
}
export function port(v) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 65535) bad('port invalide');
  return n;
}
export function healthPath(v) {
  if (v === null || v === '') return null;
  if (typeof v !== 'string' || !/^\/[A-Za-z0-9_.~\/%-]*$/.test(v)) bad('chemin de santé invalide (ex. /health)');
  return v;
}
export const HOST_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
export function hostname(v) {
  const h = typeof v === 'string' ? v.trim().toLowerCase() : '';
  if (!HOST_RE.test(h)) bad('nom de domaine invalide');
  return h;
}
export function sha(v) {
  if (typeof v !== 'string' || !/^[0-9a-f]{7,40}$/i.test(v)) bad('sha invalide');
  return v.toLowerCase();
}
export function positive(v, what, max) {
  if (v === null) return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0 || n > max) bad(`${what} invalide (0 < valeur ≤ ${max})`);
  return n;
}

// Variables d'environnement : noms réservés = ceux que la plateforme pose elle-même
// ou qui changeraient le comportement du client docker qui lance le conteneur.
const RESERVED = /^(PORT|PATH|HOME|PWD|SHELL|LD_[A-Z_]*|DOCKER_[A-Z_]*|RAIL_[A-Z_]*)$/;
export function envKey(k) {
  if (typeof k !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(k)) bad(`nom de variable invalide : ${String(k).slice(0, 40)}`);
  if (RESERVED.test(k)) bad(`${k} est réservé à la plateforme`);
  return k;
}
export function envValue(v) {
  if (typeof v !== 'string' || v.length > 32768 || v.includes('\0')) bad('valeur de variable invalide');
  return v;
}

// Une valeur prise dans une liste fermée (moteur de base, état voulu…).
export function oneOf(v, list, what) {
  if (!list.includes(v)) bad(`${what} invalide : attendu ${list.join(', ')}`);
  return v;
}
// Point de montage d'un volume : chemin absolu, sans « .. », hors des dossiers de l'hôte qui comptent.
export function absPath(v, what = 'chemin') {
  if (typeof v !== 'string' || !/^\/[A-Za-z0-9_.\/-]{1,200}$/.test(v) || v.split('/').includes('..') || v.endsWith('/')) bad(`${what} invalide : chemin absolu (ex. /data)`);
  return v;
}
// Fenêtre de mesures : « 1h », « 6h », « 24h », « 7d » → secondes.
const WINDOWS = { '15m': 900, '1h': 3600, '6h': 21600, '24h': 86400, '7d': 604800 };
export const WINDOW_NAMES = Object.keys(WINDOWS);
export function windowSeconds(v, dflt = '1h') {
  const k = v || dflt;
  if (!(k in WINDOWS)) bad(`fenêtre invalide : attendu ${WINDOW_NAMES.join(', ')}`);
  return WINDOWS[k];
}
// Référence d'image Docker : « postgres:16-alpine », « ghcr.io/org/img@sha256:… ».
export function image(v) {
  if (typeof v !== 'string' || !/^[a-z0-9][a-z0-9._/-]{0,120}(:[A-Za-z0-9._-]{1,64})?(@sha256:[a-f0-9]{64})?$/.test(v)) bad('image invalide (ex. postgres:16-alpine)');
  return v;
}

// Nom (ou identifiant) d'un conteneur Docker : ce que `docker ps` affiche.
export function containerName(v) {
  if (typeof v !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(v)) bad('nom de conteneur invalide');
  return v;
}
