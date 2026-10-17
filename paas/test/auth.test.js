// Les comptes : première installation, connexion par mot de passe, rôles,
// anti-CSRF, jetons d'API, et les garde-fous de l'administration.
import test from 'node:test';
import assert from 'node:assert/strict';
import { env, serve, seedUser } from './helpers.js';
import { hashPassword, verifyPassword, checkPassword, allows, parseCookies } from '../src/users.js';

const MDP = 'mot-de-passe-long';

test('mot de passe : haché avec son sel, vérifié en temps constant, politique minimale', () => {
  const h = hashPassword('secret-assez-long', { cost: 1024 }); // coût réduit : c'est un test
  assert.match(h, /^scrypt\$1024\$8\$1\$[\w-]+\$[\w-]+$/);
  assert.ok(verifyPassword('secret-assez-long', h));
  assert.ok(!verifyPassword('secret-assez-lonG', h));
  assert.ok(!verifyPassword('', h));
  assert.notEqual(hashPassword('x', { cost: 1024 }), hashPassword('x', { cost: 1024 }), 'deux sels différents');
  // Un haché illisible, tronqué ou trafiqué ne fait jamais passer, et ne fait pas ramer le serveur.
  for (const mauvais of ['', null, 'scrypt$x', 'scrypt$99999999$8$1$a$b', 'autre$1024$8$1$a$b']) {
    assert.ok(!verifyPassword('x', mauvais), String(mauvais));
  }
  assert.match(checkPassword('court'), /10 caractères/);
  assert.match(checkPassword('motdepasse'), /trop courant/);
  assert.equal(checkPassword(MDP), null);
  assert.ok(allows('admin', 'member') && allows('member', 'viewer') && !allows('viewer', 'member'));
});

test('première installation : le jeton d\'administration crée le premier compte, une seule fois', async () => {
  const e = env();
  const { call, close } = await serve(e);
  assert.equal((await call('GET', '/api/health', undefined, null)).body.setup_needed, true);

  // Sans le jeton de l'installation, personne ne s'auto-déclare administrateur.
  assert.equal((await call('POST', '/api/setup', { login: 'pirate', password: MDP }, null)).status, 401);
  assert.equal(e.store.countUsers(), 0);

  const bad = await call('POST', '/api/setup', { login: 'Ana!', password: MDP });
  assert.equal(bad.status, 400);
  assert.match((await call('POST', '/api/setup', { login: 'ana', password: 'court' })).body.error, /10 caractères/);

  const ok = await call('POST', '/api/setup', { login: 'ana', name: 'Ana', password: MDP });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.role, 'admin');
  assert.equal((await call('GET', '/api/health', undefined, null)).body.setup_needed, false);
  // La fenêtre est refermée.
  assert.equal((await call('POST', '/api/setup', { login: 'bob', password: MDP })).status, 409);
  close();
});

test('« qui suis-je » répond sans refuser : le tableau de bord n\'essuie pas un 401 à chaque visite', async () => {
  const e = env();
  const { call, asUser, close } = await serve(e);
  // Personne, et aucun compte : la page de connexion saura qu'il faut en créer un.
  const vide = await call('GET', '/api/session', undefined, null);
  assert.equal(vide.status, 200);
  assert.equal(vide.body.authenticated, false);
  assert.equal(vide.body.setup_needed, true);

  seedUser(e, { login: 'ana', role: 'admin' });
  assert.equal((await call('GET', '/api/session', undefined, null)).body.setup_needed, false);

  const ana = await asUser('ana', MDP);
  const vu = await ana.call('GET', '/api/session');
  assert.equal(vu.body.authenticated, true);
  assert.equal(vu.body.user.login, 'ana');
  assert.equal(vu.body.csrf, ana.csrf);
  assert.ok(vu.body.roles.length >= 3);
  // Un cookie périmé ou inventé n'est pas une erreur : c'est « personne ».
  assert.equal((await call('GET', '/api/session', undefined, null, { cookie: 'rail_session=inventé' })).body.authenticated, false);
  close();
});

test('connexion : cookie de session, anti-CSRF sur les écritures, déconnexion', async () => {
  const e = env();
  const u = seedUser(e, { login: 'ana', role: 'admin' });
  const { call, base, close } = await serve(e);

  assert.equal((await call('POST', '/api/login', { login: 'ana', password: 'faux' }, null)).status, 401);
  assert.equal((await call('POST', '/api/login', { login: 'inconnu', password: MDP }, null)).status, 401);

  const res = await fetch(`${base}/api/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ login: 'ana', password: u.password }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  const setCookie = String(res.headers.getSetCookie?.()[0] ?? res.headers.get('set-cookie'));
  assert.match(setCookie, /^rail_session=/);
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Lax/);
  assert.match(setCookie, /Secure/, 'le tableau de bord est en https');
  assert.ok(body.csrf && body.user.login === 'ana');
  const cookie = parseCookies(setCookie.split(';')[0]);
  const jeton = cookie.rail_session;
  const head = { cookie: `rail_session=${jeton}` };

  // Lire : le cookie suffit.
  const me = await call('GET', '/api/me', undefined, null, head);
  assert.equal(me.status, 200);
  assert.equal(me.body.via, 'session');
  assert.equal(me.body.csrf, body.csrf);

  // Écrire : sans l'anti-CSRF, un autre site ne peut rien déclencher.
  const sansCsrf = await call('POST', '/api/projects', { name: 'demo' }, null, head);
  assert.equal(sansCsrf.status, 403);
  assert.match(sansCsrf.body.error, /CSRF/);
  const avecCsrf = await call('POST', '/api/projects', { name: 'demo' }, null, { ...head, 'x-rail-csrf': body.csrf });
  assert.equal(avecCsrf.status, 201);

  // Déconnexion : la session ne vaut plus rien.
  const out = await call('POST', '/api/logout', {}, null, { ...head, 'x-rail-csrf': body.csrf });
  assert.equal(out.status, 200);
  assert.match(String(out.headers.get('set-cookie')), /rail_session=;/);
  assert.equal((await call('GET', '/api/me', undefined, null, head)).status, 401);
  assert.equal(e.store.listSessions(u.id).length, 0);
  close();
});

test('rôles : un lecteur regarde, un membre déploie, un administrateur gère les comptes', async () => {
  const e = env();
  seedUser(e, { login: 'ana', role: 'admin' });
  seedUser(e, { login: 'bob', role: 'member' });
  seedUser(e, { login: 'zoe', role: 'viewer' });
  const { asUser, close } = await serve(e);
  const ana = await asUser('ana', MDP);
  const bob = await asUser('bob', MDP);
  const zoe = await asUser('zoe', MDP);

  // Lecteur : tout voir, rien changer.
  assert.equal((await zoe.call('GET', '/api/overview')).status, 200);
  const refus = await zoe.call('POST', '/api/projects', { name: 'demo' });
  assert.equal(refus.status, 403);
  assert.match(refus.body.error, /membre/i);

  // Membre : les projets et les services, mais pas les comptes ni la machine.
  const p = await bob.call('POST', '/api/projects', { name: 'demo' });
  assert.equal(p.status, 201);
  assert.equal((await bob.call('GET', '/api/users')).status, 403);
  assert.equal((await bob.call('POST', '/api/system/prune', {})).status, 403);

  // Administrateur : tout.
  assert.equal((await ana.call('GET', '/api/users')).status, 200);
  assert.equal((await ana.call('POST', '/api/system/prune', {})).status, 200);
  close();
});

test('jetons d\'API : créés une fois, utilisables en Bearer, révocables', async () => {
  const e = env();
  seedUser(e, { login: 'bob', role: 'member' });
  const { call, asUser, close } = await serve(e);
  const bob = await asUser('bob', MDP);

  const t = await bob.call('POST', '/api/me/tokens', { name: 'cli' });
  assert.equal(t.status, 201);
  assert.match(t.body.token, /^rail_[\w-]{20,}$/);
  // Le jeton n'est gardé que haché : on ne le retrouve pas dans la liste.
  const liste = (await bob.call('GET', '/api/me/tokens')).body;
  assert.equal(liste.length, 1);
  assert.equal(liste[0].token, undefined);

  // Il vaut une connexion, sans cookie et sans anti-CSRF (c'est une CLI).
  const me = await call('GET', '/api/me', undefined, t.body.token);
  assert.equal(me.body.user.login, 'bob');
  assert.equal(me.body.via, 'token');
  assert.equal((await call('POST', '/api/projects', { name: 'depuis-cli' }, t.body.token)).status, 201);
  // Mais il garde le rôle de son propriétaire.
  assert.equal((await call('GET', '/api/users', undefined, t.body.token)).status, 403);

  assert.equal((await bob.call('DELETE', `/api/me/tokens/${t.body.id}`)).status, 200);
  assert.equal((await call('GET', '/api/me', undefined, t.body.token)).status, 401);
  close();
});

test('changement de mot de passe : l\'ancien est exigé, les autres sessions tombent', async () => {
  const e = env();
  const u = seedUser(e, { login: 'ana', role: 'admin' });
  const { close, asUser } = await serve(e);
  const s1 = await asUser('ana', MDP);
  const s2 = await asUser('ana', MDP);
  assert.equal(e.store.listSessions(u.id).length, 2);

  assert.equal((await s1.call('POST', '/api/me/password', { current: 'faux', next: 'un-autre-mot-de-passe' })).status, 403);
  assert.match((await s1.call('POST', '/api/me/password', { current: MDP, next: 'court' })).body.error, /10 caractères/);
  assert.match((await s1.call('POST', '/api/me/password', { current: MDP, next: MDP })).body.error, /identique/);

  assert.equal((await s1.call('POST', '/api/me/password', { current: MDP, next: 'un-autre-mot-de-passe' })).status, 200);
  assert.equal(e.store.listSessions(u.id).length, 0, 'toutes les sessions sont fermées');
  assert.equal((await s2.call('GET', '/api/me')).status, 401);
  // Le nouveau mot de passe est le bon.
  const s3 = await asUser('ana', 'un-autre-mot-de-passe');
  assert.equal(s3.user.login, 'ana');
  close();
});

test('administration des comptes : création, rôle, mot de passe remis à zéro, dernier administrateur protégé', async () => {
  const e = env();
  seedUser(e, { login: 'ana', role: 'admin' });
  const { asUser, close } = await serve(e);
  const ana = await asUser('ana', MDP);

  const bob = (await ana.call('POST', '/api/users', { login: 'bob', password: MDP, role: 'member' })).body;
  assert.equal(bob.role, 'member');
  assert.equal(bob.must_change_password, true, 'un compte créé par un autre doit changer son mot de passe');
  assert.equal((await ana.call('POST', '/api/users', { login: 'bob', password: MDP })).status, 409);
  assert.equal((await ana.call('POST', '/api/users', { login: 'carl', password: MDP, role: 'empereur' })).status, 400);

  // Le dernier administrateur ne se rétrograde pas, ne se supprime pas.
  const moi = e.store.findUser('ana');
  assert.match((await ana.call('PATCH', `/api/users/${moi.id}`, { role: 'member' })).body.error, /dernier administrateur/);
  assert.match((await ana.call('DELETE', `/api/users/${moi.id}`)).body.error, /dernier administrateur/);

  // Remettre un mot de passe à zéro ferme les sessions de la personne.
  const sessionBob = await asUser('bob', MDP);
  assert.equal((await sessionBob.call('GET', '/api/me')).status, 200);
  assert.equal((await ana.call('PATCH', `/api/users/${bob.id}`, { password: 'nouveau-mot-de-passe' })).status, 200);
  assert.equal((await sessionBob.call('GET', '/api/me')).status, 401);

  // Et on ne supprime pas son propre compte (même en étant deux administrateurs).
  await ana.call('PATCH', `/api/users/${bob.id}`, { role: 'admin' });
  assert.match((await ana.call('DELETE', `/api/users/${moi.id}`)).body.error, /propre compte/);
  assert.equal((await ana.call('DELETE', `/api/users/${bob.id}`)).status, 200);
  assert.equal(e.store.listUsers().length, 1);
  close();
});

test('essais répétés : la devinette d\'un mot de passe est freinée', async () => {
  const e = env();
  seedUser(e, { login: 'ana' });
  const { call, close } = await serve(e);
  for (let i = 0; i < 10; i++) {
    assert.equal((await call('POST', '/api/login', { login: 'ana', password: `faux${i}` }, null)).status, 401);
  }
  const trop = await call('POST', '/api/login', { login: 'ana', password: MDP }, null);
  assert.equal(trop.status, 429);
  assert.match(trop.body.error, /patientez/);
  close();
});

test('le jeton d\'administration reste la clé de secours, et un jeton inconnu ne passe pas', async () => {
  const e = env();
  seedUser(e, { login: 'ana', role: 'viewer' });
  const { call, close } = await serve(e);
  const me = await call('GET', '/api/me'); // helpers appelle avec config.adminToken
  assert.equal(me.body.user.login, 'root');
  assert.equal(me.body.via, 'root');
  assert.equal((await call('GET', '/api/users')).status, 200, 'le jeton de secours est administrateur');
  assert.equal((await call('GET', '/api/me', undefined, 'rail_inconnu')).status, 401);
  // Le compte « root » n'a pas de mot de passe à changer, et ne fabrique pas de jetons.
  assert.match((await call('POST', '/api/me/password', { current: 'x', next: MDP })).body.error, /\.env/);
  assert.match((await call('POST', '/api/me/tokens', { name: 'x' })).body.error, /connectez-vous avec un compte/);
  close();
});

test('compte GitHub : un jeton vérifié puis gardé chiffré, personnel ou partagé', async () => {
  const e = env();
  seedUser(e, { login: 'bob', role: 'member' });
  seedUser(e, { login: 'ana', role: 'admin' });
  const { asUser, close } = await serve(e);
  const bob = await asUser('bob', MDP);

  assert.equal((await bob.call('POST', '/api/me/github', { token: 'court' })).status, 400);
  assert.match((await bob.call('POST', '/api/me/github', { token: 'ghp_mauvais'.padEnd(25, 'x') })).body.error, /refusé/);

  const ok = await bob.call('POST', '/api/me/github', { token: 'ghp_'.padEnd(30, 'a') });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.github.login, 'octocat');
  assert.equal(ok.body.scope, 'compte');
  assert.equal((await bob.call('GET', '/api/me')).body.github.connected, true);
  // Le jeton est chiffré au repos : la colonne ne contient pas le texte clair.
  const brut = e.store.db.prepare('SELECT github_token_enc FROM users WHERE login=?').get('bob').github_token_enc;
  assert.match(brut, /^v1:/);
  assert.ok(!brut.includes('ghp_'));

  // Seul un administrateur partage un jeton avec toute la plateforme.
  assert.equal((await bob.call('POST', '/api/me/github', { token: 'ghp_'.padEnd(30, 'b'), shared: true })).status, 403);
  const ana = await asUser('ana', MDP);
  assert.equal((await ana.call('POST', '/api/me/github', { token: 'ghp_'.padEnd(30, 'c'), shared: true })).body.scope, 'plateforme');
  assert.equal(e.store.getSetting('github_login'), 'octocat');

  // Les dépôts et les branches viennent de GitHub, pas de nous.
  const repos = (await bob.call('GET', '/api/github/repos')).body;
  assert.equal(repos.length, 2);
  assert.equal(repos[0].full_name, 'acme/api');
  assert.deepEqual((await bob.call('GET', '/api/github/repos?q=site')).body.map((x) => x.full_name), ['acme/site']);
  assert.deepEqual((await bob.call('GET', '/api/github/branches?repo=acme/api')).body, ['main', 'preprod']);
  assert.equal((await bob.call('GET', '/api/github/head?repo=acme/api&branch=main')).body.message, 'dernier commit');
  assert.equal((await bob.call('GET', '/api/github/branches?repo=pasunrepo')).status, 400);

  assert.equal((await bob.call('DELETE', '/api/me/github')).status, 200);
  close();
});

test('sessions ouvertes : visibles et révocables une par une', async () => {
  const e = env();
  const u = seedUser(e, { login: 'ana' });
  const { asUser, close } = await serve(e);
  const s1 = await asUser('ana', MDP);
  await asUser('ana', MDP);
  const liste = (await s1.call('GET', '/api/me/sessions')).body;
  assert.equal(liste.length, 2);
  assert.equal(liste.filter((x) => x.current).length, 1);
  const autre = liste.find((x) => !x.current);
  assert.equal((await s1.call('DELETE', `/api/me/sessions/${autre.id}`)).status, 200);
  assert.equal(e.store.listSessions(u.id).length, 1);
  assert.equal((await s1.call('DELETE', '/api/me/sessions/inexistante')).status, 404);
  close();
});
