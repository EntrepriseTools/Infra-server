import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { env, makeRepo, seedService } from './helpers.js';

const PKG = JSON.stringify({ scripts: { start: 'node s.js' } });
const routeFile = (e, id) => path.join(e.config.routesDir, `${id}.yml`);
const upstream = (e, id) => JSON.parse(fs.readFileSync(routeFile(e, id), 'utf8')).http.services[`rail-${id}`].loadBalancer.servers[0].url;

async function setup(extra = {}) {
  const e = env();
  const repo = makeRepo(e.dir, 'acme/api', { 'package.json': PKG, 's.js': '//' });
  const { service } = seedService(e, extra);
  e.store.setVars(service.id, { DATABASE_URL: 'postgres://x', MULTI: 'a\nb' });
  return { e, repo, svc: service };
}

test('déploiement nominal : clone → build → démarre → sain → route → succès', async () => {
  const { e, repo, svc } = await setup();
  const dep = e.deployer.deploy(svc.id, { trigger: 'manual' });
  await e.deployer.drain();
  const d = e.store.getDeployment(dep.id);
  assert.equal(d.status, 'success', e.logs.read(dep.id));
  assert.equal(d.commit_sha, repo.first);
  assert.equal(d.commit_message, 'premier commit');
  assert.equal(d.image, `rail/${svc.id}:1`);
  assert.equal(d.container, `rail-${svc.id}-1`);
  assert.equal(e.store.getService(svc.id).active_deployment_id, dep.id);
  assert.equal(upstream(e, svc.id), `http://rail-${svc.id}-1:3000`);
  // Dockerfile engendré (aucun dans le dépôt) et .git retiré du contexte
  assert.ok(e.runtime.lastBuild.dockerfile.endsWith('.rail.Dockerfile'));
  assert.ok(!e.runtime.lastBuild.files.includes('.git'));
  // variables injectées + variables de plateforme
  const env_ = e.runtime.env[d.container];
  assert.equal(env_.DATABASE_URL, 'postgres://x'); assert.equal(env_.MULTI, 'a\nb');
  assert.equal(env_.PORT, '3000'); assert.equal(env_.RAIL_GIT_COMMIT_SHA, repo.first);
  assert.equal(env_.RAIL_PUBLIC_DOMAIN, 'api-demo.apps.test.dev');
  assert.equal(e.runtime.last.alias, 'api.demo.internal');
  assert.match(e.logs.read(dep.id), /construction automatique \(node\)/);
  assert.deepEqual(e.statuses.map((s) => s.state), ['pending', 'success']);
  assert.ok(!fs.existsSync(path.join(e.config.buildsDir, dep.id)), 'le dossier de build est nettoyé');
});

test('zéro coupure : l\'ancien conteneur n\'est arrêté qu\'APRÈS le basculement de la route', async () => {
  const { e, repo, svc } = await setup();
  e.deployer.deploy(svc.id); await e.deployer.drain();
  repo.commit({ 'v.txt': '2' }, 'deuxième');
  e.runtime.calls.length = 0;
  const seen = [];
  const origStop = e.runtime.stop.bind(e.runtime);
  e.runtime.stop = async (n, g) => { seen.push({ n, route: upstream(e, svc.id) }); return origStop(n, g); };
  const dep2 = e.deployer.deploy(svc.id); await e.deployer.drain();
  assert.equal(e.store.getDeployment(dep2.id).status, 'success');
  const stopOld = seen.find((s) => s.n === `rail-${svc.id}-1`);
  assert.equal(stopOld.route, `http://rail-${svc.id}-2:3000`, 'la route pointait déjà sur le nouveau');
  assert.equal(e.store.listDeployments(svc.id)[1].status, 'removed');
  assert.ok(e.runtime.containers.has(`rail-${svc.id}-2`) && !e.runtime.containers.has(`rail-${svc.id}-1`));
});

test('échec de santé : l\'ancien reste en service, le nouveau est retiré, logs du conteneur conservés', async () => {
  const { e, repo, svc } = await setup();
  e.deployer.deploy(svc.id); await e.deployer.drain();
  repo.commit({ 'v.txt': '2' }, 'cassé');
  e.runtime.healthy = false;
  const dep2 = e.deployer.deploy(svc.id); await e.deployer.drain();
  const d = e.store.getDeployment(dep2.id);
  assert.equal(d.status, 'failed'); assert.match(d.error, /pas de réponse saine/);
  assert.match(e.logs.read(dep2.id), /derniers logs du conteneur/);
  assert.equal(upstream(e, svc.id), `http://rail-${svc.id}-1:3000`, 'la route n\'a pas bougé');
  assert.ok(e.runtime.containers.has(`rail-${svc.id}-1`) && !e.runtime.containers.has(`rail-${svc.id}-2`));
  assert.equal(e.store.getService(svc.id).active_deployment_id, e.store.listDeployments(svc.id)[1].id);
  assert.equal(e.statuses.at(-1).state, 'failure');
});

test('conteneur qui plante au démarrage → échec immédiat', async () => {
  const { e, svc } = await setup();
  e.runtime.crashOnStart = true;
  const dep = e.deployer.deploy(svc.id); await e.deployer.drain();
  const d = e.store.getDeployment(dep.id);
  assert.equal(d.status, 'failed'); assert.match(d.error, /s'est arrêté au démarrage/);
  assert.equal(e.store.getService(svc.id).active_deployment_id, null);
  assert.ok(!fs.existsSync(routeFile(e, svc.id)), 'aucune route vers un service qui n\'a jamais été sain');
});

test('échec de build : pas de conteneur, message clair', async () => {
  const { e, svc } = await setup();
  e.runtime.buildError = 'npm ERR! boom';
  const dep = e.deployer.deploy(svc.id); await e.deployer.drain();
  const d = e.store.getDeployment(dep.id);
  assert.equal(d.status, 'failed'); assert.match(d.error, /boom/);
  assert.equal(e.runtime.calls.filter((c) => c.startsWith('start')).length, 0);
});

test('Dockerfile absent et langage inconnu → échec expliqué', async () => {
  const e = env();
  makeRepo(e.dir, 'acme/api', { 'README.md': 'rien' });
  const { service } = seedService(e);
  const dep = e.deployer.deploy(service.id); await e.deployer.drain();
  assert.match(e.store.getDeployment(dep.id).error, /Langage non reconnu/);
});

test('dépôt ou sha inexistant → échec, jeton jamais journalisé', async () => {
  const e = env();
  const { service } = seedService(e, { repo: 'acme/inexistant', github_token: 'ghp_TOPSECRET' });
  const dep = e.deployer.deploy(service.id); await e.deployer.drain();
  const d = e.store.getDeployment(dep.id);
  assert.equal(d.status, 'failed');
  assert.ok(!e.logs.read(dep.id).includes('ghp_TOPSECRET') && !d.error.includes('ghp_TOPSECRET'));
});

test('déploiement d\'un sha précis (webhook) même si la branche a avancé', async () => {
  const { e, repo, svc } = await setup();
  const second = repo.commit({ 'v.txt': '2' }, 'deux');
  repo.commit({ 'v.txt': '3' }, 'trois');
  const dep = e.deployer.deploy(svc.id, { trigger: 'push', sha: second, message: 'deux' }); await e.deployer.drain();
  assert.equal(e.store.getDeployment(dep.id).commit_sha, second);
  assert.equal(e.store.getDeployment(dep.id).status, 'success', e.logs.read(dep.id));
});

test('Dockerfile du dépôt, sous-dossier racine et dossier absent', async () => {
  const e = env();
  makeRepo(e.dir, 'acme/api', { 'services/api/Dockerfile': 'FROM scratch', 'services/api/x': '1' });
  const { service } = seedService(e, { root_dir: 'services/api' });
  e.deployer.deploy(service.id); await e.deployer.drain();
  assert.ok(e.runtime.lastBuild.dockerfile.endsWith(path.join('services', 'api', 'Dockerfile')));
  assert.ok(e.runtime.lastBuild.contextDir.endsWith(path.join('services', 'api')));
  e.store.updateService(service.id, { root_dir: 'nope' });
  const d2 = e.deployer.deploy(service.id); await e.deployer.drain();
  assert.match(e.store.getDeployment(d2.id).error, /n'existe pas/);
});

test('retour arrière : réutilise l\'image, sans reconstruire, et rebascule la route', async () => {
  const { e, repo, svc } = await setup();
  const d1 = e.deployer.deploy(svc.id); await e.deployer.drain();
  repo.commit({ 'v.txt': '2' }, 'deux');
  e.deployer.deploy(svc.id); await e.deployer.drain();
  const builds = e.runtime.calls.filter((c) => c.startsWith('build')).length;
  const rb = e.deployer.rollback(d1.id); await e.deployer.drain();
  const d = e.store.getDeployment(rb.id);
  assert.equal(d.status, 'success', e.logs.read(rb.id));
  assert.equal(d.trigger, 'rollback'); assert.equal(d.image, `rail/${svc.id}:1`);
  assert.equal(e.runtime.calls.filter((c) => c.startsWith('build')).length, builds, 'aucune reconstruction');
  assert.equal(upstream(e, svc.id), `http://rail-${svc.id}-3:3000`);
  assert.equal(e.store.getDeployment(d1.id).commit_sha, d.commit_sha);
  // une image disparue ne peut pas être remise
  e.runtime.images.clear();
  const bad = e.deployer.rollback(d1.id); await e.deployer.drain();
  assert.match(e.store.getDeployment(bad.id).error, /n'existe plus/);
  assert.throws(() => e.deployer.rollback(bad.id), /pas d'image réutilisable/);
});

test('redéploiement : prend les nouvelles variables et domaines sans reconstruire', async () => {
  const { e, svc } = await setup();
  e.deployer.deploy(svc.id); await e.deployer.drain();
  e.store.setVars(svc.id, { NOUVELLE: 'oui' });
  e.store.addDomain(svc.id, 'api.client.com', 'custom');
  const builds = e.runtime.calls.filter((c) => c.startsWith('build')).length;
  const re = e.deployer.redeploy(svc.id); await e.deployer.drain();
  assert.equal(e.store.getDeployment(re.id).status, 'success');
  assert.equal(e.runtime.calls.filter((c) => c.startsWith('build')).length, builds);
  assert.equal(e.runtime.env[`rail-${svc.id}-2`].NOUVELLE, 'oui');
  const route = JSON.parse(fs.readFileSync(routeFile(e, svc.id), 'utf8'));
  assert.match(route.http.routers[`rail-${svc.id}`].rule, /api\.client\.com/);
  assert.throws(() => e.deployer.redeploy('inconnu'), /service inconnu/);
  const p2 = e.store.createProject('autre');
  const vide = e.store.createService(p2.id, { name: 'vide', repo: 'a/b', branch: 'main', root_dir: '.', port: 80 });
  assert.throws(() => e.deployer.redeploy(vide.id), /aucun déploiement en service/);
});

test('file d\'attente : un seul déploiement à la fois par service, le plus récent remplace ceux qui attendent', async () => {
  const { e, repo, svc } = await setup();
  let running = 0; let max = 0;
  const origBuild = e.runtime.build.bind(e.runtime);
  e.runtime.build = async (o) => { running++; max = Math.max(max, running); await new Promise((r) => setTimeout(r, 40)); try { return await origBuild(o); } finally { running--; } };
  const a = e.deployer.deploy(svc.id);
  await new Promise((r) => setTimeout(r, 10)); // a est en cours de construction
  const b = e.deployer.deploy(svc.id);
  repo.commit({ 'v': '2' }, 'x');
  const c = e.deployer.deploy(svc.id);
  await e.deployer.drain();
  assert.equal(max, 1);
  assert.equal(e.store.getDeployment(a.id).status, 'removed'); // a a fini, puis c l'a remplacé
  assert.equal(e.store.getDeployment(b.id).status, 'skipped');
  assert.equal(e.store.getDeployment(c.id).status, 'success');
});

test('annulation d\'un déploiement en file', async () => {
  const { e, svc } = await setup();
  const origBuild = e.runtime.build.bind(e.runtime);
  e.runtime.build = async (o) => { await new Promise((r) => setTimeout(r, 60)); return origBuild(o); };
  const a = e.deployer.deploy(svc.id);
  await new Promise((r) => setTimeout(r, 5));
  const b = e.deployer.deploy(svc.id);
  assert.equal(e.deployer.cancel(b.id), true);
  await e.deployer.drain();
  assert.equal(e.store.getDeployment(b.id).status, 'canceled');
  assert.equal(e.store.getDeployment(a.id).status, 'success');
  assert.equal(e.deployer.cancel(a.id), false, 'déjà terminé');
});

test('annulation pendant le démarrage : le conteneur est retiré', async () => {
  const { e, svc } = await setup();
  e.runtime.healthy = false;
  e.config.healthTimeoutMs = 5000;
  const dep = e.deployer.deploy(svc.id);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(e.store.getDeployment(dep.id).status, 'deploying');
  e.deployer.cancel(dep.id); await e.deployer.drain();
  assert.equal(e.store.getDeployment(dep.id).status, 'canceled');
  assert.equal(e.runtime.containers.size, 0);
});

test('nettoyage : seules les N dernières images (et celle en service) sont gardées', async () => {
  const { e, repo, svc } = await setup();
  e.config.keepImages = 2;
  for (let i = 0; i < 4; i++) { e.deployer.deploy(svc.id); await e.deployer.drain(); repo.commit({ 'v': String(i) }, `c${i}`); }
  assert.deepEqual([...e.runtime.images].sort(), [`rail/${svc.id}:3`, `rail/${svc.id}:4`]);
});

test('reconcile : les déploiements interrompus échouent, les routes se réécrivent', async () => {
  const { e, svc } = await setup();
  e.deployer.deploy(svc.id); await e.deployer.drain();
  const stuck = e.store.createDeployment(svc.id, { trigger: 'manual' });
  e.store.updateDeployment(stuck.id, { status: 'building' });
  fs.rmSync(routeFile(e, svc.id));
  await e.deployer.reconcile();
  assert.equal(e.store.getDeployment(stuck.id).status, 'failed');
  assert.ok(fs.existsSync(routeFile(e, svc.id)));
});

test('destroy : route, conteneurs et images disparaissent', async () => {
  const { e, svc } = await setup();
  e.deployer.deploy(svc.id); await e.deployer.drain();
  await e.deployer.destroy(svc.id);
  assert.ok(!fs.existsSync(routeFile(e, svc.id)));
  assert.equal(e.runtime.containers.size, 0); assert.equal(e.runtime.images.size, 0);
});

test('un journal suivi en direct reçoit TOUTES les lignes, jusqu\'à la dernière', async () => {
  const { e, svc } = await setup();
  const dep = e.deployer.deploy(svc.id);
  let got = ''; let ended = false;
  e.logs.follow(dep.id, (t) => { got += t; }, () => { ended = true; });
  await e.deployer.drain();
  assert.ok(ended);
  assert.match(got, /En service sur https:\/\/api-demo/);
  assert.equal(got, e.logs.read(dep.id));
});

test('arrêt et redémarrage : la route disparaît, le conteneur survit, rien ne se reconstruit', async () => {
  const { e, svc } = await setup();
  e.deployer.deploy(svc.id); await e.deployer.drain();
  const container = `rail-${svc.id}-1`;
  const builds = e.runtime.calls.filter((c) => c.startsWith('build')).length;

  await e.deployer.stopService(svc.id);
  assert.equal(e.store.getService(svc.id).desired_state, 'stopped');
  assert.ok(!fs.existsSync(routeFile(e, svc.id)), 'plus de route : le service répond 404');
  assert.equal(await e.runtime.state(container), 'exited');
  assert.equal(e.store.listEvents({ limit: 1 })[0].kind, 'service.stopped');

  await e.deployer.startService(svc.id);
  assert.equal(e.store.getService(svc.id).desired_state, 'running');
  assert.equal(await e.runtime.state(container), 'running');
  assert.equal(upstream(e, svc.id), `http://${container}:3000`);
  assert.equal(e.runtime.calls.filter((c) => c.startsWith('build')).length, builds, 'aucune reconstruction');

  await e.deployer.restartService(svc.id);
  assert.equal(e.runtime.restarts[container], 1);
  assert.equal(e.store.listDeployments(svc.id).length, 1, 'redémarrer n\'est pas déployer');
});

test('démarrer un service dont le conteneur a disparu relance l\'image', async () => {
  const { e, svc } = await setup();
  e.deployer.deploy(svc.id); await e.deployer.drain();
  await e.deployer.stopService(svc.id);
  e.runtime.containers.clear(); // le conteneur a été supprimé à la main
  const r = await e.deployer.startService(svc.id);
  await e.deployer.drain();
  assert.ok(r.deployment, 'un déploiement a été relancé');
  assert.equal(e.store.getDeployment(r.deployment.id).status, 'success');
  assert.equal(e.runtime.calls.filter((c) => c.startsWith('build')).length, 1, 'l\'image existante est réutilisée');
});

test('déployer un service arrêté le remet en marche', async () => {
  const { e, svc } = await setup();
  e.deployer.deploy(svc.id); await e.deployer.drain();
  await e.deployer.stopService(svc.id);
  e.deployer.deploy(svc.id); await e.deployer.drain();
  assert.equal(e.store.getService(svc.id).desired_state, 'running');
  assert.ok(fs.existsSync(routeFile(e, svc.id)));
});

test('reconcile : un conteneur resté sur le carreau après un reboot est relancé', async () => {
  const { e, svc } = await setup();
  e.deployer.deploy(svc.id); await e.deployer.drain();
  const container = `rail-${svc.id}-1`;
  e.runtime.containers.set(container, 'exited');
  fs.rmSync(routeFile(e, svc.id));
  await e.deployer.reconcile();
  assert.equal(await e.runtime.state(container), 'running');
  assert.ok(fs.existsSync(routeFile(e, svc.id)));
});

test('reconcile : un service arrêté exprès le reste', async () => {
  const { e, svc } = await setup();
  e.deployer.deploy(svc.id); await e.deployer.drain();
  await e.deployer.stopService(svc.id);
  await e.deployer.reconcile();
  assert.ok(!fs.existsSync(routeFile(e, svc.id)));
  assert.equal(await e.runtime.state(`rail-${svc.id}-1`), 'exited');
});

test('journal des conteneurs : rotation imposée, pour qu\'un service bavard ne remplisse pas le disque', async () => {
  const { e, svc } = await setup();
  e.deployer.deploy(svc.id); await e.deployer.drain();
  assert.equal(e.store.listEvents({ limit: 20 }).filter((x) => x.kind === 'deployment.success').length, 1);
  assert.equal(e.config.logMaxSizeMb, 10);
  assert.equal(e.config.logMaxFiles, 3);
});

test('échec : l\'événement et l\'alerte partent avec la raison', async () => {
  const { e, svc } = await setup();
  e.runtime.buildError = 'npm ERR! boom';
  e.deployer.deploy(svc.id); await e.deployer.drain();
  const ev = e.store.listEvents({ limit: 10 }).find((x) => x.kind === 'deployment.failed');
  assert.match(ev.message, /boom/);
  assert.equal(ev.level, 'error');
  assert.equal(e.notifier.sent.at(-1).level, 'error');
});

test('arrêter pendant une construction : le déploiement est annulé, la requête ne patiente pas', async () => {
  const { e, svc } = await setup();
  const origBuild = e.runtime.build.bind(e.runtime);
  e.runtime.build = async (o) => { await new Promise((r) => setTimeout(r, 300)); return origBuild(o); };
  const dep = e.deployer.deploy(svc.id);
  await new Promise((r) => setTimeout(r, 20));
  const t0 = Date.now();
  await e.deployer.stopService(svc.id);
  assert.ok(Date.now() - t0 < 250, 'on n\'attend pas la fin de la construction');
  await e.deployer.drain();
  assert.equal(e.store.getDeployment(dep.id).status, 'canceled');
  assert.equal(e.store.getService(svc.id).desired_state, 'stopped');
});

test('démarrer ou redémarrer pendant un déploiement : refusé plutôt que mis en attente', async () => {
  const { e, svc } = await setup();
  const origBuild = e.runtime.build.bind(e.runtime);
  e.runtime.build = async (o) => { await new Promise((r) => setTimeout(r, 200)); return origBuild(o); };
  e.deployer.deploy(svc.id);
  await new Promise((r) => setTimeout(r, 20));
  await assert.rejects(() => e.deployer.restartService(svc.id), /déploiement est en cours/);
  await assert.rejects(() => e.deployer.startService(svc.id), /déploiement est en cours/);
  await e.deployer.drain();
  assert.equal(e.store.listDeployments(svc.id)[0].status, 'success');
});
