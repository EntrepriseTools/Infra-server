// Le tableau de bord : une page, un routeur par ancre, et des vues qui ne
// parlent au serveur que par l'API JSON.
//
//   #/                     vue d'ensemble : la machine, les projets, l'activité
//   #/projects/<id>        un projet : ses environnements, ses services, ses variables
//   #/services/<id>/<tab>  un service (voir views.js)
//   #/templates            le catalogue en un clic
//   #/containers           tout ce que Docker fait tourner ici
//   #/activity  #/system   l'histoire, et la machine
//   #/account   #/users    mon compte, et les comptes (administrateur)
import {
  App, can, h, toast, act, field, dialog, formDialog, api, setCsrf, setUnauthorizedHandler,
  fmtBytes, fmtPct, fmtDur, ago, dateTime, chart, VIZ, rangePicker,
  stateBadge, stateWord, levelDot, copyBtn, confirmThen, kindIcon,
} from './ui.js';
import {
  serviceView, serviceCard, eventLine, logDialog,
  newServiceDialog, newDatabaseDialog, templatesDialog,
} from './views.js';

const $app = document.getElementById('app');
const $nav = document.getElementById('nav');
let stoppers = [];              // flux et minuteries de la vue courante
const envChoisi = new Map();    // projet → environnement affiché

App.onLeave = (fn) => stoppers.push(fn);
App.refreshIn = (ms) => { const t = setTimeout(App.render, ms); App.onLeave(() => clearTimeout(t)); };
App.range = (() => { try { return localStorage.getItem('rail_range') || '1h'; } catch { return '1h'; } })();
const leaveAll = () => { for (const f of stoppers) { try { f(); } catch { /* rien */ } } stoppers = []; };

// ── connexion ─────────────────────────────────────────────────────────────
setUnauthorizedHandler(() => { App.me = null; setCsrf(''); });

async function logout() {
  try { await api('POST', '/logout', {}); } catch { /* la session était déjà morte */ }
  App.me = null; setCsrf('');
  location.hash = '#/';
  render();
}
document.getElementById('logout').onclick = logout;

function loginView({ setupNeeded }) {
  const login = h('input', { required: true, autocomplete: 'username', placeholder: 'identifiant', style: 'width:100%' });
  const mdp = h('input', { type: 'password', required: true, autocomplete: setupNeeded ? 'new-password' : 'current-password', placeholder: 'mot de passe', style: 'width:100%' });
  const jeton = h('input', { type: 'password', required: true, autocomplete: 'off', placeholder: 'jeton d’administration', style: 'width:100%' });

  const entrer = act(async (e) => {
    e.preventDefault();
    const r = await api('POST', '/login', { login: login.value.trim(), password: mdp.value });
    App.me = { user: r.user, csrf: r.csrf, via: 'session' };
    setCsrf(r.csrf);
    render();
  });
  const installer = act(async (e) => {
    e.preventDefault();
    // Le jeton d'administration ne sert qu'ici : il prouve qu'on est bien
    // la personne qui a installé Rail, le temps de créer le premier compte.
    const res = await fetch('/api/setup', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${jeton.value.trim()}` },
      body: JSON.stringify({ login: login.value.trim(), password: mdp.value }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Erreur ${res.status}`);
    toast('Compte créé — connectez-vous');
    await entrer(e);
  });

  const form = h('form', { class: 'card login', onsubmit: setupNeeded ? installer : entrer },
    h('h1', {}, '▲ Rail'),
    setupNeeded
      ? h('div', {},
        h('p', { class: 'mut' }, 'Première ouverture : créez le compte administrateur. Le jeton d’administration est celui qu’a affiché l’installation (', h('span', { class: 'mono' }, 'RAIL_ADMIN_TOKEN'), ').'),
        field('Jeton d’administration', jeton),
        field('Identifiant', login, 'minuscules, chiffres, point, tiret'),
        field('Mot de passe', mdp, '10 caractères au moins'))
      : h('div', {},
        h('p', { class: 'mut' }, 'Déployez et surveillez vos API, vos bases et vos tâches, sur votre serveur.'),
        field('Identifiant', login),
        field('Mot de passe', mdp)),
    h('p', {}, h('button', { class: 'pri', type: 'submit' }, setupNeeded ? 'Créer le compte' : 'Entrer')));
  $app.replaceChildren(form);
  (setupNeeded ? jeton : login).focus();
}

// ── tuiles ────────────────────────────────────────────────────────────────
function tile(k, value, sub, ratio) {
  const cls = ratio == null ? '' : ratio > 0.9 ? ' ko' : ratio > 0.75 ? ' warn' : '';
  return h('div', { class: 'tile' },
    h('div', { class: 'k' }, k), h('div', { class: 'v' }, value), h('div', { class: 's' }, sub || ''),
    ratio == null ? null : h('div', { class: `bar${cls}` }, h('i', { style: `width:${Math.min(100, Math.round(ratio * 100))}%` })));
}

// ── un projet : pastilles d'environnement + grille de services ────────────
function envPills(p, courant, { gerer = false } = {}) {
  return h('div', { class: 'row' },
    ...p.environments.map((e) => h('button', {
      class: `sm${e.id === courant.id ? ' pri' : ''}`,
      onclick: () => { envChoisi.set(p.id, e.name); render(); },
    }, e.name, h('span', { class: 'mut' }, ` ${e.services.length}`))),
    gerer && can('member') ? h('button', { class: 'sm', title: 'Nouvel environnement', onclick: () => newEnvDialog(p) }, '+ Environnement') : null);
}

function newEnvDialog(p) {
  const name = h('input', { required: true, placeholder: 'preprod', pattern: '[a-z0-9]([a-z0-9\\-]{0,28}[a-z0-9])?' });
  const copier = h('select', {}, h('option', { value: '' }, 'partir de rien'), p.environments.map((e) => h('option', { value: e.id }, `copier « ${e.name} » (${e.services.length} service(s))`)));
  formDialog(`Nouvel environnement — ${p.name}`,
    h('div', {},
      h('div', { class: 'grid2' }, field('Nom', name), field('Contenu', copier)),
      h('p', { class: 'mut sm' }, 'Copier un environnement recrée ses services et leurs variables, avec des adresses à lui (',
        h('span', { class: 'mono' }, 'api-projet-preprod.' + (App.cfg.domain || '')), '). Les bases repartent vides, avec des identifiants neufs : aucune donnée n’est copiée.')),
    async () => {
      const e = await api('POST', `/projects/${p.id}/environments`, { name: name.value.trim(), copy_from: copier.value || null });
      envChoisi.set(p.id, e.name);
      toast(e.deploy_hint ? `Environnement créé — ${e.deploy_hint}` : 'Environnement créé');
      render();
    });
}

function projectSection(p, { detail = false } = {}) {
  const envs = p.environments;
  const voulu = envChoisi.get(p.id);
  const env = envs.find((e) => e.name === voulu) || envs.find((e) => e.name === 'production') || envs[0];
  const boutons = !can('member') ? [] : [
    h('button', { class: 'sm pri', onclick: () => newServiceDialog(p, env) }, '+ Service'),
    h('button', { class: 'sm', onclick: () => newDatabaseDialog(p, env) }, '+ Base de données'),
    h('button', { class: 'sm', onclick: () => newServiceDialog(p, env, { kind: 'cron' }) }, '+ Tâche planifiée'),
    h('button', { class: 'sm', onclick: () => templatesDialog(p, env) }, 'Modèles'),
  ];
  const titre = detail
    ? h('h1', { style: 'margin:0' }, p.name)
    : h('h2', { style: 'margin:0' }, h('a', { href: `#/projects/${p.id}`, style: 'color:inherit;text-decoration:none' }, p.name));
  // Une section nommée : le repère du projet dans la page (et dans les tests).
  return h('section', { class: 'projet', 'data-nom': p.name },
    h('div', { class: 'row sp', style: detail ? '' : 'margin-top:26px' }, titre, h('div', { class: 'row' }, boutons)),
    h('div', { class: 'row sp', style: 'margin:8px 0' }, envPills(p, env, { gerer: detail }),
      detail && env.name !== 'production' && can('member')
        ? h('button', { class: 'sm dng', onclick: confirmThen(`Supprimer l’environnement « ${env.name} » et ses ${env.services.length} service(s) ?`, async () => { await api('DELETE', `/environments/${env.id}`); envChoisi.delete(p.id); render(); }) }, `Supprimer « ${env.name} »`)
        : null),
    env.services.length
      ? h('div', { class: 'grid' }, env.services.map(serviceCard))
      : h('div', { class: 'card empty' }, 'Aucun service ici. Reliez un dépôt GitHub, déployez une image, ajoutez une base — ou partez d’un modèle.'),
    detail ? sharedVarsCard(env) : null,
    detail ? h('div', { class: 'card' },
      h('h3', { style: 'color:var(--ko)' }, 'Zone dangereuse'),
      h('p', { class: 'mut sm' }, 'Supprimer le projet supprime tous ses environnements, ses services, ses volumes et leurs données.'),
      !can('member') ? null : h('button', { class: 'dng', onclick: confirmThen(`Supprimer le projet « ${p.name} » et tout ce qu’il contient ?`, async () => { await api('DELETE', `/projects/${p.id}`); location.hash = '#/'; }) }, 'Supprimer ce projet')) : null);
}

/** Les variables communes à tous les services d'un environnement. */
function sharedVarsCard(env) {
  const carte = h('div', { class: 'card' }, h('h3', {}, `Variables partagées — ${env.name}`), h('div', { class: 'mut sm' }, 'Chargement…'));
  (async () => {
    const vars = await api('GET', `/environments/${env.id}/variables`);
    const rows = h('div', {});
    const addRow = (k = '', v = '') => rows.append(h('div', { class: 'row', style: 'margin:6px 0' },
      h('input', { class: 'k mono', placeholder: 'NOM', value: k, style: 'flex:1' }),
      h('input', { class: 'v mono', placeholder: 'valeur', value: v, style: 'flex:2' }),
      h('button', { class: 'dng sm', onclick: (e) => e.currentTarget.parentElement.remove() }, '✕')));
    Object.entries(vars).forEach(([k, v]) => addRow(k, v));
    carte.replaceChildren(
      h('h3', {}, `Variables partagées — ${env.name}`),
      h('p', { class: 'mut sm' }, 'Fournies à tous les services de cet environnement. Une variable du service remplace celle d’ici.'),
      rows,
      !can('member') ? null : h('div', { class: 'row' },
        h('button', { onclick: () => addRow() }, '+ Variable'),
        h('button', {
          class: 'pri',
          onclick: act(async () => {
            const next = {};
            for (const r of rows.children) { const k = r.querySelector('.k').value.trim(); if (k) next[k] = r.querySelector('.v').value; }
            await api('PUT', `/environments/${env.id}/variables`, { variables: next });
          }, 'Enregistré — redéployez les services pour appliquer'),
        }, 'Enregistrer')));
  })().catch((e) => carte.append(h('div', { class: 'erreur' }, e.message)));
  return carte;
}

// ── vue d'ensemble ────────────────────────────────────────────────────────
async function overviewView() {
  const o = await api('GET', '/overview');
  const metrics = await api('GET', '/system/metrics?range=1h');
  const sys = o.system;
  const up = sys.states?.running || 0;
  const nodes = [
    h('div', { class: 'row sp' },
      h('div', {}, h('h1', {}, 'Vue d’ensemble'),
        h('div', { class: 'mut' }, `${sys.projects} projet(s), ${sys.services} service(s) dont ${sys.databases} base(s) et ${sys.jobs} tâche(s) — ${sys.domain}`)),
      !can('member') ? null : h('div', { class: 'row' },
        h('a', { class: 'btn', href: '#/templates' }, 'Catalogue'),
        h('button', { class: 'pri', onclick: () => newProjectDialog() }, '+ Nouveau projet'))),
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

  for (const p of o.projects) nodes.push(projectSection(p));
  if (!o.projects.length) {
    nodes.push(h('div', { class: 'card' },
      h('h3', {}, 'Commencer'),
      h('p', {}, 'Créez un projet, puis reliez un dépôt GitHub — ou partez d’un modèle prêt à l’emploi.'),
      !can('member') ? null : h('p', { class: 'row' },
        h('button', { class: 'pri', onclick: () => newProjectDialog() }, '+ Nouveau projet'),
        h('a', { class: 'btn', href: '#/templates' }, 'Voir le catalogue'))));
  }

  nodes.push(h('div', { class: 'row sp', style: 'margin-top:26px' }, h('h2', { style: 'margin:0' }, 'Activité'), h('a', { href: '#/activity' }, 'Tout voir →')));
  nodes.push(h('div', { class: 'card' }, o.events.length ? h('ul', { class: 'feed' }, o.events.slice(0, 8).map(eventLine)) : h('div', { class: 'empty' }, 'Rien pour l’instant.')));
  $app.replaceChildren(...nodes);
  App.refreshIn(10000);
}

async function projectView(id) {
  const p = await api('GET', `/projects/${id}`);
  $app.replaceChildren(h('p', {}, h('a', { href: '#/' }, '← Vue d’ensemble')), projectSection(p, { detail: true }));
  App.refreshIn(15000);
}

function newProjectDialog() {
  const name = h('input', { required: true, pattern: '[a-z0-9]([a-z0-9\\-]{0,28}[a-z0-9])?', placeholder: 'mon-projet' });
  formDialog('Nouveau projet', field('Nom (minuscules, chiffres, tirets)', name, 'Un environnement « production » est créé avec le projet.'),
    async () => { const p = await api('POST', '/projects', { name: name.value }); location.hash = `#/projects/${p.id}`; });
}

// ── catalogue de modèles ──────────────────────────────────────────────────
async function templatesView() {
  const projets = await api('GET', '/projects');
  const lancer = (t) => async () => {
    if (!can('member')) return;
    if (!projets.length) { toast('Créez d’abord un projet', true); newProjectDialog(); return; }
    const choix = h('select', {}, projets.flatMap((p) => p.environments.map((e) => h('option', { value: `${p.id}|${e.id}` }, `${p.name} / ${e.name}`))));
    const prefix = h('input', { placeholder: 'facultatif', pattern: '[a-z0-9]([a-z0-9\\-]{0,28}[a-z0-9])?' });
    formDialog(`Déployer ${t.label}`,
      h('div', {},
        h('p', {}, t.about),
        h('p', { class: 'mut sm' }, 'Services créés : ', h('span', { class: 'mono' }, t.services.map((s) => `${s.name} (${s.what})`).join(' + '))),
        h('div', { class: 'grid2' }, field('Où', choix), field('Préfixe des noms', prefix, 'Pour déployer ce modèle deux fois'))),
      async () => {
        const [pid, eid] = choix.value.split('|');
        toast(`Déploiement de ${t.label}…`);
        const r = await api('POST', `/projects/${pid}/templates`, { template: t.id, environment_id: eid, prefix: prefix.value.trim() || null });
        location.hash = `#/services/${r.main?.id ?? r.services[0].id}/deployments`;
      }, 'Déployer');
  };
  $app.replaceChildren(
    h('div', { class: 'row sp' }, h('h1', {}, 'Catalogue'), h('a', { href: '#/' }, '← Vue d’ensemble')),
    h('p', { class: 'mut' }, 'Des piles complètes, déployées en un clic : Rail crée les services, engendre les secrets, câble les variables entre eux et lance la construction. Les versions d’images restent modifiables ensuite.'),
    h('div', { class: 'grid' }, (App.cfg.templates || []).map((t) => h('div', { class: 'card' },
      h('div', { class: 'row sp' }, h('strong', {}, t.label), h('span', { class: 'tag' }, (t.tags || [])[0] || '')),
      h('div', { class: 'sm' }, t.tagline),
      h('p', { class: 'mut sm' }, t.about),
      h('div', { class: 'mut sm mono trunc', title: t.services.map((s) => s.what).join(' + ') }, t.services.map((s) => s.name).join(' + ')),
      !can('member') ? null : h('p', { style: 'margin-bottom:0' }, h('button', { class: 'pri sm', onclick: act(lancer(t)) }, 'Déployer'))))),
  );
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
      h('td', { class: 'mut sm' }, c.service ? `${c.service.project}/${c.service.environment}/${c.service.name}` : c.control_plane ? 'plan de contrôle' : 'hors Rail'),
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
  App.refreshIn(10000);
}

async function containerDialog(c) {
  const corps = h('div', {}, h('div', { class: 'mut' }, 'Chargement…'));
  const dlg = dialog(c.name, corps, { wide: true });
  const geste = (nom, etiquette) => h('button', {
    onclick: act(async () => { await api('POST', `/containers/${encodeURIComponent(c.name)}/${nom}`); dlg.close(); render(); }, `${etiquette} : fait`),
  }, etiquette);
  let m = { points: [] };
  try { m = await api('GET', `/containers/${encodeURIComponent(c.name)}/metrics?range=${App.range}`); } catch { /* pas de mesures */ }
  corps.replaceChildren(
    h('dl', { class: 'kv' },
      h('dt', {}, 'Image'), h('dd', { class: 'mono' }, c.image),
      h('dt', {}, 'État'), h('dd', {}, c.status),
      h('dt', {}, 'Ports'), h('dd', { class: 'mono' }, c.ports || '—'),
      h('dt', {}, 'Réseaux'), h('dd', { class: 'mono' }, c.networks || '—'),
      h('dt', {}, 'Créé'), h('dd', {}, c.created || '—')),
    h('div', { style: 'margin-top:14px' }, chart({ points: m.points, series: [{ key: 'cpu', label: 'Processeur', color: VIZ.s1 }], format: fmtPct, title: `Processeur (${m.range || App.range})` })),
    h('div', {}, chart({ points: m.points, series: [{ key: 'mem', label: 'Mémoire', color: VIZ.s1 }], format: fmtBytes, title: `Mémoire (${m.range || App.range})` })),
    h('p', { class: 'row', style: 'margin-top:14px' },
      h('button', { class: 'sm', onclick: () => logDialog(`Journal — ${c.name}`, `/containers/${encodeURIComponent(c.name)}/logs?follow=1&tail=300`) }, 'Logs'),
      !can('member') ? null : c.state === 'running' ? geste('restart', 'Redémarrer') : null,
      !can('member') ? null : c.state === 'running' ? geste('stop', 'Arrêter') : geste('start', 'Démarrer')),
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
    h('p', { class: 'mut' }, 'Déploiements, arrêts, redémarrages, pannes détectées, connexions et changements de comptes : les 200 derniers événements, avec qui les a demandés.'),
    h('div', { class: 'card' }, events.length ? h('ul', { class: 'feed' }, events.map(eventLine)) : h('div', { class: 'empty' }, 'Aucun événement.')),
  );
  App.refreshIn(15000);
}

// ── système ───────────────────────────────────────────────────────────────
async function systemView() {
  const sys = await api('GET', '/system');
  const m = await api('GET', `/system/metrics?range=${App.range}`);
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
      !can('admin') ? null : h('p', { class: 'row' },
        h('button', { onclick: act(async () => { const r = await api('POST', '/system/prune', {}); toast(r.output || 'Nettoyé'); render(); }) }, 'Nettoyer les images orphelines'),
        h('span', { class: 'mut sm' }, 'Ne touche ni aux images en service, ni aux volumes de vos bases.'))),
    h('div', { class: 'card' },
      h('h3', {}, 'Installation'),
      h('dl', { class: 'kv' },
        h('dt', {}, 'Version de Rail'), h('dd', { class: 'mono' }, sys.version),
        h('dt', {}, 'Node'), h('dd', { class: 'mono' }, sys.node),
        h('dt', {}, 'Docker'), h('dd', { class: 'mono' }, sys.docker || 'inconnu'),
        h('dt', {}, 'Domaine de base'), h('dd', { class: 'mono' }, sys.domain),
        h('dt', {}, 'Tableau de bord'), h('dd', { class: 'mono' }, App.cfg.dashboardHost || ''),
        h('dt', {}, 'Mode TLS'), h('dd', { class: 'mono' }, App.cfg.tls || '?'),
        h('dt', {}, 'Ports TCP exposables'), h('dd', { class: 'mono' }, `${App.cfg.tcp_ports?.from}–${App.cfg.tcp_ports?.to}`),
        h('dt', {}, 'Comptes'), h('dd', {}, `${sys.users} compte(s)`),
        h('dt', {}, 'Alertes sortantes'), h('dd', {}, sys.alerts ? 'activées (RAIL_NOTIFY_URL)' : 'désactivées — renseignez RAIL_NOTIFY_URL dans .env'))),
  );
  App.refreshIn(15000);
}

// ── mon compte ────────────────────────────────────────────────────────────
async function accountView() {
  const me = await api('GET', '/me');
  App.me = me; setCsrf(me.csrf);
  const [tokens, sessions] = await Promise.all([
    api('GET', '/me/tokens').catch(() => []),
    api('GET', '/me/sessions').catch(() => []),
  ]);
  const actuel = h('input', { type: 'password', autocomplete: 'current-password' });
  const neuf = h('input', { type: 'password', autocomplete: 'new-password' });
  const jeton = h('input', { type: 'password', placeholder: 'github_pat_… ou ghp_…', autocomplete: 'off', style: 'flex:1' });
  const partage = h('input', { type: 'checkbox', style: 'width:auto' });
  const nomJeton = h('input', { placeholder: 'mon-portable', pattern: '[a-z0-9]([a-z0-9\\-]{0,28}[a-z0-9])?' });

  $app.replaceChildren(
    h('h1', {}, 'Mon compte'),
    h('div', { class: 'card' },
      h('dl', { class: 'kv' },
        h('dt', {}, 'Identifiant'), h('dd', { class: 'mono' }, me.user.login),
        h('dt', {}, 'Rôle'), h('dd', {}, `${me.user.role_label} — ${(me.roles.find((r) => r.id === me.user.role) || {}).help || ''}`),
        h('dt', {}, 'Accès en cours'), h('dd', {}, me.via === 'root' ? 'jeton d’administration (.env)' : me.via === 'token' ? 'jeton d’API' : 'session du navigateur'),
        h('dt', {}, 'Dernière venue'), h('dd', {}, me.user.last_seen_at ? dateTime(me.user.last_seen_at) : '—')),
      me.user.must_change_password ? h('p', { class: 'erreur' }, 'Votre mot de passe a été défini par un administrateur : changez-le maintenant.') : null),

    me.user.root ? null : h('form', {
      class: 'card',
      onsubmit: act(async (e) => {
        e.preventDefault();
        await api('POST', '/me/password', { current: actuel.value, next: neuf.value });
        toast('Mot de passe changé — les autres sessions ont été fermées');
        actuel.value = ''; neuf.value = '';
        render();
      }),
    },
    h('h3', {}, 'Mot de passe'),
    h('div', { class: 'grid2' }, field('Mot de passe actuel', actuel), field('Nouveau mot de passe', neuf, '10 caractères au moins')),
    h('p', {}, h('button', { class: 'pri', type: 'submit' }, 'Changer le mot de passe'))),

    h('div', { class: 'card' },
      h('h3', {}, 'Compte GitHub'),
      me.github.connected
        ? h('p', {}, `Relié${me.github.login ? ` : ${me.github.login}` : ''} (${me.github.scope}). Rail peut lister vos dépôts, les cloner et installer les webhooks.`)
        : h('p', { class: 'mut sm' }, 'Reliez un jeton pour choisir vos dépôts dans une liste au lieu de les écrire. Droits utiles : « Contents: read » et « Webhooks: write ».'),
      h('div', { class: 'row' }, jeton,
        h('button', { class: 'pri', onclick: act(async () => { const r = await api('POST', '/me/github', { token: jeton.value.trim(), shared: partage.checked }); toast(`GitHub relié : ${r.github.login}`); render(); }) }, 'Relier'),
        me.github.connected ? h('button', { class: 'dng', onclick: act(async () => { await api('DELETE', '/me/github'); render(); }, 'Jeton retiré') }, 'Retirer') : null),
      !can('admin') ? null : h('label', { class: 'row', style: 'color:var(--fg)' }, partage, 'Partager ce jeton avec toute la plateforme (pour les dépôts de l’organisation)')),

    me.user.root ? null : h('div', { class: 'card' },
      h('h3', {}, 'Jetons d’API (ligne de commande)'),
      h('p', { class: 'mut sm' }, 'Un jeton vaut votre rôle. Pour la CLI : ', h('span', { class: 'mono' }, `RAIL_URL=${App.cfg.publicUrl || ''} RAIL_TOKEN=… rail status`)),
      tokens.length ? h('table', {}, h('tbody', {}, tokens.map((t) => h('tr', {},
        h('td', { class: 'mono' }, t.name),
        h('td', { class: 'mut sm' }, `créé ${ago(t.created_at)}`),
        h('td', { class: 'mut sm' }, t.last_used_at ? `utilisé ${ago(t.last_used_at)}` : 'jamais utilisé'),
        h('td', { class: 'actions' }, h('button', { class: 'sm dng', onclick: act(async () => { await api('DELETE', `/me/tokens/${t.id}`); render(); }, 'Jeton révoqué') }, 'Révoquer')))))) : h('div', { class: 'empty sm' }, 'Aucun jeton.'),
      !can('member') ? null : h('div', { class: 'row', style: 'margin-top:10px' }, nomJeton,
        h('button', {
          class: 'pri',
          onclick: act(async () => {
            const t = await api('POST', '/me/tokens', { name: (nomJeton.value || 'cli').trim() });
            dialog('Jeton créé', h('div', {},
              h('p', {}, 'Copiez-le maintenant : il ne sera plus affiché.'),
              h('pre', { class: 'log' }, t.token),
              h('p', {}, copyBtn(t.token, 'Copier le jeton')),
              h('p', { class: 'mut sm' }, 'Pour la CLI : ', h('span', { class: 'mono' }, `export RAIL_URL=${App.cfg.publicUrl || ''} RAIL_TOKEN=${t.token.slice(0, 10)}…`))));
            render();
          }),
        }, 'Créer un jeton'))),

    me.user.root ? null : h('div', { class: 'card' },
      h('h3', {}, 'Sessions ouvertes'),
      h('table', {}, h('tbody', {}, sessions.map((x) => h('tr', {},
        h('td', {}, x.current ? h('strong', {}, 'cette session') : h('span', { class: 'mut' }, 'autre navigateur')),
        h('td', { class: 'mut sm' }, x.ip || '—'),
        h('td', { class: 'mut sm trunc', style: 'max-width:260px', title: x.agent || '' }, x.agent || '—'),
        h('td', { class: 'mut sm' }, `vue ${ago(x.seen_at)}`),
        h('td', { class: 'actions' }, x.current ? null : h('button', { class: 'sm dng', onclick: act(async () => { await api('DELETE', `/me/sessions/${x.id}`); render(); }, 'Session fermée') }, 'Fermer')))))),
      h('p', { class: 'mut sm' }, 'Changer de mot de passe ferme toutes les autres sessions.')),
  );
}

// ── comptes (administrateur) ──────────────────────────────────────────────
async function usersView() {
  const users = await api('GET', '/users');
  const roles = App.me?.roles || [];
  const creer = () => {
    const login = h('input', { required: true, pattern: '[a-z0-9][a-z0-9._\\-]{1,30}', placeholder: 'prenom.nom' });
    const nom = h('input', { placeholder: 'Prénom Nom' });
    const mdp = h('input', { type: 'password', required: true, autocomplete: 'new-password' });
    const role = h('select', {}, roles.map((r) => h('option', { value: r.id, selected: r.id === 'member' }, `${r.label} — ${r.help}`)));
    formDialog('Nouveau compte',
      h('div', {},
        h('div', { class: 'grid2' }, field('Identifiant', login), field('Nom affiché', nom)),
        field('Rôle', role),
        field('Mot de passe provisoire', mdp, '10 caractères au moins — la personne devra le changer')),
      async () => {
        await api('POST', '/users', { login: login.value.trim(), name: nom.value.trim() || null, password: mdp.value, role: role.value });
        render();
      });
  };
  const changerMdp = (u) => {
    const mdp = h('input', { type: 'password', required: true, autocomplete: 'new-password' });
    formDialog(`Nouveau mot de passe — ${u.login}`,
      field('Mot de passe provisoire', mdp, 'Les sessions ouvertes de cette personne seront fermées'),
      async () => { await api('PATCH', `/users/${u.id}`, { password: mdp.value }); toast('Mot de passe remis à zéro'); render(); }, 'Enregistrer');
  };
  $app.replaceChildren(
    h('div', { class: 'row sp' }, h('h1', {}, 'Comptes'), h('button', { class: 'pri', onclick: creer }, '+ Nouveau compte')),
    h('p', { class: 'mut' }, 'Un lecteur voit tout sans rien changer ; un membre déploie et exploite ; un administrateur gère en plus les comptes et la machine.'),
    h('div', { class: 'card' }, h('table', {},
      h('thead', {}, h('tr', {}, ['Identifiant', 'Nom', 'Rôle', 'Dernière venue', ''].map((t) => h('th', {}, t)))),
      h('tbody', {}, users.map((u) => h('tr', {},
        h('td', { class: 'mono' }, u.login, u.must_change_password ? h('span', { class: 'tag' }, 'mot de passe à changer') : null),
        h('td', {}, u.name || '—'),
        h('td', {}, h('select', {
          onchange: act(async (ev) => { await api('PATCH', `/users/${u.id}`, { role: ev.target.value }); render(); }, 'Rôle changé'),
        }, roles.map((r) => h('option', { value: r.id, selected: r.id === u.role }, r.label)))),
        h('td', { class: 'mut sm' }, u.last_seen_at ? ago(u.last_seen_at) : 'jamais connecté'),
        h('td', { class: 'actions' },
          h('button', { class: 'sm', onclick: () => changerMdp(u) }, 'Mot de passe'),
          h('button', { class: 'sm dng', onclick: confirmThen(`Supprimer le compte « ${u.login} » ?`, async () => { await api('DELETE', `/users/${u.id}`); render(); }) }, 'Supprimer'))))))),
  );
}

// ── routage ───────────────────────────────────────────────────────────────
function navLinks(view) {
  $nav.replaceChildren(
    h('a', { href: '#/', class: view === 'home' ? 'on' : '' }, 'Services'),
    h('a', { href: '#/templates', class: view === 'templates' ? 'on' : '' }, 'Catalogue'),
    h('a', { href: '#/containers', class: view === 'containers' ? 'on' : '' }, 'Conteneurs'),
    h('a', { href: '#/activity', class: view === 'activity' ? 'on' : '' }, 'Activité'),
    h('a', { href: '#/system', class: view === 'system' ? 'on' : '' }, 'Système'),
    can('admin') ? h('a', { href: '#/users', class: view === 'users' ? 'on' : '' }, 'Comptes') : null,
    h('a', { href: '#/account', class: view === 'account' ? 'on' : '' }, App.me?.user?.login || 'Mon compte'),
  );
}

async function render() {
  leaveAll();
  // Pas de session connue : on demande qui c'est. La route est publique et répond
  // « personne » plutôt que de refuser : aucun 401 à chaque ouverture de la page.
  if (!App.me) {
    document.getElementById('logout').hidden = true;
    $nav.hidden = true;
    const s = await api('GET', '/session').catch(() => ({ authenticated: false }));
    if (!s.authenticated) {
      document.getElementById('domain').textContent = s.version ? `v${s.version}` : '';
      return loginView({ setupNeeded: !!s.setup_needed });
    }
    App.me = s; setCsrf(s.csrf);
  }
  document.getElementById('logout').hidden = false;
  $nav.hidden = false;
  try {
    App.cfg = { ...App.cfg, ...(await api('GET', '/config')) };
    document.getElementById('domain').textContent = `${App.cfg.domain} · v${App.cfg.version}`;
    const svc = /^#\/services\/([a-f0-9]+)(?:\/([a-z]+))?/.exec(location.hash);
    const proj = /^#\/projects\/([a-f0-9]+)/.exec(location.hash);
    if (svc) { navLinks('home'); await serviceView(svc[1], svc[2]); }
    else if (proj) { navLinks('home'); await projectView(proj[1]); }
    else if (location.hash.startsWith('#/templates')) { navLinks('templates'); await templatesView(); }
    else if (location.hash.startsWith('#/containers')) { navLinks('containers'); await containersView(); }
    else if (location.hash.startsWith('#/activity')) { navLinks('activity'); await activityView(); }
    else if (location.hash.startsWith('#/system')) { navLinks('system'); await systemView(); }
    else if (location.hash.startsWith('#/account')) { navLinks('account'); await accountView(); }
    else if (location.hash.startsWith('#/users')) { navLinks('users'); await usersView(); }
    else { navLinks('home'); await overviewView(); }
  } catch (e) {
    if (!App.me) return render();
    $app.replaceChildren(h('div', { class: 'card' }, h('strong', {}, 'Erreur'), h('p', {}, e.message), h('button', { onclick: render }, 'Réessayer')));
  }
  return undefined;
}
App.render = render;

addEventListener('hashchange', render);
render();
