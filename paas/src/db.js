// Le catalogue : projets, services, variables, domaines, déploiements, événements
// et mesures — dans un seul fichier SQLite.
// Les secrets (variables, jeton GitHub, secret de webhook) sont chiffrés avant d'y entrer.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { encrypt, decrypt, shortId, randomToken } from './crypto.js';

export const SCHEMA_VERSION = 2;

const SCHEMA = `
CREATE TABLE projects(
  id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL);
CREATE TABLE services(
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL, repo TEXT NOT NULL, branch TEXT NOT NULL, root_dir TEXT NOT NULL,
  dockerfile_path TEXT, port INTEGER NOT NULL, healthcheck_path TEXT,
  auto_deploy INTEGER NOT NULL DEFAULT 1, memory_mb INTEGER, cpus REAL,
  webhook_secret_enc TEXT NOT NULL, github_token_enc TEXT, active_deployment_id TEXT,
  created_at TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'app', engine TEXT, base_image TEXT,
  desired_state TEXT NOT NULL DEFAULT 'running', volume_path TEXT,
  UNIQUE(project_id, name));
CREATE TABLE variables(
  service_id TEXT NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  key TEXT NOT NULL, value_enc TEXT NOT NULL, PRIMARY KEY(service_id, key));
CREATE TABLE domains(
  id TEXT PRIMARY KEY, service_id TEXT NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  hostname TEXT NOT NULL UNIQUE, kind TEXT NOT NULL);
CREATE TABLE deployments(
  id TEXT PRIMARY KEY, service_id TEXT NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  number INTEGER NOT NULL, status TEXT NOT NULL, trigger TEXT NOT NULL,
  commit_sha TEXT, commit_message TEXT, image TEXT, container TEXT, error TEXT,
  created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT, UNIQUE(service_id, number));
CREATE INDEX deployments_service ON deployments(service_id, number DESC);
-- Le fil d'activité. Volontairement SANS clé étrangère : l'histoire survit à la
-- suppression d'un service (« qui a supprimé quoi » est justement ce qu'on veut garder).
CREATE TABLE events(
  id TEXT PRIMARY KEY, at TEXT NOT NULL, kind TEXT NOT NULL, level TEXT NOT NULL,
  project_id TEXT, service_id TEXT, deployment_id TEXT, subject TEXT, message TEXT NOT NULL);
CREATE INDEX events_at ON events(at DESC);
CREATE INDEX events_service ON events(service_id, at DESC);
-- Les mesures : un échantillon par service et par tick (at = secondes epoch).
CREATE TABLE samples(
  service_id TEXT NOT NULL, at INTEGER NOT NULL,
  cpu REAL, mem INTEGER, mem_limit INTEGER, rx INTEGER, tx INTEGER, up INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY(service_id, at)) WITHOUT ROWID;
CREATE TABLE host_samples(
  at INTEGER PRIMARY KEY, cpu REAL, load1 REAL, mem INTEGER, mem_total INTEGER,
  disk INTEGER, disk_total INTEGER, containers INTEGER);
`;

// v1 → v2 : monitoring, bases de données managées, volumes, arrêt/démarrage.
const MIGRATIONS = {
  1: `
    ALTER TABLE services ADD COLUMN kind TEXT NOT NULL DEFAULT 'app';
    ALTER TABLE services ADD COLUMN engine TEXT;
    ALTER TABLE services ADD COLUMN base_image TEXT;
    ALTER TABLE services ADD COLUMN desired_state TEXT NOT NULL DEFAULT 'running';
    ALTER TABLE services ADD COLUMN volume_path TEXT;
    CREATE TABLE events(
      id TEXT PRIMARY KEY, at TEXT NOT NULL, kind TEXT NOT NULL, level TEXT NOT NULL,
      project_id TEXT, service_id TEXT, deployment_id TEXT, subject TEXT, message TEXT NOT NULL);
    CREATE INDEX events_at ON events(at DESC);
    CREATE INDEX events_service ON events(service_id, at DESC);
    CREATE TABLE samples(
      service_id TEXT NOT NULL, at INTEGER NOT NULL,
      cpu REAL, mem INTEGER, mem_limit INTEGER, rx INTEGER, tx INTEGER, up INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY(service_id, at)) WITHOUT ROWID;
    CREATE TABLE host_samples(
      at INTEGER PRIMARY KEY, cpu REAL, load1 REAL, mem INTEGER, mem_total INTEGER,
      disk INTEGER, disk_total INTEGER, containers INTEGER);
  `,
};

const now = () => new Date().toISOString();
const plain = (row) => (row ? { ...row } : null);

export class Store {
  constructor(file, key) {
    this.key = key;
    this.depth = 0;
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
    this.#migrate();
  }

  // Une base neuve part du schéma courant ; une base existante monte marche par marche.
  #migrate() {
    let v = this.db.prepare('PRAGMA user_version').get().user_version;
    if (v === 0) { this.db.exec(`${SCHEMA}; PRAGMA user_version=${SCHEMA_VERSION};`); return; }
    if (v > SCHEMA_VERSION) throw new Error(`base de données en version ${v} : plus récente que ce plan de contrôle`);
    while (v < SCHEMA_VERSION) {
      const step = MIGRATIONS[v];
      if (!step) throw new Error(`aucune migration de la version ${v} vers ${v + 1}`);
      this.db.exec(`BEGIN IMMEDIATE; ${step}; PRAGMA user_version=${v + 1}; COMMIT;`);
      v += 1;
    }
  }

  // Ré-entrante : une transaction imbriquée rejoint celle qui l'entoure
  // (créer une base, c'est un service ET ses identifiants, ou rien).
  tx(fn) {
    if (this.depth) { this.depth++; try { return fn(); } finally { this.depth--; } }
    this.db.exec('BEGIN IMMEDIATE');
    this.depth = 1;
    try { const r = fn(); this.db.exec('COMMIT'); return r; }
    catch (e) { this.db.exec('ROLLBACK'); throw e; }
    finally { this.depth = 0; }
  }
  close() { this.db.close(); }

  // ── projets ──
  createProject(name) {
    const id = shortId();
    this.db.prepare('INSERT INTO projects(id,name,created_at) VALUES(?,?,?)').run(id, name, now());
    return this.getProject(id);
  }
  getProject(id) { return plain(this.db.prepare('SELECT * FROM projects WHERE id=?').get(id)); }
  findProject(name) { return plain(this.db.prepare('SELECT * FROM projects WHERE name=?').get(name)); }
  listProjects() { return this.db.prepare('SELECT * FROM projects ORDER BY name').all().map(plain); }
  deleteProject(id) { this.db.prepare('DELETE FROM projects WHERE id=?').run(id); }

  // ── services ──
  #service(row) {
    if (!row) return null;
    const { webhook_secret_enc, github_token_enc, ...s } = row;
    return { ...s, auto_deploy: !!s.auto_deploy, has_github_token: !!github_token_enc };
  }
  createService(projectId, f) {
    const id = shortId();
    this.db.prepare(`INSERT INTO services(id,project_id,name,repo,branch,root_dir,dockerfile_path,port,healthcheck_path,
      auto_deploy,memory_mb,cpus,webhook_secret_enc,github_token_enc,created_at,kind,engine,base_image,desired_state,volume_path)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, projectId, f.name, f.repo ?? '', f.branch ?? '', f.root_dir ?? '.', f.dockerfile_path ?? null, f.port, f.healthcheck_path ?? null,
        f.auto_deploy === false ? 0 : 1, f.memory_mb ?? null, f.cpus ?? null,
        encrypt(this.key, randomToken(24)), f.github_token ? encrypt(this.key, f.github_token) : null, now(),
        f.kind ?? 'app', f.engine ?? null, f.base_image ?? null, f.desired_state ?? 'running', f.volume_path ?? null);
    return this.getService(id);
  }
  getService(id) { return this.#service(this.db.prepare('SELECT * FROM services WHERE id=?').get(id)); }
  listServices(projectId) {
    const q = projectId
      ? this.db.prepare('SELECT * FROM services WHERE project_id=? ORDER BY kind DESC, name').all(projectId)
      : this.db.prepare('SELECT * FROM services ORDER BY name').all();
    return q.map((r) => this.#service(r));
  }
  findServicesByRepo(repoFullName) {
    return this.db.prepare('SELECT * FROM services WHERE repo<>\'\' AND lower(repo)=lower(?)').all(repoFullName).map((r) => this.#service(r));
  }
  findService(projectName, serviceName) {
    return this.#service(this.db.prepare(
      'SELECT s.* FROM services s JOIN projects p ON p.id=s.project_id WHERE p.name=? AND s.name=?').get(projectName, serviceName));
  }
  webhookSecret(id) {
    const r = this.db.prepare('SELECT webhook_secret_enc FROM services WHERE id=?').get(id);
    return r ? decrypt(this.key, r.webhook_secret_enc) : null;
  }
  githubToken(id) {
    const r = this.db.prepare('SELECT github_token_enc FROM services WHERE id=?').get(id);
    return r?.github_token_enc ? decrypt(this.key, r.github_token_enc) : null;
  }
  updateService(id, patch) {
    const cols = ['repo', 'branch', 'root_dir', 'dockerfile_path', 'port', 'healthcheck_path', 'auto_deploy',
      'memory_mb', 'cpus', 'active_deployment_id', 'desired_state', 'base_image', 'volume_path'];
    const sets = []; const vals = [];
    for (const c of cols) if (c in patch) { sets.push(`${c}=?`); vals.push(c === 'auto_deploy' ? (patch[c] ? 1 : 0) : patch[c]); }
    if ('github_token' in patch) { sets.push('github_token_enc=?'); vals.push(patch.github_token ? encrypt(this.key, patch.github_token) : null); }
    if (sets.length) this.db.prepare(`UPDATE services SET ${sets.join(',')} WHERE id=?`).run(...vals, id);
    return this.getService(id);
  }
  deleteService(id) { this.db.prepare('DELETE FROM services WHERE id=?').run(id); }

  // ── variables ──
  getVars(serviceId) {
    const out = {};
    for (const r of this.db.prepare('SELECT key,value_enc FROM variables WHERE service_id=? ORDER BY key').all(serviceId)) out[r.key] = decrypt(this.key, r.value_enc);
    return out;
  }
  setVars(serviceId, vars) {
    this.tx(() => {
      const st = this.db.prepare('INSERT INTO variables(service_id,key,value_enc) VALUES(?,?,?) ON CONFLICT(service_id,key) DO UPDATE SET value_enc=excluded.value_enc');
      for (const [k, v] of Object.entries(vars)) st.run(serviceId, k, encrypt(this.key, v));
    });
  }
  deleteVar(serviceId, key) { return this.db.prepare('DELETE FROM variables WHERE service_id=? AND key=?').run(serviceId, key).changes > 0; }

  // ── domaines ──
  addDomain(serviceId, hostname, kind) {
    const id = shortId();
    this.db.prepare('INSERT INTO domains(id,service_id,hostname,kind) VALUES(?,?,?,?)').run(id, serviceId, hostname, kind);
    return { id, service_id: serviceId, hostname, kind };
  }
  listDomains(serviceId) { return this.db.prepare('SELECT * FROM domains WHERE service_id=? ORDER BY kind, hostname').all(serviceId).map(plain); }
  getDomain(id) { return plain(this.db.prepare('SELECT * FROM domains WHERE id=?').get(id)); }
  deleteDomain(id) { this.db.prepare('DELETE FROM domains WHERE id=?').run(id); }

  // ── déploiements ──
  createDeployment(serviceId, f) {
    return this.tx(() => {
      const id = shortId();
      const number = (this.db.prepare('SELECT COALESCE(MAX(number),0)+1 AS n FROM deployments WHERE service_id=?').get(serviceId)).n;
      this.db.prepare(`INSERT INTO deployments(id,service_id,number,status,trigger,commit_sha,commit_message,image,created_at)
        VALUES(?,?,?,?,?,?,?,?,?)`).run(id, serviceId, number, 'queued', f.trigger, f.commit_sha ?? null, f.commit_message ?? null, f.image ?? null, now());
      return this.getDeployment(id);
    });
  }
  getDeployment(id) { return plain(this.db.prepare('SELECT * FROM deployments WHERE id=?').get(id)); }
  updateDeployment(id, patch) {
    const cols = ['status', 'commit_sha', 'commit_message', 'image', 'container', 'error', 'started_at', 'finished_at'];
    const sets = []; const vals = [];
    for (const c of cols) if (c in patch) { sets.push(`${c}=?`); vals.push(patch[c]); }
    if (sets.length) this.db.prepare(`UPDATE deployments SET ${sets.join(',')} WHERE id=?`).run(...vals, id);
    return this.getDeployment(id);
  }
  listDeployments(serviceId, limit = 50) {
    return this.db.prepare('SELECT * FROM deployments WHERE service_id=? ORDER BY number DESC LIMIT ?').all(serviceId, limit).map(plain);
  }
  deploymentsWithStatus(...statuses) {
    return this.db.prepare(`SELECT * FROM deployments WHERE status IN (${statuses.map(() => '?').join(',')})`).all(...statuses).map(plain);
  }

  // ── événements ──
  addEvent(e) {
    const id = shortId();
    this.db.prepare('INSERT INTO events(id,at,kind,level,project_id,service_id,deployment_id,subject,message) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(id, now(), e.kind, e.level || 'info', e.project_id ?? null, e.service_id ?? null, e.deployment_id ?? null, e.subject ?? null, e.message);
    return { id, at: now(), ...e };
  }
  listEvents({ limit = 50, serviceId = null, projectId = null, level = null } = {}) {
    const where = []; const vals = [];
    if (serviceId) { where.push('service_id=?'); vals.push(serviceId); }
    if (projectId) { where.push('project_id=?'); vals.push(projectId); }
    if (level) { where.push('level=?'); vals.push(level); }
    const sql = `SELECT * FROM events ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY at DESC, rowid DESC LIMIT ?`;
    return this.db.prepare(sql).all(...vals, Math.min(limit, 500)).map(plain);
  }
  /** Ne garde que les N événements les plus récents. */
  pruneEvents(keep = 5000) {
    this.db.prepare('DELETE FROM events WHERE id NOT IN (SELECT id FROM events ORDER BY at DESC, rowid DESC LIMIT ?)').run(keep);
  }

  // ── mesures ──
  addSample(serviceId, at, m) {
    this.db.prepare('INSERT OR REPLACE INTO samples(service_id,at,cpu,mem,mem_limit,rx,tx,up) VALUES(?,?,?,?,?,?,?,?)')
      .run(serviceId, at, m.cpu ?? null, m.mem ?? null, m.mem_limit ?? null, m.rx ?? null, m.tx ?? null, m.up ? 1 : 0);
  }
  addHostSample(at, m) {
    this.db.prepare('INSERT OR REPLACE INTO host_samples(at,cpu,load1,mem,mem_total,disk,disk_total,containers) VALUES(?,?,?,?,?,?,?,?)')
      .run(at, m.cpu ?? null, m.load1 ?? null, m.mem ?? null, m.mem_total ?? null, m.disk ?? null, m.disk_total ?? null, m.containers ?? null);
  }
  /** Série d'un service, moyennée par paquets de `bucket` secondes (pour ne pas renvoyer 5 000 points). */
  samples(serviceId, { since, bucket = 60 } = {}) {
    // CAST : node:sqlite lie les nombres JS en flottant, et 1000/300 doit rester une division entière.
    return this.db.prepare(`SELECT CAST(at/? AS INTEGER)*? AS at, AVG(cpu) cpu, AVG(mem) mem, MAX(mem_limit) mem_limit,
      MAX(rx) rx, MAX(tx) tx, MIN(up) up FROM samples WHERE service_id=? AND at>=? GROUP BY 1 ORDER BY 1`)
      .all(bucket, bucket, serviceId, since).map(plain);
  }
  hostSamples({ since, bucket = 60 } = {}) {
    return this.db.prepare(`SELECT CAST(at/? AS INTEGER)*? AS at, AVG(cpu) cpu, AVG(load1) load1, AVG(mem) mem, MAX(mem_total) mem_total,
      AVG(disk) disk, MAX(disk_total) disk_total, AVG(containers) containers FROM host_samples WHERE at>=? GROUP BY 1 ORDER BY 1`)
      .all(bucket, bucket, since).map(plain);
  }
  lastSample(serviceId) {
    return plain(this.db.prepare('SELECT * FROM samples WHERE service_id=? ORDER BY at DESC LIMIT 1').get(serviceId));
  }
  lastHostSample() { return plain(this.db.prepare('SELECT * FROM host_samples ORDER BY at DESC LIMIT 1').get()); }
  pruneSamples(before) {
    this.db.prepare('DELETE FROM samples WHERE at<?').run(before);
    this.db.prepare('DELETE FROM host_samples WHERE at<?').run(before);
  }
}
