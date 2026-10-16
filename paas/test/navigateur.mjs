// Le tableau de bord, dans un VRAI navigateur. Facultatif : ce test demande
// Chromium et `playwright-core`, que le dépôt ne veut pas en dépendance.
//
//   npm i --no-save playwright-core
//   CHROME=/chemin/vers/chrome node test/navigateur.mjs [--photos /tmp/rail]
//
// Il monte l'API avec le faux Docker, la remplit de données crédibles, puis
// clique : créer un projet, créer une base, lire les journaux, filtrer, changer
// les variables, arrêter, démarrer, déployer, changer de fenêtre de mesures.
// Toute erreur de console ou d'exécution fait échouer le test.
import process from 'node:process';
import { env, makeRepo, seedService, serve } from './helpers.js';
import { provision } from '../src/databases.js';

const CHROME = process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const photos = process.argv.includes('--photos') ? process.argv[process.argv.indexOf('--photos') + 1] : null;

let chromium;
try { ({ chromium } = await import('playwright-core')); }
catch { console.log('playwright-core absent : test du navigateur ignoré (npm i --no-save playwright-core)'); process.exit(0); }

// ── des données crédibles ────────────────────────────────────────────────
const e = env();
makeRepo(e.dir, 'acme/api', { 'package.json': '{"scripts":{"start":"node s.js"}}', 's.js': '//' });
const { project, service } = seedService(e);
e.store.setVars(service.id, { JWT_SECRET: 'secret', DATABASE_URL: '${{base.DATABASE_URL}}' });
const { fields, vars } = provision({ engine: 'postgres', name: 'base', project: project.name });
const db = e.store.createService(project.id, fields);
e.store.setVars(db.id, vars);
e.deployer.deploy(service.id); e.deployer.deploy(db.id);
await e.deployer.drain();
// Le serveur fait aussi tourner autre chose que Rail.
e.runtime.externes = [
  { id: 'c1', name: 'nginx-maison', image: 'nginx:1.27', state: 'running', status: 'Up 3 days', created: '2026-01-01', ports: '0.0.0.0:8080->80/tcp', networks: 'bridge', labels: {}, service_id: null, managed: false },
];

const maintenant = Math.floor(Date.now() / 1000);
for (let i = 240; i >= 0; i--) {
  const t = maintenant - i * 15;
  e.store.addSample(service.id, t, { cpu: 18 + Math.sin(i / 9) * 10, mem: 180e6 + Math.sin(i / 20) * 30e6, mem_limit: 512e6, rx: 4e5 + i * 2500, tx: 1.2e5 + i * 900, up: i === 120 ? 0 : 1 });
  e.store.addHostSample(t, { cpu: 22 + Math.sin(i / 14) * 12, load1: 0.8, mem: 5.1e9, mem_total: 16e9, disk: 41e9, disk_total: 100e9, containers: 2 });
}
await e.monitor.tick();
const { base, close } = await serve(e);

// ── le navigateur ────────────────────────────────────────────────────────
const nav = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
const page = await nav.newPage({ viewport: { width: 1280, height: 1000 } });
const erreurs = [];
page.on('pageerror', (x) => erreurs.push(`erreur de page : ${x.message}`));
page.on('console', (m) => { if (m.type() === 'error') erreurs.push(`console : ${m.text()}`); });
page.on('requestfailed', (r) => erreurs.push(`requête échouée : ${r.url()}`));
page.on('dialog', (d) => d.accept());

let rates = 0;
const etape = async (nom, fn) => {
  try { await fn(); console.log(`  ok    ${nom}`); }
  catch (x) { rates++; console.log(`  ÉCHEC ${nom} : ${x.message.split('\n')[0]}`); }
};
const photo = async (nom) => { if (photos) await page.screenshot({ path: `${photos}/${nom}.png`, fullPage: true }); };

await page.goto(`${base}/`);
await page.fill('input[type=password]', e.config.adminToken);
await page.click('button[type=submit]');
await page.waitForSelector('.tile', { timeout: 10000 });
await photo('accueil');

await etape('créer un projet', async () => {
  await page.click('text=+ Nouveau projet');
  await page.fill('dialog input', 'nouveau');
  await page.click('dialog button[type=submit]');
  await page.waitForSelector('h2:text("nouveau")', { timeout: 5000 });
});
await etape('créer une base de données', async () => {
  await page.locator('div.row.sp', { has: page.locator('h2:text("nouveau")') }).locator('text=+ Base de données').click();
  await page.selectOption('dialog select', 'redis');
  await page.fill('dialog input', 'cache');
  await page.click('dialog button[type=submit]');
  await page.waitForSelector('text=Réseau privé', { timeout: 5000 });
});
await etape('aperçu : tuiles et graphiques', async () => {
  await page.goto(`${base}/#/services/${service.id}/apercu`);
  await page.waitForSelector('.chart svg', { timeout: 5000 });
  if (await page.locator('.chart').count() < 3) throw new Error('processeur, mémoire et réseau attendus');
  const boite = await page.locator('.chart').first().boundingBox();
  await page.locator('.chart').first().hover({ position: { x: boite.width * 0.6, y: 50 } });
  if (!(await page.locator('.chart .tip').first().isVisible())) throw new Error('pas d\'infobulle au survol');
  await photo('service-apercu');
});
await etape('journal d\'exécution, en direct et filtrable', async () => {
  await page.goto(`${base}/#/services/${service.id}/logs`);
  await page.waitForFunction(() => document.querySelector('pre.log')?.textContent.includes('log de rail-'), null, { timeout: 6000 });
  await page.fill('input[placeholder^="filtrer"]', 'zzz');
  await page.waitForTimeout(200);
  if ((await page.locator('pre.log').textContent()).trim() !== '') throw new Error('le filtre ne filtre pas');
});
await etape('journal de construction (fenêtre)', async () => {
  await page.goto(`${base}/#/services/${service.id}/deployments`);
  await page.click('table button:text("Logs")');
  await page.waitForFunction(() => document.querySelector('dialog pre.log')?.textContent.includes('En service sur'), null, { timeout: 6000 });
  await page.click('dialog button:text("Fermer")');
});
await etape('variables : ajouter et enregistrer', async () => {
  await page.goto(`${base}/#/services/${service.id}/variables`);
  await page.waitForSelector('input.k');
  await page.click('button:text("+ Variable")');
  const n = await page.locator('input.k').count();
  await page.locator('input.k').nth(n - 1).fill('NOUVELLE');
  await page.locator('input.v').nth(n - 1).fill('valeur');
  await page.click('button:text("Enregistrer")');
  await page.waitForSelector('.toast', { timeout: 5000 });
});
await etape('arrêter puis démarrer', async () => {
  await page.goto(`${base}/#/services/${service.id}/apercu`);
  await page.click('button:text("Arrêter")');
  await page.waitForSelector('button:text("Démarrer")', { timeout: 6000 });
  await page.click('button:text("Démarrer")');
  await page.waitForSelector('button:text("Arrêter")', { timeout: 6000 });
});
await etape('déployer', async () => {
  await page.click('button:text("Déployer")');
  await page.waitForURL(/deployments$/, { timeout: 6000 });
  await page.waitForFunction(() => document.querySelectorAll('table tbody tr').length >= 2, null, { timeout: 10000 });
});
await etape('changer de fenêtre de mesures', async () => {
  await page.goto(`${base}/#/services/${service.id}/apercu`);
  await page.waitForSelector('.chart svg');
  await page.click('button:text("24h")');
  await page.waitForSelector('text=PROCESSEUR (24H)', { timeout: 5000 });
});
await etape('identifiants de la base', async () => {
  await page.goto(`${base}/#/services/${db.id}/variables`);
  await page.waitForSelector('text=IDENTIFIANTS DE CONNEXION', { timeout: 5000 });
  await photo('base-connexion');
});
await etape('console SQL : tables, requête, résultat', async () => {
  await page.goto(`${base}/#/services/${db.id}/sql`);
  await page.waitForSelector('textarea', { timeout: 5000 });
  await page.waitForSelector('.tables button', { timeout: 5000 });
  await page.fill('textarea', 'SELECT * FROM gens');
  await page.click('button:text("Exécuter")');
  await page.waitForSelector('.result table tbody tr', { timeout: 5000 });
  const lignes = await page.locator('.result table tbody tr').count();
  if (lignes < 2) throw new Error('résultat vide');
  await photo('sql');
});
await etape('conteneurs de la machine', async () => {
  await page.goto(`${base}/#/containers`);
  await page.waitForSelector('table tbody tr', { timeout: 5000 });
  if (!(await page.locator('text=nginx-maison').count())) throw new Error('les conteneurs hors Rail ne sont pas listés');
  await photo('conteneurs');
});
await etape('activité et système', async () => {
  await page.goto(`${base}/#/activity`);
  await page.click('button:text("Erreurs")');
  await page.goto(`${base}/#/system`);
  await page.waitForSelector('text=PLACE OCCUPÉE PAR DOCKER', { timeout: 5000 });
  await photo('systeme');
});
await etape('téléphone : pas de défilement horizontal', async () => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${base}/#/services/${service.id}/apercu`);
  await page.waitForSelector('.chart svg');
  await photo('mobile');
  if (await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1)) throw new Error('la page déborde à droite');
});

await nav.close();
close();
for (const x of erreurs) console.log(`  ERREUR ${x}`);
const total = rates + erreurs.length;
console.log(total ? `\n${total} problème(s)` : '\nLe tableau de bord répond à tous les gestes, sans une erreur de console.');
process.exit(total ? 1 : 0);
