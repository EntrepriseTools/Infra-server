// Le démarrage : lire la configuration, ouvrir le catalogue, remettre d'aplomb ce
// qu'un redémarrage a interrompu, puis écouter.
import fs from 'node:fs';
import { loadConfig } from './config.js';
import { Store } from './db.js';
import { LogHub } from './logs.js';
import { DockerRuntime } from './runtime.js';
import { Routes } from './routes.js';
import { GithubApi } from './github.js';
import { Notifier } from './notify.js';
import { Monitor } from './monitor.js';
import { Deployer } from './deployer.js';
import { Backups } from './backup.js';
import { Scheduler } from './scheduler.js';
import { Auth } from './auth.js';
import { createApp } from './api.js';
import { checkPassword, LOGIN_RE } from './users.js';

const config = loadConfig();
for (const d of [config.dataDir, config.buildsDir, config.logsDir, config.routesDir, config.backupsDir]) fs.mkdirSync(d, { recursive: true });
fs.rmSync(config.buildsDir, { recursive: true, force: true }); // restes d'un arrêt brutal
fs.mkdirSync(config.buildsDir, { recursive: true });

const store = new Store(config.dbFile, config.secretKey);
const logs = new LogHub(config.logsDir);
const runtime = new DockerRuntime({ network: config.network });
const routes = new Routes(config.routesDir, { entryPoint: config.entryPoint, certResolver: config.certResolver });
const github = new GithubApi({ apiBase: config.githubApi });
const notifier = new Notifier({ url: config.notifyUrl, onError: (e) => console.warn('[alerte]', e.message) });
const deployer = new Deployer({ store, runtime, routes, logs, github, config, notifier });
const monitor = new Monitor({ store, runtime, config, notifier, deployer });
const backups = new Backups({ store, runtime, config, notifier });
const scheduler = new Scheduler({ store, deployer, backups, config });
const auth = new Auth({ store, config });

// ── le premier compte ────────────────────────────────────────────────────
// Renseigner RAIL_ADMIN_LOGIN et RAIL_ADMIN_PASSWORD dans .env donne un compte
// prêt à l'emploi dès le premier démarrage (c'est ce que fait install.sh).
// Sans cela, le tableau de bord demande le jeton d'administration pour créer
// le compte à la main — et la fenêtre se referme dès qu'un compte existe.
if (store.countUsers() === 0 && config.bootstrapLogin && config.bootstrapPassword) {
  const why = LOGIN_RE.test(config.bootstrapLogin) ? checkPassword(config.bootstrapPassword) : 'identifiant invalide';
  if (why) console.error(`[rail] compte initial refusé : ${why} (RAIL_ADMIN_LOGIN / RAIL_ADMIN_PASSWORD)`);
  else {
    store.createUser({ login: config.bootstrapLogin, name: config.bootstrapLogin, role: 'admin', password: config.bootstrapPassword });
    store.addEvent({ kind: 'user.created', level: 'warn', subject: config.bootstrapLogin, actor: 'system', message: `compte administrateur « ${config.bootstrapLogin} » créé depuis .env` });
    console.log(`[rail] compte administrateur « ${config.bootstrapLogin} » créé`);
  }
}
store.pruneSessions();

await runtime.ensureNetwork();
// La route du tableau de bord appartient au plan de contrôle : elle se réécrit à chaque démarrage.
routes.set('core', { hosts: [config.dashboardHost], upstream: config.controlUpstream });
await deployer.reconcile();
monitor.start();
scheduler.start();
store.addEvent({ kind: 'system.start', level: 'info', actor: 'system', message: `plan de contrôle démarré (version ${config.version})` });

const server = createApp({ config, store, deployer, runtime, logs, github, monitor, notifier, backups, scheduler, auth });
server.listen(config.port, () => {
  console.log(`[rail] v${config.version} — plan de contrôle sur :${config.port} — tableau de bord https://${config.dashboardHost}`);
  if (store.countUsers() === 0) console.log('[rail] aucun compte : ouvrez le tableau de bord, le jeton d\'administration (RAIL_ADMIN_TOKEN) crée le premier.');
});

const stop = () => { monitor.stop(); scheduler.stop(); server.close(); setTimeout(() => process.exit(0), 200); };
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
