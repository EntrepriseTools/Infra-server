// Le catalogue : comptes, projets, environnements, services, variables, domaines,
// déploiements, tâches planifiées, sauvegardes, événements et mesures — dans un
// seul fichier SQLite.
// Les secrets (variables, jetons, mots de passe, secrets de webhook) sont chiffrés
// ou hachés avant d'y entrer.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { encrypt, decrypt, shortId, randomToken } from './crypto.js';
import { hashPassword, hashToken } from './users.js';

export const SCHEMA_VERSION = 3;

const SCHEMA = `
-- ── comptes ──────────────────────────────────────────────────────────────
CREATE TABLE users(
  id TEXT PRIMARY KEY, login TEXT NOT NULL UNIQUE, name TEXT NOT NULL, role TEXT NOT NULL,
  password_hash TEXT NOT NULL, github_token_enc TEXT, created_at TEXT NOT NULL,
  last_seen_at TEXT, must_change_password INTEGER NOT NULL DEFAULT 0);
-- Une session : seule l'empreinte du jeton est gardée (id = sha256 du jeton du cookie).
CREATE TABLE sessions(
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, seen_at TEXT NOT NULL,
  ip TEXT, agent TEXT);
CREATE INDEX sessions_user ON sessions(user_id);
CREATE TABLE api_tokens(
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL, hash TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, last_used_at TEXT);
-- Réglages de la plateforme modifiables depuis l'interface (jeton GitHub partagé…).
CREATE TABLE settings(key TEXT PRIMARY KEY, value_enc TEXT NOT NULL);

-- ── projets et environnements ────────────────────────────────────────────
CREATE TABLE projects(
  id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL);
CREATE TABLE environments(
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(project_id, name));
-- Variables communes à tous les services d'un environnement.
CREATE TABLE project_vars(
  environment_id TEXT NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
  key TEXT NOT NULL, value_enc TEXT NOT NULL, PRIMARY KEY(environment_id, key));

-- ── services ─────────────────────────────────────────────────────────────
CREATE TABLE services(
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  environment_id TEXT NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
  name TEXT NOT NULL, repo TEXT NOT NULL, branch TEXT NOT NULL, root_dir TEXT NOT NULL,
  dockerfile_path TEXT, port INTEGER NOT NULL, healthcheck_path TEXT,
  auto_deploy INTEGER NOT NULL DEFAULT 1, memory_mb INTEGER, cpus REAL,
  webhook_secret_enc TEXT NOT NULL, github_token_enc TEXT, active_deployment_id TEXT,
  created_at TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'app', engine TEXT, base_image TEXT,
  desired_state TEXT NOT NULL DEFAULT 'running', volume_path TEXT,
  source_kind TEXT NOT NULL DEFAULT 'repo',
  build_command TEXT, start_command TEXT, watch_paths TEXT,
  public_port INTEGER, cron_schedule TEXT, template TEXT,
  backup_schedule TEXT, backup_keep INTEGER,
  -- Certaines images publiques veulent leur volume à elles (un identifiant d'utilisateur
  -- précis) ou quelques capacités pour le préparer : les modèles le déclarent.
  volume_owner INTEGER, extra_caps TEXT,
  UNIQUE(environment_id, name));
CREATE INDEX services_project ON services(project_id);
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

-- ── tâches planifiées et sauvegardes ─────────────────────────────────────
CREATE TABLE job_runs(
  id TEXT PRIMARY KEY, service_id TEXT NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  number INTEGER NOT NULL, status TEXT NOT NULL, trigger TEXT NOT NULL,
  started_at TEXT NOT NULL, finished_at TEXT, exit_code INTEGER, output TEXT,
  UNIQUE(service_id, number));
CREATE INDEX job_runs_service ON job_runs(service_id, number DESC);
CREATE TABLE backups(
  id TEXT PRIMARY KEY, service_id TEXT NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  file TEXT NOT NULL, size INTEGER, status TEXT NOT NULL, trigger TEXT NOT NULL,
  created_at TEXT NOT NULL, error TEXT);
CREATE INDEX backups_service ON backups(service_id, created_at DESC);

-- ── histoire et mesures ──────────────────────────────────────────────────
-- Le fil d'activité. Volontairement SANS clé étrangère : l'histoire survit à la
-- suppression d'un service (« qui a supprimé quoi » est justement ce qu'on veut garder).
CREATE TABLE events(
  id TEXT PRIMARY KEY, at TEXT NOT NULL, kind TEXT NOT NULL, level TEXT NOT NULL,
  project_id TEXT, service_id TEXT, deployment_id TEXT, subject TEXT, message TEXT NOT NULL,
  actor TEXT);
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

// v1 → v2 : surveillance, bases de données managées, volumes, arrêt/démarrage.
const V1_V2 = `
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
`;

// v2 → v3 : comptes, environnements, images Docker, cron, sauvegardes.
// La table « services » est reconstruite : elle gagne son environnement, et sa
// contrainte d'unicité passe du projet à l'environnement (le même service existe
// en production ET en préproduction). Les identifiants ne changent pas, donc rien
// de ce qui pointe sur un service ne bouge.
const V2_V3 = `
  CREATE TABLE users(
    id TEXT PRIMARY KEY, login TEXT NOT NULL UNIQUE, name TEXT NOT NULL, role TEXT NOT NULL,
    password_hash TEXT NOT NULL, github_token_enc TEXT, created_at TEXT NOT NULL,
    last_seen_at TEXT, must_change_password INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE sessions(
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    csrf TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, seen_at TEXT NOT NULL,
    ip TEXT, agent TEXT);
  CREATE INDEX sessions_user ON sessions(user_id);
  CREATE TABLE api_tokens(
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL, hash TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, last_used_at TEXT);
  CREATE TABLE settings(key TEXT PRIMARY KEY, value_enc TEXT NOT NULL);
  CREATE TABLE environments(
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(project_id, name));
  CREATE TABLE project_vars(
    environment_id TEXT NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
    key TEXT NOT NULL, value_enc TEXT NOT NULL, PRIMARY KEY(environment_id, key));
  -- Un environnement « production » par projet existant, et tous les services dedans.
  INSERT INTO environments(id, project_id, name, created_at)
    SELECT lower(hex(randomblob(6))), id, 'production', created_at FROM projects;
  CREATE TABLE services_v3(
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    environment_id TEXT NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
    name TEXT NOT NULL, repo TEXT NOT NULL, branch TEXT NOT NULL, root_dir TEXT NOT NULL,
    dockerfile_path TEXT, port INTEGER NOT NULL, healthcheck_path TEXT,
    auto_deploy INTEGER NOT NULL DEFAULT 1, memory_mb INTEGER, cpus REAL,
    webhook_secret_enc TEXT NOT NULL, github_token_enc TEXT, active_deployment_id TEXT,
    created_at TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'app', engine TEXT, base_image TEXT,
    desired_state TEXT NOT NULL DEFAULT 'running', volume_path TEXT,
    source_kind TEXT NOT NULL DEFAULT 'repo',
    build_command TEXT, start_command TEXT, watch_paths TEXT,
    public_port INTEGER, cron_schedule TEXT, template TEXT,
    backup_schedule TEXT, backup_keep INTEGER,
    volume_owner INTEGER, extra_caps TEXT,
    UNIQUE(environment_id, name));
  INSERT INTO services_v3(id, project_id, environment_id, name, repo, branch, root_dir, dockerfile_path,
      port, healthcheck_path, auto_deploy, memory_mb, cpus, webhook_secret_enc, github_token_enc,
      active_deployment_id, created_at, kind, engine, base_image, desired_state, volume_path, source_kind)
    SELECT s.id, s.project_id, e.id, s.name, s.repo, s.branch, s.root_dir, s.dockerfile_path,
      s.port, s.healthcheck_path, s.auto_deploy, s.memory_mb, s.cpus, s.webhook_secret_enc, s.github_token_enc,
      s.active_deployment_id, s.created_at, s.kind, s.engine, s.base_image, s.desired_state, s.volume_path,
      CASE WHEN s.kind='database' THEN 'image' ELSE 'repo' END
    FROM services s JOIN environments e ON e.project_id = s.project_id AND e.name='production';
  DROP TABLE services;
  ALTER TABLE services_v3 RENAME TO services;
  CREATE INDEX services_project ON services(project_id);
  CREATE TABLE job_runs(
    id TEXT PRIMARY KEY, service_id TEXT NOT NULL REFERENCES services(id) ON DELETE CASCADE,
    number INTEGER NOT NULL, status TEXT NOT NULL, trigger TEXT NOT NULL,
    started_at TEXT NOT NULL, finished_at TEXT, exit_code INTEGER, output TEXT,
    UNIQUE(service_id, number));
  CREATE INDEX job_runs_service ON job_runs(service_id, number DESC);
  CREATE TABLE backups(
    id TEXT PRIMARY KEY, service_id TEXT NOT NULL REFERENCES services(id) ON DELETE CASCADE,
    file TEXT NOT NULL, size INTEGER, status TEXT NOT NULL, trigger TEXT NOT NULL,
    created_at TEXT NOT NULL, error TEXT);
  CREATE INDEX backups_service ON backups(service_id, created_at DESC);
  ALTER TABLE events ADD COLUMN actor TEXT;
`;

const MIGRATIONS = { 1: V1_V2, 2: V2_V3 };

const now = () => new Date().toISOString();
const plain = (row) => (row ? { ...row } : null);
/** Les colonnes d'un service qu'une mise à jour peut toucher. */
const SERVICE_COLS = ['repo', 'branch', 'root_dir', 'dockerfile_path', 'port', 'healthcheck_path', 'auto_deploy',
  'memory_mb', 'cpus', 'active_deployment_id', 'desired_state', 'base_image', 'volume_path', 'source_kind',
  'build_command', 'start_command', 'watch_paths', 'public_port', 'cron_schedule', 'backup_schedule', 'backup_keep',
  'volume_owner', 'extra_caps', 'name'];

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
  // Les clés étrangères sont relâchées le temps d'une marche (une table reconstruite se
  // supprime et se renomme), puis vérifiées avant de valider : une migration ne laisse
  // jamais une référence cassée derrière elle.
  #migrate() {
    let v = this.db.prepare('PRAGMA user_version').get().user_version;
    if (v === 0) { this.db.exec(`${SCHEMA}; PRAGMA user_version=${SCHEMA_VERSION};`); return; }
    if (v > SCHEMA_VERSION) throw new Error(`base de données en version ${v} : plus récente que ce plan de contrôle`);
    while (v < SCHEMA_VERSION) {
      const step = MIGRATIONS[v];
      if (!step) throw new Error(`aucune migration de la version ${v} vers ${v + 1}`);
      this.db.exec('PRAGMA foreign_keys=OFF');
      try {
        this.db.exec(`BEGIN IMMEDIATE; ${step}; PRAGMA user_version=${v + 1};`);
        const casse = this.db.prepare('PRAGMA foreign_key_check').all();
        if (casse.length) throw new Error(`${casse.length} référence(s) cassée(s)`);
        this.db.exec('COMMIT');
      } catch (e) {
        try { this.db.exec('ROLLBACK'); } catch { /* déjà défaite */ }
        throw new Error(`migration ${v} → ${v + 1} impossible : ${e.message}`);
      } finally {
        this.db.exec('PRAGMA foreign_keys=ON');
      }
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

  // ── comptes ──
  #user(row) {
    if (!row) return null;
    const { password_hash, github_token_enc, ...u } = row;
    return { ...u, must_change_password: !!u.must_change_password, has_github_token: !!github_token_enc };
  }
  countUsers() { return this.db.prepare('SELECT COUNT(*) AS n FROM users').get().n; }
  createUser({ login, name, role, password, mustChange = false }) {
    const id = shortId();
    this.db.prepare('INSERT INTO users(id,login,name,role,password_hash,created_at,must_change_password) VALUES(?,?,?,?,?,?,?)')
      .run(id, login, name || login, role, hashPassword(password), now(), mustChange ? 1 : 0);
    return this.getUser(id);
  }
  getUser(id) { return this.#user(this.db.prepare('SELECT * FROM users WHERE id=?').get(id)); }
  findUser(login) { return this.#user(this.db.prepare('SELECT * FROM users WHERE login=?').get(String(login || '').toLowerCase())); }
  /** Le haché du mot de passe : seul `verifyPassword` doit le voir. */
  passwordHash(login) { return this.db.prepare('SELECT password_hash FROM users WHERE login=?').get(String(login || '').toLowerCase())?.password_hash ?? null; }
  passwordHashById(id) { return this.db.prepare('SELECT password_hash FROM users WHERE id=?').get(id)?.password_hash ?? null; }
  listUsers() { return this.db.prepare('SELECT * FROM users ORDER BY login').all().map((r) => this.#user(r)); }
  updateUser(id, patch) {
    const sets = []; const vals = [];
    for (const c of ['login', 'name', 'role']) if (c in patch) { sets.push(`${c}=?`); vals.push(patch[c]); }
    if ('must_change_password' in patch) { sets.push('must_change_password=?'); vals.push(patch.must_change_password ? 1 : 0); }
    if ('last_seen_at' in patch) { sets.push('last_seen_at=?'); vals.push(patch.last_seen_at); }
    if (patch.password) { sets.push('password_hash=?'); vals.push(hashPassword(patch.password)); }
    if ('github_token' in patch) { sets.push('github_token_enc=?'); vals.push(patch.github_token ? encrypt(this.key, patch.github_token) : null); }
    if (sets.length) this.db.prepare(`UPDATE users SET ${sets.join(',')} WHERE id=?`).run(...vals, id);
    return this.getUser(id);
  }
  deleteUser(id) { this.db.prepare('DELETE FROM users WHERE id=?').run(id); }
  userGithubToken(id) {
    const r = this.db.prepare('SELECT github_token_enc FROM users WHERE id=?').get(id);
    return r?.github_token_enc ? decrypt(this.key, r.github_token_enc) : null;
  }

  // ── sessions ──
  /** Ouvre une session et renvoie le jeton en clair (vu une seule fois) + son anti-CSRF. */
  createSession(userId, { ip = null, agent = null, ttlMs = 12 * 3600 * 1000 } = {}) {
    const token = randomToken(32);
    const csrf = randomToken(18);
    this.db.prepare('INSERT INTO sessions(id,user_id,csrf,created_at,expires_at,seen_at,ip,agent) VALUES(?,?,?,?,?,?,?,?)')
      .run(hashToken(token), userId, csrf, now(), new Date(Date.now() + ttlMs).toISOString(), now(), ip, String(agent || '').slice(0, 200));
    return { token, csrf, expiresAt: new Date(Date.now() + ttlMs).toISOString() };
  }
  /** La session d'un jeton de cookie, ou null si elle est inconnue ou périmée. */
  getSession(token) {
    if (!token) return null;
    const row = this.db.prepare('SELECT * FROM sessions WHERE id=?').get(hashToken(token));
    if (!row) return null;
    if (new Date(row.expires_at) <= new Date()) { this.db.prepare('DELETE FROM sessions WHERE id=?').run(row.id); return null; }
    return plain(row);
  }
  touchSession(id) { this.db.prepare('UPDATE sessions SET seen_at=? WHERE id=?').run(now(), id); }
  deleteSession(token) { this.db.prepare('DELETE FROM sessions WHERE id=?').run(hashToken(token)); }
  deleteSessionById(id) { return this.db.prepare('DELETE FROM sessions WHERE id=?').run(id).changes > 0; }
  deleteUserSessions(userId) { this.db.prepare('DELETE FROM sessions WHERE user_id=?').run(userId); }
  listSessions(userId) {
    return this.db.prepare('SELECT id,created_at,expires_at,seen_at,ip,agent FROM sessions WHERE user_id=? ORDER BY seen_at DESC').all(userId).map(plain);
  }
  pruneSessions() { this.db.prepare('DELETE FROM sessions WHERE expires_at<=?').run(now()); }

  // ── jetons d'API (la ligne de commande) ──
  createApiToken(userId, name) {
    const token = `rail_${randomToken(24)}`;
    const id = shortId();
    this.db.prepare('INSERT INTO api_tokens(id,user_id,name,hash,created_at) VALUES(?,?,?,?,?)').run(id, userId, name, hashToken(token), now());
    return { id, token, name };
  }
  findApiToken(token) {
    const row = this.db.prepare('SELECT * FROM api_tokens WHERE hash=?').get(hashToken(token));
    return plain(row);
  }
  touchApiToken(id) { this.db.prepare('UPDATE api_tokens SET last_used_at=? WHERE id=?').run(now(), id); }
  listApiTokens(userId) { return this.db.prepare('SELECT id,name,created_at,last_used_at FROM api_tokens WHERE user_id=? ORDER BY created_at DESC').all(userId).map(plain); }
  deleteApiToken(userId, id) { return this.db.prepare('DELETE FROM api_tokens WHERE id=? AND user_id=?').run(id, userId).changes > 0; }

  // ── réglages ──
  setSetting(key, value) {
    if (value == null || value === '') { this.db.prepare('DELETE FROM settings WHERE key=?').run(key); return; }
    this.db.prepare('INSERT INTO settings(key,value_enc) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value_enc=excluded.value_enc').run(key, encrypt(this.key, value));
  }
  getSetting(key) {
    const r = this.db.prepare('SELECT value_enc FROM settings WHERE key=?').get(key);
    return r ? decrypt(this.key, r.value_enc) : null;
  }

  // ── projets ──
  createProject(name) {
    return this.tx(() => {
      const id = shortId();
      this.db.prepare('INSERT INTO projects(id,name,created_at) VALUES(?,?,?)').run(id, name, now());
      this.createEnvironment(id, 'production');
      return this.getProject(id);
    });
  }
  getProject(id) { return plain(this.db.prepare('SELECT * FROM projects WHERE id=?').get(id)); }
  findProject(name) { return plain(this.db.prepare('SELECT * FROM projects WHERE name=?').get(name)); }
  listProjects() { return this.db.prepare('SELECT * FROM projects ORDER BY name').all().map(plain); }
  deleteProject(id) { this.db.prepare('DELETE FROM projects WHERE id=?').run(id); }

  // ── environnements ──
  createEnvironment(projectId, name) {
    const id = shortId();
    this.db.prepare('INSERT INTO environments(id,project_id,name,created_at) VALUES(?,?,?,?)').run(id, projectId, name, now());
    return this.getEnvironment(id);
  }
  getEnvironment(id) { return plain(this.db.prepare('SELECT * FROM environments WHERE id=?').get(id)); }
  findEnvironment(projectId, name) { return plain(this.db.prepare('SELECT * FROM environments WHERE project_id=? AND name=?').get(projectId, name)); }
  listEnvironments(projectId) {
    // « production » d'abord, le reste par ordre alphabétique.
    return this.db.prepare("SELECT * FROM environments WHERE project_id=? ORDER BY name<>'production', name").all(projectId).map(plain);
  }
  deleteEnvironment(id) { this.db.prepare('DELETE FROM environments WHERE id=?').run(id); }

  getProjectVars(environmentId) {
    const out = {};
    for (const r of this.db.prepare('SELECT key,value_enc FROM project_vars WHERE environment_id=? ORDER BY key').all(environmentId)) out[r.key] = decrypt(this.key, r.value_enc);
    return out;
  }
  setProjectVars(environmentId, vars) {
    this.tx(() => {
      const st = this.db.prepare('INSERT INTO project_vars(environment_id,key,value_enc) VALUES(?,?,?) ON CONFLICT(environment_id,key) DO UPDATE SET value_enc=excluded.value_enc');
      for (const [k, v] of Object.entries(vars)) st.run(environmentId, k, encrypt(this.key, v));
    });
  }
  deleteProjectVar(environmentId, key) { return this.db.prepare('DELETE FROM project_vars WHERE environment_id=? AND key=?').run(environmentId, key).changes > 0; }

  // ── services ──
  #service(row) {
    if (!row) return null;
    const { webhook_secret_enc, github_token_enc, ...s } = row;
    return { ...s, auto_deploy: !!s.auto_deploy, has_github_token: !!github_token_enc };
  }
  createService(projectId, f) {
    const id = shortId();
    const environmentId = f.environment_id || this.findEnvironment(projectId, 'production')?.id;
    if (!environmentId) throw new Error('environnement inconnu pour ce projet');
    this.db.prepare(`INSERT INTO services(id,project_id,environment_id,name,repo,branch,root_dir,dockerfile_path,port,healthcheck_path,
      auto_deploy,memory_mb,cpus,webhook_secret_enc,github_token_enc,created_at,kind,engine,base_image,desired_state,volume_path,
      source_kind,build_command,start_command,watch_paths,public_port,cron_schedule,template,backup_schedule,backup_keep,
      volume_owner,extra_caps)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, projectId, environmentId, f.name, f.repo ?? '', f.branch ?? '', f.root_dir ?? '.', f.dockerfile_path ?? null, f.port, f.healthcheck_path ?? null,
        f.auto_deploy === false ? 0 : 1, f.memory_mb ?? null, f.cpus ?? null,
        encrypt(this.key, randomToken(24)), f.github_token ? encrypt(this.key, f.github_token) : null, now(),
        f.kind ?? 'app', f.engine ?? null, f.base_image ?? null, f.desired_state ?? 'running', f.volume_path ?? null,
        f.source_kind ?? 'repo', f.build_command ?? null, f.start_command ?? null, f.watch_paths ?? null,
        f.public_port ?? null, f.cron_schedule ?? null, f.template ?? null, f.backup_schedule ?? null, f.backup_keep ?? null,
        f.volume_owner ?? null, f.extra_caps ?? null);
    return this.getService(id);
  }
  getService(id) { return this.#service(this.db.prepare('SELECT * FROM services WHERE id=?').get(id)); }
  listServices(projectId) {
    const q = projectId
      ? this.db.prepare('SELECT * FROM services WHERE project_id=? ORDER BY kind DESC, name').all(projectId)
      : this.db.prepare('SELECT * FROM services ORDER BY name').all();
    return q.map((r) => this.#service(r));
  }
  listEnvServices(environmentId) {
    return this.db.prepare('SELECT * FROM services WHERE environment_id=? ORDER BY kind DESC, name').all(environmentId).map((r) => this.#service(r));
  }
  findServicesByRepo(repoFullName) {
    return this.db.prepare('SELECT * FROM services WHERE repo<>\'\' AND lower(repo)=lower(?)').all(repoFullName).map((r) => this.#service(r));
  }
  /** Le service nommé `name` dans le MÊME environnement : c'est la portée des références entre variables. */
  findEnvService(environmentId, name) {
    return this.#service(this.db.prepare('SELECT * FROM services WHERE environment_id=? AND name=?').get(environmentId, name));
  }
  /** « projet/service » (environnement de production), ou « projet/env/service ». */
  findService(projectName, serviceName, envName = 'production') {
    return this.#service(this.db.prepare(
      `SELECT s.* FROM services s JOIN projects p ON p.id=s.project_id JOIN environments e ON e.id=s.environment_id
       WHERE p.name=? AND e.name=? AND s.name=?`).get(projectName, envName, serviceName));
  }
  servicesWithCron() { return this.db.prepare("SELECT * FROM services WHERE cron_schedule IS NOT NULL AND cron_schedule<>''").all().map((r) => this.#service(r)); }
  servicesWithBackup() { return this.db.prepare("SELECT * FROM services WHERE backup_schedule IS NOT NULL AND backup_schedule<>''").all().map((r) => this.#service(r)); }
  /** Les ports publics déjà pris (exposition TCP). */
  usedPublicPorts() { return this.db.prepare('SELECT public_port FROM services WHERE public_port IS NOT NULL').all().map((r) => r.public_port); }
  webhookSecret(id) {
    const r = this.db.prepare('SELECT webhook_secret_enc FROM services WHERE id=?').get(id);
    return r ? decrypt(this.key, r.webhook_secret_enc) : null;
  }
  githubToken(id) {
    const r = this.db.prepare('SELECT github_token_enc FROM services WHERE id=?').get(id);
    return r?.github_token_enc ? decrypt(this.key, r.github_token_enc) : null;
  }
  updateService(id, patch) {
    const sets = []; const vals = [];
    for (const c of SERVICE_COLS) if (c in patch) { sets.push(`${c}=?`); vals.push(c === 'auto_deploy' ? (patch[c] ? 1 : 0) : patch[c]); }
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

  // ── exécutions des tâches planifiées ──
  createRun(serviceId, trigger) {
    return this.tx(() => {
      const id = shortId();
      const number = (this.db.prepare('SELECT COALESCE(MAX(number),0)+1 AS n FROM job_runs WHERE service_id=?').get(serviceId)).n;
      this.db.prepare('INSERT INTO job_runs(id,service_id,number,status,trigger,started_at) VALUES(?,?,?,?,?,?)')
        .run(id, serviceId, number, 'running', trigger, now());
      return this.getRun(id);
    });
  }
  getRun(id) { return plain(this.db.prepare('SELECT * FROM job_runs WHERE id=?').get(id)); }
  finishRun(id, { status, exitCode = null, output = null }) {
    this.db.prepare('UPDATE job_runs SET status=?, finished_at=?, exit_code=?, output=? WHERE id=?')
      .run(status, now(), exitCode, output == null ? null : String(output).slice(-20000), id);
    return this.getRun(id);
  }
  listRuns(serviceId, limit = 30) {
    return this.db.prepare('SELECT * FROM job_runs WHERE service_id=? ORDER BY number DESC LIMIT ?').all(serviceId, Math.min(limit, 200)).map(plain);
  }
  runningRuns(serviceId) { return this.db.prepare("SELECT * FROM job_runs WHERE service_id=? AND status='running'").all(serviceId).map(plain); }
  pruneRuns(serviceId, keep = 50) {
    this.db.prepare('DELETE FROM job_runs WHERE service_id=? AND id NOT IN (SELECT id FROM job_runs WHERE service_id=? ORDER BY number DESC LIMIT ?)')
      .run(serviceId, serviceId, keep);
  }

  // ── sauvegardes ──
  addBackup(serviceId, { file, size = null, status = 'success', trigger = 'manual', error = null }) {
    const id = shortId();
    this.db.prepare('INSERT INTO backups(id,service_id,file,size,status,trigger,created_at,error) VALUES(?,?,?,?,?,?,?,?)')
      .run(id, serviceId, file, size, status, trigger, now(), error);
    return this.getBackup(id);
  }
  getBackup(id) { return plain(this.db.prepare('SELECT * FROM backups WHERE id=?').get(id)); }
  listBackups(serviceId, limit = 50) {
    return this.db.prepare('SELECT * FROM backups WHERE service_id=? ORDER BY created_at DESC LIMIT ?').all(serviceId, Math.min(limit, 200)).map(plain);
  }
  deleteBackup(id) { this.db.prepare('DELETE FROM backups WHERE id=?').run(id); }
  lastBackupAt(serviceId) { return this.db.prepare("SELECT MAX(created_at) AS at FROM backups WHERE service_id=? AND status='success'").get(serviceId)?.at ?? null; }

  // ── événements ──
  addEvent(e) {
    const id = shortId();
    const at = now();
    this.db.prepare('INSERT INTO events(id,at,kind,level,project_id,service_id,deployment_id,subject,message,actor) VALUES(?,?,?,?,?,?,?,?,?,?)')
      .run(id, at, e.kind, e.level || 'info', e.project_id ?? null, e.service_id ?? null, e.deployment_id ?? null, e.subject ?? null, e.message, e.actor ?? null);
    return { id, at, ...e };
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
