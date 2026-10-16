// Le seul endroit qui parle à Docker (via son CLI). Tout le reste de la plateforme
// passe par cette interface — c'est ce qui permet de la tester avec un faux.
import http from 'node:http';
import net from 'node:net';
import { run } from './proc.js';

const CLIENT_ENV_KEEP = ['PATH', 'HOME', 'DOCKER_HOST', 'DOCKER_CONFIG', 'DOCKER_CERT_PATH', 'DOCKER_TLS_VERIFY'];

/** GET http://host:port/path ; vrai si le statut est 2xx/3xx. */
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

/** Simple connexion TCP : la seule vérification possible pour ce qui ne parle pas HTTP (bases de données…). */
export function probeTcp({ host, port, timeoutMs = 3000 }) {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port });
    const done = (ok) => { sock.destroy(); resolve(ok); };
    sock.setTimeout(timeoutMs);
    sock.on('connect', () => done(true));
    sock.on('timeout', () => done(false));
    sock.on('error', () => done(false));
  });
}

/** « 5.9MiB », « 1.2GB », « 0B » → octets. Docker mélange les deux notations. */
export function parseSize(s) {
  const m = /^([\d.]+)\s*([a-zA-Z]*)$/.exec(String(s).trim());
  if (!m) return null;
  const mult = { b: 1, kb: 1e3, mb: 1e6, gb: 1e9, tb: 1e12, kib: 1024, mib: 1024 ** 2, gib: 1024 ** 3, tib: 1024 ** 4 };
  return Math.round(Number(m[1]) * (mult[m[2].toLowerCase()] ?? 1));
}
const pct = (s) => { const n = Number.parseFloat(String(s)); return Number.isFinite(n) ? n : null; };
const pair = (s) => String(s).split('/').map((x) => parseSize(x));

export class DockerRuntime {
  constructor({ network, docker = 'docker' }) { this.network = network; this.docker = docker; }

  #env(extra = {}) {
    const e = {};
    for (const k of CLIENT_ENV_KEEP) if (process.env[k]) e[k] = process.env[k];
    return { ...e, DOCKER_BUILDKIT: '1', ...extra };
  }
  // L'environnement calculé passe EN DERNIER : sinon l'étalement de `opts` le remplace
  // par les seules variables du service, le client docker perd son PATH, et spawn
  // échoue sur « docker ENOENT ».
  #d(args, opts = {}) { return run(this.docker, args, { ...opts, env: this.#env(opts.env) }); }

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
  /** Récupère une image publique (bases de données managées). */
  pull({ image, onLog, signal, timeoutMs }) { return this.#d(['pull', image], { onData: onLog, signal, timeoutMs }); }

  async imageExists(tag) {
    try { await this.#d(['image', 'inspect', tag]); return true; } catch { return false; }
  }
  async removeImage(tag) { try { await this.#d(['image', 'rm', tag]); } catch { /* utilisée ailleurs : on laisse */ } }
  /** Supprime les images orphelines (celles qu'aucun conteneur ni tag n'utilise). */
  pruneImages() { return this.#d(['image', 'prune', '-f']); }

  /**
   * Démarre un conteneur durci. Les variables passent par l'environnement du client
   * (`-e CLE` sans valeur) : jamais dans la liste d'arguments, donc jamais dans `ps`.
   */
  async start({ name, image, env, labels = {}, memoryMb, cpus, alias, volumes = [], cmd = null, caps = [], logMaxSizeMb = 10, logMaxFiles = 3 }) {
    const args = ['run', '-d', '--name', name, '--network', this.network, '--restart', 'unless-stopped',
      '--security-opt', 'no-new-privileges', '--cap-drop', 'ALL', '--cap-add', 'NET_BIND_SERVICE',
      '--pids-limit', '512', '--add-host', 'host.docker.internal:host-gateway',
      '--log-opt', `max-size=${logMaxSizeMb}m`, '--log-opt', `max-file=${logMaxFiles}`];
    for (const c of caps) args.push('--cap-add', c);
    if (alias) args.push('--network-alias', alias);
    if (memoryMb) args.push('--memory', `${memoryMb}m`);
    if (cpus) args.push('--cpus', String(cpus));
    for (const v of volumes) args.push('-v', `${v.name}:${v.path}`);
    for (const [k, v] of Object.entries(labels)) args.push('--label', `${k}=${v}`);
    for (const k of Object.keys(env)) args.push('-e', k);
    args.push(image);
    if (cmd) args.push(...cmd);
    return (await this.#d(args, { env })).trim();
  }

  async stop(name, graceS = 30) {
    try { await this.#d(['stop', '-t', String(graceS), name]); } catch { /* déjà arrêté ou absent */ }
    try { await this.#d(['rm', '-f', name]); } catch { /* idem */ }
  }
  /** Arrête SANS supprimer : le conteneur pourra redémarrer tel quel (« Arrêter » dans l'interface). */
  async halt(name, graceS = 30) { try { await this.#d(['stop', '-t', String(graceS), name]); return true; } catch { return false; } }
  async resume(name) { try { await this.#d(['start', name]); return true; } catch { return false; } }
  async restart(name, graceS = 30) { try { await this.#d(['restart', '-t', String(graceS), name]); return true; } catch { return false; } }

  async state(name) {
    try { return (await this.#d(['inspect', '-f', '{{.State.Status}}', name])).trim(); } catch { return null; }
  }
  /** État détaillé : statut, démarré à, redémarrages, code de sortie, santé Docker. */
  async inspect(name) {
    try {
      const out = await this.#d(['inspect', '-f',
        '{{.State.Status}}|{{.State.StartedAt}}|{{.RestartCount}}|{{.State.ExitCode}}|{{if .State.Health}}{{.State.Health.Status}}{{end}}|{{.Config.Image}}', name]);
      const [status, startedAt, restarts, exitCode, health, image] = out.trim().split('|');
      return { status, startedAt, restarts: Number(restarts) || 0, exitCode: Number(exitCode) || 0, health: health || null, image };
    } catch { return null; }
  }
  /**
   * TOUS les conteneurs de la machine, pas seulement ceux de Rail : un serveur
   * porte souvent d'autres piles (compose, bases installées à la main…), et on veut
   * les voir et les surveiller depuis le même tableau de bord.
   */
  async listContainers({ all = true } = {}) {
    const args = ['ps', '--format', '{{json .}}'];
    if (all) args.push('-a');
    const out = await this.#d(args);
    const list = [];
    for (const line of out.split('\n')) {
      if (!line.trim()) continue;
      let c; try { c = JSON.parse(line); } catch { continue; }
      const labels = {};
      for (const kv of String(c.Labels || '').split(',')) {
        const i = kv.indexOf('=');
        if (i > 0) labels[kv.slice(0, i)] = kv.slice(i + 1);
      }
      list.push({
        id: c.ID, name: c.Names.split(',')[0], image: c.Image,
        state: c.State || (/^Up/.test(c.Status) ? 'running' : 'exited'),
        status: c.Status, created: c.CreatedAt, ports: c.Ports || '',
        networks: c.Networks || '', labels,
        service_id: labels['rail.service'] || null,
        managed: labels['rail.managed'] === 'true',
      });
    }
    return list.sort((a, b) => a.name.localeCompare(b.name));
  }
  /** Noms des conteneurs gérés par la plateforme pour un service. */
  async containersOf(serviceId) {
    const out = await this.#d(['ps', '-a', '--filter', `label=rail.service=${serviceId}`, '--format', '{{.Names}}']);
    return out.split('\n').map((s) => s.trim()).filter(Boolean);
  }
  async logs(name, { tail = 200, follow = false, onData, signal, since }) {
    const args = ['logs', '--timestamps', '--tail', String(tail)];
    if (since) args.push('--since', since);
    if (follow) args.push('-f');
    args.push(name);
    try { await this.#d(args, { onData, signal }); } catch (e) { if (!signal?.aborted) throw e; }
  }
  /**
   * Exécute une commande DANS un conteneur (sauvegarde, requête SQL…).
   * `input` arrive par l'entrée standard : une requête n'apparaît jamais dans `ps` de l'hôte.
   */
  exec(name, args, { env = {}, input, onData, onErr, signal, timeoutMs } = {}) {
    const a = ['exec'];
    if (input !== undefined) a.push('-i');
    for (const k of Object.keys(env)) a.push('-e', k);
    a.push(name, ...args);
    return this.#d(a, { env, input, onData, onErr, signal, timeoutMs });
  }
  healthcheck({ name, port, path }) {
    return path ? probeHttp({ host: name, port, path }) : probeTcp({ host: name, port });
  }

  // ── volumes ──
  async volumeRemove(name) { try { await this.#d(['volume', 'rm', name]); return true; } catch { return false; } }
  async volumeSize(name) {
    try {
      const out = await this.#d(['system', 'df', '-v', '--format', '{{json .Volumes}}']);
      const v = JSON.parse(out).find((x) => x.Name === name);
      return v ? parseSize(v.Size) : null;
    } catch { return null; }
  }

  // ── mesures ──
  /** Un instantané CPU/mémoire/réseau de TOUS les conteneurs en marche, par nom. */
  async stats() {
    const names = (await this.#d(['ps', '--format', '{{.Names}}']))
      .split('\n').map((s) => s.trim()).filter(Boolean);
    if (!names.length) return {};
    const out = await this.#d(['stats', '--no-stream', '--format', '{{json .}}', ...names]);
    const byName = {};
    for (const line of out.split('\n')) {
      if (!line.trim()) continue;
      let s; try { s = JSON.parse(line); } catch { continue; }
      const [mem, memLimit] = pair(s.MemUsage);
      const [rx, tx] = pair(s.NetIO);
      byName[s.Name] = { cpu: pct(s.CPUPerc), mem, mem_limit: memLimit, rx, tx, pids: Number(s.PIDs) || 0 };
    }
    return byName;
  }
  /** Place occupée par Docker : images, conteneurs, volumes, et ce qui est récupérable. */
  async systemDf() {
    const out = await this.#d(['system', 'df', '--format', '{{json .}}']);
    const rows = {};
    for (const line of out.split('\n')) {
      if (!line.trim()) continue;
      let r; try { r = JSON.parse(line); } catch { continue; }
      rows[String(r.Type).toLowerCase()] = {
        count: Number(r.TotalCount) || 0, active: Number(r.Active) || 0,
        size: parseSize(r.Size), reclaimable: parseSize(String(r.Reclaimable).split(' ')[0]),
      };
    }
    return rows;
  }
  async version() {
    try { return (await this.#d(['version', '-f', '{{.Server.Version}}'])).trim(); } catch { return null; }
  }
  /** Nombre de conteneurs gérés par la plateforme, en marche. */
  async countRunning() {
    const out = await this.#d(['ps', '--filter', 'label=rail.managed=true', '--format', '{{.Names}}']);
    return out.split('\n').filter((s) => s.trim()).length;
  }
}
