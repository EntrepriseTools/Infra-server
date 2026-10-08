// Le seul endroit qui parle à Docker (via son CLI). Tout le reste de la plateforme
// passe par cette interface — c'est ce qui permet de la tester avec un faux.
import http from 'node:http';
import { run } from './proc.js';

const CLIENT_ENV_KEEP = ['PATH', 'HOME', 'DOCKER_HOST', 'DOCKER_CONFIG', 'DOCKER_CERT_PATH', 'DOCKER_TLS_VERIFY'];

/** GET http://host:port/path ; vrai si le statut est 2xx/3xx. Sans chemin : simple connexion TCP. */
export function probeHttp({ host, port, path, timeoutMs = 3000 }) {
  return new Promise((resolve) => {
    const req = http.get({ host, port, path: path || '/', timeout: timeoutMs, headers: { 'user-agent': 'rail-healthcheck' } }, (res) => {
      res.resume();
      resolve(path ? res.statusCode >= 200 && res.statusCode < 400 : true);
    });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}

export class DockerRuntime {
  constructor({ network, docker = 'docker' }) { this.network = network; this.docker = docker; }

  #env(extra = {}) {
    const e = {};
    for (const k of CLIENT_ENV_KEEP) if (process.env[k]) e[k] = process.env[k];
    return { ...e, DOCKER_BUILDKIT: '1', ...extra };
  }
  #d(args, opts = {}) { return run(this.docker, args, { env: this.#env(opts.env), ...opts }); }

  async ensureNetwork() {
    try { await this.#d(['network', 'inspect', this.network]); }
    catch { await this.#d(['network', 'create', this.network]); }
  }

  build({ contextDir, dockerfile, tag, labels = {}, onLog, signal, timeoutMs }) {
    const args = ['build', '--progress=plain', '-f', dockerfile, '-t', tag];
    for (const [k, v] of Object.entries(labels)) args.push('--label', `${k}=${v}`);
    args.push(contextDir);
    return this.#d(args, { onData: onLog, signal, timeoutMs });
  }

  async imageExists(tag) {
    try { await this.#d(['image', 'inspect', tag]); return true; } catch { return false; }
  }
  async removeImage(tag) { try { await this.#d(['image', 'rm', tag]); } catch { /* utilisée ailleurs : on laisse */ } }

  /**
   * Démarre un conteneur durci. Les variables passent par l'environnement du client
   * (`-e CLE` sans valeur) : jamais dans la liste d'arguments, donc jamais dans `ps`.
   */
  async start({ name, image, env, labels = {}, memoryMb, cpus, alias }) {
    const args = ['run', '-d', '--name', name, '--network', this.network, '--restart', 'unless-stopped',
      '--security-opt', 'no-new-privileges', '--cap-drop', 'ALL', '--cap-add', 'NET_BIND_SERVICE',
      '--pids-limit', '512', '--add-host', 'host.docker.internal:host-gateway'];
    if (alias) args.push('--network-alias', alias);
    if (memoryMb) args.push('--memory', `${memoryMb}m`);
    if (cpus) args.push('--cpus', String(cpus));
    for (const [k, v] of Object.entries(labels)) args.push('--label', `${k}=${v}`);
    for (const k of Object.keys(env)) args.push('-e', k);
    args.push(image);
    return (await this.#d(args, { env })).trim();
  }

  async stop(name, graceS = 30) {
    try { await this.#d(['stop', '-t', String(graceS), name]); } catch { /* déjà arrêté ou absent */ }
    try { await this.#d(['rm', '-f', name]); } catch { /* idem */ }
  }
  async state(name) {
    try { return (await this.#d(['inspect', '-f', '{{.State.Status}}', name])).trim(); } catch { return null; }
  }
  /** Noms des conteneurs gérés par la plateforme pour un service. */
  async containersOf(serviceId) {
    const out = await this.#d(['ps', '-a', '--filter', `label=rail.service=${serviceId}`, '--format', '{{.Names}}']);
    return out.split('\n').map((s) => s.trim()).filter(Boolean);
  }
  async logs(name, { tail = 200, follow = false, onData, signal }) {
    const args = ['logs', '--timestamps', '--tail', String(tail)];
    if (follow) args.push('-f');
    args.push(name);
    try { await this.#d(args, { onData, signal }); } catch (e) { if (!signal?.aborted) throw e; }
  }
  healthcheck({ name, port, path }) { return probeHttp({ host: name, port, path }); }
}
