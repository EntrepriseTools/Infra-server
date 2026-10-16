// Le lien avec Traefik : un fichier de configuration dynamique par service, écrit de façon
// atomique (fichier temporaire + rename). Traefik surveille le dossier et recharge seul.
// Le basculement du trafic est l'écriture de ce fichier — après que le nouveau conteneur est sain.
import fs from 'node:fs';
import path from 'node:path';

const rule = (hosts) => hosts.map((h) => `Host(\`${h}\`)`).join(' || ');

function writeAtomic(file, content) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, content, { mode: 0o644 });
  fs.renameSync(tmp, file);
}

export class Routes {
  /** @param opts.entryPoint entrée Traefik visée ; opts.certResolver null quand un proxy fait le TLS. */
  constructor(dir, { entryPoint = 'websecure', certResolver = 'le' } = {}) {
    this.dir = dir; this.entryPoint = entryPoint; this.certResolver = certResolver;
    fs.mkdirSync(dir, { recursive: true });
  }
  #file(key) { return path.join(this.dir, `${key}.yml`); }

  // JSON est du YAML valide : pas de sérialiseur YAML à maintenir, pas d'échappement à rater.
  set(key, { hosts, upstream }) {
    if (!hosts.length) return this.remove(key);
    const name = `rail-${key}`;
    writeAtomic(this.#file(key), JSON.stringify({
      http: {
        routers: {
          [name]: {
            rule: rule(hosts), entryPoints: [this.entryPoint], service: name,
            ...(this.certResolver ? { tls: { certResolver: this.certResolver } } : {}),
          },
        },
        services: { [name]: { loadBalancer: { servers: [{ url: upstream }], passHostHeader: true } } },
      },
    }, null, 2));
  }
  remove(key) { fs.rmSync(this.#file(key), { force: true }); }
  has(key) { return fs.existsSync(this.#file(key)); }
}
