// Qui parle ? Trois façons de se présenter, dans cet ordre :
//
//   1. le cookie de session       — le tableau de bord, après « login + mot de passe »
//   2. un jeton d'API « rail_… »  — la ligne de commande, les scripts
//   3. RAIL_ADMIN_TOKEN           — la clé de secours de l'installation (compte « root »)
//
// Chaque route demande un rang minimum (lecteur < membre < administrateur).
// Les requêtes qui changent quelque chose et qui viennent d'un cookie doivent
// porter l'anti-CSRF de la session : un autre site ne peut rien déclencher ici.
import { HttpError } from './validate.js';
import { safeEqual } from './crypto.js';
import { verifyPassword, hashPassword, allows, COOKIE, parseCookies, serializeCookie } from './users.js';

const ROOT = { id: 'root', login: 'root', name: 'Jeton d\'administration', role: 'admin', root: true };
/** Un haché jetable, du même coût que les vrais : il fait travailler le serveur
 *  autant pour un compte inconnu que pour un compte existant. Calculé une fois. */
let LEURRE = null;
const leurre = () => (LEURRE ??= hashPassword('\u0000aucun-compte\u0000'));
const SANS_ECRITURE = new Set(['GET', 'HEAD', 'OPTIONS']);
const FENETRE_MS = 60_000;
const ESSAIS_MAX = 10;

export class Auth {
  constructor({ store, config }) {
    this.store = store;
    this.config = config;
    this.failures = new Map(); // ip → { n, until } : freine la devinette d'un jeton ou d'un mot de passe
  }

  /** Vrai quand la machine en face a trop échoué récemment. */
  throttled(ip) {
    const f = this.failures.get(ip);
    return !!(f && f.n >= ESSAIS_MAX && f.until > Date.now());
  }
  fail(ip) {
    const f = this.failures.get(ip);
    this.failures.set(ip, { n: (f?.until > Date.now() ? f.n : 0) + 1, until: Date.now() + FENETRE_MS });
    // La carte ne grossit pas indéfiniment : les entrées périmées partent au passage.
    if (this.failures.size > 2000) for (const [k, v] of this.failures) if (v.until < Date.now()) this.failures.delete(k);
  }
  pass(ip) { this.failures.delete(ip); }

  /**
   * Identifie l'appelant. @returns {{user, via:'session'|'token'|'root', session?}|null}
   */
  identify(req) {
    const bearer = /^Bearer (.+)$/.exec(req.headers.authorization || '')?.[1];
    if (bearer) {
      if (safeEqual(bearer, this.config.adminToken)) return { user: ROOT, via: 'root' };
      const row = this.store.findApiToken(bearer);
      if (row) {
        const user = this.store.getUser(row.user_id);
        if (user) { this.store.touchApiToken(row.id); return { user, via: 'token' }; }
      }
      return null;
    }
    const raw = parseCookies(req.headers.cookie)[COOKIE];
    if (!raw) return null;
    const session = this.store.getSession(raw);
    if (!session) return null;
    const user = this.store.getUser(session.user_id);
    if (!user) return null;
    return { user, via: 'session', session, cookie: raw };
  }

  /** Lève une HttpError si l'appelant n'a pas le droit d'appeler cette route. */
  authorize(req, who, needed) {
    if (!who) throw new HttpError(401, 'connexion nécessaire');
    if (!allows(who.user.role, needed)) throw new HttpError(403, `réservé au rôle « ${needed} » (le vôtre : ${who.user.role})`);
    if (who.via === 'session' && !SANS_ECRITURE.has(req.method)) {
      const given = req.headers['x-rail-csrf'];
      if (!given || !safeEqual(given, who.session.csrf)) throw new HttpError(403, 'jeton anti-CSRF manquant ou invalide');
    }
  }

  // ── connexion ──
  /** Vérifie login + mot de passe et ouvre une session. Lève une HttpError sinon. */
  login({ login, password, ip, agent }) {
    const l = String(login || '').trim().toLowerCase();
    const hash = this.store.passwordHash(l);
    // On vérifie TOUJOURS un haché, même pour un compte inconnu : le temps de réponse
    // ne dit donc pas si le compte existe. Et comme « compte inconnu » lève de toute
    // façon, une correspondance avec le leurre ne connecte personne.
    const bon = verifyPassword(String(password || ''), hash || leurre());
    if (!hash || !bon) { this.fail(ip); throw new HttpError(401, 'identifiant ou mot de passe incorrect'); }
    this.pass(ip);
    const user = this.store.findUser(l);
    this.store.updateUser(user.id, { last_seen_at: new Date().toISOString() });
    const session = this.store.createSession(user.id, { ip, agent, ttlMs: this.config.sessionTtlMs });
    return { user: this.store.getUser(user.id), session };
  }

  cookieFor(token, { clear = false } = {}) {
    return serializeCookie(COOKIE, clear ? '' : token, {
      maxAge: clear ? 0 : Math.floor(this.config.sessionTtlMs / 1000),
      secure: this.config.siteScheme === 'https',
    });
  }
}

export { ROOT };
