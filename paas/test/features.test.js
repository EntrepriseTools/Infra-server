// Les fonctionnalités « Railway » ajoutées au-dessus du déploiement : environnements,
// variables partagées, images publiques, modèles en un clic, tâches planifiées,
// sauvegardes, exposition TCP, chemins surveillés.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHmac } from 'node:crypto';
import { env, makeRepo, serve } from './helpers.js';
import { volumeName } from '../src/deployer.js';
import { templateList, getTemplate, instantiate } from '../src/templates.js';
import { autoHost, privateHost } from '../src/naming.js';
import { cronMatches, cronNext, cronWords, parseCron } from '../src/cron.js';

const PKG = JSON.stringify({ scripts: { start: 'node s.js' } });
const routeFile = (e, id) => path.join(e.config.routesDir, `${id}.yml`);

async function boot() {
  const e = env();
  makeRepo(e.dir, 'acme/api', { 'package.json': PKG, 's.js': '//' });
  const s = await serve(e);
  const project = (await s.call('POST', '/api/projects', { name: 'demo' })).body;
  return { e, project, ...s };
}
const prodOf = (p) => p.environments.find((x) => x.name === 'production');

// ── environnements ─────────────────────────────────────────────────────────

test('noms : « production » n\'ajoute rien, un autre environnement se glisse dans le nom', () => {
  assert.equal(autoHost({ service: 'api', project: 'boutique', environment: 'production', domain: 'apps.test.dev' }), 'api-boutique.apps.test.dev');
  assert.equal(autoHost({ service: 'api', project: 'boutique', environment: 'preprod', domain: 'apps.test.dev' }), 'api-boutique-preprod.apps.test.dev');
  assert.equal(privateHost({ service: 'api', project: 'boutique', environment: 'production' }), 'api.boutique.internal');
  assert.equal(privateHost({ service: 'api', project: 'boutique', environment: 'preprod' }), 'api.boutique-preprod.internal');
});

test('environnements : le même service deux fois, avec des adresses et des variables à lui', async () => {
  const { e, project, call, close } = await boot();
  assert.equal(project.environments.length, 1);
  assert.equal(prodOf(project).name, 'production');

  const prod = prodOf(project);
  const apiProd = (await call('POST', `/api/projects/${project.id}/services`, { name: 'api', repo: 'acme/api' })).body;
  assert.equal(apiProd.domains[0].hostname, 'api-demo.apps.test.dev');

  const preprod = (await call('POST', `/api/projects/${project.id}/environments`, { name: 'preprod' })).body;
  assert.equal(preprod.services.length, 0);
  const apiPre = (await call('POST', `/api/projects/${project.id}/services`, { name: 'api', repo: 'acme/api', environment_id: preprod.id, branch: 'main' })).body;
  assert.equal(apiPre.domains[0].hostname, 'api-demo-preprod.apps.test.dev');
  assert.equal(apiPre.environment_name, 'preprod');
  assert.notEqual(apiPre.id, apiProd.id, 'deux services distincts, même nom');
  assert.equal(apiPre.private_host, 'api.demo-preprod.internal');

  // Dix environnements au plus, et pas deux fois le même nom.
  assert.equal((await call('POST', `/api/projects/${project.id}/environments`, { name: 'preprod' })).status, 409);

  // Les variables partagées descendent dans les services de leur environnement, et cèdent
  // devant une variable du service.
  await call('PUT', `/api/environments/${prod.id}/variables`, { variables: { ZONE: 'eu', COMMUN: 'oui' } });
  await call('PUT', `/api/environments/${preprod.id}/variables`, { variables: { ZONE: 'bac-a-sable' } });
  await call('PUT', `/api/services/${apiProd.id}/variables`, { variables: { COMMUN: 'remplacé' } });
  const heritees = (await call('GET', `/api/services/${apiProd.id}/variables?inherited=1`)).body;
  assert.deepEqual(heritees.shared, { ZONE: 'eu', COMMUN: 'oui' });
  assert.deepEqual(heritees.effective, { ZONE: 'eu', COMMUN: 'remplacé' });

  await call('POST', `/api/services/${apiProd.id}/deploy`, {});
  await call('POST', `/api/services/${apiPre.id}/deploy`, {});
  await e.deployer.drain();
  const envProd = e.runtime.env[(await call('GET', `/api/services/${apiProd.id}`)).body.active_deployment.container];
  const envPre = e.runtime.env[(await call('GET', `/api/services/${apiPre.id}`)).body.active_deployment.container];
  assert.equal(envProd.ZONE, 'eu');
  assert.equal(envProd.COMMUN, 'remplacé');
  assert.equal(envProd.RAIL_ENVIRONMENT_NAME, 'production');
  assert.equal(envPre.ZONE, 'bac-a-sable');
  assert.equal(envPre.COMMUN, undefined, 'les variables d\'un environnement restent chez lui');
  assert.equal(envPre.RAIL_ENVIRONMENT_NAME, 'preprod');
  assert.equal(envPre.RAIL_PRIVATE_DOMAIN, 'api.demo-preprod.internal');

  // Une variable partagée s'enlève.
  assert.equal((await call('DELETE', `/api/environments/${prod.id}/variables/ZONE`)).status, 200);
  assert.deepEqual(Object.keys((await call('GET', `/api/environments/${prod.id}/variables`)).body), ['COMMUN']);
  close();
});

test('dupliquer un environnement : les services suivent, les données non', async () => {
  const { e, project, call, close } = await boot();
  const prod = prodOf(project);
  const api = (await call('POST', `/api/projects/${project.id}/services`, { name: 'api', repo: 'acme/api' })).body;
  await call('PUT', `/api/services/${api.id}/variables`, { variables: { CLE: 'valeur', LIEN: '${{base.DATABASE_URL}}' } });
  const base = (await call('POST', `/api/projects/${project.id}/databases`, { engine: 'postgres', name: 'base' })).body;
  await call('PUT', `/api/environments/${prod.id}/variables`, { variables: { ZONE: 'eu' } });
  await e.deployer.drain();

  const copie = (await call('POST', `/api/projects/${project.id}/environments`, { name: 'demo2', copy_from: prod.id })).body;
  assert.equal(copie.services.length, 2);
  assert.deepEqual((await call('GET', `/api/environments/${copie.id}/variables`)).body, { ZONE: 'eu' });

  const apiCopie = copie.services.find((s) => s.name === 'api');
  const baseCopie = copie.services.find((s) => s.name === 'base');
  assert.equal(apiCopie.domains[0].hostname, 'api-demo-demo2.apps.test.dev');
  assert.deepEqual((await call('GET', `/api/services/${apiCopie.id}/variables`)).body, { CLE: 'valeur', LIEN: '${{base.DATABASE_URL}}' });
  // La base copiée a des identifiants NEUFS : on ne recopie pas un mot de passe d'un environnement à l'autre.
  const motsDePasse = [base, baseCopie].map((s) => e.store.getVars(s.id).POSTGRES_PASSWORD);
  assert.notEqual(motsDePasse[0], motsDePasse[1]);
  assert.match(e.store.getVars(baseCopie.id).DATABASE_URL, /@base\.demo-demo2\.internal:5432\//);
  assert.equal(apiCopie.latest_deployment, null, 'rien n\'est déployé tant qu\'on ne le demande pas');

  // La référence se résout dans le nouvel environnement, vers la nouvelle base.
  await call('POST', `/api/services/${baseCopie.id}/deploy`, {});
  await call('POST', `/api/services/${apiCopie.id}/deploy`, {});
  await e.deployer.drain();
  const envCopie = e.runtime.env[(await call('GET', `/api/services/${apiCopie.id}`)).body.active_deployment.container];
  assert.equal(envCopie.LIEN, e.store.getVars(baseCopie.id).DATABASE_URL);

  // « production » ne se supprime pas ; un autre environnement part avec ses services.
  assert.match((await call('DELETE', `/api/environments/${prod.id}`)).body.error, /production/);
  assert.equal((await call('DELETE', `/api/environments/${copie.id}`)).status, 200);
  assert.equal(e.store.listEnvironments(project.id).length, 1);
  assert.equal(e.store.listServices(project.id).length, 2, 'seuls les services de production restent');
  close();
});

// ── services bâtis sur une image publique ──────────────────────────────────

test('image publique : rien à construire, l\'image est récupérée puis démarrée', async () => {
  const { e, project, call, close } = await boot();
  const s = (await call('POST', `/api/projects/${project.id}/services`, {
    name: 'tableau', source: 'image', image: 'grafana/grafana:11.3.0', port: 3000,
    volume_path: '/var/lib/grafana', healthcheck_path: '/api/health',
  })).body;
  assert.equal(s.source_kind, 'image');
  assert.equal(s.url, 'https://tableau-demo.apps.test.dev');

  await call('PATCH', `/api/services/${s.id}`, { volume_owner: 472 });
  await call('POST', `/api/services/${s.id}/deploy`, {});
  await e.deployer.drain();
  const after = (await call('GET', `/api/services/${s.id}`)).body;
  assert.equal(after.active_deployment.status, 'success', e.logs.read(after.latest_deployment.id));
  assert.equal(after.active_deployment.image, 'grafana/grafana:11.3.0');
  assert.ok(e.runtime.pulled.includes('grafana/grafana:11.3.0'));
  assert.equal(e.runtime.calls.filter((c) => c.startsWith('build')).length, 0, 'aucune construction');
  // Le volume est créé et donné à l'utilisateur de l'image avant le démarrage.
  assert.deepEqual(e.runtime.prepared, [{ name: volumeName(s.id), owner: 472 }]);
  assert.ok(fs.existsSync(routeFile(e, s.id)), 'une route Traefik comme tout service web');
  // Pas de webhook pour une image (il n'y a pas de dépôt derrière).
  assert.equal(after.webhook, undefined);
  assert.equal((await call('POST', `/webhooks/github/${s.id}`, '{}', null, { 'x-github-event': 'ping' })).status, 401);

  // Changer d'image, c'est un déploiement de plus — et un retour arrière reste possible.
  await call('PATCH', `/api/services/${s.id}`, { base_image: 'grafana/grafana:11.4.0' });
  await call('POST', `/api/services/${s.id}/deploy`, {});
  await e.deployer.drain();
  assert.equal((await call('GET', `/api/services/${s.id}`)).body.active_deployment.image, 'grafana/grafana:11.4.0');
  assert.equal((await call('POST', `/api/projects/${project.id}/services`, { name: 'x', source: 'image', image: 'PAS/une IMAGE' })).status, 400);
  close();
});

// ── modèles ────────────────────────────────────────────────────────────────

test('catalogue de modèles : chaque pile se décrit et s\'instancie', () => {
  const liste = templateList();
  assert.ok(liste.length >= 10);
  for (const t of liste) {
    assert.ok(t.id && t.label && t.tagline && t.about && t.services.length, t.id);
    for (const s of t.services) assert.ok(s.name && s.what, `${t.id}/${s.name}`);
  }
  const tpl = getTemplate('n8n');
  const pieces = instantiate(tpl, {
    hostOf: (n) => `${n}-demo.apps.test.dev`,
    privateHostOf: (n) => `${n}.demo.internal`,
    urlOf: (n) => `https://${n}-demo.apps.test.dev`,
    project: 'demo',
    environment: 'production',
  });
  const app = pieces.find((p) => p.fields);
  assert.equal(app.fields.source_kind, 'image');
  assert.equal(app.fields.template, 'n8n');
  assert.equal(app.vars.N8N_HOST, 'n8n-demo.apps.test.dev');
  assert.equal(app.vars.WEBHOOK_URL, 'https://n8n-demo.apps.test.dev/');
  assert.match(app.vars.N8N_ENCRYPTION_KEY, /^[\w-]{20,}$/, 'un secret est tiré à la création');
  assert.equal(app.vars.DB_POSTGRESDB_HOST, '${{base.PGHOST}}', 'la référence reste à résoudre au déploiement');
  assert.ok(pieces.some((p) => p.spec.engine === 'postgres'));
  // Deux instanciations ne partagent pas leurs secrets.
  const encore = instantiate(tpl, { hostOf: () => 'x', privateHostOf: () => 'x', urlOf: () => 'x', project: 'd', environment: 'production' });
  assert.notEqual(encore.find((p) => p.fields).vars.N8N_ENCRYPTION_KEY, app.vars.N8N_ENCRYPTION_KEY);
});

test('modèle en un clic : les services sont créés, câblés et déployés', async () => {
  const { e, project, call, close } = await boot();
  const r = await call('POST', `/api/projects/${project.id}/templates`, { template: 'n8n' });
  assert.equal(r.status, 201);
  assert.equal(r.body.services.length, 2);
  assert.equal(r.body.main.name, 'n8n');
  assert.equal(r.body.main.url, 'https://n8n-demo.apps.test.dev');
  await e.deployer.drain();

  const base = r.body.services.find((s) => s.kind === 'database');
  const app = r.body.services.find((s) => s.kind === 'app');
  const apres = (await call('GET', `/api/services/${app.id}`)).body;
  assert.equal(apres.active_deployment.status, 'success', e.logs.read(apres.latest_deployment.id));
  assert.equal(apres.template, 'n8n');
  // La référence du modèle est résolue au déploiement, vers la base du modèle.
  const vars = e.runtime.env[apres.active_deployment.container];
  assert.equal(vars.DB_POSTGRESDB_HOST, e.store.getVars(base.id).PGHOST);
  assert.equal(vars.DB_POSTGRESDB_PASSWORD, e.store.getVars(base.id).POSTGRES_PASSWORD);
  assert.ok(e.runtime.pulled.some((i) => i.includes('n8n')));

  // Le même modèle deux fois dans un projet : il faut un préfixe.
  assert.equal((await call('POST', `/api/projects/${project.id}/templates`, { template: 'n8n' })).status, 409);
  const deux = await call('POST', `/api/projects/${project.id}/templates`, { template: 'n8n', prefix: 'bis' });
  assert.equal(deux.status, 201);
  await e.deployer.drain();
  const app2 = deux.body.services.find((s) => s.kind === 'app');
  assert.equal(app2.name, 'bis-n8n');
  const vars2 = e.runtime.env[(await call('GET', `/api/services/${app2.id}`)).body.active_deployment.container];
  assert.equal(vars2.DB_POSTGRESDB_HOST, e.store.getVars(deux.body.services.find((s) => s.kind === 'database').id).PGHOST,
    'le préfixe suit aussi dans les références');
  assert.equal((await call('POST', `/api/projects/${project.id}/templates`, { template: 'inconnu' })).status, 404);
  close();
});

// ── tâches planifiées ──────────────────────────────────────────────────────

test('planification : analyse, correspondance, prochaine occurrence, phrase lisible', () => {
  assert.ok(cronMatches('0 3 * * *', new Date('2026-03-01T03:00:00')));
  assert.ok(!cronMatches('0 3 * * *', new Date('2026-03-01T03:01:00')));
  assert.ok(cronMatches('*/10 * * * *', new Date('2026-03-01T03:20:00')));
  assert.ok(cronMatches('@hourly', new Date('2026-03-01T05:00:00')));
  // Jour du mois ET jour de semaine tous deux précisés : l'un OU l'autre suffit (cron historique).
  assert.ok(cronMatches('0 0 1 * 5', new Date('2026-05-01T00:00:00')));
  assert.ok(cronMatches('0 0 1 * 5', new Date('2026-05-08T00:00:00')));
  assert.ok(!cronMatches('0 0 1 * 5', new Date('2026-05-07T00:00:00')));
  assert.equal(parseCron('0 0 * * 7').dow.has(0), true, 'dimanche s\'écrit 0 ou 7');
  assert.equal(cronNext('0 3 1 1 *', new Date('2026-06-01T00:00:00')).getFullYear(), 2027);
  assert.match(cronWords('0 3 * * *'), /chaque jour/);
  for (const mauvais of ['', '* * *', '60 * * * *', '* * * * 9', 'tous les jours', '*/0 * * * *']) {
    assert.throws(() => parseCron(mauvais), /planification/, String(mauvais));
  }
});

test('tâche planifiée : image prête, exécution à la demande, historique, horloge', async () => {
  const { e, project, call, close } = await boot();
  const job = (await call('POST', `/api/projects/${project.id}/services`, {
    name: 'menage', kind: 'cron', source: 'image', image: 'alpine:3', cron_schedule: '0 3 * * *',
    start_command: 'echo bonjour',
  })).body;
  assert.equal(job.kind, 'cron');
  assert.equal(job.cron.words, 'chaque jour à 03 h 00');
  assert.ok(job.cron.next);
  assert.equal(job.url, null, 'une tâche ne s\'expose pas sur le web');
  assert.equal((await call('POST', `/api/projects/${project.id}/services`, { name: 'x', kind: 'cron', source: 'image', image: 'alpine:3' })).status, 400,
    'une tâche sans planification est refusée');

  await call('POST', `/api/services/${job.id}/deploy`, {});
  await e.deployer.drain();
  const apres = (await call('GET', `/api/services/${job.id}`)).body;
  assert.equal(apres.active_deployment.status, 'success', e.logs.read(apres.latest_deployment.id));
  assert.equal(apres.active_deployment.container, null, 'aucun conteneur ne reste en marche');
  assert.equal(apres.status.state, 'scheduled');
  assert.ok(!fs.existsSync(routeFile(e, job.id)), 'aucune route vers une tâche');

  // Exécuter maintenant.
  const run = await call('POST', `/api/services/${job.id}/run`, {});
  assert.equal(run.status, 202);
  assert.equal(run.body.number, 1);
  await e.deployer.drain();
  const hist = (await call('GET', `/api/services/${job.id}/runs`)).body;
  assert.equal(hist.runs[0].status, 'success');
  assert.equal(hist.runs[0].exit_code, 0);
  assert.match(hist.runs[0].output, /travail de rail-job-/);
  assert.deepEqual(e.runtime.jobs[0].cmd, ['sh', '-c', 'echo bonjour']);
  assert.equal(e.runtime.jobs[0].env.RAIL_SERVICE_NAME, 'menage');

  // Une tâche qui sort en erreur est une tâche en échec, et une alerte.
  e.runtime.jobExit = 2;
  await call('POST', `/api/services/${job.id}/run`, {});
  await e.deployer.drain();
  const hist2 = (await call('GET', `/api/services/${job.id}/runs`)).body;
  assert.equal(hist2.runs[0].status, 'failed');
  assert.equal(hist2.runs[0].exit_code, 2);
  assert.ok(e.store.listEvents({ limit: 20 }).some((x) => x.kind === 'job.failed'));

  // L'horloge : à l'heure dite, une seule fois par minute.
  e.runtime.jobExit = 0;
  const heure = new Date('2026-03-01T03:00:00');
  await e.scheduler.tick(heure);
  await e.deployer.drain();
  const apresHorloge = (await call('GET', `/api/services/${job.id}/runs`)).body;
  assert.equal(apresHorloge.runs[0].trigger, 'schedule');
  const combien = apresHorloge.runs.length;
  await e.scheduler.tick(heure);
  await e.deployer.drain();
  assert.equal((await call('GET', `/api/services/${job.id}/runs`)).body.runs.length, combien, 'pas deux fois la même minute');
  await e.scheduler.tick(new Date('2026-03-01T03:01:00'));
  await e.deployer.drain();
  assert.equal((await call('GET', `/api/services/${job.id}/runs`)).body.runs.length, combien, 'et pas à une minute qui ne correspond pas');

  // Arrêtée, elle ne part plus toute seule.
  await call('POST', `/api/services/${job.id}/stop`, {});
  await e.scheduler.tick(new Date('2026-03-02T03:00:00'));
  await e.deployer.drain();
  assert.equal((await call('GET', `/api/services/${job.id}/runs`)).body.runs.length, combien);
  close();
});

// ── sauvegardes gardées ────────────────────────────────────────────────────

test('sauvegardes : fabriquées, listées, téléchargées, restaurées, et élaguées', async () => {
  const { e, project, call, close } = await boot();
  const db = (await call('POST', `/api/projects/${project.id}/databases`, { engine: 'postgres', name: 'base', backup_schedule: '0 4 * * *' })).body;
  await e.deployer.drain();
  assert.equal(db.backup.schedule, '0 4 * * *');
  assert.equal(db.backup.supported, true);

  const faite = await call('POST', `/api/services/${db.id}/backups`, {});
  assert.equal(faite.status, 201);
  assert.equal(faite.body.status, 'success');
  assert.ok(faite.body.size > 0);
  assert.match(faite.body.file, /^base-\d{4}-\d{2}-\d{2}/);
  assert.ok(fs.existsSync(path.join(e.config.backupsDir, db.id, faite.body.file)));

  const liste = (await call('GET', `/api/services/${db.id}/backups`)).body;
  assert.equal(liste.backups.length, 1);
  assert.equal(liste.backups[0].available, true);
  assert.equal(liste.restorable, true);

  const fichier = await call('GET', `/api/backups/${faite.body.id}/download`);
  assert.match(String(fichier.body), /sauvegarde/);
  assert.match(fichier.headers.get('content-disposition'), /attachment; filename="base-/);

  // Restaurer : la sauvegarde repart dans le conteneur, et l'activité le note.
  const remise = await call('POST', `/api/backups/${faite.body.id}/restore`, {});
  assert.equal(remise.status, 200);
  assert.ok(e.runtime.execs.some((x) => x.args[0] === 'psql'), 'la restauration passe par le client du moteur');
  assert.ok(e.store.listEvents({ limit: 20 }).some((x) => x.kind === 'database.restore'));

  // L'horloge en fabrique une, et on ne garde que les dernières.
  await call('PATCH', `/api/services/${db.id}`, { backup_keep: 2 });
  await e.scheduler.tick(new Date('2026-03-01T04:00:00'));
  assert.equal((await call('GET', `/api/services/${db.id}/backups`)).body.backups.at(-1).trigger, 'manual');
  for (const h of ['04:00', '05:00', '06:00']) {
    e.store.addBackup(db.id, { file: `vieille-${h}.sql`, size: 10, status: 'success', trigger: 'schedule' });
  }
  e.backups.prune(db.id, 2);
  const apresElagage = (await call('GET', `/api/services/${db.id}/backups`)).body.backups;
  assert.equal(apresElagage.length, 2, 'on garde les deux dernières');

  // Supprimer une sauvegarde emporte son fichier.
  const encore = (await call('POST', `/api/services/${db.id}/backups`, {})).body;
  const chemin = path.join(e.config.backupsDir, db.id, encore.file);
  assert.ok(fs.existsSync(chemin));
  assert.equal((await call('DELETE', `/api/backups/${encore.id}`)).status, 200);
  assert.ok(!fs.existsSync(chemin));

  // Un moteur sans export intégré le dit, plutôt que de rendre un fichier vide.
  const cache = (await call('POST', `/api/projects/${project.id}/databases`, { engine: 'redis', name: 'cache' })).body;
  await e.deployer.drain();
  assert.match((await call('POST', `/api/services/${cache.id}/backups`, {})).body.error, /pas de sauvegarde intégrée/);
  close();
});

test('sauvegarde en échec : inscrite en échec, avec sa raison, et une alerte', async () => {
  const { e, project, call, close } = await boot();
  const db = (await call('POST', `/api/projects/${project.id}/databases`, { engine: 'postgres', name: 'base' })).body;
  await e.deployer.drain();
  e.runtime.execError = 'pg_dump: error: connection refused';
  const r = await call('POST', `/api/services/${db.id}/backups`, {});
  assert.equal(r.status, 409);
  assert.match(r.body.error, /connection refused/);
  const liste = (await call('GET', `/api/services/${db.id}/backups`)).body.backups;
  assert.equal(liste[0].status, 'failed');
  assert.match(liste[0].error, /connection refused/);
  assert.ok(e.notifier.sent.some((m) => m.level === 'error' && /sauvegarde/.test(m.title)));
  close();
});

// ── exposition TCP ─────────────────────────────────────────────────────────

test('exposition TCP : un port de la plage, publié au redéploiement, et rendu ensuite', async () => {
  const { e, project, call, close } = await boot();
  const db = (await call('POST', `/api/projects/${project.id}/databases`, { engine: 'postgres', name: 'base' })).body;
  await e.deployer.drain();
  assert.equal(db.public_endpoint, null);

  const exp = await call('POST', `/api/services/${db.id}/expose`, {});
  assert.equal(exp.status, 200);
  assert.equal(exp.body.public_port, e.config.tcpPortFrom);
  assert.equal(exp.body.public_endpoint, `apps.test.dev:${e.config.tcpPortFrom}`);
  assert.match(exp.body.hint, /Redéployez/);

  await call('POST', `/api/services/${db.id}/redeploy`, {});
  await e.deployer.drain();
  assert.deepEqual(e.runtime.last.ports, [{ host: e.config.tcpPortFrom, container: 5432, bind: '0.0.0.0' }]);

  // Hors plage, ou déjà pris : refusé.
  assert.match((await call('POST', `/api/services/${db.id}/expose`, { port: 80 })).body.error, /RAIL_TCP_PORTS/);
  const autre = (await call('POST', `/api/projects/${project.id}/databases`, { engine: 'redis', name: 'cache' })).body;
  assert.match((await call('POST', `/api/services/${autre.id}/expose`, { port: e.config.tcpPortFrom })).body.error, /déjà pris/);
  const libre = (await call('POST', `/api/services/${autre.id}/expose`, {})).body;
  assert.equal(libre.public_port, e.config.tcpPortFrom + 1, 'le port suivant qui est libre');

  assert.equal((await call('DELETE', `/api/services/${db.id}/expose`)).status, 200);
  await call('POST', `/api/services/${db.id}/redeploy`, {});
  await e.deployer.drain();
  assert.deepEqual(e.runtime.last.ports, []);
  close();
});

// ── construction : commandes et chemins surveillés ─────────────────────────

test('monodépôt : un push qui ne touche pas les chemins surveillés ne déploie rien', async () => {
  const { e, project, call, close } = await boot();
  const svc = (await call('POST', `/api/projects/${project.id}/services`, {
    name: 'api', repo: 'acme/api', watch_paths: 'services/api, paquets/commun',
  })).body;
  assert.equal(svc.watch_paths, 'services/api\npaquets/commun');
  const secret = e.store.webhookSecret(svc.id);
  const pousse = (files) => {
    const corps = JSON.stringify({
      ref: 'refs/heads/main', after: 'a'.repeat(40), repository: { full_name: 'acme/api' },
      head_commit: { message: 'un commit' }, commits: [{ modified: files }],
    });
    return call('POST', `/webhooks/github/${svc.id}`, corps, null, {
      'x-github-event': 'push',
      'x-hub-signature-256': `sha256=${createHmac('sha256', secret).update(corps).digest('hex')}`,
    });
  };
  const ignore = await pousse(['site-vitrine/index.html']);
  assert.equal(ignore.status, 200);
  assert.match(ignore.body.ignored, /chemin surveillé/);
  assert.equal(e.store.listDeployments(svc.id).length, 0);

  const pris = await pousse(['site-vitrine/index.html', 'paquets/commun/util.js']);
  assert.equal(pris.status, 202);
  assert.equal(e.store.listDeployments(svc.id).length, 1);
  await e.deployer.drain();

  // Des chemins invalides sont refusés à la saisie.
  assert.equal((await call('PATCH', `/api/services/${svc.id}`, { watch_paths: '../ailleurs' })).status, 400);
  assert.equal((await call('PATCH', `/api/services/${svc.id}`, { watch_paths: '' })).body.watch_paths, null);
  close();
});

test('commandes de construction et de démarrage : elles passent dans le Dockerfile engendré', async () => {
  const { e, project, call, close } = await boot();
  const svc = (await call('POST', `/api/projects/${project.id}/services`, {
    name: 'api', repo: 'acme/api', build_command: 'npm run compile', start_command: 'node dist/index.js',
  })).body;
  await call('POST', `/api/services/${svc.id}/deploy`, {});
  await e.deployer.drain();
  const dockerfile = e.runtime.lastBuild.dockerfileText;
  assert.match(dockerfile, /RUN npm run compile/);
  assert.match(dockerfile, /CMD \["sh","-c","node dist\/index\.js"\]/);
  // Une commande sur plusieurs lignes n'a pas de sens ici.
  assert.equal((await call('PATCH', `/api/services/${svc.id}`, { start_command: 'a\nb' })).status, 400);
  close();
});

test('un service se renomme, et son nom reste unique dans son environnement', async () => {
  const { project, call, close } = await boot();
  const a = (await call('POST', `/api/projects/${project.id}/services`, { name: 'api', repo: 'acme/api' })).body;
  const b = (await call('POST', `/api/projects/${project.id}/services`, { name: 'site', repo: 'acme/api' })).body;
  assert.equal((await call('PATCH', `/api/services/${a.id}`, { name: 'site' })).status, 409);
  assert.equal((await call('PATCH', `/api/services/${a.id}`, { name: 'api-v2' })).body.name, 'api-v2');
  assert.equal((await call('PATCH', `/api/services/${b.id}`, { name: 'API' })).status, 400);
  close();
});
