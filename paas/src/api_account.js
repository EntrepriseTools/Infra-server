// Les routes des comptes : première installation, connexion, mot de passe,
// jetons d'API, sessions, utilisateurs, et le branchement du compte GitHub.
import { HttpError } from './validate.js';
import * as v from './validate.js';
import { ok } from './api_shared.js';
import { ROLES, ROLE_NAMES, LOGIN_RE, checkPassword, verifyPassword, allows, COOKIE, parseCookies } from './users.js';

const login = (x) => {
  const l = String(x || '').trim().toLowerCase();
  if (!LOGIN_RE.test(l)) throw new HttpError(400, 'identifiant invalide : minuscules, chiffres, point, tiret, souligné (2 à 31 caractères)');
  return l;
};
const motDePasse = (x) => {
  const why = checkPassword(x);
  if (why) throw new HttpError(400, why);
  return x;
};
const nomAffiche = (x, dflt) => {
  if (x == null || x === '') return dflt;
  const s = String(x).trim();
  if (s.length > 60 || /[\x00-\x1f]/.test(s)) throw new HttpError(400, 'nom affiché invalide (60 caractères au plus)');
  return s;
};

export function mountAccount(ctx) {
  const { r, config, store, auth, github, H } = ctx;

  const publicUser = (u) => ({ ...u, role_label: ROLES[u.role]?.label ?? u.role });

  // ── première installation ───────────────────────────────────────────────
  // Ouverte, mais il faut présenter RAIL_ADMIN_TOKEN (celui qu'affiche install.sh)
  // ET qu'aucun compte n'existe encore : la fenêtre se referme d'elle-même.
  r.add('POST', '/api/setup', ({ body, req }) => {
    if (store.countUsers() > 0) throw new HttpError(409, 'un compte existe déjà : connectez-vous');
    const who = auth.identify(req);
    if (who?.via !== 'root') throw new HttpError(401, 'le jeton d\'administration (affiché par l\'installation) est nécessaire pour créer le premier compte');
    const l = login(body.login);
    const u = store.createUser({ login: l, name: nomAffiche(body.name, l), role: 'admin', password: motDePasse(body.password) });
    store.addEvent({ kind: 'user.created', level: 'warn', subject: u.login, actor: 'root', message: `compte administrateur « ${u.login} » créé à l'installation` });
    return ok(publicUser(u), 201);
  }, { public: true });

  // ── « qui suis-je ? », sans échouer quand la réponse est « personne » ────
  // Le tableau de bord appelle cette route au chargement : elle évite un 401 à
  // chaque visite, et dit du même coup s'il faut créer le premier compte.
  r.add('GET', '/api/session', ({ req }) => {
    const who = auth.identify(req);
    if (!who) return ok({ authenticated: false, setup_needed: store.countUsers() === 0, version: config.version });
    return ok({
      authenticated: true,
      user: publicUser(who.user),
      via: who.via,
      csrf: who.session?.csrf ?? null,
      roles: ROLE_NAMES.map((id) => ({ id, ...ROLES[id] })),
      github: githubState(who.user),
      version: config.version,
    });
  }, { public: true });

  // ── connexion ───────────────────────────────────────────────────────────
  r.add('POST', '/api/login', ({ body, req, res }) => {
    const ip = req.socket.remoteAddress;
    if (auth.throttled(ip)) throw new HttpError(429, 'trop d\'essais : patientez une minute');
    const { user, session } = auth.login({
      login: body.login, password: body.password, ip, agent: req.headers['user-agent'],
    });
    res.setHeader('set-cookie', auth.cookieFor(session.token));
    store.addEvent({ kind: 'user.login', level: 'info', subject: user.login, actor: user.login, message: `${user.login} s'est connecté` });
    return ok({ user: publicUser(user), csrf: session.csrf, expires_at: session.expiresAt });
  }, { public: true });

  r.add('POST', '/api/logout', ({ req, res, user }) => {
    const raw = parseCookies(req.headers.cookie)[COOKIE];
    if (raw) store.deleteSession(raw);
    res.setHeader('set-cookie', auth.cookieFor('', { clear: true }));
    return ok({ bye: user?.login ?? null });
  }, { role: 'viewer' });

  r.add('GET', '/api/me', ({ who }) => ok({
    user: publicUser(who.user),
    via: who.via,
    csrf: who.session?.csrf ?? null,
    roles: ROLE_NAMES.map((id) => ({ id, ...ROLES[id] })),
    github: githubState(who.user),
  }), { role: 'viewer' });

  r.add('POST', '/api/me/password', ({ body, who }) => {
    if (who.user.root) throw new HttpError(400, 'le jeton d\'administration n\'a pas de mot de passe : il se change dans .env');
    const hash = store.passwordHashById(who.user.id);
    if (!verifyPassword(String(body.current || ''), hash)) throw new HttpError(403, 'mot de passe actuel incorrect');
    const next = motDePasse(body.next);
    if (next === String(body.current)) throw new HttpError(400, 'le nouveau mot de passe est identique à l\'ancien');
    store.updateUser(who.user.id, { password: next, must_change_password: false });
    // Les autres sessions tombent : un mot de passe changé, c'est aussi « déconnecte le reste ».
    store.deleteUserSessions(who.user.id);
    store.addEvent({ kind: 'user.password', level: 'warn', subject: who.user.login, actor: who.user.login, message: `${who.user.login} a changé son mot de passe (autres sessions fermées)` });
    return ok({ changed: true, sessions_closed: true });
  }, { role: 'viewer' });

  // ── sessions ouvertes ──
  r.add('GET', '/api/me/sessions', ({ who }) => ok(who.user.root ? [] : store.listSessions(who.user.id).map((s) => ({
    ...s, current: who.session?.id === s.id,
  }))), { role: 'viewer' });
  r.add('DELETE', '/api/me/sessions/:id', ({ params, who }) => {
    const mine = store.listSessions(who.user.id).some((s) => s.id === params.id);
    if (!mine) throw new HttpError(404, 'session introuvable');
    store.deleteSessionById(params.id);
    return ok({ closed: true });
  }, { role: 'viewer' });

  // ── jetons d'API (la ligne de commande) ──
  r.add('GET', '/api/me/tokens', ({ who }) => ok(who.user.root ? [] : store.listApiTokens(who.user.id)), { role: 'viewer' });
  r.add('POST', '/api/me/tokens', ({ body, who }) => {
    if (who.user.root) throw new HttpError(400, 'le jeton d\'administration ne crée pas de jetons : connectez-vous avec un compte');
    if (store.listApiTokens(who.user.id).length >= 20) throw new HttpError(409, '20 jetons au plus par compte : supprimez-en un');
    const t = store.createApiToken(who.user.id, v.name(String(body.name || 'cli').toLowerCase(), 'nom du jeton'));
    store.addEvent({ kind: 'token.created', level: 'warn', subject: who.user.login, actor: who.user.login, message: `jeton d'API « ${t.name} » créé pour ${who.user.login}` });
    // La seule fois où le jeton est lisible.
    return ok({ ...t, note: 'copiez-le maintenant : il ne sera plus affiché' }, 201);
  }, { role: 'member' });
  r.add('DELETE', '/api/me/tokens/:id', ({ params, who }) => {
    if (!store.deleteApiToken(who.user.id, params.id)) throw new HttpError(404, 'jeton introuvable');
    return ok({ deleted: true });
  }, { role: 'member' });

  // ── compte GitHub ───────────────────────────────────────────────────────
  function githubState(user) {
    const perso = user.root ? null : store.userGithubToken(user.id);
    const commun = store.getSetting('github_token') || config.defaultGithubToken;
    return {
      connected: !!(perso || commun),
      scope: perso ? 'compte' : commun ? 'plateforme' : null,
      login: store.getSetting('github_login') || null,
    };
  }
  /** Colle un jeton GitHub, le vérifie auprès de GitHub, puis le garde chiffré. */
  r.add('POST', '/api/me/github', async ({ body, who }) => {
    const token = String(body.token || '').trim();
    if (!/^[A-Za-z0-9_-]{20,255}$/.test(token)) throw new HttpError(400, 'jeton GitHub invalide (ghp_… ou github_pat_…)');
    let me;
    try { me = await github.me(token); } catch (e) { throw new HttpError(400, e.message); }
    const partage = body.shared === true;
    if (partage && !allows(who.user.role, 'admin')) throw new HttpError(403, 'seul un administrateur peut partager un jeton avec toute la plateforme');
    if (partage || who.user.root) { store.setSetting('github_token', token); store.setSetting('github_login', me.login); }
    else store.updateUser(who.user.id, { github_token: token });
    store.addEvent({ kind: 'github.connected', level: 'info', subject: me.login, actor: who.user.login, message: `GitHub relié : ${me.login}${partage || who.user.root ? ' (pour toute la plateforme)' : ''}` });
    return ok({ connected: true, github: me, scope: partage || who.user.root ? 'plateforme' : 'compte' });
  }, { role: 'member' });
  r.add('DELETE', '/api/me/github', ({ who, query }) => {
    if (query.get('shared') === '1') {
      if (!allows(who.user.role, 'admin')) throw new HttpError(403, 'réservé à un administrateur');
      store.setSetting('github_token', null); store.setSetting('github_login', null);
    } else if (!who.user.root) store.updateUser(who.user.id, { github_token: null });
    return ok({ disconnected: true });
  }, { role: 'member' });

  // ── utilisateurs (administration) ───────────────────────────────────────
  const admins = () => store.listUsers().filter((u) => u.role === 'admin');
  r.add('GET', '/api/users', () => ok(store.listUsers().map(publicUser)), { role: 'admin' });
  r.add('POST', '/api/users', ({ body, who }) => {
    const l = login(body.login);
    if (store.findUser(l)) throw new HttpError(409, 'cet identifiant est déjà pris');
    const role = v.oneOf(body.role || 'member', ROLE_NAMES, 'rôle');
    const u = store.createUser({
      login: l, name: nomAffiche(body.name, l), role, password: motDePasse(body.password),
      mustChange: body.must_change_password !== false,
    });
    store.addEvent({ kind: 'user.created', level: 'warn', subject: u.login, actor: who.user.login, message: `compte « ${u.login} » créé (${ROLES[role].label})` });
    return ok(publicUser(u), 201);
  }, { role: 'admin' });
  r.add('PATCH', '/api/users/:id', ({ params, body, who }) => {
    const u = H.userOr404(params.id);
    const patch = {};
    if ('name' in body) patch.name = nomAffiche(body.name, u.login);
    if ('role' in body) {
      patch.role = v.oneOf(body.role, ROLE_NAMES, 'rôle');
      if (u.role === 'admin' && patch.role !== 'admin' && admins().length === 1) throw new HttpError(409, 'c\'est le dernier administrateur : nommez-en un autre d\'abord');
    }
    if (body.password) {
      patch.password = motDePasse(body.password);
      patch.must_change_password = body.must_change_password !== false;
      store.deleteUserSessions(u.id); // un mot de passe remis à zéro ferme les sessions
    }
    const next = store.updateUser(u.id, patch);
    store.addEvent({ kind: 'user.updated', level: 'warn', subject: u.login, actor: who.user.login, message: `compte « ${u.login} » modifié${patch.role ? ` → ${ROLES[patch.role].label}` : ''}${patch.password ? ' (mot de passe remis à zéro)' : ''}` });
    return ok(publicUser(next));
  }, { role: 'admin' });
  r.add('DELETE', '/api/users/:id', ({ params, who }) => {
    const u = H.userOr404(params.id);
    if (u.role === 'admin' && admins().length === 1) throw new HttpError(409, 'c\'est le dernier administrateur : il ne peut pas être supprimé');
    if (who.user.id === u.id) throw new HttpError(409, 'on ne supprime pas son propre compte : demandez à un autre administrateur');
    store.deleteUser(u.id);
    store.addEvent({ kind: 'user.deleted', level: 'warn', subject: u.login, actor: who.user.login, message: `compte « ${u.login} » supprimé` });
    return ok({ deleted: true });
  }, { role: 'admin' });

  return { githubState };
}
