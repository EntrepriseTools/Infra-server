import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHmac } from 'node:crypto';
import { encrypt, decrypt, safeEqual } from '../src/crypto.js';
import * as v from '../src/validate.js';
import { loadConfig } from '../src/config.js';
import { detectBuild, materialize, DetectError } from '../src/detect.js';
import { verifySignature, parsePush } from '../src/github.js';
import { Store } from '../src/db.js';
import { Routes } from '../src/routes.js';
import { redact } from '../src/source.js';
import { probeHttp } from '../src/runtime.js';
import http from 'node:http';
import { createRequire } from 'node:module';
import { tmp } from './helpers.js';

const require = createRequire(import.meta.url);

const key = Buffer.alloc(32, 7);

test('crypto : aller-retour, IV neuf, altération détectée', () => {
  const a = encrypt(key, 'secret'); const b = encrypt(key, 'secret');
  assert.notEqual(a, b);
  assert.equal(decrypt(key, a), 'secret');
  assert.throws(() => decrypt(key, a.slice(0, -2) + 'AA'));
  assert.throws(() => decrypt(Buffer.alloc(32, 1), a));
  assert.ok(safeEqual('x', 'x') && !safeEqual('x', 'y') && !safeEqual('x', 'xx'));
});

test('validate : on refuse ce qui finirait dans une commande ou un chemin', () => {
  assert.equal(v.name('mon-api'), 'mon-api');
  for (const bad of ['', 'A', '-a', 'a-', 'a_b', 'a'.repeat(31), 'a b', '../x']) assert.throws(() => v.name(bad), bad);
  assert.equal(v.repo('acme/api.v2'), 'acme/api.v2');
  for (const bad of ['acme', 'a/b/c', '../x', 'a/..', 'a b/c', '-x/y;ls']) assert.throws(() => v.repo(bad), bad);
  for (const bad of ['..', '../x', '/etc', 'a/../b', 'a;b', 'a b']) assert.throws(() => v.relPath(bad), bad);
  assert.equal(v.relPath('./services/api/'), 'services/api');
  assert.equal(v.relPath('.'), '.');
  assert.throws(() => v.branch('a..b')); assert.throws(() => v.branch('-rf')); assert.equal(v.branch('feat/x-1'), 'feat/x-1');
  assert.throws(() => v.port(0)); assert.throws(() => v.port('abc')); assert.equal(v.port('8080'), 8080);
  assert.throws(() => v.healthPath('health')); assert.throws(() => v.healthPath('/a b')); assert.equal(v.healthPath('/health'), '/health');
  assert.equal(v.hostname(' API.Exemple.com '), 'api.exemple.com');
  for (const bad of ['localhost', 'a..b.com', 'a`) || Host(`b.com', '-a.com']) assert.throws(() => v.hostname(bad), bad);
  for (const k of ['PORT', 'PATH', 'LD_PRELOAD', 'DOCKER_HOST', 'RAIL_X', '1A', 'A-B']) assert.throws(() => v.envKey(k), k);
  assert.equal(v.envKey('DATABASE_URL'), 'DATABASE_URL');
  assert.throws(() => v.envValue('a\0b'));
});

test('config : refuse les secrets faibles', () => {
  const ok = { RAIL_ADMIN_TOKEN: 'x'.repeat(24), RAIL_SECRET_KEY: 'a'.repeat(64), RAIL_DOMAIN: 'apps.exemple.com' };
  const c = loadConfig(ok);
  assert.equal(c.dashboardHost, 'rail.apps.exemple.com');
  assert.throws(() => loadConfig({ ...ok, RAIL_ADMIN_TOKEN: 'court' }), /24/);
  assert.throws(() => loadConfig({ ...ok, RAIL_SECRET_KEY: 'zz' }), /64/);
  assert.throws(() => loadConfig({ ...ok, RAIL_DOMAIN: 'nope' }), /domaine/);
  assert.throws(() => loadConfig({ ...ok, RAIL_DOMAIN: undefined }), /obligatoire/);
});

const proj = (files) => {
  const d = tmp();
  for (const [f, c] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); fs.writeFileSync(path.join(d, f), c); }
  return d;
};

test('detect : le Dockerfile du dépôt gagne', () => {
  const d = proj({ Dockerfile: 'FROM scratch', 'package.json': '{}' });
  assert.equal(detectBuild(d).kind, 'dockerfile');
  assert.equal(materialize(d, detectBuild(d)), path.join(d, 'Dockerfile'));
});

test('detect : Node (npm, build, version du moteur)', () => {
  const d = proj({ 'package.json': JSON.stringify({ engines: { node: '>=20' }, scripts: { start: 'node s.js', build: 'tsc' } }), 'package-lock.json': '{}' });
  const b = detectBuild(d);
  assert.equal(b.language, 'node');
  assert.match(b.dockerfile, /^FROM node:20-slim/);
  assert.match(b.dockerfile, /RUN npm ci/);
  assert.match(b.dockerfile, /RUN npm run build/);
  assert.match(b.dockerfile, /USER node/);
  assert.match(b.dockerfile, /CMD \["sh","-c","npm start"\]/);
  assert.ok(b.dockerignore);
  const f = materialize(d, b);
  assert.ok(fs.existsSync(f) && fs.existsSync(path.join(d, '.dockerignore')));
});

test('detect : Node pnpm, sans start → erreur claire, Procfile prioritaire', () => {
  const pn = detectBuild(proj({ 'package.json': '{"scripts":{"start":"x"}}', 'pnpm-lock.yaml': '' }));
  assert.match(pn.dockerfile, /corepack enable/); assert.match(pn.dockerfile, /pnpm install --frozen-lockfile/);
  assert.throws(() => detectBuild(proj({ 'package.json': '{}' })), DetectError);
  const pf = detectBuild(proj({ 'package.json': '{"scripts":{"start":"x"}}', Procfile: 'web: node dist/api.js --x' }));
  assert.match(pf.dockerfile, /node dist\/api\.js --x/);
});

test('detect : Python, Go, Java', () => {
  const py = detectBuild(proj({ 'requirements.txt': 'flask', 'app.py': '' }));
  assert.match(py.dockerfile, /pip install --no-cache-dir -r requirements.txt/); assert.match(py.dockerfile, /python app\.py/);
  assert.throws(() => detectBuild(proj({ 'requirements.txt': 'flask' })), DetectError);

  const go = detectBuild(proj({ 'go.mod': 'module x\n\ngo 1.22.3\n', 'main.go': 'package main' }));
  assert.match(go.dockerfile, /FROM golang:1\.22 AS build/); assert.match(go.dockerfile, /go build -o \/out\/app \./);
  const cmd = detectBuild(proj({ 'go.mod': 'module x\ngo 1.23\n', 'cmd/server/main.go': '' }));
  assert.match(cmd.dockerfile, /\.\/cmd\/server/);

  const mvn = detectBuild(proj({ 'pom.xml': '<project><properties><java.version>17</java.version></properties></project>', mvnw: '' }));
  assert.match(mvn.dockerfile, /eclipse-temurin:17-jdk AS build/); assert.match(mvn.dockerfile, /mvnw/); assert.match(mvn.dockerfile, /-Dserver\.port=\$\{PORT:-8080\}/);
  const gr = detectBuild(proj({ 'build.gradle': 'sourceCompatibility = JavaVersion.VERSION_21' }));
  assert.match(gr.dockerfile, /gradle:8-jdk21/);

  assert.throws(() => detectBuild(proj({ 'README.md': '' })), /non reconnu/);
  assert.throws(() => detectBuild(proj({}), { dockerfilePath: 'nope/Dockerfile' }), /introuvable/);
});

test('github : signature HMAC et lecture d\'un push', () => {
  const body = Buffer.from('{"a":1}');
  const sig = `sha256=${createHmac('sha256', 's3cret').update(body).digest('hex')}`;
  assert.ok(verifySignature(body, sig, 's3cret'));
  assert.ok(!verifySignature(body, sig, 'autre'));
  assert.ok(!verifySignature(Buffer.from('{"a":2}'), sig, 's3cret'));
  assert.ok(!verifySignature(body, undefined, 's3cret'));
  assert.ok(!verifySignature(body, 'sha256=00', 's3cret'));
  assert.deepEqual(parsePush({ ref: 'refs/heads/feat/x', after: 'abc1234', repository: { full_name: 'a/b' }, head_commit: { message: 'titre\n\ncorps' } }),
    { repo: 'a/b', branch: 'feat/x', sha: 'abc1234', message: 'titre' });
  assert.equal(parsePush({ ref: 'refs/tags/v1', after: 'abc' }), null);
  assert.equal(parsePush({ ref: 'refs/heads/main', after: '0'.repeat(40) }), null);
  assert.equal(parsePush({ ref: 'refs/heads/main', after: 'abc', deleted: true }), null);
});

test('db : secrets chiffrés au repos, contraintes d\'unicité, cascade', () => {
  const s = new Store(':memory:', key);
  const p = s.createProject('p');
  assert.throws(() => s.createProject('p'), /UNIQUE/);
  const svc = s.createService(p.id, { name: 'a', repo: 'o/r', branch: 'main', root_dir: '.', port: 80, github_token: 'ghp_SECRET' });
  assert.equal(svc.has_github_token, true);
  assert.ok(!JSON.stringify(svc).includes('ghp_SECRET'));
  assert.equal(s.githubToken(svc.id), 'ghp_SECRET');
  assert.ok(s.webhookSecret(svc.id).length >= 20);
  s.setVars(svc.id, { A: '1', B: 'ligne1\nligne2' });
  assert.deepEqual(s.getVars(svc.id), { A: '1', B: 'ligne1\nligne2' });
  const raw = s.db.prepare('SELECT value_enc FROM variables').all().map((r) => r.value_enc).join();
  assert.ok(!raw.includes('ligne1') && raw.includes('v1:'));
  s.setVars(svc.id, { A: '2' }); assert.equal(s.getVars(svc.id).A, '2');
  const d1 = s.createDeployment(svc.id, { trigger: 'manual' }); const d2 = s.createDeployment(svc.id, { trigger: 'manual' });
  assert.deepEqual([d1.number, d2.number], [1, 2]);
  s.deleteProject(p.id);
  assert.equal(s.getService(svc.id), null);
  assert.equal(s.db.prepare('SELECT count(*) c FROM deployments').get().c, 0);
  assert.equal(s.db.prepare('SELECT count(*) c FROM variables').get().c, 0);
});

test('routes : fichier Traefik atomique, un hôte = une règle, JSON valide', () => {
  const d = tmp(); const r = new Routes(d);
  r.set('abc', { hosts: ['a.x.com', 'b.x.com'], upstream: 'http://rail-abc-1:3000' });
  const j = JSON.parse(fs.readFileSync(path.join(d, 'abc.yml'), 'utf8'));
  assert.equal(j.http.routers['rail-abc'].rule, 'Host(`a.x.com`) || Host(`b.x.com`)');
  assert.equal(j.http.services['rail-abc'].loadBalancer.servers[0].url, 'http://rail-abc-1:3000');
  assert.equal(j.http.routers['rail-abc'].tls.certResolver, 'le');
  assert.deepEqual(fs.readdirSync(d), ['abc.yml']); // pas de .tmp qui traîne
  r.set('abc', { hosts: [], upstream: 'x' }); assert.ok(!r.has('abc'));
});

test('source : le jeton est masqué dans les journaux', () => {
  assert.equal(redact('fatal: https://x:tok123@github.com tok123', ['tok123']), 'fatal: https://x:***@github.com ***');
});

test('probeHttp : statut, chemin, TCP simple', async () => {
  const srv = http.createServer((q, s) => { s.statusCode = q.url === '/ok' ? 200 : 503; s.end(); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const { port } = srv.address();
  assert.equal(await probeHttp({ host: '127.0.0.1', port, path: '/ok' }), true);
  assert.equal(await probeHttp({ host: '127.0.0.1', port, path: '/ko' }), false);
  assert.equal(await probeHttp({ host: '127.0.0.1', port }), true);
  srv.close();
  assert.equal(await probeHttp({ host: '127.0.0.1', port, path: '/ok', timeoutMs: 300 }), false);
});

test('vars : les références entre services se résolvent, les manquantes se signalent', async () => {
  const { resolveRefs, hasRef } = await import('../src/vars.js');
  const warn = [];
  const out = resolveRefs(
    { A: '${{base.DATABASE_URL}}', B: 'hôte ${{base.PGHOST}}:${{base.PGPORT}}', C: '${{absent.X}}', D: 'texte brut', E: '${{Base.X}}' },
    (s, k) => (s === 'base' ? { DATABASE_URL: 'pg://u:p@h/d', PGHOST: 'h', PGPORT: '5432' }[k] : undefined),
    (m) => warn.push(m),
  );
  assert.equal(out.A, 'pg://u:p@h/d');
  assert.equal(out.B, 'hôte h:5432');
  assert.equal(out.C, '${{absent.X}}');
  assert.equal(out.D, 'texte brut');
  assert.equal(out.E, '${{Base.X}}', 'les noms de service sont en minuscules');
  assert.equal(warn.length, 1);
  assert.ok(hasRef('x ${{a.B}}') && !hasRef('x') && hasRef('x ${{a.B}}'), 'sans état entre deux appels');
});

test('validate : image, chemin absolu, fenêtre de mesures', () => {
  assert.equal(v.image('postgres:16-alpine'), 'postgres:16-alpine');
  assert.equal(v.image('ghcr.io/org/app@sha256:' + 'a'.repeat(64)), 'ghcr.io/org/app@sha256:' + 'a'.repeat(64));
  for (const bad of ['Postgres:16', 'a b', 'x;rm -rf /', '']) assert.throws(() => v.image(bad), bad);
  assert.equal(v.absPath('/var/lib/mysql'), '/var/lib/mysql');
  for (const bad of ['data', '/a/../b', '/a/', '/a b']) assert.throws(() => v.absPath(bad), bad);
  assert.equal(v.windowSeconds(), 3600);
  assert.equal(v.windowSeconds('7d'), 604800);
  assert.throws(() => v.windowSeconds('1an'));
  assert.throws(() => v.oneOf('sqlite', ['postgres', 'redis'], 'moteur'), /postgres, redis/);
});

test('runtime : lecture des tailles de Docker et sonde TCP', async () => {
  const { parseSize, probeTcp } = await import('../src/runtime.js');
  assert.equal(parseSize('0B'), 0);
  assert.equal(parseSize('5.9MiB'), 6186598);
  assert.equal(parseSize('1.2GB'), 1200000000);
  assert.equal(parseSize('512kB'), 512000);
  assert.equal(parseSize('n/a'), null);
  const srv = http.createServer(() => {});
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const { port } = srv.address();
  assert.equal(await probeTcp({ host: '127.0.0.1', port }), true);
  srv.close();
  assert.equal(await probeTcp({ host: '127.0.0.1', port, timeoutMs: 300 }), false);
});

test('db : mesures, événements, et montée de version 1 → 2 sans perdre de données', () => {
  const s = new Store(':memory:', key);
  const p = s.createProject('p');
  const svc = s.createService(p.id, { name: 'a', repo: 'o/r', branch: 'main', root_dir: '.', port: 80 });
  assert.equal(svc.kind, 'app');
  assert.equal(svc.desired_state, 'running');
  for (let i = 0; i < 10; i++) s.addSample(svc.id, 1000 + i * 15, { cpu: i, mem: i * 100, up: i % 2 });
  assert.equal(s.samples(svc.id, { since: 0, bucket: 15 }).length, 10);
  assert.equal(s.samples(svc.id, { since: 0, bucket: 300 }).length, 1, 'les paquets moyennent');
  assert.equal(s.lastSample(svc.id).cpu, 9);
  s.addHostSample(1000, { cpu: 50, mem: 1, mem_total: 2 });
  assert.equal(s.lastHostSample().cpu, 50);
  s.addEvent({ kind: 'x', level: 'error', service_id: svc.id, message: 'boum' });
  s.addEvent({ kind: 'y', level: 'info', message: 'rien' });
  assert.equal(s.listEvents({ level: 'error' }).length, 1);
  assert.equal(s.listEvents({ serviceId: svc.id }).length, 1);
  s.deleteService(svc.id);
  assert.equal(s.listEvents({ limit: 10 }).length, 2, 'l\'histoire survit à la suppression');
  s.pruneSamples(99999);
  assert.equal(s.samples(svc.id, { since: 0 }).length, 0);
});

test('db : une base en version 1 se met à jour toute seule', () => {
  const dir = tmp();
  const file = path.join(dir, 'rail.db');
  // On fabrique une base « version 1 » : le schéma d'avant la surveillance.
  const { DatabaseSync } = require('node:sqlite');
  const old = new DatabaseSync(file);
  old.exec(`
    CREATE TABLE projects(id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL);
    CREATE TABLE services(id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      name TEXT NOT NULL, repo TEXT NOT NULL, branch TEXT NOT NULL, root_dir TEXT NOT NULL,
      dockerfile_path TEXT, port INTEGER NOT NULL, healthcheck_path TEXT,
      auto_deploy INTEGER NOT NULL DEFAULT 1, memory_mb INTEGER, cpus REAL,
      webhook_secret_enc TEXT NOT NULL, github_token_enc TEXT, active_deployment_id TEXT,
      created_at TEXT NOT NULL, UNIQUE(project_id, name));
    CREATE TABLE variables(service_id TEXT NOT NULL REFERENCES services(id) ON DELETE CASCADE,
      key TEXT NOT NULL, value_enc TEXT NOT NULL, PRIMARY KEY(service_id, key));
    CREATE TABLE domains(id TEXT PRIMARY KEY, service_id TEXT NOT NULL REFERENCES services(id) ON DELETE CASCADE,
      hostname TEXT NOT NULL UNIQUE, kind TEXT NOT NULL);
    CREATE TABLE deployments(id TEXT PRIMARY KEY, service_id TEXT NOT NULL REFERENCES services(id) ON DELETE CASCADE,
      number INTEGER NOT NULL, status TEXT NOT NULL, trigger TEXT NOT NULL,
      commit_sha TEXT, commit_message TEXT, image TEXT, container TEXT, error TEXT,
      created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT, UNIQUE(service_id, number));
    INSERT INTO projects VALUES('p1','demo','2026-01-01');
    INSERT INTO services VALUES('s1','p1','api','acme/api','main','.',NULL,3000,NULL,1,NULL,NULL,'v1:x.y.z',NULL,NULL,'2026-01-01');
    PRAGMA user_version=1;`);
  old.close();

  const s = new Store(file, key);
  const svc = s.getService('s1');
  assert.equal(svc.name, 'api', 'les services d\'avant sont toujours là');
  assert.equal(svc.kind, 'app');
  assert.equal(svc.desired_state, 'running');
  s.addEvent({ kind: 'x', level: 'info', message: 'après migration' });
  assert.equal(s.listEvents({ limit: 1 })[0].message, 'après migration');
  assert.equal(s.db.prepare('PRAGMA user_version').get().user_version, 2);
  s.close();
  assert.doesNotThrow(() => { const again = new Store(file, key); again.close(); }, 'rejouable');
});

test('sql : lire le CSV de psql et le TSV de mysql', async () => {
  const { parseCsv, parseTsv, toTable } = await import('../src/sql.js');
  assert.deepEqual(parseCsv('a,b\n1,"x,\ny"\n2,"il dit ""oui"""'), [['a', 'b'], ['1', 'x,\ny'], ['2', 'il dit "oui"']]);
  assert.deepEqual(parseCsv('a,b\r\n1,2\r\n'), [['a', 'b'], ['1', '2']]);
  assert.deepEqual(parseCsv('a,,c'), [['a', '', 'c']]);
  assert.deepEqual(parseTsv(['id\tnom', '1\tli\\tgne', '2\tNULL'].join('\n')), [['id', 'nom'], ['1', 'li\tgne'], ['2', null]]);

  const t = toTable('id,nom\n1,ana\n2,bo\n', 'csv');
  assert.deepEqual(t.columns, ['id', 'nom']);
  assert.equal(t.total, 2);
  assert.equal(t.truncated, false);
  assert.equal(toTable('CREATE TABLE', 'csv').message, 'CREATE TABLE');
  assert.equal(toTable('', 'csv').message, 'Ordre exécuté.');
  const gros = toTable(['n', ...Array.from({ length: 2500 }, (_, i) => i)].join('\n'), 'csv');
  assert.equal(gros.rows.length, 2000);
  assert.equal(gros.total, 2500);
  assert.equal(gros.truncated, true);
});
