import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { env, makeRepo } from './helpers.js';
import { createApp } from '../src/api.js';

async function boot() {
  const e = env();
  const repo = makeRepo(e.dir, 'acme/api', { 'package.json': '{"scripts":{"start":"x"}}' });
  const server = createApp({ ...e, runtime: e.runtime, github: e.github });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, body, token = e.config.adminToken, headers = {}) => {
    const res = await fetch(base + path, { method, headers: { ...(token && { authorization: `Bearer ${token}` }), ...(body && { 'content-type': 'application/json' }), ...headers }, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch { json = text; }
    return { status: res.status, body: json, headers: res.headers };
  };
  return { e, repo, server, call, close: () => server.close() };
}

test('authentification : jeton obligatoire sauf /api/health et le webhook', async () => {
  const { call, close } = await boot();
  assert.equal((await call('GET', '/api/health', undefined, null)).status, 200);
  assert.equal((await call('GET', '/api/projects', undefined, null)).status, 401);
  assert.equal((await call('GET', '/api/projects', undefined, 'mauvais')).status, 401);
  assert.equal((await call('GET', '/api/projects')).status, 200);
  assert.equal((await call('GET', '/api/inconnu')).status, 404);
  assert.equal((await call('DELETE', '/api/health')).status, 405);
  close();
});

test('parcours complet : projet → service → variables → domaine → déploiement → logs → rollback', async () => {
  const { e, call, close } = await boot();
  const p = (await call('POST', '/api/projects', { name: 'demo' })).body;
  assert.equal((await call('POST', '/api/projects', { name: 'demo' })).status, 409);
  assert.equal((await call('POST', '/api/projects', { name: 'Pas Valide' })).status, 400);

  const created = await call('POST', `/api/projects/${p.id}/services`, { name: 'api', repo: 'acme/api', port: 8080, healthcheck_path: '/health', github_token: 'ghp_xx' });
  assert.equal(created.status, 201);
  const svc = created.body;
  assert.equal(svc.url, 'https://api-demo.apps.test.dev');
  assert.equal(svc.has_github_token, true);
  assert.ok(!JSON.stringify(created.body).includes('ghp_xx'));
  assert.equal((await call('POST', `/api/projects/${p.id}/services`, { name: 'api', repo: 'acme/api' })).status, 409);
  assert.equal((await call('POST', `/api/projects/${p.id}/services`, { name: 'x', repo: '../etc' })).status, 400);
  assert.equal((await call('POST', `/api/projects/${p.id}/services`, { name: 'y', repo: 'a/b', root_dir: '../..' })).status, 400);

  const detail = (await call('GET', `/api/services/${svc.id}`)).body;
  assert.match(detail.webhook.url, new RegExp(`/webhooks/github/${svc.id}$`));
  assert.ok(detail.webhook.secret.length >= 20);

  assert.equal((await call('PUT', `/api/services/${svc.id}/variables`, { variables: { PORT: '1' } })).status, 400);
  assert.equal((await call('PUT', `/api/services/${svc.id}/variables`, { variables: { DB_URL: 'pg://x' } })).status, 200);
  assert.deepEqual((await call('GET', `/api/services/${svc.id}/variables`)).body, { DB_URL: 'pg://x' });

  assert.equal((await call('POST', `/api/services/${svc.id}/domains`, { hostname: 'API.Client.com' })).status, 201);
  assert.equal((await call('POST', `/api/services/${svc.id}/domains`, { hostname: 'api.client.com' })).status, 409);
  assert.equal((await call('POST', `/api/services/${svc.id}/domains`, { hostname: 'x`) || Host(`y.com' })).status, 400);
  assert.equal((await call('POST', `/api/services/${svc.id}/domains`, { hostname: `rail.${e.config.domain}` })).status, 400);

  const dep = (await call('POST', `/api/services/${svc.id}/deploy`, {})).body;
  assert.equal(dep.status, 'queued');
  await e.deployer.drain();
  const done = (await call('GET', `/api/deployments/${dep.id}`)).body;
  assert.equal(done.status, 'success');
  const logs = (await call('GET', `/api/deployments/${dep.id}/logs`)).body;
  assert.match(logs, /En service sur https:\/\/api-demo\.apps\.test\.dev, https:\/\/api\.client\.com/);
  assert.ok(!logs.includes('ghp_xx'));
  // suivre un journal terminé : renvoie tout puis ferme
  assert.match((await call('GET', `/api/deployments/${dep.id}/logs?follow=1`)).body, /En service/);
  assert.match((await call('GET', `/api/services/${svc.id}/logs`)).body, /log de rail-/);

  const after = (await call('GET', `/api/services/${svc.id}`)).body;
  assert.equal(after.active_deployment.id, dep.id);
  assert.equal((await call('GET', `/api/services/${svc.id}/deployments`)).body.length, 1);

  const re = (await call('POST', `/api/services/${svc.id}/redeploy`)).body;
  await e.deployer.drain();
  assert.equal(e.store.getDeployment(re.id).status, 'success');
  const rb = await call('POST', `/api/deployments/${dep.id}/rollback`);
  assert.equal(rb.status, 202);
  await e.deployer.drain();
  assert.equal(e.store.getDeployment(rb.body.id).status, 'success');
  assert.equal((await call('POST', `/api/deployments/${re.id}/cancel`)).body.canceled, false);

  assert.equal((await call('PATCH', `/api/services/${svc.id}`, { port: 99999 })).status, 400);
  assert.equal((await call('PATCH', `/api/services/${svc.id}`, { branch: 'dev', auto_deploy: false })).body.branch, 'dev');

  assert.equal((await call('DELETE', `/api/services/${svc.id}`)).status, 200);
  assert.equal((await call('GET', `/api/services/${svc.id}`)).status, 404);
  assert.equal(e.runtime.containers.size, 0);
  close();
});

test('webhook GitHub : signature, ping, branche suivie, auto-déploiement', async () => {
  const { e, repo, call, close } = await boot();
  const p = (await call('POST', '/api/projects', { name: 'demo' })).body;
  const svc = (await call('POST', `/api/projects/${p.id}/services`, { name: 'api', repo: 'acme/api' })).body;
  const secret = e.store.webhookSecret(svc.id);
  const push = (over = {}) => JSON.stringify({ ref: 'refs/heads/main', after: repo.first, repository: { full_name: 'Acme/API' }, head_commit: { message: 'feat: x\n\ndétail' }, ...over });
  const send = (body, { sig = true, event = 'push', id = svc.id, key = secret } = {}) =>
    call('POST', `/webhooks/github/${id}`, body, null, { 'x-github-event': event, 'content-type': 'application/json', ...(sig && { 'x-hub-signature-256': `sha256=${createHmac('sha256', key).update(body).digest('hex')}` }) });

  assert.equal((await send(push(), { sig: false })).status, 401);
  assert.equal((await send(push(), { key: 'faux' })).status, 401);
  assert.equal((await send(push(), { id: 'inconnu' })).status, 401);
  assert.equal((await send('{"zen":1}', { event: 'ping' })).body.pong, true);
  assert.match((await send(push({ ref: 'refs/heads/autre' }))).body.ignored, /autre/);
  assert.match((await send(push({ repository: { full_name: 'x/y' } }))).body.ignored, /autre dépôt/);
  assert.match((await send(push(), { event: 'issues' })).body.ignored, /issues/);
  assert.equal(e.store.listDeployments(svc.id).length, 0);

  const ok = await send(push());
  assert.equal(ok.status, 202);
  await e.deployer.drain();
  const d = e.store.getDeployment(ok.body.deployment);
  assert.equal(d.status, 'success', e.logs.read(d.id));
  assert.equal(d.trigger, 'push'); assert.equal(d.commit_message, 'feat: x');

  await call('PATCH', `/api/services/${svc.id}`, { auto_deploy: false });
  assert.match((await send(push())).body.ignored, /désactivé/);
  close();
});

test('installation du webhook sur GitHub', async () => {
  const { e, call, close } = await boot();
  const p = (await call('POST', '/api/projects', { name: 'demo' })).body;
  const svc = (await call('POST', `/api/projects/${p.id}/services`, { name: 'api', repo: 'acme/api' })).body;
  let args;
  e.github.installWebhook = async (a) => { args = a; return 7; };
  const r = await call('POST', `/api/services/${svc.id}/webhook/install`);
  assert.equal(r.body.hook_id, 7);
  assert.equal(args.token, 'ghp_test'); assert.equal(args.secret, e.store.webhookSecret(svc.id));
  assert.match(args.url, /^https:\/\/rail\.apps\.test\.dev\/webhooks\/github\//);
  close();
});

test('tableau de bord servi avec des en-têtes de sécurité', async () => {
  const { call, close } = await boot();
  const r = await call('GET', '/', undefined, null);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /text\/html/);
  assert.match(r.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  close();
});

test('corps invalide ou trop gros', async () => {
  const { call, close } = await boot();
  assert.equal((await call('POST', '/api/projects', '{pas json')).status, 400);
  assert.equal((await call('POST', '/api/projects', '[1]')).status, 400);
  close();
});

test('CLI : projets, service, déploiement, variables, retour arrière', async () => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const { e, close, server } = await boot();
  const rail = async (...a) => (await promisify(execFile)('node', ['bin/rail.js', ...a], { env: { PATH: process.env.PATH, RAIL_URL: `http://127.0.0.1:${server.address().port}`, RAIL_TOKEN: e.config.adminToken } })).stdout;
  await rail('project:new', 'demo');
  assert.match(await rail('service:new', 'demo', 'api', 'acme/api', '--port', '8080'), /URL : https:\/\/api-demo\.apps\.test\.dev/);
  assert.match(await rail('projects'), /api\s+—\s+https:\/\/api-demo/);
  await rail('vars:set', 'demo/api', 'A=1', 'B=x=y');
  assert.equal(await rail('vars', 'demo/api'), 'A="1"\nB="x=y"\n');
  await rail('deploy', 'demo/api'); await e.deployer.drain();
  assert.match(await rail('deployments', 'demo/api'), /success/);
  assert.match(await rail('logs', 'demo/api', '--build'), /En service sur/);
  assert.match(await rail('logs', 'demo/api'), /log de rail-/);
  const id = e.store.listDeployments(e.store.listServices()[0].id)[0].id;
  assert.match(await rail('logs', id), /Commit/);
  assert.match(await rail('rollback', id), /retour arrière : déploiement #2/);
  await e.deployer.drain();
  await assert.rejects(rail('service', 'demo/inconnu'), /introuvable/);
  close();
});
