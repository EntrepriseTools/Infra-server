import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadConfig } from '../src/config.js';
import { Store } from '../src/db.js';
import { LogHub } from '../src/logs.js';
import { Routes } from '../src/routes.js';
import { Deployer } from '../src/deployer.js';

export const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'rail-test-'));

/** Un docker de poche : il note ce qu'on lui demande, dans l'ordre, et se laisse scénariser. */
export class FakeRuntime {
  constructor() {
    this.calls = []; this.images = new Set(); this.containers = new Map(); // nom → état
    this.healthy = true; this.buildError = null; this.crashOnStart = false; this.env = {};
  }
  #n(entry) { this.calls.push(entry); }
  async ensureNetwork() {}
  async build({ tag, dockerfile, contextDir, onLog }) {
    this.#n(`build ${tag}`);
    this.lastBuild = { tag, dockerfile, contextDir, files: fs.readdirSync(contextDir) };
    onLog?.('Step 1/1 : FROM scratch\n');
    if (this.buildError) throw new Error(this.buildError);
    this.images.add(tag);
  }
  async imageExists(t) { return this.images.has(t); }
  async removeImage(t) { this.#n(`rmi ${t}`); this.images.delete(t); }
  async start({ name, image, env, labels, alias, memoryMb }) {
    this.#n(`start ${name}`);
    this.env[name] = env; this.last = { name, image, labels, alias, memoryMb };
    this.containers.set(name, this.crashOnStart ? 'exited' : 'running');
    return 'cid';
  }
  async stop(name) { this.#n(`stop ${name}`); this.containers.delete(name); }
  async state(name) { return this.containers.get(name) ?? null; }
  async containersOf(id) { return [...this.containers.keys()].filter((n) => n.startsWith(`rail-${id}-`)); }
  async logs(name, { onData }) { onData?.(`log de ${name}\n`); }
  async healthcheck() { return typeof this.healthy === 'function' ? this.healthy() : this.healthy; }
}

export function env(overrides = {}) {
  const dir = tmp();
  const config = {
    ...loadConfig({ RAIL_ADMIN_TOKEN: 'a'.repeat(32), RAIL_SECRET_KEY: 'ab'.repeat(32), RAIL_DOMAIN: 'apps.test.dev', RAIL_DATA_DIR: dir, RAIL_GIT_BASE: `file://${dir}/git` }),
    defaultGithubToken: 'ghp_test', healthTimeoutMs: 400, healthIntervalMs: 10, switchGraceMs: 0, ...overrides,
  };
  // loadConfig renvoie des accesseurs (buildsDir…) : on les fige pour l'étalement ci-dessus.
  const base = loadConfig({ RAIL_ADMIN_TOKEN: 'a'.repeat(32), RAIL_SECRET_KEY: 'ab'.repeat(32), RAIL_DOMAIN: 'apps.test.dev', RAIL_DATA_DIR: dir });
  Object.assign(config, { buildsDir: base.buildsDir, logsDir: base.logsDir, routesDir: base.routesDir, dbFile: base.dbFile });
  const store = new Store(':memory:', config.secretKey);
  const logs = new LogHub(config.logsDir);
  const routes = new Routes(config.routesDir);
  const runtime = new FakeRuntime();
  const statuses = [];
  const github = { commitStatus: async (s) => { statuses.push(s); }, installWebhook: async () => 42 };
  const deployer = new Deployer({ store, runtime, routes, logs, github, config });
  return { dir, config, store, logs, routes, runtime, deployer, github, statuses };
}

/** Crée un vrai dépôt git local à <dir>/git/<repo>.git (le code est cloné via file://). */
export function makeRepo(dir, repo, files, branch = 'main') {
  const work = path.join(dir, 'git', `${repo}.git`);
  fs.mkdirSync(work, { recursive: true });
  const g = (...a) => execFileSync('git', ['-C', work, '-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { encoding: 'utf8' });
  g('init', '-q', '-b', branch);
  const commit = (fs_, msg) => {
    for (const [f, c] of Object.entries(fs_)) { fs.mkdirSync(path.dirname(path.join(work, f)), { recursive: true }); fs.writeFileSync(path.join(work, f), c); }
    g('add', '-A'); g('commit', '-q', '-m', msg);
    return g('rev-parse', 'HEAD').trim();
  };
  const first = commit(files, 'premier commit');
  return { commit, first };
}

export function seedService(e, f = {}) {
  const p = e.store.createProject('demo');
  const s = e.store.createService(p.id, { name: 'api', repo: 'acme/api', branch: 'main', root_dir: '.', port: 3000, ...f });
  e.store.addDomain(s.id, `api-demo.${e.config.domain}`, 'auto');
  return { project: p, service: s };
}
