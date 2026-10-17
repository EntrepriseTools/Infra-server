import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { env, makeRepo, serve } from './helpers.js';
import { provision, engineList } from '../src/databases.js';
import { volumeName } from '../src/deployer.js';

const PKG = JSON.stringify({ scripts: { start: 'node s.js' } });
const routeFile = (e, id) => path.join(e.config.routesDir, `${id}.yml`);

async function boot() {
  const e = env();
  makeRepo(e.dir, 'acme/api', { 'package.json': PKG, 's.js': '//' });
  const s = await serve(e);
  const project = (await s.call('POST', '/api/projects', { name: 'demo' })).body;
  return { e, project, ...s };
}

test('catalogue : chaque moteur annonce son image, son port et son volume', () => {
  const ids = engineList().map((x) => x.id);
  assert.deepEqual(ids, ['postgres', 'mysql', 'mariadb', 'redis', 'valkey', 'mongo', 'clickhouse', 'meilisearch', 'rabbitmq']);
  for (const en of engineList()) {
    assert.ok(en.image.includes(':') && en.port > 0 && en.volume.startsWith('/'), en.id);
    assert.ok(en.label && en.family && en.about, `${en.id} se présente`);
  }
  // Ce qui parle SQL a une console ET une liste de tables ; ce qui sait s'exporter sait se restaurer.
  for (const en of engineList()) {
    if (en.sql) assert.ok(engineList().find((x) => x.id === en.id), en.id);
    if (en.backup) assert.ok(en.restore, `${en.id} : une sauvegarde sans restauration ne sert qu'à moitié`);
  }
  const p = provision({ engine: 'postgres', name: 'ma-base', project: 'demo' });
  assert.equal(p.fields.kind, 'database');
  assert.equal(p.fields.auto_deploy, false);
  assert.equal(p.vars.POSTGRES_DB, 'ma_base', 'le nom de base ne garde pas les tirets');
  assert.match(p.vars.DATABASE_URL, /^postgresql:\/\/rail:[\w-]+@ma-base\.demo\.internal:5432\/ma_base$/);
  assert.equal(p.vars.PGPASSWORD, p.vars.POSTGRES_PASSWORD);
});

test('base de données : créée, démarrée avec son volume, jamais exposée sur Internet', async () => {
  const { e, project, call, close } = await boot();
  const created = await call('POST', `/api/projects/${project.id}/databases`, { engine: 'postgres', name: 'base' });
  assert.equal(created.status, 201);
  const db = created.body;
  assert.equal(db.kind, 'database');
  assert.equal(db.url, null, 'pas d\'adresse publique');
  assert.equal(db.private_host, 'base.demo.internal');
  assert.equal(db.volume.path, '/var/lib/postgresql/data');
  await e.deployer.drain();

  const after = (await call('GET', `/api/services/${db.id}`)).body;
  assert.equal(after.active_deployment.status, 'success', e.logs.read(after.latest_deployment.id));
  assert.ok(e.runtime.pulled.includes('postgres:16-alpine'), 'l\'image officielle est récupérée');
  assert.equal(e.runtime.calls.filter((c) => c.startsWith('build')).length, 0, 'rien à construire');
  assert.deepEqual(e.runtime.last.volumes, [{ name: volumeName(db.id), path: '/var/lib/postgresql/data' }]);
  // L'image officielle prépare son volume en root puis redescend : sans ces capacités, elle s'arrête.
  assert.deepEqual(e.runtime.last.caps, ['CHOWN', 'DAC_OVERRIDE', 'FOWNER', 'SETUID', 'SETGID']);
  assert.equal(e.runtime.last.alias, 'base.demo.internal');
  assert.ok(!fs.existsSync(routeFile(e, db.id)), 'aucune route Traefik vers une base');
  const env_ = e.runtime.env[after.active_deployment.container];
  assert.ok(env_.POSTGRES_PASSWORD && env_.POSTGRES_USER === 'rail' && env_.POSTGRES_DB === 'base');

  // ni domaine, ni webhook : une base ne se publie pas
  assert.equal((await call('POST', `/api/services/${db.id}/domains`, { hostname: 'base.client.com' })).status, 400);
  assert.equal((await call('POST', `/webhooks/github/${db.id}`, '{}', null, { 'x-github-event': 'ping' })).status, 401);
  close();
});

test('base Redis : le mot de passe passe par la commande de démarrage', async () => {
  const { e, project, call, close } = await boot();
  const db = (await call('POST', `/api/projects/${project.id}/databases`, { engine: 'redis', name: 'cache' })).body;
  await e.deployer.drain();
  const vars = (await call('GET', `/api/services/${db.id}/variables`)).body;
  assert.deepEqual(e.runtime.last.cmd, ['redis-server', '--requirepass', vars.REDIS_PASSWORD, '--appendonly', 'yes']);
  assert.match(vars.REDIS_URL, /^redis:\/\/default:[\w-]+@cache\.demo\.internal:6379$/);
  close();
});

test('référence entre services : ${{base.DATABASE_URL}} est résolu au déploiement', async () => {
  const { e, project, call, close } = await boot();
  const db = (await call('POST', `/api/projects/${project.id}/databases`, { engine: 'postgres', name: 'base' })).body;
  await e.deployer.drain();
  const dbVars = (await call('GET', `/api/services/${db.id}/variables`)).body;

  const api = (await call('POST', `/api/projects/${project.id}/services`, { name: 'api', repo: 'acme/api' })).body;
  await call('PUT', `/api/services/${api.id}/variables`, { variables: { DATABASE_URL: '${{base.DATABASE_URL}}', MIXTE: 'hôte=${{base.PGHOST}}', INCONNU: '${{absent.X}}' } });
  await call('POST', `/api/services/${api.id}/deploy`, {});
  await e.deployer.drain();

  const dep = (await call('GET', `/api/services/${api.id}`)).body.active_deployment;
  const env_ = e.runtime.env[dep.container];
  assert.equal(env_.DATABASE_URL, dbVars.DATABASE_URL);
  assert.equal(env_.MIXTE, 'hôte=base.demo.internal');
  assert.equal(env_.INCONNU, '${{absent.X}}', 'une référence absente reste telle quelle');
  assert.match(e.logs.read(dep.id), /référence non résolue/);
  close();
});

test('sauvegarde : un export en flux, avec un nom de fichier', async () => {
  const { e, project, call, close } = await boot();
  const db = (await call('POST', `/api/projects/${project.id}/databases`, { engine: 'postgres', name: 'base' })).body;
  await e.deployer.drain();
  const r = await call('GET', `/api/services/${db.id}/backup`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-disposition'), /attachment; filename="base-/);
  assert.match(r.body, /sauvegarde/);
  assert.deepEqual(e.runtime.execs[0].args.slice(0, 2), ['pg_dump', '--clean']);
  // un service ordinaire n'a pas de sauvegarde intégrée
  const api = (await call('POST', `/api/projects/${project.id}/services`, { name: 'api', repo: 'acme/api' })).body;
  assert.equal((await call('GET', `/api/services/${api.id}/backup`)).status, 400);
  close();
});

test('volume : la nouvelle version ne tourne jamais à côté de l\'ancienne', async () => {
  const { e, project, call, close } = await boot();
  const db = (await call('POST', `/api/projects/${project.id}/databases`, { engine: 'postgres', name: 'base' })).body;
  await e.deployer.drain();
  e.runtime.calls.length = 0;
  await call('POST', `/api/services/${db.id}/redeploy`);
  await e.deployer.drain();
  const halt = e.runtime.calls.indexOf(`halt rail-${db.id}-1`);
  const start2 = e.runtime.calls.indexOf(`start rail-${db.id}-2`);
  assert.ok(halt >= 0 && halt < start2, `ancien arrêté avant le nouveau : ${e.runtime.calls.join(', ')}`);
  close();
});

test('volume : si la nouvelle version échoue, l\'ancienne est remise en marche', async () => {
  const { e, project, call, close } = await boot();
  const db = (await call('POST', `/api/projects/${project.id}/databases`, { engine: 'postgres', name: 'base' })).body;
  await e.deployer.drain();
  e.runtime.healthy = false;
  await call('POST', `/api/services/${db.id}/redeploy`);
  await e.deployer.drain();
  const deps = e.store.listDeployments(db.id);
  assert.equal(deps[0].status, 'failed');
  assert.ok(e.runtime.calls.includes(`resume rail-${db.id}-1`), 'l\'ancienne base est relancée');
  assert.equal(e.store.getService(db.id).active_deployment_id, deps[1].id, 'la version en service n\'a pas changé');
  close();
});

test('suppression : le volume part avec le service, sauf si on demande à le garder', async () => {
  const { e, project, call, close } = await boot();
  const a = (await call('POST', `/api/projects/${project.id}/databases`, { engine: 'postgres', name: 'une' })).body;
  const b = (await call('POST', `/api/projects/${project.id}/databases`, { engine: 'postgres', name: 'deux' })).body;
  await e.deployer.drain();
  assert.equal(e.runtime.volumes.size, 2);
  await call('DELETE', `/api/services/${a.id}`);
  assert.ok(!e.runtime.volumes.has(volumeName(a.id)));
  await call('DELETE', `/api/services/${b.id}?keep_volume=1`);
  assert.ok(e.runtime.volumes.has(volumeName(b.id)), 'gardé sur demande');
  close();
});

test('console SQL : la requête passe par l\'entrée standard, jamais par les arguments', async () => {
  const { e, project, call, close } = await boot();
  const db = (await call('POST', `/api/projects/${project.id}/databases`, { engine: 'postgres', name: 'base' })).body;
  await e.deployer.drain();

  const r = await call('POST', `/api/services/${db.id}/query`, { sql: 'SELECT * FROM gens' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.columns, ['id', 'nom']);
  assert.deepEqual(r.body.rows, [['1', 'ana'], ['2', 'bo']]);
  assert.equal(r.body.read_only, true);
  assert.ok(typeof r.body.ms === 'number');

  const appel = e.runtime.execs.at(-1);
  assert.equal(appel.args[0], 'psql');
  assert.ok(!appel.args.join(' ').includes('SELECT'), 'la requête n\'est pas dans la ligne de commande');
  assert.match(appel.input, /SET statement_timeout/);
  assert.match(appel.input, /TRANSACTION READ ONLY/);
  assert.match(appel.input, /SELECT \* FROM gens/);
  close();
});

test('console SQL : une écriture se demande explicitement et laisse une trace', async () => {
  const { e, project, call, close } = await boot();
  const db = (await call('POST', `/api/projects/${project.id}/databases`, { engine: 'postgres', name: 'base' })).body;
  await e.deployer.drain();
  e.runtime.execOut = 'INSERT 0 1';

  const r = await call('POST', `/api/services/${db.id}/query`, { sql: "INSERT INTO gens VALUES (3,'cy')", read_only: false });
  assert.equal(r.body.message, 'INSERT 0 1');
  assert.deepEqual(r.body.columns, []);
  assert.ok(!e.runtime.execs.at(-1).input.includes('READ ONLY'), 'pas de transaction en lecture seule');
  const ev = e.store.listEvents({ limit: 5 }).find((x) => x.kind === 'database.write');
  assert.match(ev.message, /INSERT INTO gens/);
  assert.equal(ev.level, 'warn');
  close();
});

test('console SQL : erreurs du moteur, moteurs sans SQL, requête vide', async () => {
  const { e, project, call, close } = await boot();
  const pg = (await call('POST', `/api/projects/${project.id}/databases`, { engine: 'postgres', name: 'base' })).body;
  const redis = (await call('POST', `/api/projects/${project.id}/databases`, { engine: 'redis', name: 'cache' })).body;
  const api_ = (await call('POST', `/api/projects/${project.id}/services`, { name: 'api', repo: 'acme/api' })).body;
  await e.deployer.drain();

  assert.equal((await call('POST', `/api/services/${pg.id}/query`, { sql: '   ' })).status, 400);
  assert.equal((await call('POST', `/api/services/${redis.id}/query`, { sql: 'SELECT 1' })).status, 400);
  assert.equal((await call('POST', `/api/services/${api_.id}/query`, { sql: 'SELECT 1' })).status, 400);

  e.runtime.execError = 'ERROR:  relation "nope" does not exist\nLINE 1: SELECT * FROM nope\n';
  const ko = await call('POST', `/api/services/${pg.id}/query`, { sql: 'SELECT * FROM nope' });
  assert.equal(ko.status, 400);
  assert.match(ko.body.error, /relation "nope" does not exist/);
  close();
});

test('liste des tables : une requête toute faite par moteur', async () => {
  const { e, project, call, close } = await boot();
  const db = (await call('POST', `/api/projects/${project.id}/databases`, { engine: 'postgres', name: 'base' })).body;
  await e.deployer.drain();
  e.runtime.execOut = 'schema,nom,taille\npublic,gens,16 kB\n';
  const t = (await call('GET', `/api/services/${db.id}/tables`)).body;
  assert.deepEqual(t.rows, [['public', 'gens', '16 kB']]);
  assert.match(e.runtime.execs.at(-1).input, /information_schema\.tables/);
  close();
});
