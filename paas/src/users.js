// Les comptes : mots de passe hachés, sessions en cookie, jetons d'API.
//
// Un mot de passe n'est jamais stocké : seul son haché scrypt l'est, avec son sel.
// Un jeton (session ou API) n'est jamais stocké non plus : seule son empreinte
// SHA-256 entre en base — un vol de la base ne donne donc aucun accès.
import { scryptSync, randomBytes, timingSafeEqual, createHash } from 'node:crypto';

const COUT = 16384; // 2^14 : ~50 ms par vérification sur un petit serveur
const R = 8;
const P = 1;
const LONGUEUR = 32;
const MAXMEM = 64 * 1024 * 1024;

/** Les rôles, du moins au plus puissant. Une route demande un rang minimum. */
export const ROLES = {
  viewer: { rank: 1, label: 'Lecteur', help: 'voit tout, ne change rien' },
  member: { rank: 2, label: 'Membre', help: 'déploie, exploite, gère projets et services' },
  admin: { rank: 3, label: 'Administrateur', help: 'tout, plus les comptes et le système' },
};
export const ROLE_NAMES = Object.keys(ROLES);
export const rank = (role) => ROLES[role]?.rank ?? 0;
export const allows = (role, needed) => rank(role) >= rank(needed);

export const hashToken = (token) => createHash('sha256').update(String(token)).digest('hex');

export function hashPassword(plain, { cost = COUT } = {}) {
  const salt = randomBytes(16);
  const key = scryptSync(String(plain), salt, LONGUEUR, { N: cost, r: R, p: P, maxmem: MAXMEM });
  return `scrypt$${cost}$${R}$${P}$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

/** Vrai si le mot de passe correspond au haché ; faux (jamais d'exception) sinon. */
export function verifyPassword(plain, stored) {
  const m = /^scrypt\$(\d+)\$(\d+)\$(\d+)\$([^$]+)\$([^$]+)$/.exec(stored || '');
  if (!m) return false;
  const [cost, r, p] = m.slice(1, 4).map(Number);
  if (cost > 1 << 20 || r > 32 || p > 16) return false; // une base trafiquée ne nous fait pas ramer
  try {
    const salt = Buffer.from(m[4], 'base64url');
    const want = Buffer.from(m[5], 'base64url');
    const got = scryptSync(String(plain), salt, want.length, { N: cost, r, p, maxmem: MAXMEM });
    return want.length === got.length && timingSafeEqual(want, got);
  } catch { return false; }
}

export const LOGIN_RE = /^[a-z0-9](?:[a-z0-9._-]{1,30})$/;
/** Ce qu'on refuse d'accepter comme mot de passe : trop court, ou dans la liste des évidences. */
const FAIBLES = new Set(['motdepasse', 'password', 'azertyuiop', 'qwertyuiop', '1234567890', 'administrateur', 'changemoi', 'changeme']);
export function checkPassword(plain) {
  if (typeof plain !== 'string' || plain.length < 10) return 'le mot de passe doit faire au moins 10 caractères';
  if (plain.length > 256) return 'mot de passe trop long (256 caractères au plus)';
  if (FAIBLES.has(plain.toLowerCase())) return 'ce mot de passe est trop courant : choisissez-en un autre';
  return null;
}

// ── le cookie de session ───────────────────────────────────────────────────
export const COOKIE = 'rail_session';

export function serializeCookie(name, value, { maxAge, secure = true } = {}) {
  const bits = [`${name}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (secure) bits.push('Secure');
  bits.push(`Max-Age=${maxAge ?? 0}`);
  return bits.join('; ');
}

export function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}
