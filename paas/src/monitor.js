// La surveillance : à intervalle régulier, on demande à Docker ce que font les
// conteneurs, on en garde une série temporelle (CPU, mémoire, réseau, en ligne
// ou non), et on raconte les changements d'état dans le fil d'activité.
//
// C'est aussi le filet : un conteneur sorti alors qu'on le voulait en marche est
// redémarré (RAIL_AUTO_HEAL), et une alerte part si un webhook est configuré.
import fs from 'node:fs';
import os from 'node:os';

const nowS = () => Math.floor(Date.now() / 1000);

/** Pourcentage d'occupation du processeur de l'hôte entre deux appels. */
function cpuSnapshot() {
  let idle = 0; let total = 0;
  for (const c of os.cpus()) { idle += c.times.idle; total += c.times.user + c.times.nice + c.times.sys + c.times.idle + c.times.irq; }
  return { idle, total };
}

export class Monitor {
  constructor({ store, runtime, config, notifier = null, deployer = null, log = console }) {
    Object.assign(this, { store, runtime, config, notifier, deployer, log });
    this.states = new Map(); // serviceId → { state, since, restarts, health }
    this.host = { cpu: null };
    this.lastCpu = cpuSnapshot();
    this.lastPrune = 0;
    this.timer = null;
    this.ticks = 0;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => { this.tick().catch((e) => this.log.error('[monitor]', e.message)); }, this.config.metricsIntervalMs);
    this.timer.unref?.();
    return this.tick().catch((e) => this.log.error('[monitor]', e.message));
  }
  stop() { clearInterval(this.timer); this.timer = null; }

  /** L'état connu d'un service, sans toucher à Docker (l'interface interroge souvent). */
  status(serviceId) {
    const s = this.states.get(serviceId) || { state: 'unknown', since: null, restarts: 0, health: null };
    return { ...s, sample: this.store.lastSample(serviceId) };
  }

  async tick() {
    this.ticks++;
    const at = nowS();
    const stats = await this.runtime.stats().catch(() => ({}));
    const aNous = new Set();
    for (const svc of this.store.listServices()) {
      // Une tâche planifiée ne garde pas de conteneur : son état se lit dans son
      // historique d'exécutions, pas dans « docker inspect ».
      if (svc.kind === 'cron') continue;
      const dep = svc.active_deployment_id ? this.store.getDeployment(svc.active_deployment_id) : null;
      if (dep?.container) aNous.add(dep.container);
      await this.#service(svc, at, stats);
    }
    // Les conteneurs de la machine qui ne viennent pas de Rail ont aussi leur série,
    // sous la clé « ext:<nom> » : le tableau de bord montre tout le serveur.
    for (const [nom, m] of Object.entries(stats)) {
      if (!aNous.has(nom)) this.store.addSample(`ext:${nom}`, at, { ...m, up: 1 });
    }
    await this.#host(at, Object.keys(stats).length);
    if (at - this.lastPrune > 3600) {
      this.lastPrune = at;
      this.store.pruneSamples(at - this.config.metricsRetentionS);
      this.store.pruneEvents(this.config.eventsKeep);
    }
  }

  async #service(svc, at, stats) {
    const active = svc.active_deployment_id ? this.store.getDeployment(svc.active_deployment_id) : null;
    const container = active?.container || null;
    const prev = this.states.get(svc.id);

    if (!container) { this.#set(svc, { state: svc.desired_state === 'stopped' ? 'stopped' : 'never', restarts: 0, health: null }, prev); return; }
    const info = await this.runtime.inspect(container);
    if (!info) { this.#set(svc, { state: 'missing', restarts: prev?.restarts ?? 0, health: null }, prev); return; }

    let state = info.status === 'running' ? 'running' : info.status === 'restarting' ? 'restarting' : info.status === 'exited' ? 'exited' : info.status;
    if (svc.desired_state === 'stopped' && state !== 'running') state = 'stopped';

    // Un service qui tourne mais ne répond plus à sa route de santé est « dégradé ».
    let health = null;
    if (state === 'running' && svc.healthcheck_path) {
      health = (await this.runtime.healthcheck({ name: container, port: svc.port, path: svc.healthcheck_path })) ? 'sain' : 'dégradé';
      if (health === 'dégradé') state = 'degraded';
    }

    const m = stats[container] || {};
    this.store.addSample(svc.id, at, { ...m, up: state === 'running' ? 1 : 0 });
    this.#set(svc, { state, restarts: info.restarts, health, startedAt: info.startedAt }, prev);

    // ── le filet ──
    if (this.config.autoHeal && svc.desired_state === 'running' && ['exited', 'missing'].includes(state) && prev && prev.state !== state) {
      const ok = info.status === 'exited' ? await this.runtime.resume(container) : false;
      this.#event(svc, ok ? 'service.heal' : 'service.down', ok ? 'warn' : 'error',
        ok ? `${svc.name} était arrêté : redémarré automatiquement` : `${svc.name} n'a plus de conteneur en marche`);
    }
  }

  #set(svc, next, prev) {
    const changed = !prev || prev.state !== next.state;
    this.states.set(svc.id, { ...next, since: changed ? new Date().toISOString() : prev.since });
    if (!prev || !changed) {
      if (prev && next.restarts > prev.restarts) {
        this.#event(svc, 'service.restarted', 'warn', `${svc.name} a redémarré (${next.restarts} fois depuis sa création)`);
      }
      return; // premier passage : on photographie, on ne raconte pas
    }
    const level = ['running', 'stopped', 'never'].includes(next.state) ? 'info' : 'error';
    const words = {
      running: 'est en ligne', stopped: 'est arrêté', exited: 's\'est arrêté tout seul',
      restarting: 'redémarre en boucle', degraded: 'répond mal (contrôle de santé en échec)',
      missing: 'n\'a plus de conteneur', never: 'n\'a jamais été déployé', paused: 'est en pause', created: 'n\'est pas démarré',
    };
    if (prev.state === 'never' && next.state === 'running') return; // le déploiement l'a déjà dit
    this.#event(svc, level === 'info' ? 'service.up' : 'service.problem', level, `${svc.name} ${words[next.state] || next.state}`);
  }

  #event(svc, kind, level, message) {
    this.store.addEvent({ kind, level, project_id: svc.project_id, service_id: svc.id, subject: svc.name, message });
    if (level !== 'info') {
      this.notifier?.send({ level, title: message, service: svc.name, url: `${this.config.publicUrl}/#/services/${svc.id}` });
    }
  }

  async #host(at, containers) {
    const c = cpuSnapshot();
    const dt = c.total - this.lastCpu.total;
    const cpu = dt > 0 ? Math.max(0, Math.min(100, (1 - (c.idle - this.lastCpu.idle) / dt) * 100)) : null;
    this.lastCpu = c;
    this.host.cpu = cpu;
    let disk = null; let diskTotal = null;
    try {
      const st = fs.statfsSync(this.config.dataDir);
      diskTotal = st.blocks * st.bsize;
      disk = diskTotal - st.bavail * st.bsize;
    } catch { /* pas de statfs : on s'en passe */ }
    this.store.addHostSample(at, {
      cpu, load1: os.loadavg()[0], mem: os.totalmem() - os.freemem(), mem_total: os.totalmem(),
      disk, disk_total: diskTotal, containers,
    });
  }
}
