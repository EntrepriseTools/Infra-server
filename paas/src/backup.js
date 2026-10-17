// Les sauvegardes de bases : un fichier sur le disque du serveur, listé, daté,
// téléchargeable, et restaurable.
//
// L'export sort du conteneur par l'entrée/sortie standard (pg_dump, mysqldump,
// mongodump) : aucun port à ouvrir, aucun mot de passe sur la ligne de commande.
// Une sauvegarde qui échoue reste inscrite, en échec, avec sa raison — c'est la
// seule façon de s'apercevoir qu'elle ne marchait plus.
import fs from 'node:fs';
import path from 'node:path';
import { engineDump, engineRestore } from './databases.js';

const stamp = (d = new Date()) => d.toISOString().slice(0, 19).replace(/[:T]/g, '-');

export class Backups {
  constructor({ store, runtime, config, notifier = null }) {
    Object.assign(this, { store, runtime, config, notifier });
    fs.mkdirSync(config.backupsDir, { recursive: true });
  }

  dir(serviceId) {
    const d = path.join(this.config.backupsDir, serviceId);
    fs.mkdirSync(d, { recursive: true });
    return d;
  }
  /** Le chemin du fichier d'une sauvegarde — `file` est un nom, jamais un chemin. */
  fileOf(record) { return path.join(this.dir(record.service_id), path.basename(record.file)); }

  /** La place prise par les sauvegardes d'un service. */
  size(serviceId) {
    let total = 0;
    for (const b of this.store.listBackups(serviceId, 200)) total += b.size || 0;
    return total;
  }

  /**
   * Fabrique une sauvegarde. Renvoie l'enregistrement (statut « success » ou « failed »).
   * Jamais d'exception : une sauvegarde ratée ne doit pas arrêter le planificateur.
   */
  async create(serviceId, { trigger = 'manual' } = {}) {
    const svc = this.store.getService(serviceId);
    if (!svc) throw new Error('service inconnu');
    if (svc.kind !== 'database') throw new Error('seule une base de données se sauvegarde ainsi');
    const vars = this.store.getVars(svc.id);
    const dump = engineDump(svc.engine, vars);
    if (!dump) throw new Error(`pas de sauvegarde intégrée pour ${svc.engine} : copiez le volume du service`);
    const dep = svc.active_deployment_id ? this.store.getDeployment(svc.active_deployment_id) : null;
    if (!dep?.container) throw new Error('la base n\'est pas déployée');

    const name = `${svc.name}-${stamp()}.${dump.ext}`;
    const dest = path.join(this.dir(serviceId), name);
    const out = fs.createWriteStream(dest);
    let erreur = null;
    try {
      await this.runtime.exec(dep.container, dump.args, {
        env: dump.env,
        onData: (t) => out.write(t),
        onErr: (t) => { erreur = (erreur || '') + t; },
        timeoutMs: 3 * 3600 * 1000,
      });
    } catch (e) {
      erreur = (erreur ? `${erreur}\n` : '') + e.message;
    }
    await new Promise((r) => out.end(r));
    const taille = fs.statSync(dest).size;
    // Un export vide n'est pas une sauvegarde : mieux vaut le dire que le ranger.
    if (erreur && taille === 0) {
      fs.rmSync(dest, { force: true });
      const rec = this.store.addBackup(serviceId, { file: name, size: 0, status: 'failed', trigger, error: erreur.slice(0, 2000) });
      this.#raconte(svc, rec, erreur);
      return rec;
    }
    const rec = this.store.addBackup(serviceId, { file: name, size: taille, status: 'success', trigger, error: erreur ? erreur.slice(0, 2000) : null });
    this.store.addEvent({
      kind: 'database.backup', level: 'info', project_id: svc.project_id, service_id: svc.id, subject: svc.name,
      message: `sauvegarde de « ${svc.name} » : ${name} (${Math.round(taille / 1024)} ko, ${trigger === 'schedule' ? 'planifiée' : trigger})`,
    });
    this.prune(serviceId, svc.backup_keep || this.config.backupKeep);
    return rec;
  }

  #raconte(svc, rec, erreur) {
    this.store.addEvent({
      kind: 'database.backup.failed', level: 'error', project_id: svc.project_id, service_id: svc.id, subject: svc.name,
      message: `sauvegarde de « ${svc.name} » en échec — ${String(erreur).split('\n')[0].slice(0, 200)}`,
    });
    this.notifier?.send({
      level: 'error', title: `${svc.name} : sauvegarde en échec`, text: String(erreur).slice(0, 1500),
      service: svc.name, url: `${this.config.publicUrl}/#/services/${svc.id}`,
    });
  }

  /** Remet une sauvegarde en place. La base est écrasée : l'appelant a confirmé. */
  async restore(serviceId, backupId, { onLog = null } = {}) {
    const svc = this.store.getService(serviceId);
    const rec = this.store.getBackup(backupId);
    if (!svc || !rec || rec.service_id !== serviceId) throw new Error('sauvegarde introuvable');
    if (rec.status !== 'success') throw new Error('cette sauvegarde est en échec : rien à restaurer');
    const restore = engineRestore(svc.engine, this.store.getVars(svc.id));
    if (!restore) throw new Error(`pas de restauration intégrée pour ${svc.engine}`);
    const dep = svc.active_deployment_id ? this.store.getDeployment(svc.active_deployment_id) : null;
    if (!dep?.container) throw new Error('la base n\'est pas déployée');
    const file = this.fileOf(rec);
    if (!fs.existsSync(file)) throw new Error('le fichier de cette sauvegarde a disparu du serveur');
    let err = '';
    await this.runtime.exec(dep.container, restore.args, {
      env: restore.env,
      inputStream: fs.createReadStream(file),
      onData: (t) => onLog?.(t),
      onErr: (t) => { err += t; onLog?.(t); },
      timeoutMs: 3 * 3600 * 1000,
    });
    this.store.addEvent({
      kind: 'database.restore', level: 'warn', project_id: svc.project_id, service_id: svc.id, subject: svc.name,
      message: `base « ${svc.name} » restaurée depuis ${rec.file}`,
    });
    return { restored: rec.file, notice: err.trim().slice(0, 2000) || null };
  }

  /** Ne garde que les N dernières sauvegardes réussies ; supprime fichiers et traces. */
  prune(serviceId, keep) {
    const n = Math.max(1, Number(keep) || this.config.backupKeep);
    const all = this.store.listBackups(serviceId, 200);
    const reussies = all.filter((b) => b.status === 'success');
    for (const b of reussies.slice(n)) this.remove(b.id);
    // Les échecs ne s'accumulent pas non plus (on en garde quelques-uns pour l'enquête).
    for (const b of all.filter((x) => x.status !== 'success').slice(10)) this.store.deleteBackup(b.id);
  }

  remove(backupId) {
    const rec = this.store.getBackup(backupId);
    if (!rec) return false;
    fs.rmSync(this.fileOf(rec), { force: true });
    this.store.deleteBackup(backupId);
    return true;
  }
  /** Les fichiers d'un service supprimé n'ont plus de raison d'être. */
  removeAll(serviceId) {
    fs.rmSync(path.join(this.config.backupsDir, serviceId), { recursive: true, force: true });
  }
}
