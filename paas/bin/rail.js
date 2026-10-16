#!/usr/bin/env node
// rail — la ligne de commande du plan de contrôle. Aucune dépendance.
//   RAIL_URL=https://rail.apps.exemple.com RAIL_TOKEN=… rail <commande>
const URL_ = (process.env.RAIL_URL || '').replace(/\/$/, '');
const TOKEN = process.env.RAIL_TOKEN || '';

const HELP = `rail — déployer et surveiller vos API et vos bases

  Vue d'ensemble
    rail status                                    serveur, services, état de chacun
    rail projects                                  liste les projets et leurs services
    rail events [-n 30] [--level error]            fil d'activité
    rail prune                                     supprime les images orphelines
    rail containers [--all]                        TOUS les conteneurs du serveur, Rail ou non
    rail container:logs <nom> [-f]                 journal d'un conteneur quelconque
    rail container:restart|stop|start <nom>        pilote un conteneur hors Rail

  Projets et services
    rail project:new <nom>
    rail service:new <projet> <nom> <proprio/dépôt> [--branch main] [--port 3000] [--health /health] [--root .] [--token ghp_…]
    rail service <service>                         détail (URL, webhook…)
    rail service:rm <service>                      supprime le service (et son volume)

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
    rail vars <service>                            affiche les variables
    rail vars:set <service> CLE=valeur […]
    rail vars:rm <service> CLE
    rail domain:add <service> <nom.de.domaine>

  Bases de données
    rail engines                                   moteurs disponibles
    rail db:new <projet> <nom> [--engine postgres] crée la base, ses identifiants, son volume
    rail db:url <service>                          l'URL de connexion
    rail backup <service> > dump.sql               export complet, en flux
    rail tables <service>                          les tables et leur taille
    rail sql <service> "SELECT …" [--write]        une requête (lecture seule par défaut)
    rail sql <service> < requete.sql               la requête peut venir de l'entrée standard

Variables : RAIL_URL, RAIL_TOKEN. Un « service » se désigne par son id, ou par projet/service.`;

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
    else if (a.startsWith('--')) { const k = a.slice(2); if (['build', 'write', 'all'].includes(k)) opt[k] = true; else opt[k] = argv[++i]; } else pos.push(a);
  }
  return { pos, opt };
}

// « projet/service » ou id → id du service
async function svcId(ref) {
  if (!ref) throw new Error('service manquant');
  if (!ref.includes('/')) return ref;
  const [p, s] = ref.split('/');
  const svc = (await api('GET', '/projects')).find((x) => x.name === p)?.services.find((x) => x.name === s);
  if (!svc) throw new Error(`service introuvable : ${ref}`);
  return svc.id;
}
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

const cmds = {
  async status() {
    const o = await api('GET', '/overview');
    const s = o.system;
    console.log(`Rail v${s.version} — ${s.domain}`);
    console.log(`  processeur ${s.cpu == null ? '—' : `${s.cpu.toFixed(0)}%`} (${s.cpus} cœurs, charge ${(s.load1 ?? 0).toFixed(2)})   mémoire ${octets(s.mem)} / ${octets(s.mem_total)}   disque ${octets(s.disk)} / ${octets(s.disk_total)}`);
    console.log(`  serveur allumé depuis ${duree(s.host_uptime_s)} · plan de contrôle ${duree(s.uptime_s)} · docker ${s.docker || '?'}`);
    for (const p of o.projects) {
      console.log(`\n${p.name}`);
      for (const svc of p.services) {
        const st = svc.status?.state || '—';
        const m = svc.status?.sample;
        console.log(`  ${(svc.kind === 'database' ? `🗄 ${svc.name}` : svc.name).padEnd(20)} ${st.padEnd(11)} ${m?.cpu != null ? `${m.cpu.toFixed(0)}% ${octets(m.mem)}`.padEnd(14) : ''.padEnd(14)} ${svc.url || svc.private_host || ''}`);
      }
    }
  },
  async projects() {
    for (const p of await api('GET', '/projects')) {
      console.log(`${p.name}  (${p.id})`);
      for (const s of p.services) console.log(`  ${(s.kind === 'database' ? `🗄 ${s.name}` : s.name).padEnd(20)} ${(s.latest_deployment?.status || '—').padEnd(10)} ${s.url || s.private_host || ''}  [${s.id}]`);
    }
  },
  async events({ opt }) {
    const q = new URLSearchParams({ limit: opt.limit || '30', ...(opt.level && { level: opt.level }) });
    for (const e of (await api('GET', `/events?${q}`)).reverse()) {
      console.log(`${e.at.slice(0, 19).replace('T', ' ')}  ${e.level.padEnd(5)} ${e.message}`);
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
  async 'project:new'({ pos }) { console.log(await api('POST', '/projects', { name: pos[0] })); },
  async 'service:new'({ pos, opt }) {
    const [proj, name, repo] = pos;
    const p = (await api('GET', '/projects')).find((x) => x.name === proj || x.id === proj);
    if (!p) throw new Error(`projet introuvable : ${proj}`);
    const s = await api('POST', `/projects/${p.id}/services`, { name, repo, branch: opt.branch, port: opt.port && +opt.port, healthcheck_path: opt.health, root_dir: opt.root, github_token: opt.token });
    console.log(`service créé : ${s.id}\nURL : ${s.url}\nProchaine étape : rail webhook ${s.id}  puis  rail deploy ${s.id}`);
  },
  async service({ pos }) { console.log(JSON.stringify(await api('GET', `/services/${await svcId(pos[0])}`), null, 2)); },
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
  async vars({ pos }) { for (const [k, v] of Object.entries(await api('GET', `/services/${await svcId(pos[0])}/variables`))) console.log(`${k}=${JSON.stringify(v)}`); },
  async 'vars:set'({ pos }) {
    const variables = {};
    for (const kv of pos.slice(1)) { const i = kv.indexOf('='); if (i < 1) throw new Error(`format attendu CLE=valeur : ${kv}`); variables[kv.slice(0, i)] = kv.slice(i + 1); }
    await api('PUT', `/services/${await svcId(pos[0])}/variables`, { variables });
    console.log('enregistré — « rail redeploy » pour appliquer');
  },
  async 'vars:rm'({ pos }) { await api('DELETE', `/services/${await svcId(pos[0])}/variables/${encodeURIComponent(pos[1])}`); console.log('supprimée'); },
  async 'domain:add'({ pos }) { console.log(await api('POST', `/services/${await svcId(pos[0])}/domains`, { hostname: pos[1] })); console.log('« rail redeploy » pour l\'appliquer'); },
  async webhook({ pos }) { console.log(await api('POST', `/services/${await svcId(pos[0])}/webhook/install`)); },
  async 'service:rm'({ pos }) { await api('DELETE', `/services/${await svcId(pos[0])}`); console.log('supprimé (conteneurs, images et volume compris)'); },
  async engines() { table((await api('GET', '/databases/engines')).map((e) => [e.id.padEnd(10), e.label.padEnd(16), e.image.padEnd(22), `port ${e.port}`, e.backup ? 'sauvegarde intégrée' : ''])); },
  async 'db:new'({ pos, opt }) {
    const [proj, name] = pos;
    const p = (await api('GET', '/projects')).find((x) => x.name === proj || x.id === proj);
    if (!p) throw new Error(`projet introuvable : ${proj}`);
    const s = await api('POST', `/projects/${p.id}/databases`, { engine: opt.engine || 'postgres', name });
    console.log(`base créée : ${s.id}\nhôte privé : ${s.private_host}:${s.port}\nURL : rail db:url ${p.name}/${s.name}\nRéférence dans un service : \${{${s.name}.DATABASE_URL}}`);
  },
  async 'db:url'({ pos }) {
    const v = await api('GET', `/services/${await svcId(pos[0])}/variables`);
    const url = v.DATABASE_URL || v.REDIS_URL || v.MONGO_URL;
    if (!url) throw new Error('ce service n\'a pas d\'URL de connexion');
    console.log(url);
  },
  async backup({ pos }) { return stream(`/services/${await svcId(pos[0])}/backup`); },
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
