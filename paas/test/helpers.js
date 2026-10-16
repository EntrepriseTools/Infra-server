import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadConfig } from '../src/config.js';
import { Store } from '../src/db.js';
import { LogHub } from '../src/logs.js';
import { Routes } from '../src/routes.js';
import { Deployer } from '../src/deployer.js';
import { Monitor } from '../src/monitor.js';
import { Notifier } from '../src/notify.js';
import { createApp } from '../src/api.js';

export const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'rail-test-'));

/** Un docker de poche : il note ce qu'on lui demande, dans l'ordre, et se laisse scénariser. */
export class FakeRuntime {
  constructor() {
    this.calls = []; this.images = new Set(); this.containers = new Map(); // nom → état
    this.healthy = true; this.buildError = null; this.crashOnStart = false; this.env = {};
    this.restarts = {}; this.volumes = new Set(); this.execs = []; this.pulled = [];
    // Ce que la machine fait tourner en dehors de Rail (nginx de l'hôte, autre pile compose…).
    this.externes = [];
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
  async pull({ image, onLog }) { this.#n(`pull ${image}`); this.pulled.push(image); onLog?.(`Pulling ${image}\n`); this.images.add(image); }
  async imageExists(t) { return this.images.has(t); }
  async removeImage(t) { this.#n(`rmi ${t}`); this.images.delete(t); }
  async pruneImages() { this.#n('prune'); return 'Total reclaimed space: 0B'; }
  async start({ name, image, env, labels, alias, memoryMb, volumes = [], cmd = null }) {
    this.#n(`start ${name}`);
    this.env[name] = env; this.last = { name, image, labels, alias, memoryMb, volumes, cmd };
    for (const v of volumes) this.volumes.add(v.name);
    this.containers.set(name, this.crashOnStart ? 'exited' : 'running');
    return 'cid';
  }
  async stop(name) { this.#n(`stop ${name}`); this.containers.delete(name); }
  async halt(name) { this.#n(`halt ${name}`); if (this.containers.has(name)) this.containers.set(name, 'exited'); return true; }
  async resume(name) { this.#n(`resume ${name}`); if (this.containers.has(name)) this.containers.set(name, 'running'); return true; }
  async restart(name) { this.#n(`restart ${name}`); this.restarts[name] = (this.restarts[name] || 0) + 1; this.containers.set(name, 'running'); return true; }
  async state(name) { return this.containers.get(name) ?? null; }
  async inspect(name) {
    const st = this.containers.get(name);
    return st ? { status: st, startedAt: '2026-01-01T00:00:00Z', restarts: this.restarts[name] || 0, exitCode: 0, health: null, image: 'img' } : null;
  }
  async containersOf(id) { return [...this.containers.keys()].filter((n) => n.startsWith(`rail-${id}-`)); }
  /** Tous les conteneurs de la « machine » : ceux de Rail, plus ceux qu'on lui ajoute. */
  async listContainers({ all = true } = {}) {
    const miens = [...this.containers.entries()].map(([name, state]) => ({
      id: name, name, image: 'img', state, status: state === 'running' ? 'Up 2 minutes' : 'Exited (0)',
      created: '2026-01-01', ports: '', networks: 'rail',
      labels: { 'rail.managed': 'true', 'rail.service': /^rail-([0-9a-f]+)-/.exec(name)?.[1] ?? '' },
      service_id: /^rail-([0-9a-f]+)-/.exec(name)?.[1] ?? null, managed: true,
    }));
    const liste = [...miens, ...this.externes];
    return all ? liste : liste.filter((c) => c.state === 'running');
  }
  async logs(name, { onData }) { onData?.(`log de ${name}\n`); }
  async exec(name, args, { env = {}, input, onData, onErr } = {}) {
    this.execs.push({ name, args, env, input });
    if (this.execError) { onErr?.(this.execError); const e = new Error('docker exec a échoué'); e.output = ''; e.stderr = this.execError; throw e; }
    const out = this.execOut ?? (args[0] === 'psql' ? 'id,nom\n1,ana\n2,bo\n' : '-- sauvegarde\n');
    onData?.(out);
    return out;
  }
  async healthcheck() { return typeof this.healthy === 'function' ? this.healthy() : this.healthy; }
  async stats() {
    const out = {};
    for (const [n, st] of this.containers) if (st === 'running') out[n] = { cpu: 5.5, mem: 100 * 1024 * 1024, mem_limit: 512 * 1024 * 1024, rx: 1000, tx: 500, pids: 3 };
    for (const c of this.externes) if (c.state === 'running') out[c.name] = { cpu: 1.25, mem: 42 * 1024 * 1024, mem_limit: 0, rx: 10, tx: 20, pids: 1 };
    return out;
  }
  async systemDf() { return { images: { count: 2, active: 1, size: 1000, reclaimable: 500 } }; }
  async version() { return '27.0.0-test'; }
  async volumeRemove(name) { this.#n(`volume rm ${name}`); this.volumes.delete(name); return true; }
  async volumeSize() { return 4096; }
  async countRunning() { return [...this.containers.values()].filter((s) => s === 'running').length; }
}

export function env(overrides = {}) {
  const dir = tmp();
  const base = loadConfig({ RAIL_ADMIN_TOKEN: 'a'.repeat(32), RAIL_SECRET_KEY: 'ab'.repeat(32), RAIL_DOMAIN: 'apps.test.dev', RAIL_DATA_DIR: dir });
  const config = {
    ...loadConfig({ RAIL_ADMIN_TOKEN: 'a'.repeat(32), RAIL_SECRET_KEY: 'ab'.repeat(32), RAIL_DOMAIN: 'apps.test.dev', RAIL_DATA_DIR: dir, RAIL_GIT_BASE: `file://${dir}/git` }),
    defaultGithubToken: 'ghp_test', healthTimeoutMs: 400, healthIntervalMs: 10, switchGraceMs: 0, ...overrides,
  };
  // loadConfig renvoie des accesseurs (buildsDir…) : on les fige pour l'étalement ci-dessus.
  Object.assign(config, { buildsDir: base.buildsDir, logsDir: base.logsDir, routesDir: base.routesDir, dbFile: base.dbFile });
  const store = new Store(':memory:', config.secretKey);
  const logs = new LogHub(config.logsDir);
  const routes = new Routes(config.routesDir);
  const runtime = new FakeRuntime();
  const statuses = [];
  const github = { commitStatus: async (s) => { statuses.push(s); }, installWebhook: async () => 42 };
  const notifier = new Notifier({ url: config.notifyUrl });
  const deployer = new Deployer({ store, runtime, routes, logs, github, config, notifier });
  const monitor = new Monitor({ store, runtime, config, notifier, log: { error() {}, warn() {} } });
  return { dir, config, store, logs, routes, runtime, deployer, monitor, notifier, github, statuses };
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
  const p = e.store.findProject('demo') || e.store.createProject('demo');
  const s = e.store.createService(p.id, { name: 'api', repo: 'acme/api', branch: 'main', root_dir: '.', port: 3000, ...f });
  if (s.kind !== 'database') e.store.addDomain(s.id, `${s.name}-${p.name}.${e.config.domain}`, 'auto');
  return { project: p, service: s };
}

/** Démarre l'API sur un port libre et renvoie de quoi l'appeler. */
export async function serve(e) {
  const server = createApp({ config: e.config, store: e.store, deployer: e.deployer, runtime: e.runtime, logs: e.logs, github: e.github, monitor: e.monitor, notifier: e.notifier });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, body, token = e.config.adminToken, headers = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: { ...(token && { authorization: `Bearer ${token}` }), ...(body && { 'content-type': 'application/json' }), ...headers },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch { json = text; }
    return { status: res.status, body: json, headers: res.headers };
  };
  return { server, base, call, close: () => server.close() };
}
