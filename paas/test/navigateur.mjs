// Le tableau de bord, dans un VRAI navigateur. Facultatif : ce test demande
// Chromium et `playwright-core`, que le dépôt ne veut pas en dépendance.
//
//   npm i --no-save playwright-core
//   CHROME=/chemin/vers/chrome node test/navigateur.mjs [--photos /tmp/rail]
//
// Il monte l'API avec le faux Docker, la remplit de données crédibles, puis
// clique : se connecter, créer un projet, un service depuis une image, une base,
// une tâche planifiée, déployer un modèle, lire les journaux, requêter, sauvegarder,
// changer les variables, gérer les comptes. Toute erreur de console fait échouer.
import process from 'node:process';
import { env, makeRepo, seedService, seedUser, serve } from './helpers.js';
import { provision } from '../src/databases.js';

const CHROME = process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const photos = process.argv.includes('--photos') ? process.argv[process.argv.indexOf('--photos') + 1] : null;

let chromium;
try { ({ chromium } = await import('playwright-core')); }
catch { console.log('playwright-core absent : test du navigateur ignoré (npm i --no-save playwright-core)'); process.exit(0); }

// ── des données crédibles ────────────────────────────────────────────────
// Le serveur d'essai parle en clair : le cookie de session ne doit pas être « Secure ».
const e = env({ siteScheme: 'http' });
makeRepo(e.dir, 'acme/api', { 'package.json': '{"scripts":{"start":"node s.js"}}', 's.js': '//' });
const compte = seedUser(e, { login: 'ana', role: 'admin' });
seedUser(e, { login: 'zoe', role: 'viewer' });
const { project, service } = seedService(e);
e.store.setVars(service.id, { JWT_SECRET: 'secret', DATABASE_URL: '${{base.DATABASE_URL}}' });
const { fields, vars } = provision({ engine: 'postgres', name: 'base', project: project.name });
const db = e.store.createService(project.id, fields);
e.store.setVars(db.id, vars);
// Une tâche planifiée, pour voir ses exécutions.
const tache = e.store.createService(project.id, {
  name: 'menage', kind: 'cron', source_kind: 'image', base_image: 'alpine:3', port: 1,
  cron_schedule: '0 3 * * *', start_command: 'echo bonjour', auto_deploy: false, repo: '', branch: '', root_dir: '.',
});
e.deployer.deploy(service.id); e.deployer.deploy(db.id); e.deployer.deploy(tache.id);
await e.deployer.drain();
e.deployer.runJob(tache.id, { trigger: 'manual' });
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
// Une étape qui rate ne doit pas manger tout le temps du test.
page.setDefaultTimeout(8000);
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
const section = (nom) => page.locator(`section.projet[data-nom="${nom}"]`);

// ── connexion par identifiant et mot de passe ────────────────────────────
await page.goto(`${base}/`);
await page.fill('input[placeholder="identifiant"]', compte.login);
await page.fill('input[placeholder="mot de passe"]', compte.password);
await page.click('button[type=submit]');
await page.waitForSelector('.tile', { timeout: 10000 });
await photo('accueil');

await etape('la session tient, et le nom du compte est dans la barre', async () => {
  if (!(await page.locator('header nav a:text("ana")').count())) throw new Error('le compte connecté n\'est pas affiché');
  await page.reload();
  await page.waitForSelector('.tile', { timeout: 8000 });
});

await etape('créer un projet', async () => {
  await page.click('text=+ Nouveau projet');
  await page.fill('dialog input', 'nouveau');
  await page.click('dialog button[type=submit]');
  await page.waitForSelector('h1:text-is("nouveau")', { timeout: 5000 });
});

await etape('créer une base de données en choisissant son moteur', async () => {
  await page.click('button:text("+ Base de données")');
  await page.waitForSelector('dialog .picker button');
  await page.locator('dialog .picker button', { hasText: /^Redis 7/ }).click();
  await page.fill('dialog input[value="base"]', 'cache');
  await page.click('dialog button[type=submit]');
  await page.waitForSelector('text=Réseau privé', { timeout: 5000 });
});

await etape('créer un service depuis une image Docker', async () => {
  await page.goto(`${base}/#/`);
  await section('demo').locator('button:text("+ Service")').click();
  await page.waitForSelector('dialog');
  await page.click('dialog button:text("Image Docker")');
  await page.fill('dialog input[placeholder^="ghcr.io"]', 'nginx:1.27-alpine');
  await page.fill('dialog input[placeholder="api"]', 'vitrine');
  await page.locator('dialog input[type=number]').first().fill('80');
  await page.click('dialog button:text-is("Créer")');
  await page.waitForURL(/#\/services\/[a-f0-9]+/, { timeout: 8000 });
  await page.waitForSelector('text=nginx:1.27-alpine', { timeout: 5000 });
  await photo('service-image');
});

await etape('les environnements : en créer un, et voir ses pastilles', async () => {
  await page.goto(`${base}/#/projects/${project.id}`);
  await page.waitForSelector('button:text("+ Environnement")');
  await page.click('button:text("+ Environnement")');
  await page.fill('dialog input[placeholder="preprod"]', 'preprod');
  await page.selectOption('dialog select', { index: 1 });
  await page.click('dialog button[type=submit]');
  await page.waitForSelector('button:text("preprod")', { timeout: 8000 });
  // Le nouvel environnement devient celui qu'on regarde : ses services y sont copiés.
  await page.waitForSelector('text=VARIABLES PARTAGÉES — PREPROD', { timeout: 6000 });
  if (!(await page.locator('.grid a', { hasText: 'api' }).count())) throw new Error('les services copiés ne sont pas là');
  await photo('projet-environnements');
});

await etape('variables partagées de l\'environnement', async () => {
  await page.goto(`${base}/#/projects/${project.id}`);
  // On revient sur « production » : c'est là que vivent les services de ce test.
  await page.click('button:text("production")');
  await page.waitForSelector('text=VARIABLES PARTAGÉES — PRODUCTION', { timeout: 6000 });
  await page.click('button:text("+ Variable")');
  await page.locator('input.k').last().fill('ZONE');
  await page.locator('input.v').last().fill('eu-ouest');
  await page.click('button:text-is("Enregistrer")');
  await page.waitForSelector('.toast', { timeout: 5000 });
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

await etape('variables : ajouter, coller un .env, enregistrer', async () => {
  await page.goto(`${base}/#/services/${service.id}/variables`);
  await page.waitForSelector('input.k');
  await page.click('button:text("+ Variable")');
  const n = await page.locator('input.k').count();
  await page.locator('input.k').nth(n - 1).fill('NOUVELLE');
  await page.locator('input.v').nth(n - 1).fill('valeur');
  await page.click('button:text("Coller un .env")');
  await page.fill('dialog textarea', 'DEPUIS_ENV=1\n# commentaire\nAUTRE="deux"');
  await page.click('dialog button[type=submit]');
  await page.waitForSelector('.toast', { timeout: 5000 });
  await page.click('button:text-is("Enregistrer")');
  await page.waitForSelector('.toast', { timeout: 5000 });
  if (!(await page.locator('text=HÉRITÉES DE L’ENVIRONNEMENT').count())) throw new Error('les variables héritées ne sont pas montrées');
});

await etape('arrêter puis démarrer', async () => {
  await page.goto(`${base}/#/services/${service.id}/apercu`);
  await page.click('button:text("Arrêter")');
  await page.waitForSelector('button:text("Démarrer")', { timeout: 6000 });
  await page.click('button:text("Démarrer")');
  await page.waitForSelector('button:text("Arrêter")', { timeout: 6000 });
});

await etape('déployer', async () => {
  await page.click('button:text-is("Déployer")');
  await page.waitForURL(/deployments$/, { timeout: 6000 });
  await page.waitForFunction(() => document.querySelectorAll('table tbody tr').length >= 2, null, { timeout: 10000 });
});

await etape('exposer le service en TCP depuis ses réglages', async () => {
  await page.goto(`${base}/#/services/${db.id}/settings`);
  await page.waitForSelector('text=EXPOSITION TCP');
  await page.click('button:text-is("Exposer")');
  await page.waitForSelector('text=Joignable depuis l’extérieur', { timeout: 6000 });
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

await etape('sauvegardes : en fabriquer une, la voir listée', async () => {
  await page.goto(`${base}/#/services/${db.id}/backups`);
  await page.waitForSelector('text=SAUVEGARDES AUTOMATIQUES', { timeout: 5000 });
  await page.click('button:text("Sauvegarder maintenant")');
  await page.waitForFunction(() => document.querySelectorAll('table tbody tr').length >= 1, null, { timeout: 8000 });
  await page.selectOption('select', { index: 2 });
  await page.click('button:text-is("Enregistrer")');
  await page.waitForSelector('.toast', { timeout: 5000 });
  await photo('sauvegardes');
});

await etape('tâche planifiée : planification, exécution, sortie', async () => {
  await page.goto(`${base}/#/services/${tache.id}/runs`);
  await page.waitForSelector('text=HISTORIQUE', { timeout: 5000 });
  // Le bouton de la carte « Historique », pas celui de l'en-tête du service.
  await page.locator('.card').filter({ hasText: 'Historique' }).locator('button:text("Exécuter maintenant")').click();
  await page.waitForFunction(() => document.querySelectorAll('table tbody tr').length >= 2, null, { timeout: 8000 });
  await page.click('table button:text("Sortie")');
  await page.waitForFunction(() => document.querySelector('dialog pre.log')?.textContent.includes('travail de'), null, { timeout: 5000 });
  await page.click('dialog button:text("Fermer")');
  await photo('taches');
});

await etape('catalogue : déployer un modèle en un clic', async () => {
  await page.goto(`${base}/#/templates`);
  await page.waitForSelector('text=Uptime Kuma', { timeout: 5000 });
  await photo('catalogue');
  await page.locator('.card', { hasText: 'Uptime Kuma' }).locator('button:text("Déployer")').click();
  await page.waitForSelector('dialog select');
  await page.click('dialog button[type=submit]');
  await page.waitForURL(/#\/services\/[a-f0-9]+\/deployments/, { timeout: 10000 });
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

await etape('mon compte : jeton d\'API et GitHub', async () => {
  await page.goto(`${base}/#/account`);
  await page.waitForSelector('text=JETONS D’API (LIGNE DE COMMANDE)', { timeout: 5000 });
  await page.fill('input[placeholder="mon-portable"]', 'portable');
  await page.click('button:text("Créer un jeton")');
  await page.waitForFunction(() => document.querySelector('dialog pre.log')?.textContent.startsWith('rail_'), null, { timeout: 5000 });
  await page.click('dialog button:text("Fermer")');
  await page.fill('input[placeholder^="github_pat_"]', 'ghp_aaaaaaaaaaaaaaaaaaaaaaaaaa');
  await page.click('button:text-is("Relier")');
  await page.waitForSelector('text=Relié : octocat', { timeout: 6000 });
  await photo('compte');
});

await etape('comptes : créer un membre, changer un rôle', async () => {
  await page.goto(`${base}/#/users`);
  await page.waitForSelector('text=+ Nouveau compte');
  await page.click('button:text("+ Nouveau compte")');
  await page.fill('dialog input[placeholder="prenom.nom"]', 'bob');
  await page.fill('dialog input[type=password]', 'mot-de-passe-long');
  await page.click('dialog button[type=submit]');
  await page.waitForSelector('td:text("bob")', { timeout: 6000 });
  await photo('comptes');
});

await etape('un dépôt GitHub se choisit dans une liste', async () => {
  await page.goto(`${base}/#/`);
  await section('demo').locator('button:text("+ Service")').click();
  await page.waitForSelector('dialog .picker button', { timeout: 6000 });
  await page.locator('dialog .picker button', { hasText: 'acme/api' }).click();
  await page.waitForTimeout(300);
  const nom = await page.locator('dialog input[placeholder="api"]').inputValue();
  if (nom !== 'api') throw new Error(`le nom devait être deviné (reçu « ${nom} »)`);
  await photo('choix-depot');
  await page.click('dialog button:text("Annuler")');
});

await etape('un lecteur voit tout sans rien pouvoir changer', async () => {
  await page.click('#logout');
  await page.waitForSelector('input[placeholder="identifiant"]', { timeout: 6000 });
  await page.fill('input[placeholder="identifiant"]', 'zoe');
  await page.fill('input[placeholder="mot de passe"]', 'mot-de-passe-long');
  await page.click('button[type=submit]');
  await page.waitForSelector('.tile', { timeout: 8000 });
  if (await page.locator('button:text("+ Nouveau projet")').count()) throw new Error('un lecteur ne doit pas voir « + Nouveau projet »');
  if (await page.locator('header nav a:text("Comptes")').count()) throw new Error('un lecteur ne doit pas voir la page des comptes');
  await page.goto(`${base}/#/services/${service.id}/apercu`);
  await page.waitForSelector('.chart svg', { timeout: 6000 });
  if (await page.locator('button:text-is("Déployer")').count()) throw new Error('un lecteur ne doit pas pouvoir déployer');
  await photo('lecteur');
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
