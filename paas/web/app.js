// Le tableau de bord : une page, quatre vues (vue d'ensemble, service, activité,
// système). Tout passe par l'API JSON — rien n'est rendu côté serveur.
import {
  h, toast, act, field, dialog, api, download, followLog, getToken, setToken, setUnauthorizedHandler,
  fmtBytes, fmtRate, fmtPct, fmtDur, ago, dateTime, clock, chart, VIZ,
  stateBadge, deployBadge, levelDot, stateWord,
} from './ui.js';

const $app = document.getElementById('app');
const $nav = document.getElementById('nav');
let cfg = {};
let stoppers = [];          // flux et minuteries de la vue courante
let range = localStorage.getItem('rail_range') || '1h';

const onLeave = (fn) => stoppers.push(fn);
const leaveAll = () => { for (const f of stoppers) { try { f(); } catch { /* rien */ } } stoppers = []; };
const refreshIn = (ms) => { const t = setTimeout(render, ms); onLeave(() => clearTimeout(t)); };
const copy = (t) => navigator.clipboard?.writeText(t).then(() => toast('Copié'), () => toast('Copie impossible', true));
const confirmThen = (question, fn) => act(async (ev) => { if (confirm(question)) await fn(ev); });
const RANGES = ['15m', '1h', '6h', '24h', '7d'];

// ── connexion ─────────────────────────────────────────────────────────────
function logout() { setToken(''); render(); }
setUnauthorizedHandler(() => setToken(''));
document.getElementById('logout').onclick = logout;

function loginView() {
  const inp = h('input', { type: 'password', placeholder: 'Jeton d’administration', autocomplete: 'current-password', required: true, style: 'width:100%' });
  const form = h('form', {
    class: 'card login',
    onsubmit: act(async (e) => { e.preventDefault(); setToken(inp.value.trim()); await api('GET', '/config'); render(); }),
  },
  h('h1', {}, '▲ Rail'),
  h('p', { class: 'mut' }, 'Déployez et surveillez vos API et vos bases, sur votre serveur.'),
  inp,
  h('p', {}, h('button', { class: 'pri', type: 'submit' }, 'Entrer')));
  $app.replaceChildren(form);
  inp.focus();
}

// ── tuiles ────────────────────────────────────────────────────────────────
function tile(k, value, sub, ratio) {
  const cls = ratio == null ? '' : ratio > 0.9 ? ' ko' : ratio > 0.75 ? ' warn' : '';
  return h('div', { class: 'tile' },
    h('div', { class: 'k' }, k), h('div', { class: 'v' }, value), h('div', { class: 's' }, sub || ''),
    ratio == null ? null : h('div', { class: `bar${cls}` }, h('i', { style: `width:${Math.min(100, Math.round(ratio * 100))}%` })));
}

function serviceCard(s) {
  const st = s.status?.state || 'unknown';
  return h('a', { href: `#/services/${s.id}`, class: 'card tight', style: 'text-decoration:none;color:inherit;margin:0;display:block' },
    h('div', { class: 'row sp' }, h('strong', {}, s.kind === 'database' ? `🗄 ${s.name}` : s.name), stateBadge(st)),
    h('div', { class: 'mut mono trunc' }, s.kind === 'database' ? `${s.engine} · ${s.base_image}` : `${s.repo} · ${s.branch}`),
    h('div', { class: 'row sp sm mut' },
      h('span', {}, s.latest_deployment ? ['#', s.latest_deployment.number, ' ', deployBadge(s.latest_deployment.status), ' ', ago(s.latest_deployment.created_at)] : 'jamais déployé'),
      h('span', {}, s.status?.sample?.cpu != null ? `${fmtPct(s.status.sample.cpu)} · ${fmtBytes(s.status.sample.mem)}` : '')));
}

const eventLine = (e) => h('li', {},
  h('time', { datetime: e.at, title: dateTime(e.at) }, ago(e.at)),
  levelDot(e.level),
  e.service_id ? h('a', { href: `#/services/${e.service_id}` }, e.message) : h('span', {}, e.message));

// ── vue d'ensemble ────────────────────────────────────────────────────────
async function overviewView() {
  const o = await api('GET', '/overview');
  const metrics = await api('GET', '/system/metrics?range=1h');
  const sys = o.system;
  const up = sys.states?.running || 0;
  const nodes = [
    h('div', { class: 'row sp' },
      h('div', {}, h('h1', {}, 'Vue d’ensemble'), h('div', { class: 'mut' }, `${sys.projects} projet(s), ${sys.services} service(s) dont ${sys.databases} base(s) — ${sys.domain}`)),
      h('button', { class: 'pri', onclick: () => newProjectDialog() }, '+ Nouveau projet')),
    h('div', { class: 'tiles' },
      tile('Processeur', fmtPct(sys.cpu), `${sys.cpus} cœurs · charge ${(sys.load1 ?? 0).toFixed(2)}`, sys.cpu == null ? null : sys.cpu / 100),
      tile('Mémoire', fmtBytes(sys.mem), `sur ${fmtBytes(sys.mem_total)}`, sys.mem_total ? sys.mem / sys.mem_total : null),
      tile('Disque', fmtBytes(sys.disk), sys.disk_total ? `sur ${fmtBytes(sys.disk_total)}` : 'inconnu', sys.disk_total ? sys.disk / sys.disk_total : null),
      tile('Services en ligne', `${up} / ${sys.services}`, Object.entries(sys.states || {}).filter(([k]) => k !== 'running').map(([k, n]) => `${n} ${stateWord(k)}`).join(', ') || 'tout va bien')),
    h('div', { class: 'card' }, chart({
      points: metrics.points, series: [{ key: 'cpu', label: 'Processeur', color: VIZ.s1 }],
      format: fmtPct, title: 'Processeur du serveur (1 h)', limit: 100, limitLabel: 'plafond',
    })),
  ];

  for (const p of o.projects) {
    nodes.push(h('div', { class: 'row sp', style: 'margin-top:26px' },
      h('h2', { style: 'margin:0' }, p.name),
      h('div', { class: 'row' },
        h('button', { class: 'sm', onclick: () => newServiceDialog(p) }, '+ Service'),
        h('button', { class: 'sm', onclick: () => newDatabaseDialog(p) }, '+ Base de données'),
        h('button', { class: 'sm dng', onclick: confirmThen(`Supprimer le projet « ${p.name} », ses services, ses bases et leurs données ?`, async () => { await api('DELETE', `/projects/${p.id}`); render(); }) }, 'Supprimer'))));
    nodes.push(p.services.length
      ? h('div', { class: 'grid' }, p.services.map(serviceCard))
      : h('div', { class: 'card empty' }, 'Aucun service. Reliez un dépôt GitHub, ou ajoutez une base de données.'));
  }
  if (!o.projects.length) nodes.push(h('div', { class: 'card empty' }, 'Aucun projet. Créez-en un, puis ajoutez-y un service relié à un dépôt GitHub.'));

  nodes.push(h('div', { class: 'row sp', style: 'margin-top:26px' }, h('h2', { style: 'margin:0' }, 'Activité'), h('a', { href: '#/activity' }, 'Tout voir →')));
  nodes.push(h('div', { class: 'card' }, o.events.length ? h('ul', { class: 'feed' }, o.events.slice(0, 8).map(eventLine)) : h('div', { class: 'empty' }, 'Rien pour l’instant.')));
  $app.replaceChildren(...nodes);
  refreshIn(10000);
}

// ── tous les conteneurs de la machine ─────────────────────────────────────
async function containersView() {
  const liste = await api('GET', '/containers');
  const enMarche = liste.filter((c) => c.state === 'running');
  const aRail = liste.filter((c) => c.managed || c.name === 'rail-control' || c.name.startsWith('rail-'));
  const ligne = (c) => {
    const m = c.stats || c.sample || {};
    return h('tr', {},
      h('td', {}, h('div', { class: 'row', style: 'gap:7px' },
        h('span', { class: `s-${c.state === 'running' ? 'running' : 'stopped'}`, title: c.state, role: 'img', 'aria-label': c.state }, h('i', { class: 'dot' })),
        c.service ? h('a', { href: `#/services/${c.service.id}` }, c.name) : h('span', { class: 'mono' }, c.name)),
      h('div', { class: 'mut sm trunc', style: 'max-width:280px' }, c.image)),
      h('td', { class: 'sm' }, c.status),
      h('td', { class: 'mono sm' }, m.cpu != null ? fmtPct(m.cpu) : '—'),
      h('td', { class: 'mono sm' }, m.mem != null ? fmtBytes(m.mem) : '—'),
      h('td', { class: 'mut sm trunc', style: 'max-width:200px', title: c.ports }, c.ports || '—'),
      h('td', { class: 'mut sm' }, c.service ? `${c.service.project}/${c.service.name}` : c.control_plane ? 'plan de contrôle' : 'hors Rail'),
      h('td', { class: 'actions' },
        h('button', { class: 'sm', onclick: () => logDialog(`Journal — ${c.name}`, `/containers/${encodeURIComponent(c.name)}/logs?follow=1&tail=300`) }, 'Logs'),
        c.service || c.control_plane ? null : h('button', { class: 'sm', onclick: () => containerDialog(c) }, 'Détail')));
  };
  $app.replaceChildren(
    h('div', { class: 'row sp' }, h('h1', {}, 'Conteneurs'), h('span', { class: 'mut' }, `${enMarche.length} en marche sur ${liste.length}`)),
    h('p', { class: 'mut' }, 'Tout ce qui tourne sur ce serveur, déployé par Rail ou non. Les conteneurs de Rail se pilotent depuis leur service ; les autres se redémarrent ici.'),
    h('div', { class: 'card' }, h('table', {},
      h('thead', {}, h('tr', {}, ['Conteneur', 'État', 'Proc.', 'Mémoire', 'Ports', 'Origine', ''].map((t) => h('th', {}, t)))),
      h('tbody', {}, liste.map(ligne)))),
    aRail.length === liste.length ? null : h('p', { class: 'mut sm' }, 'Les conteneurs « hors Rail » gardent leur configuration : Rail les observe, les journalise et peut les redémarrer, mais ne les redéploie pas.'),
  );
  refreshIn(10000);
}

async function containerDialog(c) {
  const corps = h('div', {}, h('div', { class: 'mut' }, 'Chargement…'));
  const dlg = dialog(c.name, corps, { wide: true });
  const geste = (nom, etiquette) => h('button', {
    onclick: act(async () => { await api('POST', `/containers/${encodeURIComponent(c.name)}/${nom}`); dlg.close(); render(); }, `${etiquette} : fait`),
  }, etiquette);
  let m = { points: [] };
  try { m = await api('GET', `/containers/${encodeURIComponent(c.name)}/metrics?range=${range}`); } catch { /* pas de mesures */ }
  corps.replaceChildren(
    h('dl', { class: 'kv' },
      h('dt', {}, 'Image'), h('dd', { class: 'mono' }, c.image),
      h('dt', {}, 'État'), h('dd', {}, c.status),
      h('dt', {}, 'Ports'), h('dd', { class: 'mono' }, c.ports || '—'),
      h('dt', {}, 'Réseaux'), h('dd', { class: 'mono' }, c.networks || '—'),
      h('dt', {}, 'Créé'), h('dd', {}, c.created || '—')),
    h('div', { style: 'margin-top:14px' }, chart({ points: m.points, series: [{ key: 'cpu', label: 'Processeur', color: VIZ.s1 }], format: fmtPct, title: `Processeur (${m.range || range})` })),
    h('div', {}, chart({ points: m.points, series: [{ key: 'mem', label: 'Mémoire', color: VIZ.s1 }], format: fmtBytes, title: `Mémoire (${m.range || range})` })),
    h('p', { class: 'row', style: 'margin-top:14px' },
      h('button', { class: 'sm', onclick: () => logDialog(`Journal — ${c.name}`, `/containers/${encodeURIComponent(c.name)}/logs?follow=1&tail=300`) }, 'Logs'),
      c.state === 'running' ? geste('restart', 'Redémarrer') : null,
      c.state === 'running' ? geste('stop', 'Arrêter') : geste('start', 'Démarrer')),
  );
}

// ── activité ──────────────────────────────────────────────────────────────
let eventLevel = '';
async function activityView() {
  const events = await api('GET', `/events?limit=200${eventLevel ? `&level=${eventLevel}` : ''}`);
  const filter = h('div', { class: 'row' }, [['', 'Tout'], ['info', 'Informations'], ['warn', 'Avertissements'], ['error', 'Erreurs']].map(([v, l]) =>
    h('button', { class: `sm${eventLevel === v ? ' pri' : ''}`, onclick: () => { eventLevel = v; render(); } }, l)));
  $app.replaceChildren(
    h('div', { class: 'row sp' }, h('h1', {}, 'Activité'), filter),
    h('p', { class: 'mut' }, 'Déploiements, arrêts, redémarrages, pannes détectées : les 200 derniers événements.'),
    h('div', { class: 'card' }, events.length ? h('ul', { class: 'feed' }, events.map(eventLine)) : h('div', { class: 'empty' }, 'Aucun événement.')),
  );
  refreshIn(15000);
}

// ── système ───────────────────────────────────────────────────────────────
async function systemView() {
  const sys = await api('GET', '/system');
  const m = await api('GET', `/system/metrics?range=${range}`);
  const df = sys.df || {};
  const dfRow = (label, k) => (df[k] ? h('tr', {}, h('td', {}, label), h('td', { class: 'mono' }, `${df[k].active} / ${df[k].count}`), h('td', { class: 'mono' }, fmtBytes(df[k].size)), h('td', { class: 'mono' }, fmtBytes(df[k].reclaimable))) : null);
  $app.replaceChildren(
    h('div', { class: 'row sp' }, h('h1', {}, 'Système'), rangePicker()),
    h('div', { class: 'tiles' },
      tile('Processeur', fmtPct(sys.cpu), `${sys.cpus} cœurs · charge ${(sys.load1 ?? 0).toFixed(2)}`, sys.cpu == null ? null : sys.cpu / 100),
      tile('Mémoire', fmtBytes(sys.mem), `sur ${fmtBytes(sys.mem_total)}`, sys.mem_total ? sys.mem / sys.mem_total : null),
      tile('Disque', fmtBytes(sys.disk), sys.disk_total ? `sur ${fmtBytes(sys.disk_total)}` : 'inconnu', sys.disk_total ? sys.disk / sys.disk_total : null),
      tile('Serveur allumé depuis', fmtDur(sys.host_uptime_s), `plan de contrôle : ${fmtDur(sys.uptime_s)}`)),
    h('div', { class: 'card' }, chart({ points: m.points, series: [{ key: 'cpu', label: 'Processeur', color: VIZ.s1 }], format: fmtPct, title: `Processeur (${m.range})`, limit: 100, limitLabel: 'plafond' })),
    h('div', { class: 'card' }, chart({ points: m.points, series: [{ key: 'mem', label: 'Mémoire', color: VIZ.s1 }], format: fmtBytes, title: `Mémoire (${m.range})`, limit: sys.mem_total, limitLabel: 'total' })),
    h('div', { class: 'card' }, chart({ points: m.points, series: [{ key: 'disk', label: 'Disque', color: VIZ.s1 }], format: fmtBytes, title: `Disque (${m.range})`, limit: sys.disk_total, limitLabel: 'total' })),
    h('div', { class: 'card' },
      h('h3', {}, 'Place occupée par Docker'),
      h('table', {}, h('thead', {}, h('tr', {}, ['', 'Actifs / total', 'Taille', 'Récupérable'].map((t) => h('th', {}, t)))),
        h('tbody', {}, dfRow('Images', 'images'), dfRow('Conteneurs', 'containers'), dfRow('Volumes', 'local volumes'), dfRow('Cache de construction', 'build cache'))),
      h('p', { class: 'row' },
        h('button', { onclick: act(async () => { const r = await api('POST', '/system/prune'); toast(r.output || 'Nettoyé'); render(); }) }, 'Nettoyer les images orphelines'),
        h('span', { class: 'mut sm' }, 'Ne touche ni aux images en service, ni aux volumes de vos bases.'))),
    h('div', { class: 'card' },
      h('h3', {}, 'Installation'),
      h('dl', { class: 'kv' },
        h('dt', {}, 'Version de Rail'), h('dd', { class: 'mono' }, sys.version),
        h('dt', {}, 'Node'), h('dd', { class: 'mono' }, sys.node),
        h('dt', {}, 'Docker'), h('dd', { class: 'mono' }, sys.docker || 'inconnu'),
        h('dt', {}, 'Domaine de base'), h('dd', { class: 'mono' }, sys.domain),
        h('dt', {}, 'Tableau de bord'), h('dd', { class: 'mono' }, cfg.dashboardHost || ''),
        h('dt', {}, 'Alertes sortantes'), h('dd', {}, sys.alerts ? 'activées (RAIL_NOTIFY_URL)' : 'désactivées — renseignez RAIL_NOTIFY_URL dans .env'))),
  );
  refreshIn(15000);
}

function rangePicker() {
  return h('div', { class: 'row' }, RANGES.map((r) => h('button', {
    class: `sm${range === r ? ' pri' : ''}`,
    onclick: () => { range = r; localStorage.setItem('rail_range', r); render(); },
  }, r)));
}

// ── création ──────────────────────────────────────────────────────────────
function formDialog(title, content, onSubmit, submitLabel = 'Créer') {
  const form = h('form', { method: 'dialog', onsubmit: act(async (e) => { e.preventDefault(); await onSubmit(); dlg.close(); }) },
    content, h('p', { class: 'row' }, h('button', { class: 'pri', type: 'submit' }, submitLabel), h('button', { type: 'button', onclick: () => dlg.close() }, 'Annuler')));
  const dlg = dialog(title, form);
  form.querySelector('input,select')?.focus();
  return dlg;
}

function newProjectDialog() {
  const name = h('input', { required: true, pattern: '[a-z0-9]([a-z0-9\\-]{0,28}[a-z0-9])?', placeholder: 'mon-projet' });
  formDialog('Nouveau projet', field('Nom (minuscules, chiffres, tirets)', name),
    async () => { await api('POST', '/projects', { name: name.value }); render(); });
}

function newServiceDialog(p) {
  const f = {
    name: h('input', { required: true, placeholder: 'api' }),
    repo: h('input', { required: true, placeholder: 'propriétaire/dépôt' }),
    branch: h('input', { value: 'main' }),
    root_dir: h('input', { value: '.' }),
    port: h('input', { type: 'number', value: '3000', min: 1, max: 65535 }),
    healthcheck_path: h('input', { placeholder: '/health (facultatif)' }),
    github_token: h('input', { type: 'password', placeholder: 'dépôt privé : jeton « Contents: read »', autocomplete: 'off' }),
  };
  formDialog(`Nouveau service — ${p.name}`,
    h('div', {},
      h('div', { class: 'grid2' }, field('Nom', f.name), field('Dépôt GitHub', f.repo), field('Branche', f.branch), field('Dossier racine', f.root_dir), field('Port de l’API', f.port), field('Chemin de santé', f.healthcheck_path)),
      field('Jeton GitHub', f.github_token),
      h('p', { class: 'mut sm' }, 'Sans Dockerfile, Rail détecte Node, Python, Go ou Java et construit pour vous.')),
    async () => {
      const s = await api('POST', `/projects/${p.id}/services`, {
        name: f.name.value, repo: f.repo.value, branch: f.branch.value, root_dir: f.root_dir.value,
        port: +f.port.value, healthcheck_path: f.healthcheck_path.value || null, github_token: f.github_token.value || null,
      });
      location.hash = `#/services/${s.id}`;
    });
}

function newDatabaseDialog(p) {
  const engine = h('select', {}, (cfg.engines || []).map((e) => h('option', { value: e.id }, `${e.label} — ${e.image}`)));
  const name = h('input', { required: true, placeholder: 'base', value: 'base' });
  formDialog(`Nouvelle base de données — ${p.name}`,
    h('div', {},
      h('div', { class: 'grid2' }, field('Moteur', engine), field('Nom', name)),
      h('p', { class: 'mut sm' }, 'Rail engendre les identifiants, crée un volume persistant, et démarre la base sur le réseau privé. Les autres services s’y branchent avec ', h('span', { class: 'mono' }, '${{nom.DATABASE_URL}}'), '.')),
    async () => {
      const s = await api('POST', `/projects/${p.id}/databases`, { engine: engine.value, name: name.value });
      location.hash = `#/services/${s.id}`;
    });
}

// ── un service ────────────────────────────────────────────────────────────
const TABS_APP = [['apercu', 'Aperçu'], ['deployments', 'Déploiements'], ['logs', 'Logs'], ['variables', 'Variables'], ['domains', 'Domaines'], ['settings', 'Réglages']];
const TABS_DB = [['apercu', 'Aperçu'], ['sql', 'Requêtes'], ['deployments', 'Déploiements'], ['logs', 'Logs'], ['variables', 'Connexion'], ['settings', 'Réglages']];

async function serviceView(id, tab) {
  const s = await api('GET', `/services/${id}`);
  const isDb = s.kind === 'database';
  const parleSql = isDb && (cfg.engines || []).find((x) => x.id === s.engine)?.sql;
  const tabs = (isDb ? TABS_DB : TABS_APP).filter(([k]) => k !== 'sql' || parleSql);
  if (!tabs.some(([k]) => k === tab)) tab = 'apercu';
  const state = s.status?.state || 'unknown';
  const stopped = s.desired_state === 'stopped';

  const actions = h('div', { class: 'row' },
    stateBadge(state),
    isDb ? null : h('button', { class: 'pri', onclick: act(async () => { await api('POST', `/services/${id}/deploy`, {}); go(id, 'deployments'); }, 'Déploiement lancé') }, 'Déployer'),
    s.active_deployment ? h('button', { onclick: act(async () => { await api('POST', `/services/${id}/redeploy`); go(id, 'deployments'); }, 'Redéploiement lancé') }, 'Redéployer') : null,
    s.active_deployment && !stopped ? h('button', { onclick: act(async () => { await api('POST', `/services/${id}/restart`); render(); }, 'Redémarré') }, 'Redémarrer') : null,
    stopped
      ? h('button', { onclick: act(async () => { await api('POST', `/services/${id}/start`); render(); }, 'Démarré') }, 'Démarrer')
      : h('button', { onclick: confirmThen(`Arrêter « ${s.name} » ? Le service ne répondra plus jusqu’à son redémarrage.`, async () => { await api('POST', `/services/${id}/stop`); render(); }) }, 'Arrêter'));

  const head = h('div', {},
    h('div', { class: 'row sp' },
      h('div', {},
        h('h1', {}, isDb ? `🗄 ${s.name}` : s.name),
        h('div', { class: 'mut mono' }, `${s.project_name} / ${s.name} · `, isDb ? `${s.engine} ${s.base_image}` : `${s.repo} · ${s.branch}`)),
      actions),
    s.url ? h('p', {}, '🌐 ', h('a', { href: s.url, target: '_blank', rel: 'noopener' }, s.url)) : null,
    isDb ? h('p', { class: 'sm' }, 'Réseau privé : ', h('span', { class: 'mono' }, `${s.private_host}:${s.port}`)) : null);

  const tabsEl = h('div', { class: 'tabs', role: 'tablist' }, tabs.map(([k, l]) =>
    h('button', { role: 'tab', 'aria-selected': String(tab === k), class: tab === k ? 'on' : '', onclick: () => go(id, k) }, l)));
  const body = h('div', {});
  $app.replaceChildren(h('p', {}, h('a', { href: '#/' }, '← Vue d’ensemble')), head, tabsEl, body);

  if (tab === 'apercu') await overviewTab(body, s);
  if (tab === 'sql') await sqlTab(body, s);
  if (tab === 'deployments') await deploymentsTab(body, s);
  if (tab === 'logs') logsTab(body, s);
  if (tab === 'variables') await variablesTab(body, s);
  if (tab === 'domains') domainsTab(body, s);
  if (tab === 'settings') settingsTab(body, s);
}
const go = (id, tab) => { location.hash = `#/services/${id}/${tab}`; };

async function overviewTab(body, s) {
  const [m, events] = await Promise.all([
    api('GET', `/services/${s.id}/metrics?range=${range}`),
    api('GET', `/events?service_id=${s.id}&limit=8`),
  ]);
  const st = s.status || {};
  const dep = s.active_deployment;
  const since = st.startedAt || st.since;
  body.append(
    h('div', { class: 'tiles' },
      tile('État', stateWord(st.state || 'unknown'), since ? `depuis ${ago(since).replace('il y a ', '')}` : ''),
      tile('Disponibilité', m.uptime == null ? '—' : `${(m.uptime * 100).toFixed(1)} %`, `sur ${m.range}`),
      tile('Processeur', fmtPct(m.current?.cpu), `limite ${m.limits.cpus} cœur(s)`, m.current?.cpu == null ? null : m.current.cpu / (100 * m.limits.cpus)),
      tile('Mémoire', fmtBytes(m.current?.mem), `limite ${m.limits.memory_mb} Mo`, m.current?.mem == null ? null : m.current.mem / (m.limits.memory_mb * 1024 * 1024)),
      tile('Redémarrages', String(st.restarts ?? 0), 'depuis la création du conteneur')),
    h('div', { class: 'row sp' }, h('h2', { style: 'margin:0' }, 'Mesures'), rangePicker()),
    h('div', { class: 'card' }, chart({ points: m.points, series: [{ key: 'cpu', label: 'Processeur', color: VIZ.s1 }], format: fmtPct, title: `Processeur (${m.range})`, limit: m.limits.cpus * 100, limitLabel: 'limite' })),
    h('div', { class: 'card' }, chart({ points: m.points, series: [{ key: 'mem', label: 'Mémoire', color: VIZ.s1 }], format: fmtBytes, title: `Mémoire (${m.range})`, limit: m.limits.memory_mb * 1024 * 1024, limitLabel: 'limite' })),
    h('div', { class: 'card' }, chart({
      points: m.points,
      series: [{ key: 'rx', label: 'Entrant', color: VIZ.s1 }, { key: 'tx', label: 'Sortant', color: VIZ.s2 }],
      format: fmtRate, title: `Réseau (${m.range})`,
    })),
    h('div', { class: 'card' },
      h('h3', {}, 'Déploiement en service'),
      dep ? h('dl', { class: 'kv' },
        h('dt', {}, 'Numéro'), h('dd', {}, `#${dep.number} (${dep.trigger})`),
        h('dt', {}, 'Image'), h('dd', { class: 'mono trunc' }, dep.image || '—'),
        h('dt', {}, 'Commit'), h('dd', { class: 'mono' }, dep.commit_sha ? `${dep.commit_sha.slice(0, 10)} ${dep.commit_message || ''}` : '—'),
        h('dt', {}, 'Conteneur'), h('dd', { class: 'mono' }, dep.container || '—'),
        h('dt', {}, 'Déployé'), h('dd', {}, `${dateTime(dep.finished_at || dep.created_at)} (${ago(dep.finished_at || dep.created_at)})`),
        ...(s.volume ? [h('dt', {}, 'Volume'), h('dd', { class: 'mono' }, `${s.volume.name} → ${s.volume.path}`)] : []))
        : h('div', { class: 'empty' }, 'Aucun déploiement en service.')),
    h('div', { class: 'card' }, h('h3', {}, 'Activité du service'),
      events.length ? h('ul', { class: 'feed' }, events.map(eventLine)) : h('div', { class: 'empty sm' }, 'Rien pour l’instant.')),
  );
  refreshIn(8000);
}

async function deploymentsTab(body, s) {
  const deps = await api('GET', `/services/${s.id}/deployments`);
  if (!deps.length) {
    body.append(h('div', { class: 'card empty' }, 'Aucun déploiement. Cliquez sur « Déployer », ou installez le webhook (Réglages) pour déployer à chaque push.'));
    return;
  }
  const busy = deps.some((d) => ['queued', 'building', 'deploying'].includes(d.status));
  body.append(h('div', { class: 'card' }, h('table', {},
    h('thead', {}, h('tr', {}, ['#', 'Statut', 'Commit', 'Durée', 'Quand', ''].map((t) => h('th', {}, t)))),
    h('tbody', {}, deps.map((d) => {
      const dur = d.started_at && d.finished_at ? Math.round((new Date(d.finished_at) - new Date(d.started_at)) / 1000) : null;
      return h('tr', {},
        h('td', { class: 'mono' }, d.number),
        h('td', {}, deployBadge(d.status), d.error ? h('div', { class: 'mut sm' }, d.error) : null, d.id === s.active_deployment_id ? h('div', { class: 'sm s-ok' }, 'en service') : null),
        h('td', {}, h('span', { class: 'mono' }, (d.commit_sha || '').slice(0, 7)), ' ', d.commit_message || '',
          !['push', 'manual'].includes(d.trigger) ? h('span', { class: 'mut' }, ` (${d.trigger === 'rollback' ? 'retour arrière' : 'redéploiement'})`) : ''),
        h('td', { class: 'mut sm' }, dur == null ? '—' : fmtDur(dur)),
        h('td', { class: 'mut sm' }, ago(d.created_at)),
        h('td', { class: 'actions' },
          h('button', { class: 'sm', onclick: () => logDialog(`Déploiement #${d.number}`, `/deployments/${d.id}/logs?follow=1`) }, 'Logs'),
          ['success', 'removed'].includes(d.status) && d.id !== s.active_deployment_id && d.image
            ? h('button', { class: 'sm', onclick: confirmThen(`Remettre le déploiement #${d.number} en service ?`, async () => { await api('POST', `/deployments/${d.id}/rollback`); render(); }) }, 'Revenir ici') : null,
          ['queued', 'building', 'deploying'].includes(d.status)
            ? h('button', { class: 'sm dng', onclick: act(async () => { await api('POST', `/deployments/${d.id}/cancel`); render(); }) }, 'Annuler') : null));
    })))));
  if (busy) refreshIn(2500);
}

function logDialog(title, path) {
  const pre = h('pre', { class: 'log' }, 'Chargement…');
  const dlg = dialog(title, pre, { wide: true });
  const stop = followLog(path, pre);
  dlg.addEventListener('close', stop);
}

function logsTab(body, s) {
  if (!s.active_deployment) { body.append(h('div', { class: 'card empty' }, 'Aucun conteneur en service : déployez d’abord.')); return; }
  let buf = '';
  const pre = h('pre', { class: 'log' }, 'Chargement…');
  const filter = h('input', { placeholder: 'filtrer (texte simple)', style: 'flex:1' });
  const apply = () => {
    const q = filter.value.toLowerCase();
    pre.textContent = q ? buf.split('\n').filter((l) => l.toLowerCase().includes(q)).join('\n') : buf;
    pre.scrollTop = pre.scrollHeight;
  };
  filter.oninput = apply;
  body.append(h('div', { class: 'card' },
    h('div', { class: 'row' }, filter,
      h('button', { onclick: () => { const u = URL.createObjectURL(new Blob([buf], { type: 'text/plain' })); const a = h('a', { href: u, download: `${s.name}.log` }); document.body.append(a); a.click(); a.remove(); } }, 'Télécharger'),
      h('span', { class: 'mut sm' }, 'en direct')),
    pre));
  const stop = followLog(`/services/${s.id}/logs?follow=1&tail=400`, pre, { onLine: (t) => { buf += t; if (filter.value) apply(); } });
  onLeave(stop);
}

// ── console SQL ───────────────────────────────────────────────────────────
const DANGER = /\b(drop|truncate|delete|alter|update|grant|revoke)\b/i;
const histoire = {
  lire: () => { try { return JSON.parse(localStorage.getItem('rail_sql') || '{}'); } catch { return {}; } },
  pour: (id) => (histoire.lire()[id] || []),
  ajouter(id, sql) {
    const tout = histoire.lire();
    tout[id] = [sql, ...(tout[id] || []).filter((x) => x !== sql)].slice(0, 15);
    try { localStorage.setItem('rail_sql', JSON.stringify(tout)); } catch { /* navigation privée */ }
  },
};

async function sqlTab(body, s) {
  const editeur = h('textarea', { spellcheck: 'false', placeholder: 'SELECT * FROM ma_table LIMIT 100;' });
  const lecture = h('input', { type: 'checkbox', checked: true, style: 'width:auto' });
  const sortie = h('div', {});
  const infos = h('span', { class: 'mut sm' });
  const liste = h('div', { class: 'card tight tables' }, h('div', { class: 'mut sm' }, 'Chargement…'));

  const executer = act(async () => {
    const sql = editeur.value.trim();
    if (!sql) return;
    if (!lecture.checked && DANGER.test(sql) && !confirm('Cette requête peut modifier ou supprimer des données. Continuer ?')) return;
    infos.textContent = 'Exécution…';
    sortie.replaceChildren();
    try {
      const r = await api('POST', `/services/${s.id}/query`, { sql, read_only: lecture.checked });
      histoire.ajouter(s.id, sql);
      infos.textContent = `${r.message ? r.message : `${r.total ?? r.rows.length} ligne(s)`} · ${r.ms} ms${r.read_only ? ' · lecture seule' : ''}`;
      sortie.replaceChildren(resultat(r, s));
      if (!lecture.checked) rafraichirTables();
    } catch (e) {
      infos.textContent = '';
      sortie.replaceChildren(h('div', { class: 'erreur' }, e.message));
      throw e;
    }
  });
  editeur.addEventListener('keydown', (ev) => { if ((ev.metaKey || ev.ctrlKey) && ev.key === 'Enter') { ev.preventDefault(); executer({ currentTarget: null }); } });

  const lancer = (sql) => { editeur.value = sql; executer({ currentTarget: null }); };
  async function rafraichirTables() {
    try {
      const t = await api('GET', `/services/${s.id}/tables`);
      const lignes = t.rows.map((r) => {
        const nom = r.length > 1 && r[0] !== 'public' ? `${r[0]}.${r[1]}` : r[1];
        return h('button', { title: r[2] ? `taille ${r[2]}` : '', onclick: () => lancer(`SELECT * FROM ${nom} LIMIT 100;`) }, nom, r[2] ? h('span', { class: 'mut' }, ` · ${r[2]}`) : null);
      });
      liste.replaceChildren(h('div', { class: 'mut sm', style: 'padding:2px 8px 6px' }, lignes.length ? `${lignes.length} table(s)` : 'aucune table'), ...lignes);
    } catch (e) { liste.replaceChildren(h('div', { class: 'mut sm' }, e.message)); }
  }

  const passe = histoire.pour(s.id);
  const rappel = h('select', { style: 'max-width:240px', onchange: (ev) => { if (ev.target.value) { editeur.value = ev.target.value; ev.target.selectedIndex = 0; } } },
    h('option', { value: '' }, 'Requêtes récentes…'), passe.map((q) => h('option', { value: q }, q.replace(/\s+/g, ' ').slice(0, 70))));

  body.append(h('div', { class: 'sql' },
    h('div', {}, h('h3', {}, 'Tables'), liste,
      h('p', { class: 'mut sm' }, 'Un clic ouvre les 100 premières lignes.')),
    h('div', {},
      h('div', { class: 'card' },
        editeur,
        h('div', { class: 'row sp', style: 'margin-top:10px' },
          h('div', { class: 'row' },
            h('button', { class: 'pri', onclick: executer }, 'Exécuter'),
            h('label', { class: 'row', style: 'color:var(--fg);margin:0' }, lecture, 'Lecture seule'),
            passe.length ? rappel : null),
          h('span', { class: 'mut sm' }, 'Ctrl/⌘ + Entrée · une requête à la fois')),
        h('p', { class: 'mut sm', style: 'margin-bottom:0' }, 'Décochez « lecture seule » pour écrire : la requête est alors inscrite dans l’activité.')),
      h('div', { class: 'row', style: 'margin:6px 2px' }, infos),
      sortie)));
  rafraichirTables();
}

function resultat(r, s) {
  if (!r.columns.length) return h('div', { class: 'card tight mut' }, r.message || 'Aucun résultat.');
  const csv = () => {
    const echappe = (v) => (v == null ? '' : /[",\n]/.test(v) ? `"${String(v).replace(/"/g, '""')}"` : v);
    const texte = [r.columns.join(','), ...r.rows.map((l) => l.map(echappe).join(','))].join('\n');
    const u = URL.createObjectURL(new Blob([texte], { type: 'text/csv' }));
    const a = h('a', { href: u, download: `${s.name}-resultat.csv` });
    document.body.append(a); a.click(); a.remove();
  };
  return h('div', {},
    h('div', { class: 'result' }, h('table', {},
      h('thead', {}, h('tr', {}, r.columns.map((c) => h('th', {}, c)))),
      h('tbody', {}, r.rows.map((l) => h('tr', {}, l.map((v) => h('td', { class: v == null ? 'nul' : '', title: v == null ? 'NULL' : String(v) }, v == null ? 'NULL' : String(v)))))))),
    h('div', { class: 'row sp', style: 'margin-top:8px' },
      h('span', { class: 'mut sm' }, r.truncated ? `affichage des ${r.rows.length} premières lignes sur ${r.total}` : `${r.rows.length} ligne(s)`),
      h('button', { class: 'sm', onclick: csv }, 'Télécharger en CSV')),
    r.notice ? h('p', { class: 'mut sm' }, r.notice) : null);
}

async function variablesTab(body, s) {
  const vars = await api('GET', `/services/${s.id}/variables`);
  if (s.kind === 'database') {
    const rows = Object.entries(vars);
    body.append(h('div', { class: 'card' },
      h('h3', {}, 'Identifiants de connexion'),
      h('p', { class: 'mut sm' }, 'Engendrés à la création, chiffrés au repos. Dans un autre service du projet, écrivez ', h('span', { class: 'mono' }, `\${{${s.name}.DATABASE_URL}}`), ' : la valeur est injectée au déploiement.'),
      h('table', {}, h('tbody', {}, rows.map(([k, v]) => h('tr', {},
        h('td', { class: 'mono' }, k),
        h('td', { class: 'mono trunc', style: 'max-width:380px' }, /PASSWORD|URL/.test(k) ? '•'.repeat(18) : v),
        h('td', { class: 'actions' },
          h('button', { class: 'sm', onclick: () => copy(v) }, 'Copier'),
          h('button', { class: 'sm', onclick: () => copy(`\${{${s.name}.${k}}}`) }, 'Copier la référence')))))),
      s.engine_info?.client ? h('p', { class: 'sm mut' }, 'Client en ligne de commande, depuis le serveur : ', h('span', { class: 'mono' }, `docker exec -it ${s.active_deployment?.container || '<conteneur>'} ${s.engine_info.client}`)) : null));
    return;
  }
  const rows = h('div', {});
  const addRow = (k = '', v = '') => rows.append(h('div', { class: 'row', style: 'margin:6px 0' },
    h('input', { class: 'k mono', placeholder: 'NOM', value: k, style: 'flex:1' }),
    h('input', { class: 'v mono', placeholder: 'valeur', value: v, style: 'flex:2' }),
    h('button', { class: 'dng sm', title: 'Retirer', onclick: (e) => e.currentTarget.parentElement.remove() }, '✕')));
  Object.entries(vars).forEach(([k, v]) => addRow(k, v));
  const save = act(async () => {
    const next = {};
    for (const r of rows.children) { const k = r.querySelector('.k').value.trim(); if (k) next[k] = r.querySelector('.v').value; }
    for (const k of Object.keys(vars)) if (!(k in next)) await api('DELETE', `/services/${s.id}/variables/${encodeURIComponent(k)}`);
    await api('PUT', `/services/${s.id}/variables`, { variables: next });
  }, 'Variables enregistrées — redéployez pour les appliquer');
  body.append(h('div', { class: 'card' },
    h('p', { class: 'mut sm' }, 'Fournies à votre API comme variables d’environnement. ', h('span', { class: 'mono' }, 'PORT'), ' et ', h('span', { class: 'mono' }, 'RAIL_*'), ' sont posées par Rail. Chiffrées au repos. Pour pointer une base du projet : ', h('span', { class: 'mono' }, '${{ma-base.DATABASE_URL}}'), '.'),
    rows,
    h('div', { class: 'row' },
      h('button', { onclick: () => addRow() }, '+ Variable'),
      h('button', { class: 'pri', onclick: save }, 'Enregistrer'),
      h('button', { onclick: act(async () => { await save(); await api('POST', `/services/${s.id}/redeploy`); go(s.id, 'deployments'); }) }, 'Enregistrer et redéployer'))));
}

function domainsTab(body, s) {
  const host = h('input', { placeholder: 'api.mondomaine.com', style: 'flex:1' });
  body.append(h('div', { class: 'card' },
    h('table', {}, h('tbody', {}, s.domains.map((d) => h('tr', {},
      h('td', {}, h('a', { href: `https://${d.hostname}`, target: '_blank', rel: 'noopener' }, d.hostname)),
      h('td', { class: 'mut' }, d.kind === 'auto' ? 'fourni' : 'personnalisé'),
      h('td', { class: 'actions' }, h('button', { class: 'sm dng', onclick: act(async () => { await api('DELETE', `/services/${s.id}/domains/${d.id}`); render(); }) }, 'Retirer')))))),
    h('div', { class: 'row', style: 'margin-top:12px' }, host,
      h('button', { class: 'pri', onclick: act(async () => { await api('POST', `/services/${s.id}/domains`, { hostname: host.value }); render(); }, 'Domaine ajouté — redéployez pour l’appliquer') }, 'Ajouter')),
    h('p', { class: 'mut sm' }, `Pour un domaine personnalisé : un enregistrement DNS A (ou CNAME vers ${cfg.dashboardHost || 'ce serveur'}) vers ce serveur, puis « Redéployer ». Le certificat HTTPS est demandé automatiquement.`)));
}

function settingsTab(body, s) {
  if (s.kind === 'database') { databaseSettings(body, s); return; }
  const f = {
    repo: h('input', { value: s.repo }), branch: h('input', { value: s.branch }), root_dir: h('input', { value: s.root_dir }),
    dockerfile_path: h('input', { value: s.dockerfile_path || '', placeholder: 'auto' }),
    port: h('input', { type: 'number', value: s.port }), healthcheck_path: h('input', { value: s.healthcheck_path || '', placeholder: '/health' }),
    memory_mb: h('input', { type: 'number', value: s.memory_mb || '', placeholder: 'défaut' }),
    cpus: h('input', { type: 'number', step: '0.1', value: s.cpus || '', placeholder: 'défaut' }),
    volume_path: h('input', { value: s.volume_path || '', placeholder: '/data (facultatif)' }),
    github_token: h('input', { type: 'password', placeholder: s.has_github_token ? '•••••• (enregistré — laisser vide pour conserver)' : 'aucun', autocomplete: 'off' }),
  };
  const auto = h('input', { type: 'checkbox', checked: s.auto_deploy, style: 'width:auto' });
  const save = act(async (e) => {
    e.preventDefault();
    const p = {
      repo: f.repo.value, branch: f.branch.value, root_dir: f.root_dir.value, dockerfile_path: f.dockerfile_path.value || null,
      port: +f.port.value, healthcheck_path: f.healthcheck_path.value || null,
      memory_mb: f.memory_mb.value ? +f.memory_mb.value : null, cpus: f.cpus.value ? +f.cpus.value : null,
      volume_path: f.volume_path.value || null, auto_deploy: auto.checked,
    };
    if (f.github_token.value) p.github_token = f.github_token.value;
    await api('PATCH', `/services/${s.id}`, p);
    render();
  }, 'Réglages enregistrés');
  body.append(
    h('form', { class: 'card', onsubmit: save },
      h('div', { class: 'grid2' }, field('Dépôt', f.repo), field('Branche suivie', f.branch), field('Dossier racine', f.root_dir),
        field('Dockerfile (chemin)', f.dockerfile_path), field('Port', f.port), field('Chemin de santé', f.healthcheck_path),
        field('Mémoire (Mo)', f.memory_mb), field('CPU', f.cpus)),
      field('Volume persistant (point de montage)', f.volume_path, 'Un dossier qui survit aux déploiements. Attention : avec un volume, la nouvelle version ne peut pas tourner à côté de l’ancienne (courte interruption).'),
      field('Jeton GitHub', f.github_token),
      h('label', { class: 'row', style: 'color:var(--fg);margin-top:14px' }, auto, 'Déployer automatiquement à chaque push sur la branche'),
      h('p', {}, h('button', { class: 'pri', type: 'submit' }, 'Enregistrer'))),
    webhookCard(s),
    dangerCard(s));
}

function webhookCard(s) {
  return h('div', { class: 'card' },
    h('h3', {}, 'Déploiement à chaque push (webhook GitHub)'),
    h('p', { class: 'mut sm' }, 'Automatique si un jeton avec le droit « Webhooks: write » est enregistré :'),
    h('p', {}, h('button', { onclick: act(async () => { await api('POST', `/services/${s.id}/webhook/install`); }, 'Webhook installé sur GitHub') }, 'Installer le webhook')),
    h('p', { class: 'mut sm' }, 'Ou à la main (Settings → Webhooks → Add webhook), type « application/json », événement « push » :'),
    h('div', { class: 'row' }, h('span', { class: 'mono trunc' }, s.webhook.url), h('button', { class: 'sm', onclick: () => copy(s.webhook.url) }, 'Copier')),
    h('div', { class: 'row' }, h('span', { class: 'mono' }, 'Secret : ••••••••'), h('button', { class: 'sm', onclick: () => copy(s.webhook.secret) }, 'Copier le secret')));
}

function databaseSettings(body, s) {
  const image = h('input', { value: s.base_image, style: 'width:100%' });
  const memory_mb = h('input', { type: 'number', value: s.memory_mb || '' });
  const cpus = h('input', { type: 'number', step: '0.1', value: s.cpus || '' });
  body.append(
    h('form', {
      class: 'card',
      onsubmit: act(async (e) => {
        e.preventDefault();
        await api('PATCH', `/services/${s.id}`, { base_image: image.value, memory_mb: memory_mb.value ? +memory_mb.value : null, cpus: cpus.value ? +cpus.value : null });
        render();
      }, 'Enregistré — « Redéployer » pour appliquer'),
    },
    h('h3', {}, 'Réglages de la base'),
    field('Image', image, 'Changer de version majeure peut demander une migration des données : vérifiez la documentation du moteur.'),
    h('div', { class: 'grid2' }, field('Mémoire (Mo)', memory_mb), field('CPU', cpus)),
    h('p', {}, h('button', { class: 'pri', type: 'submit' }, 'Enregistrer'))),
    h('div', { class: 'card' },
      h('h3', {}, 'Sauvegarde'),
      h('p', { class: 'mut sm' }, 'Un export complet, en flux, depuis le conteneur. Gardez-le ailleurs que sur ce serveur.'),
      h('p', {}, h('button', { onclick: act(async () => { toast('Sauvegarde en cours…'); await download(`/services/${s.id}/backup`, `${s.name}.sql`); }, 'Sauvegarde téléchargée') }, 'Télécharger une sauvegarde')),
      s.volume ? h('p', { class: 'mut sm' }, 'Volume : ', h('span', { class: 'mono' }, s.volume.name), ' — à inclure dans vos sauvegardes du serveur.') : null),
    dangerCard(s));
}

function dangerCard(s) {
  return h('div', { class: 'card' },
    h('h3', { style: 'color:var(--ko)' }, 'Zone dangereuse'),
    s.volume ? h('p', { class: 'mut sm' }, 'Supprimer ce service supprime aussi son volume ', h('span', { class: 'mono' }, s.volume.name), ' : les données seront perdues.') : null,
    h('button', {
      class: 'dng',
      onclick: confirmThen(`Supprimer « ${s.name} » (conteneurs, images${s.volume ? ', et le volume avec ses données' : ''}) ?`,
        async () => { await api('DELETE', `/services/${s.id}`); location.hash = '#/'; }),
    }, 'Supprimer ce service'));
}

// ── routage ───────────────────────────────────────────────────────────────
function navLinks(view) {
  $nav.replaceChildren(
    h('a', { href: '#/', class: view === 'home' ? 'on' : '' }, 'Services'),
    h('a', { href: '#/containers', class: view === 'containers' ? 'on' : '' }, 'Conteneurs'),
    h('a', { href: '#/activity', class: view === 'activity' ? 'on' : '' }, 'Activité'),
    h('a', { href: '#/system', class: view === 'system' ? 'on' : '' }, 'Système'));
}

async function render() {
  leaveAll();
  document.getElementById('logout').hidden = !getToken();
  $nav.hidden = !getToken();
  if (!getToken()) return loginView();
  try {
    cfg = { ...cfg, ...(await api('GET', '/config')) };
    document.getElementById('domain').textContent = `${cfg.domain} · v${cfg.version}`;
    const m = /^#\/services\/([a-f0-9]+)(?:\/([a-z]+))?/.exec(location.hash);
    if (m) { navLinks('home'); await serviceView(m[1], m[2]); }
    else if (location.hash.startsWith('#/containers')) { navLinks('containers'); await containersView(); }
    else if (location.hash.startsWith('#/activity')) { navLinks('activity'); await activityView(); }
    else if (location.hash.startsWith('#/system')) { navLinks('system'); await systemView(); }
    else { navLinks('home'); await overviewView(); }
  } catch (e) {
    if (!getToken()) return loginView();
    $app.replaceChildren(h('div', { class: 'card' }, h('strong', {}, 'Erreur'), h('p', {}, e.message), h('button', { onclick: render }, 'Réessayer')));
  }
  return undefined;
}

addEventListener('hashchange', render);
render();
