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
import { createApp } from './api.js';

const config = loadConfig();
for (const d of [config.dataDir, config.buildsDir, config.logsDir, config.routesDir]) fs.mkdirSync(d, { recursive: true });
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

await runtime.ensureNetwork();
// La route du tableau de bord appartient au plan de contrôle : elle se réécrit à chaque démarrage.
routes.set('core', { hosts: [config.dashboardHost], upstream: config.controlUpstream });
await deployer.reconcile();
monitor.start();
store.addEvent({ kind: 'system.start', level: 'info', message: `plan de contrôle démarré (version ${config.version})` });

const server = createApp({ config, store, deployer, runtime, logs, github, monitor, notifier });
server.listen(config.port, () => console.log(`[rail] v${config.version} — plan de contrôle sur :${config.port} — tableau de bord https://${config.dashboardHost}`));

const stop = () => { monitor.stop(); server.close(); setTimeout(() => process.exit(0), 200); };
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
