#!/usr/bin/env node
// rail — la ligne de commande du plan de contrôle. Aucune dépendance.
//   RAIL_URL=https://rail.apps.exemple.com RAIL_TOKEN=… rail <commande>
const URL_ = (process.env.RAIL_URL || '').replace(/\/$/, '');
const TOKEN = process.env.RAIL_TOKEN || '';

const HELP = `rail — déployer des API depuis GitHub

  rail projects                                  liste les projets et leurs services
  rail project:new <nom>
  rail service:new <projet> <nom> <proprio/dépôt> [--branch main] [--port 3000] [--health /health] [--root .] [--token ghp_…]
  rail service <service>                         détail (URL, webhook…)
  rail deploy <service> [--sha <commit>]         lance un déploiement
  rail redeploy <service>                        relance l'image en service (nouvelles variables)
  rail deployments <service>
  rail logs <service|deploiement> [-f] [--build] journal d'exécution (ou de construction avec --build / un id de déploiement)
  rail rollback <déploiement>                    remet cette version en service
  rail cancel <déploiement>
  rail vars <service>                            affiche les variables
  rail vars:set <service> CLE=valeur [CLE=valeur …]
  rail vars:rm <service> CLE
  rail domain:add <service> <nom.de.domaine>
  rail webhook <service>                         installe le webhook GitHub (jeton requis)
  rail service:rm <service>

Variables : RAIL_URL, RAIL_TOKEN. Un « service » ou « projet » se désigne par son id, ou par projet/service.`;

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
    else if (a.startsWith('--')) { const k = a.slice(2); if (['build'].includes(k)) opt[k] = true; else opt[k] = argv[++i]; } else pos.push(a);
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

const cmds = {
  async projects() {
    for (const p of await api('GET', '/projects')) {
      console.log(`${p.name}  (${p.id})`);
      for (const s of p.services) console.log(`  ${s.name.padEnd(20)} ${(s.latest_deployment?.status || '—').padEnd(10)} ${s.url || ''}  [${s.id}]`);
    }
  },
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
    // Un id de déploiement (12 hex) ou --build → journal de construction ; sinon journal d'exécution.
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
  async 'service:rm'({ pos }) { await api('DELETE', `/services/${await svcId(pos[0])}`); console.log('supprimé'); },
};

const [cmd, ...rest] = process.argv.slice(2);
if (!cmd || cmd === 'help' || cmd === '--help' || !cmds[cmd]) { console.log(HELP); process.exit(cmd && cmd !== 'help' && cmd !== '--help' ? 2 : 0); }
if (!URL_ || !TOKEN) { console.error('RAIL_URL et RAIL_TOKEN sont nécessaires'); process.exit(2); }
cmds[cmd](parse(rest)).catch((e) => { console.error(`rail : ${e.message}`); process.exit(1); });
