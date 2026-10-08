// Le coeur : transformer « un commit » en « un conteneur sain qui reçoit le trafic ».
//
//   file d'attente (un déploiement à la fois par service)
//     → récupérer le code → construire l'image → démarrer le nouveau conteneur
//     → attendre qu'il soit sain → basculer la route → arrêter l'ancien
//
// Si une étape échoue, l'ancien conteneur n'a jamais été touché : le service n'a pas bougé.
import fs from 'node:fs';
import path from 'node:path';
import { fetchSource } from './source.js';
import { detectBuild, materialize } from './detect.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => new Date().toISOString();
const TERMINAL = new Set(['success', 'failed', 'canceled', 'skipped', 'removed']);

class Canceled extends Error {}

class Semaphore {
  constructor(n) { this.n = n; this.q = []; }
  async acquire() { if (this.n > 0) { this.n--; return; } await new Promise((r) => this.q.push(r)); }
  release() { const next = this.q.shift(); if (next) next(); else this.n++; }
}

export class Deployer {
  constructor({ store, runtime, routes, logs, github, config, source = fetchSource }) {
    Object.assign(this, { store, runtime, routes, logs, github, config, source });
    this.chains = new Map();   // serviceId → promesse de la file
    this.running = new Map();  // deploymentId → AbortController
    this.builds = new Semaphore(config.maxBuilds);
  }

  // ── points d'entrée ──
  /** Nouveau déploiement depuis GitHub (push, ou clic « Déployer »). */
  deploy(serviceId, { trigger = 'manual', sha = null, message = null } = {}) {
    return this.#enqueue(serviceId, { trigger, commit_sha: sha, commit_message: message });
  }
  /** Relance l'image en service avec la configuration actuelle (variables, domaines…), sans reconstruire. */
  redeploy(serviceId) {
    if (!this.store.getService(serviceId)) throw new Error('service inconnu');
    const active = this.#active(serviceId);
    if (!active) throw new Error('aucun déploiement en service à relancer');
    return this.#enqueue(serviceId, { trigger: 'redeploy', commit_sha: active.commit_sha, commit_message: active.commit_message, image: active.image });
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
  /** Retire un service de la machine : conteneurs, route, images. */
  async destroy(serviceId) {
    for (const d of this.store.listDeployments(serviceId, 1000)) this.cancel(d.id);
    await this.chains.get(serviceId)?.catch(() => {});
    this.routes.remove(serviceId);
    for (const c of await this.runtime.containersOf(serviceId)) await this.runtime.stop(c, 10);
    for (const d of this.store.listDeployments(serviceId, 1000)) if (d.image?.startsWith('rail/')) await this.runtime.removeImage(d.image);
  }

  // ── démarrage : réconcilier ce qu'un redémarrage a interrompu ──
  async reconcile() {
    for (const d of this.store.deploymentsWithStatus('queued', 'building', 'deploying')) {
      this.store.updateDeployment(d.id, { status: 'failed', error: 'interrompu par le redémarrage du plan de contrôle', finished_at: now() });
    }
    // Les routes se réécrivent depuis la base : le volume Traefik n'est qu'un cache.
    for (const svc of this.store.listServices()) {
      const active = svc.active_deployment_id && this.store.getDeployment(svc.active_deployment_id);
      if (active?.container && (await this.runtime.state(active.container)) === 'running') this.#route(svc, active.container);
    }
  }

  // ── file d'attente ──
  #enqueue(serviceId, f) {
    const svc = this.store.getService(serviceId);
    if (!svc) throw new Error('service inconnu');
    // Un déploiement plus récent remplace ceux qui attendent encore.
    for (const q of this.store.deploymentsWithStatus('queued')) {
      if (q.service_id === serviceId) this.#finish(q, 'skipped', 'remplacé par un déploiement plus récent');
    }
    const dep = this.store.createDeployment(serviceId, f);
    this.logs.begin(dep.id);
    this.logs.line(dep.id, `Déploiement #${dep.number} en file d'attente (${f.trigger})`);
    const prev = this.chains.get(serviceId) || Promise.resolve();
    const next = prev.catch(() => {}).then(() => this.#execute(dep.id));
    this.chains.set(serviceId, next);
    next.finally(() => { if (this.chains.get(serviceId) === next) this.chains.delete(serviceId); }).catch(() => {});
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

  // ── un déploiement, de bout en bout ──
  async #execute(depId) {
    let dep = this.store.getDeployment(depId);
    if (TERMINAL.has(dep.status)) return;
    const svc = this.store.getService(dep.service_id);
    if (!svc) return this.#finish(dep, 'canceled', 'service supprimé');
    const ac = new AbortController();
    this.running.set(depId, ac);
    const log = (t) => this.logs.append(depId, t);
    const say = (t) => this.logs.line(depId, t);
    const token = this.store.githubToken(svc.id) || this.config.defaultGithubToken;
    const buildDir = path.join(this.config.buildsDir, depId);
    let container = null;
    let semaphoreHeld = false;
    try {
      dep = this.store.updateDeployment(depId, { status: 'building', started_at: now() });
      let image = dep.image;
      if (image) {
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
      await this.runtime.stop(container, 1); // reste d'une tentative précédente
      say(`→ Démarrage de ${container}`);
      await this.runtime.start({
        name: container, image, env: this.#env(svc, project, dep),
        labels: { 'rail.managed': 'true', 'rail.service': svc.id, 'rail.deployment': dep.id },
        memoryMb: svc.memory_mb || this.config.defaultMemoryMb, cpus: svc.cpus || this.config.defaultCpus,
        alias: `${svc.name}.${project.name}.internal`,
      });
      this.store.updateDeployment(depId, { container });
      await this.#waitHealthy(svc, container, depId, ac.signal, say);

      // ── basculer ──
      const previous = this.#active(svc.id);
      this.#route(svc, container);
      this.store.updateService(svc.id, { active_deployment_id: dep.id });
      say(`✓ En service sur ${this.store.listDomains(svc.id).map((d) => `https://${d.hostname}`).join(', ') || '(aucun domaine)'}`);
      this.#finish(dep, 'success'); // en dernier : après, le journal est clos pour ceux qui le suivent
      this.#status(svc, dep, 'success', `Déployé (#${dep.number})`);
      if (previous && previous.id !== dep.id) await this.#retire(previous);
      await this.#cleanup(svc);
    } catch (e) {
      const canceled = e instanceof Canceled || ac.signal.aborted;
      if (container) await this.runtime.stop(container, 1);
      const fresh = this.store.getDeployment(depId);
      if (fresh && !TERMINAL.has(fresh.status)) {
        const reason = e?.message || String(e);
        this.#finish(fresh, canceled ? 'canceled' : 'failed', canceled ? 'annulé' : reason);
        this.#status(svc, fresh, canceled ? 'error' : 'failure', canceled ? 'Annulé' : reason);
      }
    } finally {
      if (semaphoreHeld) this.builds.release();
      this.running.delete(depId);
      fs.rmSync(buildDir, { recursive: true, force: true });
    }
  }

  #env(svc, project, dep) {
    return {
      ...this.store.getVars(svc.id),
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
