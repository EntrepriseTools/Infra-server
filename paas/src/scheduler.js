// L'horloge de la plateforme : à chaque tour, elle regarde l'heure et déclenche
// ce qui est dû — les tâches planifiées (services « cron ») et les sauvegardes
// automatiques des bases.
//
// Elle tourne plus souvent qu'une fois par minute, et se garde de lancer deux fois
// la même minute : c'est l'historique en base qui le dit, pas une variable en
// mémoire — un redémarrage du plan de contrôle ne rejoue donc rien.
import { cronMatches, cronValid } from './cron.js';

const minute = (iso) => String(iso || '').slice(0, 16); // « 2026-10-17T03:00 »

export class Scheduler {
  constructor({ store, deployer, backups, config, log = console }) {
    Object.assign(this, { store, deployer, backups, config, log });
    this.timer = null;
    this.ticks = 0;
    this.busy = false;
    // Ce qui a déjà été lancé pendant la minute en cours : une tâche ne part
    // qu'une fois, même si l'horloge tourne plus souvent qu'une fois par minute.
    this.fired = new Set();
    this.firedMinute = null;
  }

  start() {
    if (this.timer) return undefined;
    this.timer = setInterval(() => { this.tick().catch((e) => this.log.error('[planificateur]', e.message)); }, this.config.schedulerIntervalMs);
    this.timer.unref?.();
    return this.tick().catch((e) => this.log.error('[planificateur]', e.message));
  }
  stop() { clearInterval(this.timer); this.timer = null; }

  async tick(at = new Date()) {
    if (this.busy) return; // un tour qui traîne ne se double pas
    this.busy = true;
    this.ticks++;
    const cette = minute(at.toISOString());
    if (this.firedMinute !== cette) { this.fired.clear(); this.firedMinute = cette; }
    try {
      await this.#jobs(at);
      await this.#backups(at);
    } finally { this.busy = false; }
  }

  // ── tâches planifiées ──
  async #jobs(at) {
    for (const svc of this.store.servicesWithCron()) {
      if (svc.kind !== 'cron' || svc.desired_state === 'stopped') continue;
      if (!cronValid(svc.cron_schedule) || !cronMatches(svc.cron_schedule, at)) continue;
      if (this.fired.has(`job:${svc.id}`)) continue;
      const recents = this.store.listRuns(svc.id, 10);
      // Une exécution encore en cours : on ne la double pas.
      if (recents[0]?.status === 'running') continue;
      // Et après un redémarrage du plan de contrôle (mémoire vide), l'historique se
      // souvient qu'une exécution PLANIFIÉE a déjà eu lieu dans la minute qui court.
      // Une exécution lancée à la main, elle, n'empêche jamais l'heure dite d'arriver.
      const planifiee = recents.find((x) => x.trigger === 'schedule');
      if (planifiee && minute(planifiee.started_at) === minute(new Date().toISOString())) continue;
      try {
        this.fired.add(`job:${svc.id}`);
        await this.deployer.runJob(svc.id, { trigger: 'schedule' });
      } catch (e) {
        this.store.addEvent({
          kind: 'job.skipped', level: 'warn', project_id: svc.project_id, service_id: svc.id, subject: svc.name,
          message: `${svc.name} : exécution planifiée impossible — ${e.message}`,
        });
      }
    }
  }

  // ── sauvegardes automatiques ──
  async #backups(at) {
    if (!this.backups) return;
    for (const svc of this.store.servicesWithBackup()) {
      if (svc.kind !== 'database') continue;
      if (!cronValid(svc.backup_schedule) || !cronMatches(svc.backup_schedule, at)) continue;
      if (this.fired.has(`backup:${svc.id}`)) continue;
      const planifiee = this.store.listBackups(svc.id, 10).find((x) => x.trigger === 'schedule');
      if (planifiee && minute(planifiee.created_at) === minute(new Date().toISOString())) continue;
      try {
        this.fired.add(`backup:${svc.id}`);
        await this.backups.create(svc.id, { trigger: 'schedule' });
      } catch (e) {
        this.store.addEvent({
          kind: 'database.backup.failed', level: 'error', project_id: svc.project_id, service_id: svc.id, subject: svc.name,
          message: `sauvegarde planifiée de « ${svc.name} » impossible — ${e.message}`,
        });
      }
    }
  }
}
