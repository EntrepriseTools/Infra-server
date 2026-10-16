// L'API JSON (`/api/*`), le webhook GitHub (`/webhooks/github/:id`) et le tableau de bord (`/`).
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRouter, readBody, send, STREAMED } from './http.js';
import * as v from './validate.js';
import { HttpError } from './validate.js';
import { safeEqual } from './crypto.js';
import { verifySignature, parsePush } from './github.js';
import { ENGINES, engineList, provision, engineDump, engineQuery, engineTables } from './databases.js';
import { toTable } from './sql.js';
import { volumeName } from './deployer.js';
import { hasRef } from './vars.js';

const WEB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web');
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/ui.js': ['ui.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
};
// Combien de secondes par point de mesure, selon la fenêtre demandée.
const BUCKET = { 900: 15, 3600: 60, 21600: 300, 86400: 900, 604800: 3600 };
const ok = (body, status = 200) => ({ status, body });
const nowS = () => Math.floor(Date.now() / 1000);

export function createApp({ config, store, deployer, runtime, logs, github, monitor = null, notifier = null }) {
  const r = createRouter();
  const failures = new Map(); // ip → { n, until } : freine la devinette du jeton
  let dockerCache = { at: 0, value: null };

  const svcOr404 = (id) => store.getService(id) ?? (() => { throw new HttpError(404, 'service introuvable'); })();
  const depOr404 = (id) => store.getDeployment(id) ?? (() => { throw new HttpError(404, 'déploiement introuvable'); })();
  const projOr404 = (id) => store.getProject(id) ?? (() => { throw new HttpError(404, 'projet introuvable'); })();
  const activeContainer = (s) => {
    const dep = s.active_deployment_id ? store.getDeployment(s.active_deployment_id) : null;
    return dep?.container || null;
  };
  const publicService = (s) => {
    const domains = store.listDomains(s.id);
    const project = store.getProject(s.project_id);
    return {
      ...s,
      project_name: project?.name ?? null,
      domains,
      url: s.kind === 'database' ? null : (domains[0] ? `https://${domains[0].hostname}` : null),
      private_host: project ? `${s.name}.${project.name}.internal` : null,
      volume: s.volume_path ? { name: volumeName(s.id), path: s.volume_path } : null,
      active_deployment: s.active_deployment_id ? store.getDeployment(s.active_deployment_id) : null,
      latest_deployment: store.listDeployments(s.id, 1)[0] ?? null,
      status: monitor ? monitor.status(s.id) : null,
    };
  };
  const webhookUrl = (s) => `${config.publicUrl}/webhooks/github/${s.id}`;

  // ── santé & config publique ──
  r.add('GET', '/api/health', () => ok({ status: 'ok', version: config.version }), { public: true });
  r.add('GET', '/api/config', () => ok({
    domain: config.domain, publicUrl: config.publicUrl, dashboardHost: config.dashboardHost,
    version: config.version, engines: engineList(), alerts: !!config.notifyUrl,
  }));

  // ── vue d'ensemble : un seul appel pour la page d'accueil ──
  r.add('GET', '/api/overview', async () => ok({
    system: await systemSummary(),
    projects: store.listProjects().map((p) => ({ ...p, services: store.listServices(p.id).map(publicService) })),
    events: store.listEvents({ limit: 15 }),
  }));

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
    for (const s of services) { const st = monitor ? monitor.status(s.id).state : 'unknown'; states[st] = (states[st] || 0) + 1; }
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
      projects: store.listProjects().length,
      states,
      alerts: !!config.notifyUrl,
      ...dockerCache.value,
    };
  }
  r.add('GET', '/api/system', async () => ok(await systemSummary()));
  r.add('GET', '/api/system/metrics', ({ query }) => {
    const win = v.windowSeconds(query.get('range'));
    return ok({ range: query.get('range') || '1h', points: store.hostSamples({ since: nowS() - win, bucket: BUCKET[win] }) });
  });
  // Ménage : les images que plus rien n'utilise (un build en laisse à chaque fois).
  r.add('POST', '/api/system/prune', async () => {
    const out = await runtime.pruneImages();
    dockerCache = { at: 0, value: null };
    return ok({ pruned: true, output: String(out).trim().split('\n').slice(-1)[0] || '' });
  });

  // ── tous les conteneurs de la machine ──
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
    return svc && activeContainer(svc) === c.name ? svc.id : `ext:${c.name}`;
  };
  const decore = (c) => {
    const svc = c.service_id ? store.getService(c.service_id) : null;
    return {
      ...c,
      service: svc ? { id: svc.id, name: svc.name, kind: svc.kind, project: store.getProject(svc.project_id)?.name ?? null } : null,
      sample: store.lastSample(cleMesures(c)),
    };
  };
  r.add('GET', '/api/containers', async ({ query }) => {
    const liste = await runtime.listContainers({ all: query.get('all') !== '0' });
    const stats = await runtime.stats().catch(() => ({}));
    return ok(liste.map((c) => ({ ...decore(c), control_plane: cestMoi(c), stats: stats[c.name] ?? null })));
  });
  r.add('GET', '/api/containers/:name/metrics', async ({ params, query }) => {
    const c = await containerOr404(params.name);
    const win = v.windowSeconds(query.get('range'));
    return ok({ range: query.get('range') || '1h', points: store.samples(cleMesures(c), { since: nowS() - win, bucket: BUCKET[win] }) });
  });
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
  });
  for (const geste of ['start', 'stop', 'restart']) {
    r.add('POST', `/api/containers/:name/${geste}`, async ({ params }) => {
      const c = await containerOr404(params.name);
      if (cestMoi(c)) throw new HttpError(400, 'ce conteneur est le plan de contrôle lui-même : il se gère depuis le serveur (docker compose restart control)');
      if (c.managed) throw new HttpError(400, 'conteneur géré par Rail : passez par son service (/api/services/:id/' + geste + ')');
      const fait = geste === 'start' ? await runtime.resume(c.name) : geste === 'stop' ? await runtime.halt(c.name, 20) : await runtime.restart(c.name, 20);
      store.addEvent({ kind: `container.${geste}`, level: 'warn', subject: c.name, message: `conteneur « ${c.name} » : ${geste}` });
      return ok({ done: fait, state: geste === 'stop' ? 'stopped' : 'running' });
    });
  }

  // ── fil d'activité ──
  r.add('GET', '/api/events', ({ query }) => ok(store.listEvents({
    limit: Number(query.get('limit')) || 50,
    serviceId: query.get('service_id') || null,
    projectId: query.get('project_id') || null,
    level: query.get('level') || null,
  })));

  // ── projets ──
  r.add('GET', '/api/projects', () => ok(store.listProjects().map((p) => ({ ...p, services: store.listServices(p.id).map(publicService) }))));
  r.add('POST', '/api/projects', ({ body }) => {
    const p = store.createProject(v.name(body.name, 'nom du projet'));
    store.addEvent({ kind: 'project.created', level: 'info', project_id: p.id, subject: p.name, message: `projet « ${p.name} » créé` });
    return ok(p, 201);
  });
  r.add('GET', '/api/projects/:id', ({ params }) => {
    const p = projOr404(params.id);
    return ok({ ...p, services: store.listServices(p.id).map(publicService) });
  });
  r.add('DELETE', '/api/projects/:id', async ({ params }) => {
    const p = projOr404(params.id);
    for (const s of store.listServices(params.id)) await deployer.destroy(s.id);
    store.deleteProject(params.id);
    store.addEvent({ kind: 'project.deleted', level: 'warn', subject: p.name, message: `projet « ${p.name} » supprimé` });
    return ok({ deleted: true });
  });

  // ── services ──
  r.add('POST', '/api/projects/:id/services', ({ params, body }) => {
    const project = projOr404(params.id);
    const f = {
      name: v.name(body.name, 'nom du service'),
      repo: v.repo(body.repo),
      branch: v.branch(body.branch ?? 'main'),
      root_dir: v.relPath(body.root_dir ?? '.', 'dossier racine'),
      dockerfile_path: body.dockerfile_path ? v.relPath(body.dockerfile_path, 'Dockerfile') : null,
      port: v.port(body.port ?? 3000),
      healthcheck_path: v.healthPath(body.healthcheck_path ?? null),
      auto_deploy: body.auto_deploy !== false,
      memory_mb: body.memory_mb == null ? null : v.positive(body.memory_mb, 'mémoire', 65536),
      cpus: body.cpus == null ? null : v.positive(body.cpus, 'cpus', 64),
      volume_path: body.volume_path ? v.absPath(body.volume_path, 'point de montage') : null,
      github_token: body.github_token || null,
    };
    const svc = store.tx(() => {
      const s = store.createService(project.id, f);
      store.addDomain(s.id, `${f.name}-${project.name}.${config.domain}`, 'auto');
      return s;
    });
    store.addEvent({ kind: 'service.created', level: 'info', project_id: project.id, service_id: svc.id, subject: svc.name, message: `service « ${svc.name} » créé depuis ${f.repo}` });
    return ok(publicService(svc), 201);
  });

  // ── bases de données managées ──
  r.add('GET', '/api/databases/engines', () => ok(engineList()));
  r.add('POST', '/api/projects/:id/databases', ({ params, body }) => {
    const project = projOr404(params.id);
    const engine = v.oneOf(body.engine, Object.keys(ENGINES), 'moteur');
    const name = v.name(body.name || engine, 'nom de la base');
    const { fields, vars } = provision({ engine, name, project: project.name });
    const svc = store.tx(() => {
      const s = store.createService(project.id, fields);
      store.setVars(s.id, vars);
      return s;
    });
    store.addEvent({ kind: 'database.created', level: 'info', project_id: project.id, service_id: svc.id, subject: svc.name, message: `base ${ENGINES[engine].label} « ${svc.name} » créée` });
    deployer.deploy(svc.id, { trigger: 'manual' });
    return ok(publicService(store.getService(svc.id)), 201);
  });
  /** La sauvegarde d'une base, en flux : `rail backup demo/db > dump.sql`. */
  r.add('GET', '/api/services/:id/backup', async ({ params, res }) => {
    const s = svcOr404(params.id);
    if (s.kind !== 'database') throw new HttpError(400, 'seule une base de données se sauvegarde ainsi');
    const container = activeContainer(s);
    if (!container) throw new HttpError(409, 'la base n\'est pas déployée');
    const vars = store.getVars(s.id);
    const dump = engineDump(s.engine, vars);
    if (!dump) throw new HttpError(400, `pas de sauvegarde intégrée pour ${s.engine} : copiez le volume ${volumeName(s.id)}`);
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
    res.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-disposition': `attachment; filename="${s.name}-${stamp}.${dump.ext}"`,
      'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
    });
    try {
      await runtime.exec(container, dump.args, { env: dump.env, onData: (t) => res.write(t), timeoutMs: 1800000 });
      store.addEvent({ kind: 'database.backup', level: 'info', project_id: s.project_id, service_id: s.id, subject: s.name, message: `sauvegarde de « ${s.name} » téléchargée` });
    } catch (e) {
      res.write(`\n-- ÉCHEC DE LA SAUVEGARDE : ${e.message}\n`);
    }
    res.end();
    return STREAMED;
  });

  // ── console SQL ──
  // La requête part par l'entrée standard du client (psql, mysql) : elle n'apparaît
  // ni dans les arguments de la commande, ni dans le `ps` de l'hôte.
  async function runSql(s, sql, { readOnly }) {
    const container = activeContainer(s);
    if (!container) throw new HttpError(409, 'la base n\'est pas déployée');
    const q = engineQuery(s.engine, store.getVars(s.id), { readOnly });
    if (!q) throw new HttpError(400, `pas de console SQL pour ${s.engine} : ce moteur ne parle pas SQL`);
    const t0 = Date.now();
    let out = ''; let err = '';
    try {
      await runtime.exec(container, q.args, {
        env: q.env,
        input: `${q.prelude}${sql}\n`,
        onData: (t) => { if (out.length < 4_000_000) out += t; },
        onErr: (t) => { err += t; },
        timeoutMs: 60_000,
      });
    } catch (e) {
      const why = (err || e.output || e.message || '').trim().split('\n').slice(0, 8).join('\n');
      throw new HttpError(400, why || 'la requête a échoué');
    }
    return { ...toTable(out, q.format), ms: Date.now() - t0, read_only: readOnly, notice: err.trim() || null };
  }
  r.add('POST', '/api/services/:id/query', async ({ params, body }) => {
    const s = svcOr404(params.id);
    if (s.kind !== 'database') throw new HttpError(400, 'seule une base de données se requête');
    const sql = typeof body.sql === 'string' ? body.sql.trim() : '';
    if (!sql) throw new HttpError(400, 'requête vide');
    if (sql.length > 200_000) throw new HttpError(413, 'requête trop longue');
    const readOnly = body.read_only !== false;
    const res = await runSql(s, sql, { readOnly });
    // Une écriture laisse une trace : qui a changé quoi, et quand, se lit dans l'activité.
    if (!readOnly) {
      store.addEvent({
        kind: 'database.write', level: 'warn', project_id: s.project_id, service_id: s.id, subject: s.name,
        message: `requête en écriture sur « ${s.name} » : ${sql.replace(/\s+/g, ' ').slice(0, 120)}`,
      });
    }
    return ok(res);
  });
  r.add('GET', '/api/services/:id/tables', async ({ params }) => {
    const s = svcOr404(params.id);
    if (s.kind !== 'database') throw new HttpError(400, 'seule une base de données a des tables');
    const sql = engineTables(s.engine);
    if (!sql) throw new HttpError(400, `pas de liste de tables pour ${s.engine}`);
    return ok(await runSql(s, sql, { readOnly: true }));
  });

  r.add('GET', '/api/services', () => ok(store.listServices().map(publicService)));
  r.add('GET', '/api/services/:id', ({ params }) => {
    const s = svcOr404(params.id);
    const out = { ...publicService(s), variables_have_refs: Object.values(store.getVars(s.id)).some(hasRef) };
    if (s.kind !== 'database') out.webhook = { url: webhookUrl(s), secret: store.webhookSecret(s.id), content_type: 'application/json', events: ['push'] };
    else out.engine_info = { ...ENGINES[s.engine], vars: undefined, cmd: undefined, dump: undefined, client: ENGINES[s.engine]?.client };
    return ok(out);
  });
  r.add('PATCH', '/api/services/:id', ({ params, body }) => {
    const s = svcOr404(params.id);
    const p = {};
    if (s.kind === 'database') {
      // Une base ne change ni de dépôt ni de port : seulement ses limites et son image.
      if ('memory_mb' in body) p.memory_mb = body.memory_mb == null ? null : v.positive(body.memory_mb, 'mémoire', 65536);
      if ('cpus' in body) p.cpus = body.cpus == null ? null : v.positive(body.cpus, 'cpus', 64);
      if ('base_image' in body && body.base_image) p.base_image = v.image(body.base_image);
      return ok(publicService(store.updateService(params.id, p)));
    }
    if ('repo' in body) p.repo = v.repo(body.repo);
    if ('branch' in body) p.branch = v.branch(body.branch);
    if ('root_dir' in body) p.root_dir = v.relPath(body.root_dir, 'dossier racine');
    if ('dockerfile_path' in body) p.dockerfile_path = body.dockerfile_path ? v.relPath(body.dockerfile_path, 'Dockerfile') : null;
    if ('port' in body) p.port = v.port(body.port);
    if ('healthcheck_path' in body) p.healthcheck_path = v.healthPath(body.healthcheck_path);
    if ('auto_deploy' in body) p.auto_deploy = !!body.auto_deploy;
    if ('memory_mb' in body) p.memory_mb = body.memory_mb == null ? null : v.positive(body.memory_mb, 'mémoire', 65536);
    if ('cpus' in body) p.cpus = body.cpus == null ? null : v.positive(body.cpus, 'cpus', 64);
    if ('volume_path' in body) p.volume_path = body.volume_path ? v.absPath(body.volume_path, 'point de montage') : null;
    if ('github_token' in body) p.github_token = body.github_token || null;
    return ok(publicService(store.updateService(params.id, p)));
  });
  r.add('DELETE', '/api/services/:id', async ({ params, query }) => {
    const s = svcOr404(params.id);
    await deployer.destroy(params.id, { keepVolume: query.get('keep_volume') === '1' });
    store.deleteService(params.id);
    store.addEvent({ kind: 'service.deleted', level: 'warn', project_id: s.project_id, subject: s.name, message: `service « ${s.name} » supprimé` });
    return ok({ deleted: true });
  });

  // ── marche / arrêt ──
  r.add('POST', '/api/services/:id/stop', async ({ params }) => ok(await deployer.stopService(svcOr404(params.id).id)));
  r.add('POST', '/api/services/:id/start', async ({ params }) => {
    try { return ok(await deployer.startService(svcOr404(params.id).id)); } catch (e) { throw new HttpError(409, e.message); }
  });
  r.add('POST', '/api/services/:id/restart', async ({ params }) => {
    try { return ok(await deployer.restartService(svcOr404(params.id).id)); } catch (e) { throw new HttpError(409, e.message); }
  });

  // ── mesures d'un service ──
  r.add('GET', '/api/services/:id/status', ({ params }) => {
    const s = svcOr404(params.id);
    return ok({ ...(monitor ? monitor.status(s.id) : { state: 'unknown' }), desired_state: s.desired_state });
  });
  r.add('GET', '/api/services/:id/metrics', ({ params, query }) => {
    const s = svcOr404(params.id);
    const win = v.windowSeconds(query.get('range'));
    const bucket = BUCKET[win];
    const rows = store.samples(s.id, { since: nowS() - win, bucket });
    // rx/tx sont des compteurs cumulés depuis le démarrage du conteneur : on en fait un débit.
    const points = rows.map((row, i) => {
      const prev = rows[i - 1];
      const dt = prev ? row.at - prev.at : 0;
      const rate = (a, b) => (dt > 0 && a != null && b != null && a >= b ? Math.round((a - b) / dt) : 0);
      return { at: row.at, cpu: row.cpu, mem: row.mem, mem_limit: row.mem_limit, up: row.up, rx: rate(row.rx, prev?.rx), tx: rate(row.tx, prev?.tx) };
    });
    const up = rows.filter((x) => x.up != null);
    return ok({
      range: query.get('range') || '1h', bucket, points,
      uptime: up.length ? up.reduce((a, x) => a + x.up, 0) / up.length : null,
      limits: { memory_mb: s.memory_mb || config.defaultMemoryMb, cpus: s.cpus || config.defaultCpus },
      current: store.lastSample(s.id),
    });
  });

  // ── variables ──
  r.add('GET', '/api/services/:id/variables', ({ params }) => ok(store.getVars(svcOr404(params.id).id)));
  r.add('PUT', '/api/services/:id/variables', ({ params, body }) => {
    svcOr404(params.id);
    const vars = body.variables;
    if (!vars || typeof vars !== 'object' || Array.isArray(vars)) throw new HttpError(400, '« variables » doit être un objet {NOM: valeur}');
    const clean = {};
    for (const [k, val] of Object.entries(vars)) clean[v.envKey(k)] = v.envValue(val);
    store.setVars(params.id, clean);
    return ok(store.getVars(params.id));
  });
  r.add('DELETE', '/api/services/:id/variables/:key', ({ params }) => {
    svcOr404(params.id);
    if (!store.deleteVar(params.id, params.key)) throw new HttpError(404, 'variable introuvable');
    return ok({ deleted: true });
  });

  // ── domaines ──
  r.add('POST', '/api/services/:id/domains', ({ params, body }) => {
    const s = svcOr404(params.id);
    if (s.kind === 'database') throw new HttpError(400, 'une base de données ne s\'expose pas sur Internet');
    const host = v.hostname(body.hostname);
    if (host === config.dashboardHost) throw new HttpError(400, 'ce nom est réservé au tableau de bord');
    return ok(store.addDomain(params.id, host, host.endsWith(`.${config.domain}`) ? 'auto' : 'custom'), 201);
  });
  r.add('DELETE', '/api/services/:id/domains/:domainId', ({ params }) => {
    svcOr404(params.id);
    const d = store.getDomain(params.domainId);
    if (!d || d.service_id !== params.id) throw new HttpError(404, 'domaine introuvable');
    store.deleteDomain(d.id);
    return ok({ deleted: true });
  });

  // ── déploiements ──
  r.add('GET', '/api/services/:id/deployments', ({ params }) => ok(store.listDeployments(svcOr404(params.id).id)));
  r.add('POST', '/api/services/:id/deploy', ({ params, body }) => {
    svcOr404(params.id);
    return ok(deployer.deploy(params.id, { trigger: 'manual', sha: body.sha ? v.sha(body.sha) : null }), 202);
  });
  r.add('POST', '/api/services/:id/redeploy', ({ params }) => {
    svcOr404(params.id);
    try { return ok(deployer.redeploy(params.id), 202); } catch (e) { throw new HttpError(409, e.message); }
  });
  r.add('GET', '/api/deployments/:id', ({ params }) => ok(depOr404(params.id)));
  r.add('POST', '/api/deployments/:id/rollback', ({ params }) => {
    depOr404(params.id);
    try { return ok(deployer.rollback(params.id), 202); } catch (e) { throw new HttpError(409, e.message); }
  });
  r.add('POST', '/api/deployments/:id/cancel', ({ params }) => {
    depOr404(params.id);
    return ok({ canceled: deployer.cancel(params.id) });
  });
  // Journal de construction : texte brut ; `?follow=1` garde la connexion jusqu'à la fin du déploiement.
  r.add('GET', '/api/deployments/:id/logs', ({ params, query, req, res }) => {
    depOr404(params.id);
    if (!query.get('follow')) return ok(logs.read(params.id));
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'x-accel-buffering': 'no' });
    const stop = logs.follow(params.id, (t) => t && res.write(t), () => res.end());
    req.on('close', stop);
    return STREAMED;
  });
  // Journal d'exécution du conteneur en service.
  r.add('GET', '/api/services/:id/logs', async ({ params, query, req, res }) => {
    const s = svcOr404(params.id);
    const container = activeContainer(s);
    if (!container) throw new HttpError(404, 'aucun conteneur en service');
    const tail = Math.min(Number(query.get('tail')) || 200, 5000);
    if (!query.get('follow')) {
      let out = '';
      await runtime.logs(container, { tail, onData: (t) => { out += t; } });
      return ok(out);
    }
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'x-accel-buffering': 'no' });
    const ac = new AbortController();
    req.on('close', () => ac.abort());
    runtime.logs(container, { tail, follow: true, signal: ac.signal, onData: (t) => res.write(t) }).catch(() => {}).finally(() => res.end());
    return STREAMED;
  });

  // ── webhook GitHub (authentifié par signature, pas par jeton) ──
  r.add('POST', '/api/services/:id/webhook/install', async ({ params }) => {
    const s = svcOr404(params.id);
    const token = store.githubToken(s.id) || config.defaultGithubToken;
    if (!token) throw new HttpError(400, 'un jeton GitHub (droit « admin:repo_hook ») est nécessaire');
    try {
      const id = await github.installWebhook({ token, repo: s.repo, url: webhookUrl(s), secret: store.webhookSecret(s.id) });
      return ok({ installed: true, hook_id: id, url: webhookUrl(s) });
    } catch (e) { throw new HttpError(502, e.message); }
  });
  r.add('POST', '/webhooks/github/:id', ({ params, headers, raw }) => {
    const s = store.getService(params.id);
    // Même réponse que le service existe ou non : on ne dit pas quels identifiants sont valides.
    if (!s || s.kind === 'database' || !verifySignature(raw, headers['x-hub-signature-256'], store.webhookSecret(s.id))) throw new HttpError(401, 'signature invalide');
    const event = headers['x-github-event'];
    if (event === 'ping') return ok({ pong: true });
    if (event !== 'push') return ok({ ignored: `événement ${event}` });
    let payload;
    try { payload = JSON.parse(raw.toString('utf8')); } catch { throw new HttpError(400, 'JSON invalide'); }
    const push = parsePush(payload);
    if (!push) return ok({ ignored: 'pas un push de branche' });
    if (push.repo?.toLowerCase() !== s.repo.toLowerCase()) return ok({ ignored: 'autre dépôt' });
    if (push.branch !== s.branch) return ok({ ignored: `branche ${push.branch} (suivie : ${s.branch})` });
    if (!s.auto_deploy) return ok({ ignored: 'déploiement automatique désactivé' });
    const dep = deployer.deploy(s.id, { trigger: 'push', sha: v.sha(push.sha), message: push.message });
    return ok({ deployment: dep.id, number: dep.number }, 202);
  }, { public: true, rawBody: true });

  // ── tableau de bord (fichiers statiques) ──
  for (const [route, [file, type]] of Object.entries(STATIC)) {
    r.add('GET', route, () => ({ file: path.join(WEB, file), type }), { public: true });
  }

  // ── le serveur ──
  const csp = "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x');
      const m = r.match(req.method, url.pathname);
      if (!m) {
        if (r.pathExists(url.pathname)) throw new HttpError(405, 'méthode non permise');
        throw new HttpError(404, 'introuvable');
      }
      if (!m.route.public) {
        const ip = req.socket.remoteAddress;
        const f = failures.get(ip);
        if (f && f.n >= 10 && f.until > Date.now()) throw new HttpError(429, 'trop d\'essais, patientez');
        const given = /^Bearer (.+)$/.exec(req.headers.authorization || '')?.[1];
        if (!given || !safeEqual(given, config.adminToken)) {
          failures.set(ip, { n: (f?.until > Date.now() ? f.n : 0) + 1, until: Date.now() + 60000 });
          throw new HttpError(401, 'jeton invalide');
        }
        failures.delete(ip);
      }
      let body = {}; let raw = Buffer.alloc(0);
      if (['POST', 'PUT', 'PATCH'].includes(req.method)) {
        raw = await readBody(req, m.route.rawBody ? 10 * 1024 * 1024 : 1024 * 1024);
        if (!m.route.rawBody && raw.length) {
          try { body = JSON.parse(raw.toString('utf8')); } catch { throw new HttpError(400, 'JSON invalide'); }
          if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'un objet JSON est attendu');
        }
      }
      const out = await m.route.handler({ req, res, params: m.params, query: url.searchParams, headers: req.headers, body, raw });
      if (out === STREAMED) return;
      if (out.file) {
        send(res, 200, fs.readFileSync(out.file), { 'content-type': out.type, 'content-security-policy': csp, 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer' });
      } else send(res, out.status, out.body);
    } catch (e) {
      const status = e instanceof HttpError ? e.status : /UNIQUE constraint/.test(e?.message) ? 409 : 500;
      if (status === 500) console.error('[api]', e);
      if (!res.headersSent) send(res, status, { error: status === 500 ? 'erreur interne' : status === 409 && !(e instanceof HttpError) ? 'ce nom existe déjà' : e.message });
      else res.end();
    }
  });
  return server;
}
