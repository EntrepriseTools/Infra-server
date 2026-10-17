// Les routes de la plateforme elle-même : santé, configuration publique, vue
// d'ensemble, machine, conteneurs, fil d'activité.
import os from 'node:os';
import { HttpError } from './validate.js';
import * as v from './validate.js';
import { ok, nowS } from './api_shared.js';
import { STREAMED } from './http.js';
import { engineList } from './databases.js';
import { templateList } from './templates.js';
import { ROLES, ROLE_NAMES } from './users.js';
import { CRON_PRESETS } from './cron.js';

// Combien de secondes par point de mesure, selon la fenêtre demandée.
const BUCKET = { 900: 15, 3600: 60, 21600: 300, 86400: 900, 604800: 3600 };

export function mountPlatform(ctx) {
  const { r, config, store, deployer, runtime, monitor, H } = ctx;
  let dockerCache = { at: 0, value: null };

  // ── santé & configuration ───────────────────────────────────────────────
  // Publique : c'est elle qui dit au navigateur s'il faut créer le premier compte.
  r.add('GET', '/api/health', () => ok({
    status: 'ok', version: config.version, setup_needed: store.countUsers() === 0,
  }), { public: true });

  r.add('GET', '/api/config', () => ok({
    domain: config.domain,
    publicUrl: config.publicUrl,
    dashboardHost: config.dashboardHost,
    version: config.version,
    engines: engineList(),
    templates: templateList(),
    cron_presets: CRON_PRESETS,
    roles: ROLE_NAMES.map((id) => ({ id, ...ROLES[id] })),
    alerts: !!config.notifyUrl,
    tls: config.tlsMode,
    site_scheme: config.siteScheme,
    site_port: config.sitePort,
    tcp_ports: { from: config.tcpPortFrom, to: config.tcpPortTo, host: config.publicHost || config.domain },
    windows: v.WINDOW_NAMES,
  }), { role: 'viewer' });

  // ── vue d'ensemble : un seul appel pour la page d'accueil ───────────────
  r.add('GET', '/api/overview', async () => ok({
    system: await systemSummary(),
    projects: store.listProjects().map((p) => ({
      ...p,
      environments: store.listEnvironments(p.id).map((e) => ({
        ...e, services: store.listEnvServices(e.id).map(H.publicService),
      })),
    })),
    events: store.listEvents({ limit: 15 }),
  }), { role: 'viewer' });

  async function systemSummary() {
    if (Date.now() - dockerCache.at > 20000) {
      dockerCache = {
        at: Date.now(),
        value: {
          docker: await runtime.version().catch(() => null),
          df: await runtime.systemDf().catch(() => ({})),
        },
      };
    }
    const host = store.lastHostSample() || {};
    const services = store.listServices();
    const states = {};
    for (const s of services) { const st = H.statusOf(s).state; states[st] = (states[st] || 0) + 1; }
    return {
      version: config.version,
      domain: config.domain,
      node: process.version,
      uptime_s: Math.floor(process.uptime()),
      host_uptime_s: Math.floor(os.uptime()),
      cpu: host.cpu ?? null,
      cpus: os.cpus().length,
      load1: host.load1 ?? os.loadavg()[0],
      mem: host.mem ?? (os.totalmem() - os.freemem()),
      mem_total: host.mem_total ?? os.totalmem(),
      disk: host.disk ?? null,
      disk_total: host.disk_total ?? null,
      services: services.length,
      databases: services.filter((s) => s.kind === 'database').length,
      jobs: services.filter((s) => s.kind === 'cron').length,
      projects: store.listProjects().length,
      users: store.countUsers(),
      states,
      alerts: !!config.notifyUrl,
      ...dockerCache.value,
    };
  }
  r.add('GET', '/api/system', async () => ok(await systemSummary()), { role: 'viewer' });
  r.add('GET', '/api/system/metrics', ({ query }) => {
    const win = v.windowSeconds(query.get('range'));
    return ok({ range: query.get('range') || '1h', points: store.hostSamples({ since: nowS() - win, bucket: BUCKET[win] }) });
  }, { role: 'viewer' });
  // Ménage : les images que plus rien n'utilise (un build en laisse à chaque fois).
  r.add('POST', '/api/system/prune', async ({ ev }) => {
    const out = await runtime.pruneImages();
    dockerCache = { at: 0, value: null };
    ev({ kind: 'system.prune', level: 'info', message: 'images orphelines supprimées' });
    return ok({ pruned: true, output: String(out).trim().split('\n').slice(-1)[0] || '' });
  }, { role: 'admin' });

  // ── tous les conteneurs de la machine ───────────────────────────────────
  // Rail n'est pas seul sur le serveur : on montre et on surveille aussi ce qu'il
  // n'a pas déployé (piles compose, bases installées à la main…).
  // On ne se coupe pas la branche : le conteneur du plan de contrôle (dont l'identifiant
  // est le nom d'hôte, vu de l'intérieur) ne s'arrête pas depuis sa propre interface.
  const MOI = os.hostname();
  const cestMoi = (c) => c.name === 'rail-control' || (MOI.length >= 8 && c.id.startsWith(MOI));
  const containerOr404 = async (name) => {
    const c = (await runtime.listContainers({ all: true })).find((x) => x.name === v.containerName(name) || x.id === name);
    if (!c) throw new HttpError(404, 'conteneur introuvable');
    return c;
  };
  // Les mesures d'un conteneur sont rangées sous son service quand Rail le gère,
  // sous « ext:<nom> » sinon.
  const cleMesures = (c) => {
    const svc = c.service_id ? store.getService(c.service_id) : null;
    return svc && H.activeContainer(svc) === c.name ? svc.id : `ext:${c.name}`;
  };
  const decore = (c) => {
    const svc = c.service_id ? store.getService(c.service_id) : null;
    return {
      ...c,
      service: svc ? { id: svc.id, name: svc.name, kind: svc.kind, project: store.getProject(svc.project_id)?.name ?? null, environment: store.getEnvironment(svc.environment_id)?.name ?? null } : null,
      sample: store.lastSample(cleMesures(c)),
    };
  };
  r.add('GET', '/api/containers', async ({ query }) => {
    const liste = await runtime.listContainers({ all: query.get('all') !== '0' });
    const stats = await runtime.stats().catch(() => ({}));
    return ok(liste.map((c) => ({ ...decore(c), control_plane: cestMoi(c), stats: stats[c.name] ?? null })));
  }, { role: 'viewer' });
  r.add('GET', '/api/containers/:name/metrics', async ({ params, query }) => {
    const c = await containerOr404(params.name);
    const win = v.windowSeconds(query.get('range'));
    return ok({ range: query.get('range') || '1h', points: store.samples(cleMesures(c), { since: nowS() - win, bucket: BUCKET[win] }) });
  }, { role: 'viewer' });
  r.add('GET', '/api/containers/:name/logs', async ({ params, query, req, res }) => {
    const c = await containerOr404(params.name);
    const tail = Math.min(Number(query.get('tail')) || 200, 5000);
    if (!query.get('follow')) {
      let out = '';
      await runtime.logs(c.name, { tail, onData: (t) => { out += t; } });
      return ok(out);
    }
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'x-accel-buffering': 'no' });
    const ac = new AbortController();
    req.on('close', () => ac.abort());
    runtime.logs(c.name, { tail, follow: true, signal: ac.signal, onData: (t) => res.write(t) }).catch(() => {}).finally(() => res.end());
    return STREAMED;
  }, { role: 'viewer' });
  for (const geste of ['start', 'stop', 'restart']) {
    r.add('POST', `/api/containers/:name/${geste}`, async ({ params, ev }) => {
      const c = await containerOr404(params.name);
      if (cestMoi(c)) throw new HttpError(400, 'ce conteneur est le plan de contrôle lui-même : il se gère depuis le serveur (docker compose restart control)');
      if (c.managed) throw new HttpError(400, `conteneur géré par Rail : passez par son service (/api/services/:id/${geste})`);
      const fait = geste === 'start' ? await runtime.resume(c.name) : geste === 'stop' ? await runtime.halt(c.name, 20) : await runtime.restart(c.name, 20);
      ev({ kind: `container.${geste}`, level: 'warn', subject: c.name, message: `conteneur « ${c.name} » : ${geste}` });
      return ok({ done: fait, state: geste === 'stop' ? 'stopped' : 'running' });
    }, { role: 'member' });
  }

  // ── fil d'activité ──────────────────────────────────────────────────────
  r.add('GET', '/api/events', ({ query }) => ok(store.listEvents({
    limit: Number(query.get('limit')) || 50,
    serviceId: query.get('service_id') || null,
    projectId: query.get('project_id') || null,
    level: query.get('level') || null,
  })), { role: 'viewer' });

  return { systemSummary };
}
