// L'API JSON (`/api/*`), le webhook GitHub (`/webhooks/github/:id`) et le tableau de bord (`/`).
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRouter, readBody, send, STREAMED } from './http.js';
import * as v from './validate.js';
import { HttpError } from './validate.js';
import { safeEqual } from './crypto.js';
import { verifySignature, parsePush } from './github.js';

const WEB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web');
const ok = (body, status = 200) => ({ status, body });

export function createApp({ config, store, deployer, runtime, logs, github }) {
  const r = createRouter();
  const failures = new Map(); // ip → { n, until } : freine la devinette du jeton

  const svcOr404 = (id) => store.getService(id) ?? (() => { throw new HttpError(404, 'service introuvable'); })();
  const depOr404 = (id) => store.getDeployment(id) ?? (() => { throw new HttpError(404, 'déploiement introuvable'); })();
  const publicService = (s) => ({
    ...s,
    domains: store.listDomains(s.id),
    url: store.listDomains(s.id)[0] ? `https://${store.listDomains(s.id)[0].hostname}` : null,
    active_deployment: s.active_deployment_id ? store.getDeployment(s.active_deployment_id) : null,
    latest_deployment: store.listDeployments(s.id, 1)[0] ?? null,
  });
  const webhookUrl = (s) => `${config.publicUrl}/webhooks/github/${s.id}`;

  // ── santé & config publique ──
  r.add('GET', '/api/health', () => ok({ status: 'ok' }), { public: true });
  r.add('GET', '/api/config', () => ok({ domain: config.domain, publicUrl: config.publicUrl, dashboardHost: config.dashboardHost }));

  // ── projets ──
  r.add('GET', '/api/projects', () => ok(store.listProjects().map((p) => ({ ...p, services: store.listServices(p.id).map(publicService) }))));
  r.add('POST', '/api/projects', ({ body }) => ok(store.createProject(v.name(body.name, 'nom du projet')), 201));
  r.add('GET', '/api/projects/:id', ({ params }) => {
    const p = store.getProject(params.id) ?? (() => { throw new HttpError(404, 'projet introuvable'); })();
    return ok({ ...p, services: store.listServices(p.id).map(publicService) });
  });
  r.add('DELETE', '/api/projects/:id', async ({ params }) => {
    if (!store.getProject(params.id)) throw new HttpError(404, 'projet introuvable');
    for (const s of store.listServices(params.id)) await deployer.destroy(s.id);
    store.deleteProject(params.id);
    return ok({ deleted: true });
  });

  // ── services ──
  r.add('POST', '/api/projects/:id/services', ({ params, body }) => {
    const project = store.getProject(params.id) ?? (() => { throw new HttpError(404, 'projet introuvable'); })();
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
      github_token: body.github_token || null,
    };
    const svc = store.tx(() => {
      const s = store.createService(project.id, f);
      store.addDomain(s.id, `${f.name}-${project.name}.${config.domain}`, 'auto');
      return s;
    });
    return ok(publicService(svc), 201);
  });
  r.add('GET', '/api/services', () => ok(store.listServices().map(publicService)));
  r.add('GET', '/api/services/:id', ({ params }) => {
    const s = svcOr404(params.id);
    return ok({ ...publicService(s), webhook: { url: webhookUrl(s), secret: store.webhookSecret(s.id), content_type: 'application/json', events: ['push'] } });
  });
  r.add('PATCH', '/api/services/:id', ({ params, body }) => {
    svcOr404(params.id);
    const p = {};
    if ('repo' in body) p.repo = v.repo(body.repo);
    if ('branch' in body) p.branch = v.branch(body.branch);
    if ('root_dir' in body) p.root_dir = v.relPath(body.root_dir, 'dossier racine');
    if ('dockerfile_path' in body) p.dockerfile_path = body.dockerfile_path ? v.relPath(body.dockerfile_path, 'Dockerfile') : null;
    if ('port' in body) p.port = v.port(body.port);
    if ('healthcheck_path' in body) p.healthcheck_path = v.healthPath(body.healthcheck_path);
    if ('auto_deploy' in body) p.auto_deploy = !!body.auto_deploy;
    if ('memory_mb' in body) p.memory_mb = body.memory_mb == null ? null : v.positive(body.memory_mb, 'mémoire', 65536);
    if ('cpus' in body) p.cpus = body.cpus == null ? null : v.positive(body.cpus, 'cpus', 64);
    if ('github_token' in body) p.github_token = body.github_token || null;
    return ok(publicService(store.updateService(params.id, p)));
  });
  r.add('DELETE', '/api/services/:id', async ({ params }) => {
    svcOr404(params.id);
    await deployer.destroy(params.id);
    store.deleteService(params.id);
    return ok({ deleted: true });
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
    svcOr404(params.id);
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
    const dep = s.active_deployment_id && store.getDeployment(s.active_deployment_id);
    if (!dep?.container) throw new HttpError(404, 'aucun conteneur en service');
    const tail = Math.min(Number(query.get('tail')) || 200, 5000);
    if (!query.get('follow')) {
      let out = '';
      await runtime.logs(dep.container, { tail, onData: (t) => { out += t; } });
      return ok(out);
    }
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'x-accel-buffering': 'no' });
    const ac = new AbortController();
    req.on('close', () => ac.abort());
    runtime.logs(dep.container, { tail, follow: true, signal: ac.signal, onData: (t) => res.write(t) }).catch(() => {}).finally(() => res.end());
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
    if (!s || !verifySignature(raw, headers['x-hub-signature-256'], store.webhookSecret(s.id))) throw new HttpError(401, 'signature invalide');
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

  // ── tableau de bord ──
  r.add('GET', '/', () => ({ file: path.join(WEB, 'index.html'), type: 'text/html; charset=utf-8' }), { public: true });

  // ── le serveur ──
  const csp = "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; img-src data:; frame-ancestors 'none'; base-uri 'none'";
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
        send(res, 200, fs.readFileSync(out.file), { 'content-type': out.type, 'content-security-policy': csp, 'x-frame-options': 'DENY' });
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
