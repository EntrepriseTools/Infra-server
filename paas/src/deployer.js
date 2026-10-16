// Le coeur : transformer « un commit » (ou « une image de base ») en « un conteneur
// sain qui reçoit le trafic ».
//
//   file d'attente (une opération à la fois par service)
//     → récupérer le code → construire l'image → démarrer le nouveau conteneur
//     → attendre qu'il soit sain → basculer la route → arrêter l'ancien
//
// Si une étape échoue, l'ancien conteneur n'a jamais été touché : le service n'a pas bougé.
// (Exception assumée : un service à volume persistant ne peut pas tourner en double —
//  l'ancien est arrêté avant, et remis en marche si le nouveau échoue.)
import fs from 'node:fs';
import path from 'node:path';
import { fetchSource } from './source.js';
import { detectBuild, materialize } from './detect.js';
import { engineCmd, DB_CAPS } from './databases.js';
import { resolveRefs } from './vars.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => new Date().toISOString();
const TERMINAL = new Set(['success', 'failed', 'canceled', 'skipped', 'removed']);

export const volumeName = (serviceId) => `rail-vol-${serviceId}`;

class Canceled extends Error {}

class Semaphore {
  constructor(n) { this.n = n; this.q = []; }
  async acquire() { if (this.n > 0) { this.n--; return; } await new Promise((r) => this.q.push(r)); }
  release() { const next = this.q.shift(); if (next) next(); else this.n++; }
}

export class Deployer {
  constructor({ store, runtime, routes, logs, github, config, notifier = null, source = fetchSource }) {
    Object.assign(this, { store, runtime, routes, logs, github, config, notifier, source });
    this.chains = new Map();   // serviceId → promesse de la file
    this.running = new Map();  // deploymentId → AbortController
    this.builds = new Semaphore(config.maxBuilds);
  }

  // ── points d'entrée ──
  /** Nouveau déploiement depuis GitHub (push, ou clic « Déployer »). */
  deploy(serviceId, { trigger = 'manual', sha = null, message = null } = {}) {
    const svc = this.store.getService(serviceId);
    if (!svc) throw new Error('service inconnu');
    // Une base de données n'a pas de dépôt : son « déploiement » est son image officielle.
    if (svc.kind === 'database') return this.#enqueue(serviceId, { trigger, image: svc.base_image });
    return this.#enqueue(serviceId, { trigger, commit_sha: sha, commit_message: message });
  }
  /** Relance l'image en service avec la configuration actuelle (variables, domaines…), sans reconstruire. */
  redeploy(serviceId) {
    const svc = this.store.getService(serviceId);
    if (!svc) throw new Error('service inconnu');
    const active = this.#active(serviceId);
    if (!active && svc.kind !== 'database') throw new Error('aucun déploiement en service à relancer');
    return this.#enqueue(serviceId, {
      trigger: 'redeploy',
      commit_sha: active?.commit_sha ?? null,
      commit_message: active?.commit_message ?? null,
      image: active?.image || svc.base_image,
    });
  }
  /** Retour arrière : remet l'image d'un déploiement passé, sans reconstruire. */
  rollback(deploymentId) {
    const d = this.store.getDeployment(deploymentId);
    if (!d || !d.image || !['success', 'removed'].includes(d.status)) throw new Error('ce déploiement n\'a pas d\'image réutilisable');
    return this.#enqueue(d.service_id, { trigger: 'rollback', commit_sha: d.commit_sha, commit_message: d.commit_message, image: d.image });
  }
  cancel(deploymentId) {
    const d = this.store.getDeployment(deploymentId);
    if (!d || TERMINAL.has(d.status)) return false;
    const ac = this.running.get(deploymentId);
    if (ac) ac.abort(); else this.#finish(d, 'canceled', 'annulé avant de démarrer');
    return true;
  }

  // ── marche / arrêt (sans redéployer) ──
  /** Un déploiement est-il en cours ou en attente pour ce service ? */
  #busy(serviceId) {
    return this.store.deploymentsWithStatus('queued', 'building', 'deploying').some((d) => d.service_id === serviceId);
  }
  /**
   * Arrête le conteneur et retire la route : le service répond 404, son image reste.
   * Un déploiement en cours est annulé — « arrêter » veut dire arrêter, pas « faire la queue
   * derrière une construction de cinq minutes ».
   */
  async stopService(serviceId) {
    const svc = this.store.getService(serviceId);
    if (!svc) throw new Error('service inconnu');
    for (const d of this.store.deploymentsWithStatus('queued', 'building', 'deploying')) {
      if (d.service_id === serviceId) this.cancel(d.id);
    }
    this.store.updateService(serviceId, { desired_state: 'stopped' });
    const active = this.#active(serviceId);
    await this.#chain(serviceId, async () => {
      this.routes.remove(serviceId);
      if (active?.container) await this.runtime.halt(active.container, 30);
    });
    this.#event(svc, 'service.stopped', 'info', `${svc.name} a été arrêté`);
    return { state: 'stopped' };
  }
  /** Remet le conteneur en marche (ou relance l'image s'il a disparu). */
  async startService(serviceId) {
    const svc = this.store.getService(serviceId);
    if (!svc) throw new Error('service inconnu');
    if (this.#busy(serviceId)) throw new Error('un déploiement est en cours : attendez qu\'il se termine');
    const active = this.#active(serviceId);
    this.store.updateService(serviceId, { desired_state: 'running' });
    const exists = active?.container ? await this.runtime.state(active.container) : null;
    if (!exists) {
      if (!active && svc.kind !== 'database') throw new Error('aucun déploiement à démarrer : déployez d\'abord');
      this.#event(svc, 'service.started', 'info', `${svc.name} redémarre (le conteneur avait disparu)`);
      return { deployment: this.redeploy(serviceId) };
    }
    await this.#chain(serviceId, async () => {
      await this.runtime.resume(active.container);
      if (svc.kind !== 'database') this.#route(svc, active.container);
    });
    this.#event(svc, 'service.started', 'info', `${svc.name} a été démarré`);
    return { state: 'running' };
  }
  /** Redémarre le conteneur en place : même image, mêmes variables, quelques secondes. */
  async restartService(serviceId) {
    const svc = this.store.getService(serviceId);
    if (!svc) throw new Error('service inconnu');
    if (this.#busy(serviceId)) throw new Error('un déploiement est en cours : attendez qu\'il se termine');
    const active = this.#active(serviceId);
    if (!active?.container) return this.startService(serviceId);
    this.store.updateService(serviceId, { desired_state: 'running' });
    await this.#chain(serviceId, () => this.runtime.restart(active.container, 30));
    this.#event(svc, 'service.restarted', 'info', `${svc.name} a été redémarré`);
    return { state: 'running' };
  }

  /** Retire un service de la machine : conteneurs, route, images, volume. */
  async destroy(serviceId, { keepVolume = false } = {}) {
    const svc = this.store.getService(serviceId);
    for (const d of this.store.listDeployments(serviceId, 1000)) this.cancel(d.id);
    await this.chains.get(serviceId)?.catch(() => {});
    this.routes.remove(serviceId);
    for (const c of await this.runtime.containersOf(serviceId)) await this.runtime.stop(c, 10);
    for (const d of this.store.listDeployments(serviceId, 1000)) if (d.image?.startsWith('rail/')) await this.runtime.removeImage(d.image);
    if (svc?.volume_path && !keepVolume) await this.runtime.volumeRemove(volumeName(serviceId));
  }

  // ── démarrage : réconcilier ce qu'un redémarrage a interrompu ──
  async reconcile() {
    for (const d of this.store.deploymentsWithStatus('queued', 'building', 'deploying')) {
      this.store.updateDeployment(d.id, { status: 'failed', error: 'interrompu par le redémarrage du plan de contrôle', finished_at: now() });
    }
    // Les routes se réécrivent depuis la base : le volume Traefik n'est qu'un cache.
    for (const svc of this.store.listServices()) {
      const active = svc.active_deployment_id && this.store.getDeployment(svc.active_deployment_id);
      if (!active?.container || svc.desired_state === 'stopped') continue;
      let state = await this.runtime.state(active.container);
      // Après un redémarrage de l'hôte, un conteneur peut être resté sur le carreau.
      if (state && state !== 'running') { await this.runtime.resume(active.container); state = await this.runtime.state(active.container); }
      if (state === 'running' && svc.kind !== 'database') this.#route(svc, active.container);
    }
  }

  // ── file d'attente ──
  /** Enchaîne une opération sur la file du service : jamais deux choses à la fois sur un même service. */
  #chain(serviceId, fn) {
    const prev = this.chains.get(serviceId) || Promise.resolve();
    const next = prev.catch(() => {}).then(fn);
    this.chains.set(serviceId, next);
    next.finally(() => { if (this.chains.get(serviceId) === next) this.chains.delete(serviceId); }).catch(() => {});
    return next;
  }
  #enqueue(serviceId, f) {
    const svc = this.store.getService(serviceId);
    if (!svc) throw new Error('service inconnu');
    // Un déploiement plus récent remplace ceux qui attendent encore.
    for (const q of this.store.deploymentsWithStatus('queued')) {
      if (q.service_id === serviceId) this.#finish(q, 'skipped', 'remplacé par un déploiement plus récent');
    }
    if (svc.desired_state === 'stopped') this.store.updateService(serviceId, { desired_state: 'running' });
    const dep = this.store.createDeployment(serviceId, f);
    this.logs.begin(dep.id);
    this.logs.line(dep.id, `Déploiement #${dep.number} en file d'attente (${f.trigger})`);
    this.#chain(serviceId, () => this.#execute(dep.id));
    return dep;
  }
  /** Résolu quand la file du service est vide (tests, arrêt propre). */
  async idle(serviceId) { while (this.chains.has(serviceId)) await this.chains.get(serviceId).catch(() => {}); }
  async drain() { while (this.chains.size) await Promise.allSettled([...this.chains.values()]); }

  #active(serviceId) {
    const id = this.store.getService(serviceId)?.active_deployment_id;
    return id ? this.store.getDeployment(id) : null;
  }
  #finish(dep, status, error = null) {
    this.store.updateDeployment(dep.id, { status, error, finished_at: now() });
    this.logs.line(dep.id, error ? `✗ ${status} : ${error}` : `✓ ${status}`);
    this.logs.end(dep.id);
  }
  #route(svc, container) {
    const hosts = this.store.listDomains(svc.id).map((d) => d.hostname);
    this.routes.set(svc.id, { hosts, upstream: `http://${container}:${svc.port}` });
  }
  #event(svc, kind, level, message, deploymentId = null) {
    this.store.addEvent({ kind, level, project_id: svc.project_id, service_id: svc.id, deployment_id: deploymentId, subject: svc.name, message });
  }

  // ── un déploiement, de bout en bout ──
  async #execute(depId) {
    let dep = this.store.getDeployment(depId);
    if (TERMINAL.has(dep.status)) return;
    const svc = this.store.getService(dep.service_id);
    if (!svc) return this.#finish(dep, 'canceled', 'service supprimé');
    const isDb = svc.kind === 'database';
    const ac = new AbortController();
    this.running.set(depId, ac);
    const log = (t) => this.logs.append(depId, t);
    const say = (t) => this.logs.line(depId, t);
    const token = this.store.githubToken(svc.id) || this.config.defaultGithubToken;
    const buildDir = path.join(this.config.buildsDir, depId);
    const previous = this.#active(svc.id);
    // Un volume ne se partage pas : la nouvelle version ne peut pas tourner à côté de l'ancienne.
    const exclusive = !!svc.volume_path && !!previous?.container;
    let container = null;
    let halted = false;
    let semaphoreHeld = false;
    try {
      dep = this.store.updateDeployment(depId, { status: 'building', started_at: now() });
      let image = dep.image;
      if (isDb) {
        image = image || svc.base_image;
        say(`Base de données ${svc.engine} — image ${image}`);
        if (!(await this.runtime.imageExists(image))) {
          say('→ Téléchargement de l\'image');
          await this.runtime.pull({ image, onLog: log, signal: ac.signal, timeoutMs: this.config.buildTimeoutMs });
        }
        this.store.updateDeployment(depId, { image });
      } else if (image) {
        this.#status(svc, dep, 'pending', 'Déploiement en cours');
        say(`Réutilisation de l'image ${image} (aucune reconstruction)`);
        if (!(await this.runtime.imageExists(image))) throw new Error(`l'image ${image} n'existe plus sur ce serveur`);
      } else {
        await this.builds.acquire(); semaphoreHeld = true;
        if (ac.signal.aborted) throw new Canceled();
        const src = await this.source({ gitBase: this.config.gitBase, repo: svc.repo, branch: svc.branch, sha: dep.commit_sha, token, dir: buildDir, onLog: log, signal: ac.signal });
        dep = this.store.updateDeployment(depId, { commit_sha: src.sha, commit_message: dep.commit_message || src.message });
        say(`Commit ${src.sha.slice(0, 10)} — ${dep.commit_message}`);
        this.#status(svc, dep, 'pending', 'Construction en cours');
        const ctx = path.join(buildDir, svc.root_dir);
        if (!fs.existsSync(ctx)) throw new Error(`le dossier « ${svc.root_dir} » n'existe pas dans le dépôt`);
        const plan = detectBuild(ctx, { dockerfilePath: svc.dockerfile_path });
        say(plan.kind === 'dockerfile' ? '→ Dockerfile du dépôt' : `→ Aucun Dockerfile : construction automatique (${plan.language})`);
        image = `rail/${svc.id}:${dep.number}`;
        await this.runtime.build({
          contextDir: ctx, dockerfile: materialize(ctx, plan), tag: image,
          labels: { 'rail.service': svc.id, 'rail.commit': src.sha }, onLog: log, signal: ac.signal, timeoutMs: this.config.buildTimeoutMs,
        });
        this.builds.release(); semaphoreHeld = false;
        fs.rmSync(buildDir, { recursive: true, force: true });
        dep = this.store.updateDeployment(depId, { image });
      }
      if (ac.signal.aborted) throw new Canceled();

      // ── démarrer, vérifier ──
      dep = this.store.updateDeployment(depId, { status: 'deploying' });
      container = `rail-${svc.id}-${dep.number}`;
      const project = this.store.getProject(svc.project_id);
      const env = this.#env(svc, project, dep);
      await this.runtime.stop(container, 1); // reste d'une tentative précédente
      if (exclusive) {
        say(`→ Arrêt de la version précédente (volume persistant : une seule à la fois, courte interruption)`);
        halted = await this.runtime.halt(previous.container, 30);
      }
      say(`→ Démarrage de ${container}`);
      await this.runtime.start({
        name: container, image, env,
        labels: { 'rail.managed': 'true', 'rail.service': svc.id, 'rail.deployment': dep.id, 'rail.kind': svc.kind },
        memoryMb: svc.memory_mb || this.config.defaultMemoryMb, cpus: svc.cpus || this.config.defaultCpus,
        alias: `${svc.name}.${project.name}.internal`,
        volumes: svc.volume_path ? [{ name: volumeName(svc.id), path: svc.volume_path }] : [],
        cmd: isDb ? engineCmd(svc.engine, env) : null,
        caps: isDb ? DB_CAPS : [],
        logMaxSizeMb: this.config.logMaxSizeMb, logMaxFiles: this.config.logMaxFiles,
      });
      this.store.updateDeployment(depId, { container });
      await this.#waitHealthy(svc, container, depId, ac.signal, say);

      // ── basculer ──
      if (isDb) say(`✓ Disponible sur ${svc.name}.${project.name}.internal:${svc.port} (réseau privé)`);
      else {
        this.#route(svc, container);
        say(`✓ En service sur ${this.store.listDomains(svc.id).map((d) => this.config.urlFor(d.hostname)).join(', ') || '(aucun domaine)'}`);
      }
      this.store.updateService(svc.id, { active_deployment_id: dep.id });
      this.#finish(dep, 'success'); // en dernier : après, le journal est clos pour ceux qui le suivent
      this.#status(svc, dep, 'success', `Déployé (#${dep.number})`);
      this.#event(svc, 'deployment.success', 'info', `${svc.name} : déploiement #${dep.number} en service${dep.commit_sha ? ` (${dep.commit_sha.slice(0, 7)})` : ''}`, dep.id);
      if (this.config.notifySuccess) {
        this.notifier?.send({ level: 'info', title: `${svc.name} déployé (#${dep.number})`, text: dep.commit_message || '', service: svc.name, url: `${this.config.publicUrl}/#/services/${svc.id}` });
      }
      if (previous && previous.id !== dep.id) await this.#retire(previous);
      await this.#cleanup(svc);
    } catch (e) {
      const canceled = e instanceof Canceled || ac.signal.aborted;
      if (container) await this.runtime.stop(container, 1);
      if (halted) { say('→ Remise en marche de la version précédente'); await this.runtime.resume(previous.container); }
      const fresh = this.store.getDeployment(depId);
      if (fresh && !TERMINAL.has(fresh.status)) {
        const reason = e?.message || String(e);
        this.#finish(fresh, canceled ? 'canceled' : 'failed', canceled ? 'annulé' : reason);
        this.#status(svc, fresh, canceled ? 'error' : 'failure', canceled ? 'Annulé' : reason);
        this.#event(svc, canceled ? 'deployment.canceled' : 'deployment.failed', canceled ? 'warn' : 'error',
          `${svc.name} : déploiement #${fresh.number} ${canceled ? 'annulé' : `en échec — ${reason}`}`, fresh.id);
        if (!canceled) {
          this.notifier?.send({ level: 'error', title: `${svc.name} : déploiement #${fresh.number} en échec`, text: reason, service: svc.name, url: `${this.config.publicUrl}/#/services/${svc.id}` });
        }
      }
    } finally {
      if (semaphoreHeld) this.builds.release();
      this.running.delete(depId);
      fs.rmSync(buildDir, { recursive: true, force: true });
    }
  }

  /** Les variables du service, références « ${{autre-service.CLE}} » résolues, plus celles de la plateforme. */
  #env(svc, project, dep) {
    const vars = resolveRefs(
      this.store.getVars(svc.id),
      (name, key) => {
        const other = this.store.findService(project.name, name);
        return other ? this.store.getVars(other.id)[key] : undefined;
      },
      (w) => this.logs.line(dep.id, `⚠ ${w}`),
    );
    return {
      ...vars,
      PORT: String(svc.port),
      RAIL_PROJECT_NAME: project.name,
      RAIL_SERVICE_NAME: svc.name,
      RAIL_DEPLOYMENT_ID: dep.id,
      RAIL_GIT_COMMIT_SHA: dep.commit_sha || '',
      RAIL_PRIVATE_DOMAIN: `${svc.name}.${project.name}.internal`,
      RAIL_PUBLIC_DOMAIN: this.store.listDomains(svc.id)[0]?.hostname || '',
    };
  }

  async #waitHealthy(svc, container, depId, signal, say) {
    const deadline = Date.now() + this.config.healthTimeoutMs;
    say(`→ Attente de la santé (${svc.healthcheck_path ? `GET ${svc.healthcheck_path}` : `TCP :${svc.port}`}, ${this.config.healthTimeoutMs / 1000}s max)`);
    const fail = async (why) => {
      let out = '';
      await this.runtime.logs(container, { tail: 30, onData: (t) => { out += t; } }).catch(() => {});
      if (out) this.logs.append(depId, `--- derniers logs du conteneur ---\n${out}${out.endsWith('\n') ? '' : '\n'}`);
      throw new Error(why);
    };
    for (;;) {
      if (signal.aborted) throw new Canceled();
      const st = await this.runtime.state(container);
      if (st !== 'running') await fail(`le conteneur s'est arrêté au démarrage (${st ?? 'absent'})`);
      if (await this.runtime.healthcheck({ name: container, port: svc.port, path: svc.healthcheck_path })) { say('✓ Sain'); return; }
      if (Date.now() > deadline) await fail(`pas de réponse saine après ${this.config.healthTimeoutMs / 1000}s`);
      await sleep(this.config.healthIntervalMs ?? 1000);
    }
  }

  async #retire(previous) {
    await sleep(this.config.switchGraceMs); // le temps que Traefik ait rechargé et vidé ses connexions
    if (previous.container) await this.runtime.stop(previous.container, 30);
    this.store.updateDeployment(previous.id, { status: 'removed' });
  }

  /** Garde les images des N derniers déploiements (retours arrière) et celle en service ; supprime le reste. */
  async #cleanup(svc) {
    const all = this.store.listDeployments(svc.id, 1000).filter((d) => d.image?.startsWith('rail/'));
    const keep = new Set(all.slice(0, this.config.keepImages).map((d) => d.image));
    const active = this.#active(svc.id);
    if (active?.image) keep.add(active.image);
    for (const image of new Set(all.map((d) => d.image))) if (!keep.has(image)) await this.runtime.removeImage(image);
  }

  #status(svc, dep, state, description) {
    const token = this.store.githubToken(svc.id) || this.config.defaultGithubToken;
    if (!token || !dep.commit_sha || !this.github) return;
    this.github.commitStatus({ token, repo: svc.repo, sha: dep.commit_sha, state, description, targetUrl: `${this.config.publicUrl}/#/services/${svc.id}` });
  }
}
