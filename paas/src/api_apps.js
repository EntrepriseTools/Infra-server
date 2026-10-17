// Les routes des projets, environnements et services : créer, régler, déployer,
// exposer, planifier — plus le branchement GitHub et les modèles en un clic.
import { HttpError } from './validate.js';
import * as v from './validate.js';
import { ok, nowS } from './api_shared.js';
import { STREAMED } from './http.js';
import { verifySignature, parsePush } from './github.js';
import { ENGINES, provision } from './databases.js';
import { getTemplate, instantiate, templateList } from './templates.js';
import { hasRef } from './vars.js';
import { cronValid, cronWords, cronNext } from './cron.js';
import { PRODUCTION } from './naming.js';

const BUCKET = { 900: 15, 3600: 60, 21600: 300, 86400: 900, 604800: 3600 };

/** « a/b, c » ou plusieurs lignes → « a/b\nc » (les chemins surveillés d'un monodépôt). */
function watchPaths(value) {
  if (value == null || value === '') return null;
  const list = String(value).split(/[\n,]/).map((s) => s.trim()).filter(Boolean).map((s) => v.relPath(s, 'chemin surveillé'));
  if (list.length > 50) throw new HttpError(400, '50 chemins surveillés au plus');
  return list.length ? list.join('\n') : null;
}
function cron(value, quoi = 'planification') {
  const s = String(value || '').trim();
  if (!s) return null;
  if (s.length > 100 || !cronValid(s)) throw new HttpError(400, `${quoi} invalide : « minute heure jour mois jour-semaine » (ex. 0 3 * * *) ou @daily`);
  return s;
}
const commande = (value, quoi) => {
  if (value == null || value === '') return null;
  const s = String(value);
  if (s.length > 2000 || /[\x00\n\r]/.test(s)) throw new HttpError(400, `${quoi} invalide (une seule ligne, 2000 caractères au plus)`);
  return s;
};

export function mountApps(ctx) {
  const { r, config, store, deployer, runtime, logs, github, backups, H } = ctx;

  // ── projets ─────────────────────────────────────────────────────────────
  const projectView = (p) => ({
    ...p,
    environments: store.listEnvironments(p.id).map((e) => ({ ...e, services: store.listEnvServices(e.id).map(H.publicService) })),
  });
  r.add('GET', '/api/projects', () => ok(store.listProjects().map(projectView)), { role: 'viewer' });
  r.add('POST', '/api/projects', ({ body, ev }) => {
    const p = store.createProject(v.name(body.name, 'nom du projet'));
    ev({ kind: 'project.created', level: 'info', project_id: p.id, subject: p.name, message: `projet « ${p.name} » créé` });
    return ok(projectView(p), 201);
  });
  r.add('GET', '/api/projects/:id', ({ params }) => ok(projectView(H.projOr404(params.id))), { role: 'viewer' });
  r.add('DELETE', '/api/projects/:id', async ({ params, ev }) => {
    const p = H.projOr404(params.id);
    for (const s of store.listServices(params.id)) { await deployer.destroy(s.id); backups?.removeAll(s.id); }
    store.deleteProject(params.id);
    ev({ kind: 'project.deleted', level: 'warn', subject: p.name, message: `projet « ${p.name} » supprimé` });
    return ok({ deleted: true });
  });

  // ── environnements ──────────────────────────────────────────────────────
  // Le même projet, deux fois : « production » et ce qu'on veut à côté
  // (preproduction, demo…). Les services y portent le même nom, les variables
  // et les références entre services restent dans leur environnement.
  r.add('GET', '/api/projects/:id/environments', ({ params }) => {
    const p = H.projOr404(params.id);
    return ok(store.listEnvironments(p.id).map((e) => ({ ...e, services: store.listEnvServices(e.id).map(H.publicService) })));
  }, { role: 'viewer' });

  r.add('POST', '/api/projects/:id/environments', ({ params, body, ev }) => {
    const p = H.projOr404(params.id);
    const name = v.name(body.name, 'nom de l\'environnement');
    if (store.findEnvironment(p.id, name)) throw new HttpError(409, 'cet environnement existe déjà');
    if (store.listEnvironments(p.id).length >= 10) throw new HttpError(409, '10 environnements au plus par projet');
    const source = body.copy_from ? H.envOr404(body.copy_from) : null;
    if (source && source.project_id !== p.id) throw new HttpError(400, 'l\'environnement à copier appartient à un autre projet');
    const env = store.tx(() => {
      const e = store.createEnvironment(p.id, name);
      store.setProjectVars(e.id, source ? store.getProjectVars(source.id) : {});
      if (source) {
        // On recopie la description des services, pas leurs données : les bases
        // repartent avec des identifiants neufs, les volumes sont vides.
        for (const s of store.listEnvServices(source.id)) {
          if (s.kind === 'database') {
            const { fields, vars } = provision({
              engine: s.engine, name: s.name, project: p.name, image: s.base_image,
              host: H.privateFor({ service: s.name, project: p.name, environment: name }),
            });
            const copie = store.createService(p.id, { ...fields, environment_id: e.id, memory_mb: s.memory_mb, cpus: s.cpus, backup_schedule: s.backup_schedule, backup_keep: s.backup_keep });
            store.setVars(copie.id, vars);
          } else {
            const copie = store.createService(p.id, {
              ...s, environment_id: e.id, id: undefined, active_deployment_id: null, public_port: null,
              github_token: store.githubToken(s.id),
            });
            store.setVars(copie.id, store.getVars(s.id));
            if (copie.kind === 'app') {
              store.addDomain(copie.id, H.hostFor({ service: copie.name, project: p.name, environment: name }), 'auto');
            }
          }
        }
      }
      return e;
    });
    ev({ kind: 'environment.created', level: 'info', project_id: p.id, subject: name, message: `environnement « ${name} » créé dans ${p.name}${source ? ` d'après « ${source.name} »` : ''}` });
    return ok({ ...env, services: store.listEnvServices(env.id).map(H.publicService), deploy_hint: source ? 'les services copiés attendent un déploiement' : null }, 201);
  });

  r.add('DELETE', '/api/environments/:id', async ({ params, ev }) => {
    const e = H.envOr404(params.id);
    if (e.name === PRODUCTION) throw new HttpError(400, 'l\'environnement « production » ne se supprime pas : supprimez le projet');
    for (const s of store.listEnvServices(e.id)) { await deployer.destroy(s.id); backups?.removeAll(s.id); }
    store.deleteEnvironment(e.id);
    ev({ kind: 'environment.deleted', level: 'warn', project_id: e.project_id, subject: e.name, message: `environnement « ${e.name} » supprimé avec ses services` });
    return ok({ deleted: true });
  });

  // Variables partagées par tous les services d'un environnement.
  r.add('GET', '/api/environments/:id/variables', ({ params }) => ok(store.getProjectVars(H.envOr404(params.id).id)), { role: 'viewer' });
  r.add('PUT', '/api/environments/:id/variables', ({ params, body, ev }) => {
    const e = H.envOr404(params.id);
    const vars = body.variables;
    if (!vars || typeof vars !== 'object' || Array.isArray(vars)) throw new HttpError(400, '« variables » doit être un objet {NOM: valeur}');
    const clean = {};
    for (const [k, val] of Object.entries(vars)) clean[v.envKey(k)] = v.envValue(val);
    store.tx(() => {
      for (const k of Object.keys(store.getProjectVars(e.id))) if (!(k in clean)) store.deleteProjectVar(e.id, k);
      store.setProjectVars(e.id, clean);
    });
    ev({ kind: 'environment.variables', level: 'info', project_id: e.project_id, subject: e.name, message: `variables partagées de « ${e.name} » modifiées (${Object.keys(clean).length})` });
    return ok(store.getProjectVars(e.id));
  });
  r.add('DELETE', '/api/environments/:id/variables/:key', ({ params }) => {
    const e = H.envOr404(params.id);
    if (!store.deleteProjectVar(e.id, params.key)) throw new HttpError(404, 'variable introuvable');
    return ok({ deleted: true });
  });

  // ── GitHub : ce que voit le jeton de l'appelant ──────────────────────────
  const tokenOr400 = (user, svc = null) => H.githubTokenFor(user, svc)
    ?? (() => { throw new HttpError(400, 'aucun jeton GitHub : reliez votre compte GitHub dans « Mon compte »'); })();
  r.add('GET', '/api/github/repos', async ({ who, query }) => {
    const token = tokenOr400(who.user);
    try {
      const liste = await github.repos(token, { page: Math.max(1, Number(query.get('page')) || 1) });
      const q = String(query.get('q') || '').toLowerCase();
      return ok(q ? liste.filter((x) => x.full_name.toLowerCase().includes(q)) : liste);
    } catch (e) { throw new HttpError(502, e.message); }
  }, { role: 'member' });
  r.add('GET', '/api/github/branches', async ({ who, query }) => {
    const token = tokenOr400(who.user);
    const repo = v.repo(query.get('repo'));
    try { return ok(await github.branches(token, repo)); } catch (e) { throw new HttpError(502, e.message); }
  }, { role: 'member' });
  r.add('GET', '/api/github/head', async ({ who, query }) => {
    const token = tokenOr400(who.user);
    const repo = v.repo(query.get('repo'));
    const branch = v.branch(query.get('branch') || 'main');
    try { return ok(await github.head(token, repo, branch)); } catch (e) { throw new HttpError(502, e.message); }
  }, { role: 'member' });

  // ── créer un service ────────────────────────────────────────────────────
  /** Les champs communs à la création d'un service d'application ou de tâche. */
  function serviceFields(body, { kind }) {
    const source = v.oneOf(body.source || (body.image ? 'image' : 'repo'), ['repo', 'image'], 'source');
    const f = {
      name: v.name(body.name, 'nom du service'),
      kind,
      source_kind: source,
      port: v.port(body.port ?? (kind === 'cron' ? 1 : 3000)),
      healthcheck_path: kind === 'cron' ? null : v.healthPath(body.healthcheck_path ?? null),
      auto_deploy: body.auto_deploy !== false,
      memory_mb: body.memory_mb == null ? null : v.positive(body.memory_mb, 'mémoire', 65536),
      cpus: body.cpus == null ? null : v.positive(body.cpus, 'cpus', 64),
      volume_path: body.volume_path ? v.absPath(body.volume_path, 'point de montage') : null,
      start_command: commande(body.start_command, 'commande de démarrage'),
      cron_schedule: kind === 'cron' ? cron(body.cron_schedule) : null,
      repo: '', branch: '', root_dir: '.',
    };
    if (kind === 'cron' && !f.cron_schedule) throw new HttpError(400, 'une tâche planifiée a besoin de sa planification (ex. 0 3 * * *)');
    if (source === 'image') {
      f.base_image = v.image(body.image || body.base_image || '');
    } else {
      f.repo = v.repo(body.repo);
      f.branch = v.branch(body.branch || 'main');
      f.root_dir = v.relPath(body.root_dir ?? '.', 'dossier racine');
      f.dockerfile_path = body.dockerfile_path ? v.relPath(body.dockerfile_path, 'Dockerfile') : null;
      f.build_command = commande(body.build_command, 'commande de construction');
      f.watch_paths = watchPaths(body.watch_paths);
      f.github_token = body.github_token || null;
    }
    return f;
  }

  /** L'environnement visé par la création : celui demandé, sinon « production ». */
  function targetEnv(project, body) {
    if (body.environment_id) {
      const e = H.envOr404(body.environment_id);
      if (e.project_id !== project.id) throw new HttpError(400, 'cet environnement appartient à un autre projet');
      return e;
    }
    if (body.environment) {
      const e = store.findEnvironment(project.id, String(body.environment));
      if (!e) throw new HttpError(404, `environnement « ${body.environment} » introuvable dans ce projet`);
      return e;
    }
    return store.findEnvironment(project.id, PRODUCTION) ?? store.listEnvironments(project.id)[0];
  }

  /** Crée le service, son domaine et ses variables, puis (si demandé) déploie. */
  function createService(project, env, fields, { vars = {}, deploy = false, ev }) {
    const svc = store.tx(() => {
      const s = store.createService(project.id, { ...fields, environment_id: env.id });
      if (Object.keys(vars).length) store.setVars(s.id, vars);
      if (s.kind === 'app') store.addDomain(s.id, H.hostFor({ service: s.name, project: project.name, environment: env.name }), 'auto');
      return s;
    });
    ev({
      kind: 'service.created', level: 'info', project_id: project.id, service_id: svc.id, subject: svc.name,
      message: `${svc.kind === 'cron' ? 'tâche planifiée' : 'service'} « ${svc.name} » créé dans ${project.name}/${env.name} depuis ${fields.source_kind === 'image' ? fields.base_image : fields.repo}`,
    });
    if (deploy) deployer.deploy(svc.id, { trigger: 'manual' });
    return svc;
  }

  r.add('POST', '/api/projects/:id/services', ({ params, body, ev }) => {
    const project = H.projOr404(params.id);
    const env = targetEnv(project, body);
    const kind = v.oneOf(body.kind || 'app', ['app', 'cron'], 'sorte de service');
    const fields = serviceFields(body, { kind });
    const svc = createService(project, env, fields, { deploy: body.deploy === true, ev });
    return ok(H.publicService(store.getService(svc.id)), 201);
  });

  // ── modèles : une pile entière en un clic ───────────────────────────────
  r.add('GET', '/api/templates', () => ok(templateList()), { role: 'viewer' });
  r.add('POST', '/api/projects/:id/templates', ({ params, body, ev }) => {
    const project = H.projOr404(params.id);
    const env = targetEnv(project, body);
    const tpl = getTemplate(String(body.template || ''));
    if (!tpl) throw new HttpError(404, 'modèle inconnu');
    // Un préfixe permet de déployer deux fois le même modèle dans un projet.
    const prefix = body.prefix ? v.name(body.prefix, 'préfixe') : null;
    const nomDe = (n) => (prefix ? `${prefix}-${n}`.slice(0, 30) : n);
    for (const s of tpl.services) {
      if (store.findEnvService(env.id, nomDe(s.name))) {
        throw new HttpError(409, `un service « ${nomDe(s.name)} » existe déjà dans ${project.name}/${env.name} : donnez un préfixe`);
      }
    }
    const pieces = instantiate(tpl, {
      hostOf: (n) => H.hostFor({ service: nomDe(n), project: project.name, environment: env.name }),
      privateHostOf: (n) => H.privateFor({ service: nomDe(n), project: project.name, environment: env.name }),
      urlOf: (n) => config.urlFor(H.hostFor({ service: nomDe(n), project: project.name, environment: env.name })),
      project: project.name,
      environment: env.name,
    });
    // Les bases d'abord : l'application qui les référence démarre après.
    const ordre = [...pieces].sort((a, b) => (a.spec.engine ? 0 : 1) - (b.spec.engine ? 0 : 1));
    const crees = [];
    for (const piece of ordre) {
      const nom = nomDe(piece.spec.name);
      if (piece.spec.engine) {
        const { fields, vars } = provision({
          engine: piece.spec.engine, name: nom, project: project.name,
          host: H.privateFor({ service: nom, project: project.name, environment: env.name }),
        });
        crees.push(createService(project, env, fields, { vars, deploy: true, ev }));
      } else {
        // Les références « ${{base.CLE}} » du modèle suivent le préfixe.
        const vars = {};
        for (const [k, val] of Object.entries(piece.vars)) {
          vars[k] = prefix ? String(val).replace(/\$\{\{\s*([a-z0-9-]+)\./g, (m, s) => `\${{${nomDe(s)}.`) : val;
        }
        crees.push(createService(project, env, { ...piece.fields, name: nom }, { vars, deploy: true, ev }));
      }
    }
    ev({ kind: 'template.deployed', level: 'info', project_id: project.id, subject: tpl.id, message: `modèle « ${tpl.label} » déployé dans ${project.name}/${env.name} (${crees.length} service(s))` });
    const principal = crees.find((s) => s.kind === 'app') || crees[0];
    return ok({
      template: tpl.id,
      services: crees.map((s) => H.publicService(store.getService(s.id))),
      main: principal ? H.publicService(store.getService(principal.id)) : null,
    }, 201);
  });

  // ── un service ──────────────────────────────────────────────────────────
  r.add('GET', '/api/services', () => ok(store.listServices().map(H.publicService)), { role: 'viewer' });
  r.add('GET', '/api/services/:id', ({ params }) => {
    const s = H.svcOr404(params.id);
    const out = { ...H.publicService(s), variables_have_refs: Object.values(store.getVars(s.id)).some(hasRef) };
    if (s.source_kind === 'repo') out.webhook = { url: H.webhookUrl(s), secret: store.webhookSecret(s.id), content_type: 'application/json', events: ['push'] };
    if (s.kind === 'database') out.engine_info = { ...ENGINES[s.engine], vars: undefined, cmd: undefined, dump: undefined, restore: undefined, query: undefined, client: ENGINES[s.engine]?.client };
    return ok(out);
  }, { role: 'viewer' });

  r.add('PATCH', '/api/services/:id', ({ params, body, ev }) => {
    const s = H.svcOr404(params.id);
    const p = {};
    const commun = () => {
      if ('memory_mb' in body) p.memory_mb = body.memory_mb == null ? null : v.positive(body.memory_mb, 'mémoire', 65536);
      if ('cpus' in body) p.cpus = body.cpus == null ? null : v.positive(body.cpus, 'cpus', 64);
      if ('volume_path' in body) p.volume_path = body.volume_path ? v.absPath(body.volume_path, 'point de montage') : null;
      if ('volume_owner' in body) p.volume_owner = body.volume_owner == null || body.volume_owner === '' ? null : v.positive(body.volume_owner, 'propriétaire du volume', 65535);
      if ('start_command' in body) p.start_command = commande(body.start_command, 'commande de démarrage');
      if ('name' in body && body.name !== s.name) {
        p.name = v.name(body.name, 'nom du service');
        if (store.findEnvService(s.environment_id, p.name)) throw new HttpError(409, 'un service porte déjà ce nom dans cet environnement');
      }
    };
    if (s.kind === 'database') {
      // Une base ne change ni de dépôt ni de port : seulement ses limites, son image, ses sauvegardes.
      commun();
      if ('base_image' in body && body.base_image) p.base_image = v.image(body.base_image);
      if ('backup_schedule' in body) p.backup_schedule = cron(body.backup_schedule, 'planification des sauvegardes');
      if ('backup_keep' in body) p.backup_keep = body.backup_keep == null ? null : v.positive(body.backup_keep, 'sauvegardes gardées', 365);
      return ok(H.publicService(store.updateService(params.id, p)));
    }
    commun();
    if ('port' in body) p.port = v.port(body.port);
    if ('healthcheck_path' in body) p.healthcheck_path = v.healthPath(body.healthcheck_path);
    if ('auto_deploy' in body) p.auto_deploy = !!body.auto_deploy;
    if ('extra_caps' in body) p.extra_caps = body.extra_caps ? String(body.extra_caps).slice(0, 200) : null;
    if (s.kind === 'cron' && 'cron_schedule' in body) p.cron_schedule = cron(body.cron_schedule);
    if (s.source_kind === 'image') {
      if ('base_image' in body && body.base_image) p.base_image = v.image(body.base_image);
    } else {
      if ('repo' in body) p.repo = v.repo(body.repo);
      if ('branch' in body) p.branch = v.branch(body.branch);
      if ('root_dir' in body) p.root_dir = v.relPath(body.root_dir, 'dossier racine');
      if ('dockerfile_path' in body) p.dockerfile_path = body.dockerfile_path ? v.relPath(body.dockerfile_path, 'Dockerfile') : null;
      if ('build_command' in body) p.build_command = commande(body.build_command, 'commande de construction');
      if ('watch_paths' in body) p.watch_paths = watchPaths(body.watch_paths);
      if ('github_token' in body) p.github_token = body.github_token || null;
    }
    const next = store.tx(() => {
      const apres = store.updateService(params.id, p);
      // Le nom est dans l'adresse : « api-demo.apps… » doit suivre « api » → « api-v2 ».
      // Les domaines personnalisés, eux, appartiennent à qui les a ajoutés : on n'y touche pas.
      if (p.name && apres.kind === 'app') {
        const project = store.getProject(apres.project_id);
        const env = store.getEnvironment(apres.environment_id);
        const voulu = H.hostFor({ service: apres.name, project: project.name, environment: env?.name });
        for (const d of store.listDomains(apres.id)) if (d.kind === 'auto') store.deleteDomain(d.id);
        if (!store.listDomains(apres.id).some((d) => d.hostname === voulu)) store.addDomain(apres.id, voulu, 'auto');
      }
      return apres;
    });
    if (p.name) {
      ev({ kind: 'service.renamed', level: 'warn', project_id: s.project_id, service_id: s.id, subject: next.name, message: `service « ${s.name} » renommé en « ${next.name} » (redéployez pour appliquer : adresse publique et hôte privé changent)` });
    }
    return ok(H.publicService(next));
  });

  r.add('DELETE', '/api/services/:id', async ({ params, query, ev }) => {
    const s = H.svcOr404(params.id);
    await deployer.destroy(params.id, { keepVolume: query.get('keep_volume') === '1' });
    backups?.removeAll(params.id);
    store.deleteService(params.id);
    ev({ kind: 'service.deleted', level: 'warn', project_id: s.project_id, subject: s.name, message: `service « ${s.name} » supprimé` });
    return ok({ deleted: true });
  });

  // ── marche / arrêt ──────────────────────────────────────────────────────
  r.add('POST', '/api/services/:id/stop', async ({ params }) => ok(await deployer.stopService(H.svcOr404(params.id).id)));
  r.add('POST', '/api/services/:id/start', async ({ params }) => {
    try { return ok(await deployer.startService(H.svcOr404(params.id).id)); } catch (e) { throw new HttpError(409, e.message); }
  });
  r.add('POST', '/api/services/:id/restart', async ({ params }) => {
    try { return ok(await deployer.restartService(H.svcOr404(params.id).id)); } catch (e) { throw new HttpError(409, e.message); }
  });

  // ── exposition TCP : une base joignable depuis l'extérieur, en un clic ──
  r.add('POST', '/api/services/:id/expose', ({ params, body, ev }) => {
    const s = H.svcOr404(params.id);
    if (s.kind === 'cron') throw new HttpError(400, 'une tâche planifiée n\'écoute sur aucun port');
    let port;
    if (body.port == null || body.port === '') {
      const pris = new Set(store.usedPublicPorts());
      port = null;
      for (let p = config.tcpPortFrom; p <= config.tcpPortTo; p++) if (!pris.has(p)) { port = p; break; }
      if (!port) throw new HttpError(409, `plus de port libre dans la plage ${config.tcpPortFrom}-${config.tcpPortTo} (RAIL_TCP_PORTS)`);
    } else {
      port = v.port(body.port);
      if (port < config.tcpPortFrom || port > config.tcpPortTo) throw new HttpError(400, `le port doit être entre ${config.tcpPortFrom} et ${config.tcpPortTo} (RAIL_TCP_PORTS)`);
      if (store.usedPublicPorts().includes(port) && s.public_port !== port) throw new HttpError(409, 'ce port est déjà pris par un autre service');
    }
    const next = store.updateService(s.id, { public_port: port });
    ev({ kind: 'service.exposed', level: 'warn', project_id: s.project_id, service_id: s.id, subject: s.name, message: `« ${s.name} » exposé sur le port ${port} de la machine (redéployez pour appliquer)` });
    return ok({ ...H.publicService(next), hint: 'Redéployez le service pour que le port s\'ouvre.' });
  });
  r.add('DELETE', '/api/services/:id/expose', ({ params, ev }) => {
    const s = H.svcOr404(params.id);
    const next = store.updateService(s.id, { public_port: null });
    ev({ kind: 'service.unexposed', level: 'warn', project_id: s.project_id, service_id: s.id, subject: s.name, message: `« ${s.name} » n'est plus exposé (redéployez pour fermer le port)` });
    return ok(H.publicService(next));
  });

  // ── mesures d'un service ────────────────────────────────────────────────
  r.add('GET', '/api/services/:id/status', ({ params }) => {
    const s = H.svcOr404(params.id);
    return ok({ ...H.statusOf(s), desired_state: s.desired_state });
  }, { role: 'viewer' });
  r.add('GET', '/api/services/:id/metrics', ({ params, query }) => {
    const s = H.svcOr404(params.id);
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
  }, { role: 'viewer' });

  // ── variables ───────────────────────────────────────────────────────────
  r.add('GET', '/api/services/:id/variables', ({ params, query }) => {
    const s = H.svcOr404(params.id);
    const propres = store.getVars(s.id);
    if (query.get('resolved') === '1') return ok(deployer.envFor(s));
    if (query.get('inherited') === '1') {
      const partagees = store.getProjectVars(s.environment_id);
      return ok({ own: propres, shared: partagees, effective: { ...partagees, ...propres } });
    }
    return ok(propres);
  }, { role: 'viewer' });
  r.add('PUT', '/api/services/:id/variables', ({ params, body, ev }) => {
    const s = H.svcOr404(params.id);
    const vars = body.variables;
    if (!vars || typeof vars !== 'object' || Array.isArray(vars)) throw new HttpError(400, '« variables » doit être un objet {NOM: valeur}');
    const clean = {};
    for (const [k, val] of Object.entries(vars)) clean[v.envKey(k)] = v.envValue(val);
    if (Object.keys(clean).length > 500) throw new HttpError(400, '500 variables au plus par service');
    store.tx(() => {
      if (body.replace === true) for (const k of Object.keys(store.getVars(s.id))) if (!(k in clean)) store.deleteVar(s.id, k);
      store.setVars(s.id, clean);
    });
    ev({ kind: 'service.variables', level: 'info', project_id: s.project_id, service_id: s.id, subject: s.name, message: `variables de « ${s.name} » modifiées (${Object.keys(clean).length})` });
    return ok(store.getVars(params.id));
  });
  r.add('DELETE', '/api/services/:id/variables/:key', ({ params }) => {
    H.svcOr404(params.id);
    if (!store.deleteVar(params.id, params.key)) throw new HttpError(404, 'variable introuvable');
    return ok({ deleted: true });
  });

  // ── domaines ────────────────────────────────────────────────────────────
  r.add('POST', '/api/services/:id/domains', ({ params, body, ev }) => {
    const s = H.svcOr404(params.id);
    if (s.kind !== 'app') throw new HttpError(400, 'seul un service web s\'expose sur un nom de domaine');
    const host = v.hostname(body.hostname);
    if (host === config.dashboardHost) throw new HttpError(400, 'ce nom est réservé au tableau de bord');
    const d = store.addDomain(params.id, host, host.endsWith(`.${config.domain}`) ? 'auto' : 'custom');
    ev({ kind: 'domain.added', level: 'info', project_id: s.project_id, service_id: s.id, subject: host, message: `domaine ${host} ajouté à « ${s.name} » (redéployez pour l'appliquer)` });
    return ok({ ...d, url: config.urlFor(d.hostname) }, 201);
  });
  r.add('DELETE', '/api/services/:id/domains/:domainId', ({ params, ev }) => {
    const s = H.svcOr404(params.id);
    const d = store.getDomain(params.domainId);
    if (!d || d.service_id !== params.id) throw new HttpError(404, 'domaine introuvable');
    store.deleteDomain(d.id);
    ev({ kind: 'domain.removed', level: 'warn', project_id: s.project_id, service_id: s.id, subject: d.hostname, message: `domaine ${d.hostname} retiré de « ${s.name} »` });
    return ok({ deleted: true });
  });

  // ── déploiements ────────────────────────────────────────────────────────
  r.add('GET', '/api/services/:id/deployments', ({ params }) => ok(store.listDeployments(H.svcOr404(params.id).id)), { role: 'viewer' });
  r.add('POST', '/api/services/:id/deploy', ({ params, body }) => {
    H.svcOr404(params.id);
    return ok(deployer.deploy(params.id, { trigger: 'manual', sha: body.sha ? v.sha(body.sha) : null }), 202);
  });
  r.add('POST', '/api/services/:id/redeploy', ({ params }) => {
    H.svcOr404(params.id);
    try { return ok(deployer.redeploy(params.id), 202); } catch (e) { throw new HttpError(409, e.message); }
  });
  r.add('GET', '/api/deployments/:id', ({ params }) => ok(H.depOr404(params.id)), { role: 'viewer' });
  r.add('POST', '/api/deployments/:id/rollback', ({ params }) => {
    H.depOr404(params.id);
    try { return ok(deployer.rollback(params.id), 202); } catch (e) { throw new HttpError(409, e.message); }
  });
  r.add('POST', '/api/deployments/:id/cancel', ({ params }) => {
    H.depOr404(params.id);
    return ok({ canceled: deployer.cancel(params.id) });
  });
  // Journal de construction : texte brut ; `?follow=1` garde la connexion jusqu'à la fin du déploiement.
  r.add('GET', '/api/deployments/:id/logs', ({ params, query, req, res }) => {
    H.depOr404(params.id);
    if (!query.get('follow')) return ok(logs.read(params.id));
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'x-accel-buffering': 'no' });
    const stop = logs.follow(params.id, (t) => t && res.write(t), () => res.end());
    req.on('close', stop);
    return STREAMED;
  }, { role: 'viewer' });
  // Journal d'exécution du conteneur en service.
  r.add('GET', '/api/services/:id/logs', async ({ params, query, req, res }) => {
    const s = H.svcOr404(params.id);
    const container = H.activeContainer(s);
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
  }, { role: 'viewer' });

  // ── tâches planifiées : exécuter maintenant, historique ─────────────────
  r.add('GET', '/api/services/:id/runs', ({ params, query }) => {
    const s = H.svcOr404(params.id);
    return ok({
      schedule: s.cron_schedule,
      words: s.cron_schedule ? cronWords(s.cron_schedule) : null,
      next: s.cron_schedule && cronValid(s.cron_schedule) ? (cronNext(s.cron_schedule)?.toISOString() ?? null) : null,
      runs: store.listRuns(s.id, Number(query.get('limit')) || 30),
    });
  }, { role: 'viewer' });
  r.add('POST', '/api/services/:id/run', ({ params }) => {
    const s = H.svcOr404(params.id);
    try { return ok(deployer.runJob(s.id, { trigger: 'manual' }), 202); } catch (e) { throw new HttpError(409, e.message); }
  });

  // ── webhook GitHub ──────────────────────────────────────────────────────
  r.add('POST', '/api/services/:id/webhook/install', async ({ params, who }) => {
    const s = H.svcOr404(params.id);
    if (s.source_kind !== 'repo') throw new HttpError(400, 'ce service ne vient pas d\'un dépôt GitHub');
    const token = H.githubTokenFor(who.user, s);
    if (!token) throw new HttpError(400, 'un jeton GitHub (droit « Webhooks: write ») est nécessaire : reliez votre compte GitHub');
    try {
      const id = await github.installWebhook({ token, repo: s.repo, url: H.webhookUrl(s), secret: store.webhookSecret(s.id) });
      return ok({ installed: true, hook_id: id, url: H.webhookUrl(s) });
    } catch (e) { throw new HttpError(502, e.message); }
  });

  // Authentifié par la signature du corps, pas par un jeton : c'est GitHub qui appelle.
  r.add('POST', '/webhooks/github/:id', ({ params, headers, raw }) => {
    const s = store.getService(params.id);
    // Même réponse que le service existe ou non : on ne dit pas quels identifiants sont valides.
    if (!s || s.source_kind !== 'repo' || !verifySignature(raw, headers['x-hub-signature-256'], store.webhookSecret(s.id))) throw new HttpError(401, 'signature invalide');
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
    // Monodépôt : ne reconstruire que si le push touche les chemins surveillés.
    if (s.watch_paths && push.files?.length) {
      const surveilles = s.watch_paths.split('\n').filter(Boolean);
      const concerne = push.files.some((f) => surveilles.some((w) => (w === '.' ? true : f === w || f.startsWith(`${w}/`))));
      if (!concerne) {
        store.addEvent({
          kind: 'deployment.skipped', level: 'info', project_id: s.project_id, service_id: s.id, subject: s.name, actor: 'github',
          message: `${s.name} : push ignoré (aucun fichier dans ${surveilles.join(', ')})`,
        });
        return ok({ ignored: 'aucun chemin surveillé touché', watch_paths: surveilles });
      }
    }
    const dep = deployer.deploy(s.id, { trigger: 'push', sha: v.sha(push.sha), message: push.message });
    return ok({ deployment: dep.id, number: dep.number }, 202);
  }, { public: true, rawBody: true });
}
