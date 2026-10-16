// Configuration lue une fois, depuis l'environnement, et validée tout de suite :
// un plan de contrôle qui démarre avec un secret faible vaut moins que pas de plan de contrôle.
import fs from 'node:fs';
import path from 'node:path';

const PKG = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

const int = (v, d) => (v === undefined || v === '' ? d : Number.parseInt(v, 10));

const bool = (v, d) => (v === undefined || v === '' ? d : !/^(0|false|non|no)$/i.test(v));

export function loadConfig(env = process.env) {
  const need = (k) => {
    if (!env[k]) throw new Error(`${k} est obligatoire (voir paas/.env.example)`);
    return env[k];
  };
  const adminToken = need('RAIL_ADMIN_TOKEN');
  if (adminToken.length < 24) throw new Error('RAIL_ADMIN_TOKEN doit faire au moins 24 caractères');
  const secretKey = need('RAIL_SECRET_KEY');
  if (!/^[0-9a-f]{64}$/i.test(secretKey)) throw new Error('RAIL_SECRET_KEY doit être 64 caractères hexadécimaux (openssl rand -hex 32)');
  const domain = need('RAIL_DOMAIN').toLowerCase();
  if (!/^([a-z0-9-]+\.)+[a-z]{2,}$/.test(domain)) throw new Error('RAIL_DOMAIN doit être un nom de domaine (ex. apps.exemple.com)');

  const dataDir = path.resolve(env.RAIL_DATA_DIR || '/data');
  const port = int(env.RAIL_PORT, 4000);
  const dashboardHost = (env.RAIL_DASHBOARD_HOST || `rail.${domain}`).toLowerCase();

  // ── Par où le monde entre ──────────────────────────────────────────────
  // acme  : Rail tient le 80 et le 443, certificats Let's Encrypt (défi HTTP-01).
  // dns   : Rail peut être sur d'autres ports ; le certificat s'obtient par DNS-01.
  // proxy : un serveur devant (nginx…) fait le HTTPS et transmet à Rail, en clair.
  const tlsMode = env.RAIL_TLS || 'acme';
  if (!['acme', 'dns', 'proxy'].includes(tlsMode)) throw new Error('RAIL_TLS doit valoir acme, dns ou proxy');
  const httpPort = int(env.RAIL_HTTP_PORT, 80);
  const httpsPort = int(env.RAIL_HTTPS_PORT, 443);
  for (const [k, v] of [['RAIL_HTTP_PORT', httpPort], ['RAIL_HTTPS_PORT', httpsPort]]) {
    if (!Number.isInteger(v) || v < 1 || v > 65535) throw new Error(`${k} doit être un port valide`);
  }
  // En mode « proxy », l'adresse publique est celle du serveur de devant, pas la nôtre.
  const siteScheme = env.RAIL_SITE_SCHEME || (tlsMode === 'proxy' ? 'https' : 'https');
  if (!['http', 'https'].includes(siteScheme)) throw new Error('RAIL_SITE_SCHEME doit valoir http ou https');
  const sitePort = int(env.RAIL_SITE_PORT, tlsMode === 'proxy' ? (siteScheme === 'https' ? 443 : 80) : httpsPort);
  /** L'adresse publique d'un nom d'hôte, port sous-entendu quand il est celui du schéma. */
  const urlFor = (host) => {
    const defaut = siteScheme === 'https' ? 443 : 80;
    return `${siteScheme}://${host}${sitePort === defaut ? '' : `:${sitePort}`}`;
  };
  return {
    tlsMode,
    httpPort,
    httpsPort,
    siteScheme,
    sitePort,
    urlFor,
    // L'entrée Traefik et le résolveur que les fichiers de route doivent viser.
    entryPoint: tlsMode === 'proxy' ? 'web' : 'websecure',
    certResolver: tlsMode === 'proxy' ? null : 'le',
    version: PKG.version,
    domain,
    dashboardHost,
    publicUrl: env.RAIL_PUBLIC_URL || urlFor(dashboardHost),
    controlUpstream: env.RAIL_CONTROL_UPSTREAM || `http://rail-control:${port}`,
    port,
    dataDir,
    network: env.RAIL_NETWORK || 'rail',
    adminToken,
    secretKey: Buffer.from(secretKey, 'hex'),
    gitBase: (env.RAIL_GIT_BASE || 'https://github.com').replace(/\/$/, ''),
    githubApi: (env.RAIL_GITHUB_API || 'https://api.github.com').replace(/\/$/, ''),
    defaultGithubToken: env.GITHUB_TOKEN || null,
    keepImages: int(env.RAIL_KEEP_IMAGES, 5),
    healthTimeoutMs: int(env.RAIL_HEALTH_TIMEOUT_S, 120) * 1000,
    healthIntervalMs: int(env.RAIL_HEALTH_INTERVAL_MS, 1000),
    switchGraceMs: int(env.RAIL_SWITCH_GRACE_MS, 3000),
    maxBuilds: int(env.RAIL_MAX_BUILDS, 2),
    buildTimeoutMs: int(env.RAIL_BUILD_TIMEOUT_S, 1800) * 1000,
    defaultMemoryMb: int(env.RAIL_DEFAULT_MEMORY_MB, 512),
    defaultCpus: Number.parseFloat(env.RAIL_DEFAULT_CPUS || '1'),
    // ── surveillance ──
    metricsIntervalMs: int(env.RAIL_METRICS_INTERVAL_S, 15) * 1000,
    metricsRetentionS: int(env.RAIL_METRICS_RETENTION_H, 72) * 3600,
    eventsKeep: int(env.RAIL_EVENTS_KEEP, 5000),
    autoHeal: bool(env.RAIL_AUTO_HEAL, true),
    // Rotation des journaux des conteneurs : sans elle, un service bavard remplit le disque.
    logMaxSizeMb: int(env.RAIL_CONTAINER_LOG_MB, 10),
    logMaxFiles: int(env.RAIL_CONTAINER_LOG_FILES, 3),
    // ── alertes ──
    notifyUrl: env.RAIL_NOTIFY_URL || null,
    notifySuccess: bool(env.RAIL_NOTIFY_SUCCESS, false),
    get buildsDir() { return path.join(dataDir, 'builds'); },
    get logsDir() { return path.join(dataDir, 'logs'); },
    get routesDir() { return path.join(dataDir, 'traefik', 'dynamic'); },
    get dbFile() { return path.join(dataDir, 'rail.db'); },
  };
}
