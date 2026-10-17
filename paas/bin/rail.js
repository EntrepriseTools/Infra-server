#!/usr/bin/env node
// rail — la ligne de commande du plan de contrôle. Aucune dépendance.
//   RAIL_URL=https://rail.apps.exemple.com RAIL_TOKEN=… rail <commande>
//
// RAIL_TOKEN accepte le jeton d'administration de l'installation, ou un jeton
// d'API créé depuis le tableau de bord (« Mon compte ») ou par « rail token:new ».
const URL_ = (process.env.RAIL_URL || '').replace(/\/$/, '');
const TOKEN = process.env.RAIL_TOKEN || '';

const HELP = `rail — déployer et surveiller vos API, vos bases et vos tâches

  Vue d'ensemble
    rail status                                    serveur, services, état de chacun
    rail projects                                  projets, environnements et services
    rail events [-n 30] [--level error]            fil d'activité
    rail prune                                     supprime les images orphelines
    rail containers [--all]                        TOUS les conteneurs du serveur, Rail ou non
    rail container:logs <nom> [-f]                 journal d'un conteneur quelconque
    rail container:restart|stop|start <nom>        pilote un conteneur hors Rail

  Mon compte
    rail whoami                                    qui suis-je, avec quel rôle
    rail tokens | rail token:new <nom> | rail token:rm <id>
    rail github:connect <jeton> [--shared]         relie un jeton GitHub (lecture des dépôts)
    rail repos [--q api]                           les dépôts que ce jeton voit
    rail users | rail user:new <login> --password … [--role member]
    rail user:rm <id>

  Projets, environnements
    rail project:new <nom>                         crée le projet et son environnement « production »
    rail project:rm <projet>
    rail envs <projet>
    rail env:new <projet> <nom> [--copy production] duplique un environnement (services et variables)
    rail env:rm <projet/env>
    rail env:vars <projet/env> | rail env:vars:set <projet/env> CLE=valeur […]

  Services
    rail service:new <projet> <nom> <proprio/dépôt> [--branch main] [--port 3000] [--health /health]
                     [--root .] [--token ghp_…] [--env preprod] [--deploy]
    rail image:new <projet> <nom> <image> [--port 80] [--volume /data] [--start "…"] [--env …]
    rail job:new <projet> <nom> --schedule "0 3 * * *" (<proprio/dépôt> | --image …) [--start "…"]
    rail service <service>                         détail (URL, webhook, planification…)
    rail service:rm <service> [--keep-volume]
    rail templates                                 le catalogue en un clic
    rail template <projet> <modèle> [--prefix blog] [--env …]

  Déployer
    rail deploy <service> [--sha <commit>]         lance un déploiement
    rail redeploy <service>                        relance l'image en service (nouvelles variables)
    rail deployments <service>
    rail rollback <déploiement>                    remet cette version en service
    rail cancel <déploiement>
    rail webhook <service>                         installe le webhook GitHub (jeton requis)

  Exploiter
    rail logs <service|déploiement> [-f] [--build] journal d'exécution (ou de construction)
    rail metrics <service> [--range 1h]            processeur, mémoire, disponibilité
    rail restart <service> | rail stop <service> | rail start <service>
    rail vars <service> [--resolved]               variables (résolues comme au déploiement)
    rail vars:set <service> CLE=valeur […]
    rail vars:rm <service> CLE
    rail domain:add <service> <nom.de.domaine>
    rail expose <service> [--port 20000]           publie son port TCP sur la machine
    rail unexpose <service>
    rail run <service>                             exécute une tâche planifiée maintenant
    rail runs <service>                            historique des exécutions

  Bases de données
    rail engines                                   moteurs disponibles
    rail db:new <projet> <nom> [--engine postgres] [--env …] [--backup "0 3 * * *"]
    rail db:url <service>                          l'URL de connexion
    rail backup <service> > dump.sql               export complet, en flux
    rail backups <service>                         sauvegardes gardées sur le serveur
    rail backup:new <service>                      en fabrique une maintenant
    rail backup:get <id> > dump.sql                télécharge une sauvegarde gardée
    rail backup:restore <id>                       REMET la base dans cet état
    rail backup:auto <service> "0 3 * * *" [--keep 7]
    rail tables <service>                          les tables et leur taille
    rail sql <service> "SELECT …" [--write]        une requête (lecture seule par défaut)
    rail sql <service> < requete.sql               la requête peut venir de l'entrée standard

Un « service » se désigne par son identifiant, par « projet/service »
(environnement production), ou par « projet/env/service ».`;

// Les options qui attendent une valeur ; les autres sont des interrupteurs.
const AVEC_VALEUR = new Set(['branch', 'port', 'health', 'root', 'token', 'sha', 'range', 'level', 'limit',
  'engine', 'env', 'prefix', 'schedule', 'image', 'password', 'role', 'keep', 'copy', 'start', 'build-cmd',
  'watch', 'volume', 'backup', 'q', 'name']);

async function api(method, path, body) {
  const res = await fetch(`${URL_}/api${path}`, { method, headers: { authorization: `Bearer ${TOKEN}`, ...(body && { 'content-type': 'application/json' }) }, body: body && JSON.stringify(body) });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
  return data;
}
async function stream(path) {
  const res = await fetch(`${URL_}/api${path}`, { headers: { authorization: `Bearer ${TOKEN}` } });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
  for await (const chunk of res.body) process.stdout.write(chunk);
}

function parse(argv) {
  const pos = []; const opt = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-f') opt.follow = true;
    else if (a === '-n') opt.limit = argv[++i];
    else if (a.startsWith('--')) {
      const k = a.slice(2);
      if (AVEC_VALEUR.has(k)) opt[k] = argv[++i];
      else opt[k.replace(/-/g, '_')] = true;
    } else pos.push(a);
  }
  return { pos, opt };
}

// ── désigner les choses ────────────────────────────────────────────────────
const projets = () => api('GET', '/projects');
async function projet(ref) {
  const p = (await projets()).find((x) => x.name === ref || x.id === ref);
  if (!p) throw new Error(`projet introuvable : ${ref}`);
  return p;
}
/** « projet/env » ou « projet » → l'environnement (production par défaut). */
async function envRef(ref, dflt = 'production') {
  const [pn, en] = String(ref || '').split('/');
  const p = await projet(pn);
  const name = en || dflt;
  const e = p.environments.find((x) => x.name === name);
  if (!e) throw new Error(`environnement introuvable : ${pn}/${name}`);
  return { project: p, environment: e };
}
/** id, « projet/service », ou « projet/env/service » → identifiant du service. */
async function svcId(ref) {
  if (!ref) throw new Error('service manquant');
  const parts = ref.split('/');
  if (parts.length === 1) return ref;
  const [pn, a, b] = parts;
  const envName = b ? a : 'production';
  const svcName = b || a;
  const p = await projet(pn);
  const e = p.environments.find((x) => x.name === envName);
  if (!e) throw new Error(`environnement introuvable : ${pn}/${envName}`);
  const svc = e.services.find((x) => x.name === svcName);
  if (!svc) throw new Error(`service introuvable : ${ref}`);
  return svc.id;
}
/** L'environnement visé par une création : --env, sinon production. */
async function cibleEnv(p, opt) {
  const name = opt.env || 'production';
  const e = p.environments.find((x) => x.name === name);
  if (!e) throw new Error(`environnement introuvable : ${p.name}/${name}`);
  return e;
}

// ── affichage ──────────────────────────────────────────────────────────────
const table = (rows) => rows.forEach((r) => console.log(r.join('  ')));
/** Un tableau aligné, colonnes tronquées : lisible dans un terminal. */
function grille(columns, rows) {
  const cell = (v) => (v == null ? 'NULL' : String(v).replace(/\n/g, ' ').slice(0, 40));
  const larg = columns.map((c, i) => Math.max(String(c).length, ...rows.map((r) => cell(r[i]).length), 3));
  const ligne = (vals) => vals.map((v, i) => cell(v).padEnd(larg[i])).join('  ');
  console.log(ligne(columns));
  console.log(larg.map((n) => '-'.repeat(n)).join('  '));
  for (const r of rows) console.log(ligne(r));
}
const entreeStandard = async () => {
  if (process.stdin.isTTY) return '';
  let t = '';
  for await (const c of process.stdin) t += c;
  return t;
};
const octets = (n) => {
  if (n == null) return '—';
  const u = ['o', 'ko', 'Mo', 'Go', 'To']; let i = 0; let x = n;
  while (x >= 1024 && i < u.length - 1) { x /= 1024; i++; }
  return `${x < 10 && i ? x.toFixed(1) : Math.round(x)}${u[i]}`;
};
const duree = (s) => (s == null ? '—' : s > 86400 ? `${Math.floor(s / 86400)}j` : s > 3600 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 60)}min`);
/** Une courbe en huit niveaux, dans le terminal. */
const sparkline = (values, max) => {
  const blocks = '▁▂▃▄▅▆▇█';
  const top = max || Math.max(1, ...values.filter((v) => v != null));
  return values.map((v) => (v == null ? ' ' : blocks[Math.min(7, Math.floor((v / top) * 8))])).join('');
};
const icone = (s) => (s.kind === 'database' ? `🗄 ${s.name}` : s.kind === 'cron' ? `⏱ ${s.name}` : s.name);
const adresse = (s) => s.url || s.public_endpoint || s.private_host || '';

const cmds = {
  async status() {
    const o = await api('GET', '/overview');
    const s = o.system;
    console.log(`Rail v${s.version} — ${s.domain}`);
    console.log(`  processeur ${s.cpu == null ? '—' : `${s.cpu.toFixed(0)}%`} (${s.cpus} cœurs, charge ${(s.load1 ?? 0).toFixed(2)})   mémoire ${octets(s.mem)} / ${octets(s.mem_total)}   disque ${octets(s.disk)} / ${octets(s.disk_total)}`);
    console.log(`  serveur allumé depuis ${duree(s.host_uptime_s)} · plan de contrôle ${duree(s.uptime_s)} · docker ${s.docker || '?'}`);
    for (const p of o.projects) {
      for (const env of p.environments) {
        console.log(`\n${p.name}${env.name === 'production' ? '' : ` / ${env.name}`}`);
        for (const svc of env.services) {
          const st = svc.status?.state || '—';
          const m = svc.status?.sample;
          console.log(`  ${icone(svc).padEnd(20)} ${st.padEnd(11)} ${m?.cpu != null ? `${m.cpu.toFixed(0)}% ${octets(m.mem)}`.padEnd(14) : ''.padEnd(14)} ${adresse(svc)}`);
        }
      }
    }
  },
  async projects() {
    for (const p of await projets()) {
      console.log(`${p.name}  (${p.id})`);
      for (const env of p.environments) {
        console.log(`  ${env.name}  [${env.id}]`);
        for (const s of env.services) console.log(`    ${icone(s).padEnd(20)} ${(s.latest_deployment?.status || '—').padEnd(10)} ${adresse(s)}  [${s.id}]`);
      }
    }
  },
  async events({ opt }) {
    const q = new URLSearchParams({ limit: opt.limit || '30', ...(opt.level && { level: opt.level }) });
    for (const e of (await api('GET', `/events?${q}`)).reverse()) {
      console.log(`${e.at.slice(0, 19).replace('T', ' ')}  ${e.level.padEnd(5)} ${(e.actor || '-').padEnd(10)} ${e.message}`);
    }
  },
  async prune() { console.log((await api('POST', '/system/prune')).output || 'nettoyé'); },
  async containers({ opt }) {
    const liste = await api('GET', `/containers${opt.all ? '' : '?all=0'}`);
    table(liste.map((c) => {
      const m = c.stats || c.sample || {};
      return [
        (c.state === 'running' ? '●' : '○'),
        c.name.padEnd(26),
        (c.image || '').slice(0, 28).padEnd(28),
        (m.cpu != null ? `${m.cpu.toFixed(0)}%` : '—').padStart(5),
        octets(m.mem).padStart(8),
        (c.service ? `${c.service.project}/${c.service.name}` : 'hors Rail').padEnd(20),
        c.ports || '',
      ];
    }));
  },
  async 'container:logs'({ pos, opt }) { return stream(`/containers/${encodeURIComponent(pos[0])}/logs?tail=200${opt.follow ? '&follow=1' : ''}`); },
  async 'container:restart'({ pos }) { console.log(await api('POST', `/containers/${encodeURIComponent(pos[0])}/restart`)); },
  async 'container:stop'({ pos }) { console.log(await api('POST', `/containers/${encodeURIComponent(pos[0])}/stop`)); },
  async 'container:start'({ pos }) { console.log(await api('POST', `/containers/${encodeURIComponent(pos[0])}/start`)); },

  // ── mon compte ──
  async whoami() {
    const me = await api('GET', '/me');
    console.log(`${me.user.login} — ${me.user.role_label} (${me.user.role}) · accès par ${me.via === 'root' ? 'le jeton d\'administration' : me.via === 'token' ? 'un jeton d\'API' : 'une session'}`);
    console.log(`GitHub : ${me.github.connected ? `relié (${me.github.scope}${me.github.login ? `, ${me.github.login}` : ''})` : 'non relié'}`);
  },
  async tokens() { table((await api('GET', '/me/tokens')).map((t) => [t.id, t.name.padEnd(16), t.created_at.slice(0, 16), t.last_used_at ? `vu ${t.last_used_at.slice(0, 16)}` : 'jamais utilisé'])); },
  async 'token:new'({ pos }) {
    const t = await api('POST', '/me/tokens', { name: pos[0] || 'cli' });
    console.log(`${t.token}\n(copiez-le maintenant : il ne sera plus affiché)`);
  },
  async 'token:rm'({ pos }) { await api('DELETE', `/me/tokens/${pos[0]}`); console.log('supprimé'); },
  async 'github:connect'({ pos, opt }) {
    const r = await api('POST', '/me/github', { token: pos[0], shared: !!opt.shared });
    console.log(`GitHub relié : ${r.github.login} (${r.scope})`);
  },
  async repos({ opt }) {
    const liste = await api('GET', `/github/repos${opt.q ? `?q=${encodeURIComponent(opt.q)}` : ''}`);
    table(liste.map((x) => [x.private ? '🔒' : '  ', x.full_name.padEnd(40), (x.default_branch || '').padEnd(12), (x.language || '').padEnd(12), (x.pushed_at || '').slice(0, 10)]));
  },
  async users() { table((await api('GET', '/users')).map((u) => [u.id, u.login.padEnd(16), u.role.padEnd(8), (u.name || '').padEnd(20), u.last_seen_at ? `vu ${u.last_seen_at.slice(0, 16)}` : 'jamais connecté'])); },
  async 'user:new'({ pos, opt }) {
    if (!opt.password) throw new Error('--password est nécessaire (10 caractères au moins)');
    const u = await api('POST', '/users', { login: pos[0], password: opt.password, role: opt.role || 'member', name: opt.name });
    console.log(`compte créé : ${u.login} (${u.role}) — il devra changer son mot de passe à la première connexion`);
  },
  async 'user:rm'({ pos }) { await api('DELETE', `/users/${pos[0]}`); console.log('supprimé'); },

  // ── projets, environnements ──
  async 'project:new'({ pos }) {
    const p = await api('POST', '/projects', { name: pos[0] });
    console.log(`projet créé : ${p.name} (${p.id}) — environnement « production » prêt`);
  },
  async 'project:rm'({ pos }) { await api('DELETE', `/projects/${(await projet(pos[0])).id}`); console.log('supprimé'); },
  async envs({ pos }) {
    const p = await projet(pos[0]);
    table(p.environments.map((e) => [e.name.padEnd(16), `${e.services.length} service(s)`.padEnd(14), e.id]));
  },
  async 'env:new'({ pos, opt }) {
    const p = await projet(pos[0]);
    const copy = opt.copy ? p.environments.find((x) => x.name === opt.copy) : null;
    if (opt.copy && !copy) throw new Error(`environnement à copier introuvable : ${opt.copy}`);
    const e = await api('POST', `/projects/${p.id}/environments`, { name: pos[1], copy_from: copy?.id });
    console.log(`environnement créé : ${p.name}/${e.name} (${e.services.length} service(s))${e.deploy_hint ? ` — ${e.deploy_hint}` : ''}`);
  },
  async 'env:rm'({ pos }) {
    const { environment } = await envRef(pos[0]);
    await api('DELETE', `/environments/${environment.id}`);
    console.log('supprimé (avec ses services)');
  },
  async 'env:vars'({ pos }) {
    const { environment } = await envRef(pos[0]);
    for (const [k, v] of Object.entries(await api('GET', `/environments/${environment.id}/variables`))) console.log(`${k}=${JSON.stringify(v)}`);
  },
  async 'env:vars:set'({ pos }) {
    const { environment } = await envRef(pos[0]);
    const actuelles = await api('GET', `/environments/${environment.id}/variables`);
    const variables = { ...actuelles };
    for (const kv of pos.slice(1)) { const i = kv.indexOf('='); if (i < 1) throw new Error(`format attendu CLE=valeur : ${kv}`); variables[kv.slice(0, i)] = kv.slice(i + 1); }
    await api('PUT', `/environments/${environment.id}/variables`, { variables });
    console.log('enregistré — redéployez les services pour appliquer');
  },

  // ── services ──
  async 'service:new'({ pos, opt }) {
    const [projName, name, repo] = pos;
    const p = await projet(projName);
    const env = await cibleEnv(p, opt);
    const s = await api('POST', `/projects/${p.id}/services`, {
      name, repo, source: 'repo', environment_id: env.id, branch: opt.branch, port: opt.port && +opt.port,
      healthcheck_path: opt.health, root_dir: opt.root, github_token: opt.token,
      build_command: opt['build-cmd'], start_command: opt.start, watch_paths: opt.watch, deploy: !!opt.deploy,
    });
    console.log(`service créé : ${s.id}\nURL : ${s.url}`);
    console.log(opt.deploy ? 'Déploiement lancé : rail logs ' + s.id + ' --build -f' : `Prochaine étape : rail webhook ${s.id}  puis  rail deploy ${s.id}`);
  },
  async 'image:new'({ pos, opt }) {
    const [projName, name, image] = pos;
    const p = await projet(projName);
    const env = await cibleEnv(p, opt);
    const s = await api('POST', `/projects/${p.id}/services`, {
      name, source: 'image', image, environment_id: env.id, port: opt.port && +opt.port,
      healthcheck_path: opt.health, volume_path: opt.volume, start_command: opt.start, deploy: opt.deploy !== false,
    });
    console.log(`service créé depuis l'image ${image} : ${s.id}\nURL : ${s.url}\nDéploiement lancé : rail logs ${s.id} --build -f`);
  },
  async 'job:new'({ pos, opt }) {
    const [projName, name, repo] = pos;
    if (!opt.schedule) throw new Error('--schedule est nécessaire (ex. --schedule "0 3 * * *")');
    const p = await projet(projName);
    const env = await cibleEnv(p, opt);
    const s = await api('POST', `/projects/${p.id}/services`, {
      name, kind: 'cron', environment_id: env.id, cron_schedule: opt.schedule,
      source: opt.image ? 'image' : 'repo', image: opt.image, repo, branch: opt.branch,
      start_command: opt.start, root_dir: opt.root, github_token: opt.token, deploy: true,
    });
    console.log(`tâche planifiée créée : ${s.id} — ${s.cron?.words || opt.schedule}\nProchaine exécution : ${s.cron?.next || '?'}`);
  },
  async service({ pos }) { console.log(JSON.stringify(await api('GET', `/services/${await svcId(pos[0])}`), null, 2)); },
  async 'service:rm'({ pos, opt }) {
    await api('DELETE', `/services/${await svcId(pos[0])}${opt.keep_volume ? '?keep_volume=1' : ''}`);
    console.log(opt.keep_volume ? 'supprimé (volume gardé)' : 'supprimé (conteneurs, images et volume compris)');
  },
  async templates() {
    for (const t of await api('GET', '/templates')) {
      console.log(`${t.id.padEnd(14)} ${t.label.padEnd(14)} ${t.tagline}`);
      console.log(`${' '.repeat(15)}${t.services.map((s) => `${s.name} (${s.what})`).join(' + ')}`);
    }
  },
  async template({ pos, opt }) {
    const p = await projet(pos[0]);
    const env = await cibleEnv(p, opt);
    const r = await api('POST', `/projects/${p.id}/templates`, { template: pos[1], prefix: opt.prefix, environment_id: env.id });
    console.log(`modèle « ${r.template} » déployé : ${r.services.map((s) => s.name).join(', ')}`);
    if (r.main?.url) console.log(`Adresse : ${r.main.url}\nSuivre : rail logs ${r.main.id} --build -f`);
  },

  // ── déployer ──
  async deploy({ pos, opt }) { const d = await api('POST', `/services/${await svcId(pos[0])}/deploy`, opt.sha ? { sha: opt.sha } : {}); console.log(`déploiement #${d.number} en file : ${d.id}\nrail logs ${d.id} -f`); },
  async redeploy({ pos }) { const d = await api('POST', `/services/${await svcId(pos[0])}/redeploy`); console.log(`redéploiement #${d.number} : ${d.id}`); },
  async deployments({ pos }) { table((await api('GET', `/services/${await svcId(pos[0])}/deployments`)).map((d) => [String(d.number).padStart(3), d.status.padEnd(9), (d.commit_sha || '').slice(0, 7).padEnd(7), (d.commit_message || '').slice(0, 50).padEnd(50), d.id])); },
  async logs({ pos, opt }) {
    const ref = pos[0];
    if (opt.build) {
      const id = await svcId(ref);
      const last = (await api('GET', `/services/${id}/deployments`))[0];
      if (!last) throw new Error('aucun déploiement');
      return stream(`/deployments/${last.id}/logs${opt.follow ? '?follow=1' : ''}`);
    }
    const isDep = await api('GET', `/deployments/${ref}`).then(() => true, () => false);
    if (isDep) return stream(`/deployments/${ref}/logs${opt.follow ? '?follow=1' : ''}`);
    return stream(`/services/${await svcId(ref)}/logs?tail=200${opt.follow ? '&follow=1' : ''}`);
  },
  async metrics({ pos, opt }) {
    const id = await svcId(pos[0]);
    const m = await api('GET', `/services/${id}/metrics?range=${opt.range || '1h'}`);
    if (!m.points.length) return console.log('pas encore de mesures');
    const cpu = m.points.map((p) => p.cpu); const mem = m.points.map((p) => p.mem);
    console.log(`fenêtre ${m.range} · disponibilité ${m.uptime == null ? '—' : `${(m.uptime * 100).toFixed(1)}%`} · limites ${m.limits.cpus} cœur(s), ${m.limits.memory_mb} Mo`);
    console.log(`processeur ${sparkline(cpu, m.limits.cpus * 100)}  ${m.current?.cpu?.toFixed(1) ?? '—'}%`);
    console.log(`mémoire    ${sparkline(mem, m.limits.memory_mb * 1024 * 1024)}  ${octets(m.current?.mem)}`);
    return undefined;
  },
  async restart({ pos }) { console.log(await api('POST', `/services/${await svcId(pos[0])}/restart`)); },
  async stop({ pos }) { console.log(await api('POST', `/services/${await svcId(pos[0])}/stop`)); },
  async start({ pos }) { console.log(await api('POST', `/services/${await svcId(pos[0])}/start`)); },
  async rollback({ pos }) { const d = await api('POST', `/deployments/${pos[0]}/rollback`); console.log(`retour arrière : déploiement #${d.number} (${d.id})`); },
  async cancel({ pos }) { console.log(await api('POST', `/deployments/${pos[0]}/cancel`)); },
  async vars({ pos, opt }) {
    const id = await svcId(pos[0]);
    const vars = await api('GET', `/services/${id}/variables${opt.resolved ? '?resolved=1' : ''}`);
    for (const [k, v] of Object.entries(vars)) console.log(`${k}=${JSON.stringify(v)}`);
  },
  async 'vars:set'({ pos }) {
    const variables = {};
    for (const kv of pos.slice(1)) { const i = kv.indexOf('='); if (i < 1) throw new Error(`format attendu CLE=valeur : ${kv}`); variables[kv.slice(0, i)] = kv.slice(i + 1); }
    await api('PUT', `/services/${await svcId(pos[0])}/variables`, { variables });
    console.log('enregistré — « rail redeploy » pour appliquer');
  },
  async 'vars:rm'({ pos }) { await api('DELETE', `/services/${await svcId(pos[0])}/variables/${encodeURIComponent(pos[1])}`); console.log('supprimée'); },
  async 'domain:add'({ pos }) { console.log(await api('POST', `/services/${await svcId(pos[0])}/domains`, { hostname: pos[1] })); console.log('« rail redeploy » pour l\'appliquer'); },
  async webhook({ pos }) { console.log(await api('POST', `/services/${await svcId(pos[0])}/webhook/install`)); },
  async expose({ pos, opt }) {
    const s = await api('POST', `/services/${await svcId(pos[0])}/expose`, opt.port ? { port: +opt.port } : {});
    console.log(`exposé sur ${s.public_endpoint} — « rail redeploy ${pos[0]} » pour ouvrir le port`);
  },
  async unexpose({ pos }) {
    await api('DELETE', `/services/${await svcId(pos[0])}/expose`);
    console.log('plus exposé — « rail redeploy » pour fermer le port');
  },
  async run({ pos }) {
    const r = await api('POST', `/services/${await svcId(pos[0])}/run`);
    console.log(`exécution #${r.number} lancée (${r.id}) — « rail runs ${pos[0]} » pour le résultat`);
  },
  async runs({ pos }) {
    const r = await api('GET', `/services/${await svcId(pos[0])}/runs`);
    console.log(`planification : ${r.words || r.schedule || 'aucune'}${r.next ? ` · prochaine : ${r.next.slice(0, 16).replace('T', ' ')}` : ''}`);
    table(r.runs.map((x) => [String(x.number).padStart(3), x.status.padEnd(8), x.trigger.padEnd(9), x.started_at.slice(0, 19).replace('T', ' '), x.exit_code == null ? '' : `code ${x.exit_code}`, (x.output || '').split('\n')[0].slice(0, 50)]));
  },

  // ── bases de données ──
  async engines() { table((await api('GET', '/databases/engines')).map((e) => [e.id.padEnd(12), e.label.padEnd(18), e.image.padEnd(42), `port ${e.port}`, e.backup ? 'sauvegarde' : '', e.sql ? 'SQL' : ''])); },
  async 'db:new'({ pos, opt }) {
    const [projName, name] = pos;
    const p = await projet(projName);
    const env = await cibleEnv(p, opt);
    const s = await api('POST', `/projects/${p.id}/databases`, { engine: opt.engine || 'postgres', name, environment_id: env.id, backup_schedule: opt.backup });
    console.log(`base créée : ${s.id}\nhôte privé : ${s.private_host}:${s.port}\nURL : rail db:url ${p.name}/${env.name === 'production' ? '' : `${env.name}/`}${s.name}\nRéférence dans un service : \${{${s.name}.DATABASE_URL}}`);
  },
  async 'db:url'({ pos }) {
    const v = await api('GET', `/services/${await svcId(pos[0])}/variables`);
    const url = v.DATABASE_URL || v.REDIS_URL || v.MONGO_URL || v.AMQP_URL || v.MEILISEARCH_URL;
    if (!url) throw new Error('ce service n\'a pas d\'URL de connexion');
    console.log(url);
  },
  async backup({ pos }) { return stream(`/services/${await svcId(pos[0])}/backup`); },
  async backups({ pos }) {
    const r = await api('GET', `/services/${await svcId(pos[0])}/backups`);
    console.log(`planification : ${r.schedule || 'aucune'} · ${r.backups.length} sauvegarde(s), ${octets(r.total_size)} · garde les ${r.keep} dernières`);
    table(r.backups.map((b) => [b.id, b.status.padEnd(8), b.trigger.padEnd(9), b.created_at.slice(0, 19).replace('T', ' '), octets(b.size).padStart(8), b.available ? '' : 'fichier absent', (b.error || '').split('\n')[0].slice(0, 40)]));
  },
  async 'backup:new'({ pos }) {
    const b = await api('POST', `/services/${await svcId(pos[0])}/backups`);
    console.log(`sauvegarde créée : ${b.file} (${octets(b.size)}) — ${b.id}`);
  },
  async 'backup:get'({ pos }) { return stream(`/backups/${pos[0]}/download`); },
  async 'backup:restore'({ pos }) {
    const r = await api('POST', `/backups/${pos[0]}/restore`);
    console.log(`restauré depuis ${r.restored}${r.notice ? `\n${r.notice}` : ''}`);
  },
  async 'backup:auto'({ pos, opt }) {
    const s = await api('PATCH', `/services/${await svcId(pos[0])}`, { backup_schedule: pos[1], backup_keep: opt.keep ? +opt.keep : undefined });
    console.log(`sauvegardes automatiques : ${s.backup?.words || s.backup?.schedule || 'désactivées'} (garde les ${s.backup?.keep})`);
  },
  async tables({ pos }) {
    const r = await api('GET', `/services/${await svcId(pos[0])}/tables`);
    if (!r.columns.length) return console.log(r.message || 'aucune table');
    return grille(r.columns, r.rows);
  },
  async sql({ pos, opt }) {
    const id = await svcId(pos[0]);
    const sql = pos.slice(1).join(' ').trim() || (await entreeStandard()).trim();
    if (!sql) throw new Error('requête manquante : « rail sql demo/base "SELECT 1" » ou par l\'entrée standard');
    const r = await api('POST', `/services/${id}/query`, { sql, read_only: !opt.write });
    if (r.columns.length) grille(r.columns, r.rows);
    else console.log(r.message || 'ordre exécuté');
    console.error(`${r.truncated ? `${r.rows.length} premières lignes sur ${r.total}` : `${r.rows.length} ligne(s)`} en ${r.ms} ms${r.read_only ? ' (lecture seule)' : ''}`);
  },
};

const [cmd, ...rest] = process.argv.slice(2);
if (!cmd || cmd === 'help' || cmd === '--help' || !cmds[cmd]) { console.log(HELP); process.exit(cmd && cmd !== 'help' && cmd !== '--help' ? 2 : 0); }
if (!URL_ || !TOKEN) { console.error('RAIL_URL et RAIL_TOKEN sont nécessaires'); process.exit(2); }
cmds[cmd](parse(rest)).catch((e) => { console.error(`rail : ${e.message}`); process.exit(1); });
