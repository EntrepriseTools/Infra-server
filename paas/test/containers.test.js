import test from 'node:test';
import assert from 'node:assert/strict';
import { env, makeRepo, serve } from './helpers.js';

const PKG = '{"scripts":{"start":"node s.js"}}';

async function boot() {
  const e = env();
  makeRepo(e.dir, 'acme/api', { 'package.json': PKG, 's.js': '//' });
  // La machine fait déjà tourner autre chose que Rail.
  e.runtime.externes = [
    { id: 'c1', name: 'nginx-maison', image: 'nginx:1.27', state: 'running', status: 'Up 3 days', created: '2026-01-01', ports: '0.0.0.0:8080->80/tcp', networks: 'bridge', labels: {}, service_id: null, managed: false },
    { id: 'c2', name: 'vieux-batch', image: 'busybox', state: 'exited', status: 'Exited (0) 2 days ago', created: '2026-01-01', ports: '', networks: 'bridge', labels: {}, service_id: null, managed: false },
  ];
  const s = await serve(e);
  const p = (await s.call('POST', '/api/projects', { name: 'demo' })).body;
  const svc = (await s.call('POST', `/api/projects/${p.id}/services`, { name: 'api', repo: 'acme/api' })).body;
  await s.call('POST', `/api/services/${svc.id}/deploy`, {});
  await e.deployer.drain();
  return { e, svc, ...s };
}

test('inventaire : les conteneurs de Rail ET ceux de la machine, avec leurs mesures', async () => {
  const { e, svc, call, close } = await boot();
  await e.monitor.tick();
  const liste = (await call('GET', '/api/containers')).body;
  const noms = liste.map((c) => c.name);
  assert.ok(noms.includes('nginx-maison') && noms.includes('vieux-batch'), noms.join(','));
  assert.ok(noms.includes(`rail-${svc.id}-1`));

  const mien = liste.find((c) => c.name === `rail-${svc.id}-1`);
  assert.equal(mien.managed, true);
  assert.equal(mien.service.name, 'api');
  assert.equal(mien.service.project, 'demo');
  assert.equal(mien.stats.cpu, 5.5);

  const autre = liste.find((c) => c.name === 'nginx-maison');
  assert.equal(autre.service, null);
  assert.equal(autre.stats.cpu, 1.25);
  assert.equal(autre.sample.mem, 42 * 1024 * 1024, 'les conteneurs hors Rail ont aussi un historique');
  assert.equal(autre.ports, '0.0.0.0:8080->80/tcp');

  const arretes = (await call('GET', '/api/containers?all=0')).body.map((c) => c.name);
  assert.ok(!arretes.includes('vieux-batch'));
  close();
});

test('mesures et journal d\'un conteneur hors Rail', async () => {
  const { e, call, close } = await boot();
  await e.monitor.tick();
  const m = (await call('GET', '/api/containers/nginx-maison/metrics?range=1h')).body;
  assert.equal(m.points.length, 1);
  assert.equal(m.points[0].cpu, 1.25);
  assert.match((await call('GET', '/api/containers/nginx-maison/logs')).body, /log de nginx-maison/);
  assert.equal((await call('GET', '/api/containers/absent/logs')).status, 404);
  assert.equal((await call('GET', '/api/containers/pas%20un%20nom/logs')).status, 400);
  close();
});

test('piloter un conteneur hors Rail ; refuser ceux que Rail gère', async () => {
  const { e, svc, call, close } = await boot();
  assert.equal((await call('POST', '/api/containers/nginx-maison/restart')).body.done, true);
  assert.ok(e.runtime.calls.includes('restart nginx-maison'));
  assert.equal(e.store.listEvents({ limit: 1 })[0].kind, 'container.restart');

  const mien = `rail-${svc.id}-1`;
  const refus = await call('POST', `/api/containers/${mien}/stop`);
  assert.equal(refus.status, 400);
  assert.match(refus.body.error, /passez par son service/);
  close();
});
