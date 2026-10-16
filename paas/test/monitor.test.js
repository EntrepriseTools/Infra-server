import test from 'node:test';
import assert from 'node:assert/strict';
import { env, makeRepo, seedService } from './helpers.js';

const PKG = JSON.stringify({ scripts: { start: 'node s.js' } });

async function deployed(extra = {}) {
  const e = env(extra);
  makeRepo(e.dir, 'acme/api', { 'package.json': PKG, 's.js': '//' });
  const { service } = seedService(e, extra.service);
  e.deployer.deploy(service.id);
  await e.deployer.drain();
  return { e, svc: e.store.getService(service.id) };
}
const kinds = (e) => e.store.listEvents({ limit: 50 }).map((x) => x.kind);

test('surveillance : un échantillon par tick, état en mémoire, premier passage silencieux', async () => {
  const { e, svc } = await deployed();
  const before = e.store.listEvents({ limit: 50 }).length;
  await e.monitor.tick();
  const st = e.monitor.status(svc.id);
  assert.equal(st.state, 'running');
  assert.equal(st.sample.cpu, 5.5);
  assert.equal(st.sample.up, 1);
  assert.ok(e.store.lastHostSample().mem_total > 0, 'le serveur est mesuré aussi');
  assert.equal(e.store.listEvents({ limit: 50 }).length, before, 'le premier passage photographie, il ne raconte pas');
  assert.equal(e.store.samples(svc.id, { since: 0, bucket: 1 }).length, 1);
});

test('surveillance : un conteneur tombé est signalé, puis relevé (RAIL_AUTO_HEAL)', async () => {
  const { e, svc } = await deployed();
  await e.monitor.tick();
  e.runtime.containers.set(`rail-${svc.id}-1`, 'exited'); // le conteneur meurt
  await e.monitor.tick();
  assert.equal(e.monitor.status(svc.id).state, 'exited');
  assert.ok(kinds(e).includes('service.problem'), 'la panne est racontée');
  assert.ok(kinds(e).includes('service.heal'), 'et le conteneur est relancé');
  assert.ok(e.runtime.calls.includes(`resume rail-${svc.id}-1`));
  assert.ok(e.notifier.sent.some((n) => n.level === 'error'), 'une alerte part');
  assert.equal(e.store.lastSample(svc.id).up, 0, 'l\'indisponibilité est mesurée');
  await e.monitor.tick();
  assert.equal(e.monitor.status(svc.id).state, 'running');
  assert.ok(kinds(e).includes('service.up'));
});

test('surveillance : sans réparation automatique, on se contente de prévenir', async () => {
  const { e, svc } = await deployed({ autoHeal: false });
  await e.monitor.tick();
  e.runtime.containers.set(`rail-${svc.id}-1`, 'exited');
  await e.monitor.tick();
  assert.ok(!kinds(e).includes('service.heal'));
  assert.ok(!e.runtime.calls.includes(`resume rail-${svc.id}-1`));
  assert.ok(kinds(e).includes('service.problem'));
});

test('surveillance : un service qui ne répond plus à son contrôle de santé est « dégradé »', async () => {
  const { e, svc } = await deployed({ service: { healthcheck_path: '/health' } });
  await e.monitor.tick();
  e.runtime.healthy = false;
  await e.monitor.tick();
  const st = e.monitor.status(svc.id);
  assert.equal(st.state, 'degraded');
  assert.equal(st.health, 'dégradé');
  assert.ok(e.store.listEvents({ limit: 5 })[0].message.includes('répond mal'));
});

test('surveillance : un service arrêté exprès n\'est pas une panne', async () => {
  const { e, svc } = await deployed();
  await e.monitor.tick();
  await e.deployer.stopService(svc.id);
  await e.monitor.tick();
  assert.equal(e.monitor.status(svc.id).state, 'stopped');
  assert.ok(!kinds(e).includes('service.problem'));
  assert.ok(!e.notifier.sent.some((n) => n.level === 'error'));
});

test('surveillance : les vieilles mesures et les vieux événements sont purgés', async () => {
  const { e, svc } = await deployed({ metricsRetentionS: 60, eventsKeep: 3 });
  const old = Math.floor(Date.now() / 1000) - 3600;
  e.store.addSample(svc.id, old, { cpu: 1, up: 1 });
  for (let i = 0; i < 10; i++) e.store.addEvent({ kind: 'test', level: 'info', message: `e${i}` });
  e.monitor.lastPrune = 0;
  await e.monitor.tick();
  assert.equal(e.store.samples(svc.id, { since: 0, bucket: 1 }).filter((s) => s.at === old).length, 0);
  assert.equal(e.store.listEvents({ limit: 100 }).length, 3);
});

test('alertes : le webhook sortant reçoit un format lisible par Slack et Discord', async () => {
  const sent = [];
  const { Notifier } = await import('../src/notify.js');
  const n = new Notifier({ url: 'https://hooks.test/x', fetchImpl: async (url, opts) => { sent.push({ url, body: JSON.parse(opts.body) }); return { ok: true, status: 200 }; } });
  assert.equal(await n.send({ level: 'error', title: 'api en échec', text: 'build cassé', service: 'api' }), true);
  assert.match(sent[0].body.text, /🚨 Rail — api en échec/);
  assert.equal(sent[0].body.text, sent[0].body.content);
  assert.equal(sent[0].body.level, 'error');
  const muet = new Notifier({ url: null });
  assert.equal(await muet.send({ level: 'info', title: 'rien' }), false, 'sans URL, rien ne part');
});
