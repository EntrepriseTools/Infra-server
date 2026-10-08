// Le catalogue : projets, services, variables, domaines, déploiements — dans un seul fichier SQLite.
// Les secrets (variables, jeton GitHub, secret de webhook) sont chiffrés avant d'y entrer.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { encrypt, decrypt, shortId, randomToken } from './crypto.js';

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
  created_at TEXT NOT NULL, UNIQUE(project_id, name));
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
`;

const now = () => new Date().toISOString();
const plain = (row) => (row ? { ...row } : null);

export class Store {
  constructor(file, key) {
    this.key = key;
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
    const v = this.db.prepare('PRAGMA user_version').get().user_version;
    if (v === 0) this.db.exec(`${SCHEMA}; PRAGMA user_version=1;`);
    else if (v !== 1) throw new Error(`base de données en version ${v}, non gérée`);
  }

  tx(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const r = fn(); this.db.exec('COMMIT'); return r; }
    catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  close() { this.db.close(); }

  // ── projets ──
  createProject(name) {
    const id = shortId();
    this.db.prepare('INSERT INTO projects(id,name,created_at) VALUES(?,?,?)').run(id, name, now());
    return this.getProject(id);
  }
  getProject(id) { return plain(this.db.prepare('SELECT * FROM projects WHERE id=?').get(id)); }
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
      auto_deploy,memory_mb,cpus,webhook_secret_enc,github_token_enc,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, projectId, f.name, f.repo, f.branch, f.root_dir, f.dockerfile_path ?? null, f.port, f.healthcheck_path ?? null,
        f.auto_deploy === false ? 0 : 1, f.memory_mb ?? null, f.cpus ?? null,
        encrypt(this.key, randomToken(24)), f.github_token ? encrypt(this.key, f.github_token) : null, now());
    return this.getService(id);
  }
  getService(id) { return this.#service(this.db.prepare('SELECT * FROM services WHERE id=?').get(id)); }
  listServices(projectId) {
    const q = projectId
      ? this.db.prepare('SELECT * FROM services WHERE project_id=? ORDER BY name').all(projectId)
      : this.db.prepare('SELECT * FROM services ORDER BY name').all();
    return q.map((r) => this.#service(r));
  }
  findServicesByRepo(repoFullName) {
    return this.db.prepare('SELECT * FROM services WHERE lower(repo)=lower(?)').all(repoFullName).map((r) => this.#service(r));
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
    const cols = ['repo', 'branch', 'root_dir', 'dockerfile_path', 'port', 'healthcheck_path', 'auto_deploy', 'memory_mb', 'cpus', 'active_deployment_id'];
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
}
