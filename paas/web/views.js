// Les vues d'un service, et les assistants de création.
//
// Tout ce qui crée quelque chose passe par une fenêtre : choisir un dépôt GitHub,
// une image, un moteur de base, une pile entière. L'idée est qu'un service parte
// en un clic, et que les réglages fins attendent qu'on les demande.
import {
  App, can, h, toast, act, field, dialog, formDialog, api, download, followLog, saveText, copy, copyBtn, confirmThen,
  fmtBytes, fmtRate, fmtPct, fmtDur, ago, dans, dateTime, chart, VIZ, rangePicker,
  stateBadge, deployBadge, runBadge, levelDot, stateWord, kindIcon,
} from './ui.js';

/**
 * Aller sur un onglet d'un service. Quand on y est déjà, changer l'ancre ne
 * déclenche rien : on repeint à la main. (« Déployer » depuis l'onglet
 * Déploiements, « Exécuter » depuis l'onglet Exécutions…)
 */
const go = (id, tab) => {
  const cible = `#/services/${id}/${tab}`;
  if (location.hash === cible) App.render(); else location.hash = cible;
};
const tile = (k, value, sub, ratio) => {
  const cls = ratio == null ? '' : ratio > 0.9 ? ' ko' : ratio > 0.75 ? ' warn' : '';
  return h('div', { class: 'tile' },
    h('div', { class: 'k' }, k), h('div', { class: 'v' }, value), h('div', { class: 's' }, sub || ''),
    ratio == null ? null : h('div', { class: `bar${cls}` }, h('i', { style: `width:${Math.min(100, Math.round(ratio * 100))}%` })));
};
export const eventLine = (e) => h('li', {},
  h('time', { datetime: e.at, title: `${dateTime(e.at)}${e.actor ? ` · ${e.actor}` : ''}` }, ago(e.at)),
  levelDot(e.level),
  e.service_id ? h('a', { href: `#/services/${e.service_id}` }, e.message) : h('span', {}, e.message),
  e.actor ? h('span', { class: 'mut sm' }, ` — ${e.actor}`) : null);

export function logDialog(title, path) {
  const pre = h('pre', { class: 'log' }, 'Chargement…');
  const dlg = dialog(title, pre, { wide: true });
  const stop = followLog(path, pre);
  dlg.addEventListener('close', stop);
}

// ── la carte d'un service, sur la page d'un projet ─────────────────────────
export function serviceCard(s) {
  const st = s.status?.state || 'unknown';
  const quoi = s.kind === 'database' ? `${s.engine_label || s.engine} · ${s.base_image}`
    : s.source_kind === 'image' ? s.base_image
      : `${s.repo} · ${s.branch}`;
  return h('a', { href: `#/services/${s.id}`, class: 'card tight', style: 'text-decoration:none;color:inherit;margin:0;display:block' },
    h('div', { class: 'row sp' }, h('strong', {}, `${kindIcon(s)} ${s.name}`), stateBadge(st)),
    h('div', { class: 'mut mono trunc' }, quoi),
    h('div', { class: 'row sp sm mut' },
      h('span', {}, s.kind === 'cron'
        ? (s.cron?.words || s.cron?.schedule || 'sans planification')
        : s.latest_deployment ? ['#', s.latest_deployment.number, ' ', deployBadge(s.latest_deployment.status), ' ', ago(s.latest_deployment.created_at)] : 'jamais déployé'),
      h('span', {}, s.status?.sample?.cpu != null ? `${fmtPct(s.status.sample.cpu)} · ${fmtBytes(s.status.sample.mem)}` : '')));
}

// ══════════════════════════════════════════════════════════════════════════
//  Créer : dépôt GitHub, image, base de données, tâche planifiée, modèle
// ══════════════════════════════════════════════════════════════════════════

/** Le bandeau « reliez GitHub », avec le champ de jeton, quand aucun n'est enregistré. */
function githubConnect(onDone) {
  const jeton = h('input', { type: 'password', placeholder: 'github_pat_… ou ghp_…', autocomplete: 'off', style: 'flex:1' });
  return h('div', { class: 'card tight' },
    h('p', { class: 'mut sm', style: 'margin-top:0' },
      'Pour lister vos dépôts, Rail a besoin d’un jeton GitHub à portée réduite : ',
      h('a', { href: 'https://github.com/settings/personal-access-tokens/new', target: '_blank', rel: 'noopener' }, 'créer un jeton'),
      ' avec « Contents: read » (et « Webhooks: write » pour déployer à chaque push).'),
    h('div', { class: 'row' }, jeton,
      h('button', {
        class: 'pri',
        onclick: act(async () => {
          const r = await api('POST', '/me/github', { token: jeton.value.trim() });
          App.me.github = { connected: true, scope: r.scope, login: r.github.login };
          toast(`GitHub relié : ${r.github.login}`);
          onDone();
        }),
      }, 'Relier')));
}

/**
 * L'assistant « nouveau service » : un dépôt GitHub (choisi dans la liste) ou une
 * image publique. Le nom, la branche et le port sont devinés ; « Créer et déployer »
 * fait tout le reste.
 */
export function newServiceDialog(project, env, { kind = 'app' } = {}) {
  const corps = h('div', {});
  const titre = kind === 'cron' ? `Nouvelle tâche planifiée — ${project.name} / ${env.name}` : `Nouveau service — ${project.name} / ${env.name}`;
  const dlg = dialog(titre, corps, { wide: true });
  let mode = 'repo';
  let choisi = null;      // { full_name, default_branch }
  let branches = null;

  const champs = {
    name: h('input', { required: true, placeholder: 'api', pattern: '[a-z0-9]([a-z0-9\\-]{0,28}[a-z0-9])?' }),
    branch: h('input', { value: 'main' }),
    root_dir: h('input', { value: '.' }),
    port: h('input', { type: 'number', value: kind === 'cron' ? '1' : '3000', min: 1, max: 65535 }),
    healthcheck_path: h('input', { placeholder: '/health (facultatif)' }),
    image: h('input', { placeholder: 'ghcr.io/org/image:1.2.3' }),
    volume_path: h('input', { placeholder: '/data (facultatif)' }),
    start_command: h('input', { placeholder: kind === 'cron' ? 'node tache.js' : 'laisser vide : commande de l’image' }),
    schedule: h('input', { value: '0 3 * * *', placeholder: '0 3 * * *' }),
  };
  const deployer = h('input', { type: 'checkbox', checked: true, style: 'width:auto' });

  const onglet = (id, label) => h('button', {
    class: mode === id ? 'on' : '', role: 'tab', 'aria-selected': String(mode === id),
    onclick: () => { mode = id; peindre(); },
  }, label);

  async function listeDepots(hote) {
    hote.replaceChildren(h('div', { class: 'mut sm' }, 'Chargement des dépôts…'));
    try {
      const repos = await api('GET', '/github/repos');
      const recherche = h('input', { placeholder: 'filtrer…', style: 'width:100%' });
      const liste = h('div', { class: 'picker' });
      const peindreListe = () => {
        const q = recherche.value.toLowerCase();
        const vus = repos.filter((r) => !q || r.full_name.toLowerCase().includes(q)).slice(0, 60);
        liste.replaceChildren(...(vus.length ? vus.map((r) => h('button', {
          type: 'button', class: choisi?.full_name === r.full_name ? 'on' : '',
          onclick: async () => {
            choisi = r;
            champs.name.value = r.full_name.split('/')[1].toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 30).replace(/^-|-$/g, '') || 'api';
            champs.branch.value = r.default_branch;
            branches = null;
            peindre();
            try { branches = await api('GET', `/github/branches?repo=${encodeURIComponent(r.full_name)}`); peindre(); } catch { /* la saisie libre reste */ }
          },
        },
        h('strong', {}, r.full_name), r.private ? h('span', { class: 'tag' }, 'privé') : null,
        h('div', { class: 'mut sm trunc' }, r.description || `${r.language || '—'} · mis à jour ${ago(r.pushed_at)}`))) : [h('div', { class: 'empty sm' }, 'Aucun dépôt ne correspond.')]));
      };
      recherche.oninput = peindreListe;
      hote.replaceChildren(recherche, liste);
      peindreListe();
    } catch (e) {
      hote.replaceChildren(
        /jeton GitHub/i.test(e.message) ? githubConnect(() => listeDepots(hote)) : h('div', { class: 'erreur' }, e.message),
        h('p', { class: 'mut sm' }, 'Vous pouvez aussi écrire le dépôt à la main ci-dessous.'),
        field('Dépôt (propriétaire/dépôt)', h('input', {
          placeholder: 'acme/api',
          oninput: (ev) => { choisi = ev.target.value.includes('/') ? { full_name: ev.target.value.trim(), default_branch: 'main' } : null; },
        })));
    }
  }

  const depotsHote = h('div', {});
  function peindre() {
    const branchChamp = branches
      ? h('select', {}, branches.map((b) => h('option', { value: b, selected: b === champs.branch.value }, b)))
      : champs.branch;
    if (branches) branchChamp.onchange = (ev) => { champs.branch.value = ev.target.value; };

    corps.replaceChildren(
      h('div', { class: 'tabs', role: 'tablist' }, onglet('repo', 'Dépôt GitHub'), onglet('image', 'Image Docker')),
      mode === 'repo'
        ? h('div', {},
          depotsHote,
          choisi ? h('p', { class: 'sm' }, 'Dépôt choisi : ', h('span', { class: 'mono' }, choisi.full_name)) : h('p', { class: 'mut sm' }, 'Choisissez un dépôt dans la liste.'),
          h('div', { class: 'grid2' },
            field('Nom du service', champs.name),
            field('Branche suivie', branchChamp),
            field('Dossier racine', champs.root_dir, 'Pour un monodépôt : services/api'),
            kind === 'cron' ? field('Planification', champs.schedule, 'minute heure jour mois jour-semaine') : field('Port écouté', champs.port),
            kind === 'cron' ? field('Commande', champs.start_command) : field('Chemin de santé', champs.healthcheck_path, 'Rail attend une réponse 2xx avant de basculer')),
          h('p', { class: 'mut sm' }, 'Sans Dockerfile, Rail reconnaît Node, Python, Go et Java et construit l’image pour vous.'))
        : h('div', {},
          field('Image', champs.image, 'Une image publique : postgres:16, ghcr.io/org/app:1.0, docker.io/bitnami/…'),
          h('div', { class: 'grid2' },
            field('Nom du service', champs.name),
            kind === 'cron' ? field('Planification', champs.schedule) : field('Port écouté', champs.port),
            field('Volume persistant', champs.volume_path, 'Un dossier qui survit aux déploiements'),
            field('Commande', champs.start_command)),
          kind === 'cron' ? null : field('Chemin de santé', champs.healthcheck_path)),
      h('label', { class: 'row', style: 'color:var(--fg);margin-top:14px' }, deployer, 'Déployer tout de suite'),
      h('p', { class: 'row' },
        h('button', { class: 'pri', onclick: creer }, 'Créer'),
        h('button', { onclick: () => dlg.close() }, 'Annuler')),
    );
    if (mode === 'repo' && !depotsHote.hasChildNodes()) listeDepots(depotsHote);
  }

  const creer = act(async () => {
    const body = {
      name: champs.name.value.trim(),
      kind,
      source: mode,
      environment_id: env.id,
      deploy: deployer.checked,
      start_command: champs.start_command.value.trim() || null,
    };
    if (kind === 'cron') body.cron_schedule = champs.schedule.value.trim();
    else {
      body.port = +champs.port.value;
      body.healthcheck_path = champs.healthcheck_path.value.trim() || null;
    }
    if (mode === 'repo') {
      if (!choisi) throw new Error('choisissez un dépôt');
      body.repo = choisi.full_name;
      body.branch = champs.branch.value.trim() || 'main';
      body.root_dir = champs.root_dir.value.trim() || '.';
    } else {
      body.image = champs.image.value.trim();
      body.volume_path = champs.volume_path.value.trim() || null;
      if (kind === 'cron') body.port = 1;
    }
    const s = await api('POST', `/projects/${project.id}/services`, body);
    // Le webhook, pour déployer à chaque push : en silence, et sans bloquer si le jeton ne le permet pas.
    if (mode === 'repo') {
      api('POST', `/services/${s.id}/webhook/install`).then(
        () => toast('Webhook GitHub installé : chaque push déploiera'),
        () => toast('Service créé — webhook à installer depuis ses réglages'),
      );
    }
    dlg.close();
    location.hash = `#/services/${s.id}${deployer.checked ? '/deployments' : ''}`;
  });

  peindre();
  return dlg;
}

/** Les moteurs de bases, en cartes : un clic, un nom, et c'est parti. */
export function newDatabaseDialog(project, env) {
  const moteurs = App.cfg.engines || [];
  let choisi = moteurs[0]?.id;
  const name = h('input', { required: true, value: 'base', pattern: '[a-z0-9]([a-z0-9\\-]{0,28}[a-z0-9])?' });
  const schedule = h('input', { placeholder: '0 3 * * * (facultatif)' });
  const liste = h('div', { class: 'picker' });
  const corps = h('div', {},
    liste,
    h('div', { class: 'grid2' }, field('Nom de la base', name), field('Sauvegarde automatique', schedule, 'Planification « cron » ; vide = aucune')),
    h('p', { class: 'mut sm' }, 'Rail engendre les identifiants, crée un volume persistant et démarre la base sur le réseau privé. Un autre service du même environnement s’y branche avec ',
      h('span', { class: 'mono' }, '${{base.DATABASE_URL}}'), '.'));

  const peindre = () => liste.replaceChildren(...moteurs.map((m) => h('button', {
    type: 'button', class: choisi === m.id ? 'on' : '',
    onclick: () => { choisi = m.id; if (name.value === 'base' || !name.value) name.value = 'base'; peindre(); },
  },
  h('div', { class: 'row sp' }, h('strong', {}, m.label), h('span', { class: 'tag' }, m.family)),
  h('div', { class: 'mut sm' }, m.about),
  h('div', { class: 'mut sm mono trunc' }, `${m.image} · port ${m.port}${m.backup ? ' · sauvegarde intégrée' : ''}${m.sql ? ' · console SQL' : ''}`))));
  peindre();

  return formDialog(`Nouvelle base de données — ${project.name} / ${env.name}`, corps, async () => {
    const s = await api('POST', `/projects/${project.id}/databases`, {
      engine: choisi, name: name.value.trim(), environment_id: env.id, backup_schedule: schedule.value.trim() || null,
    });
    location.hash = `#/services/${s.id}`;
  }, 'Créer la base', { wide: true });
}

/** Le catalogue de modèles : une pile entière, câblée, déployée. */
export function templatesDialog(project, env) {
  const modeles = App.cfg.templates || [];
  const prefix = h('input', { placeholder: 'facultatif : blog, client-b…', pattern: '[a-z0-9]([a-z0-9\\-]{0,28}[a-z0-9])?' });
  const corps = h('div', {});
  const dlg = dialog(`Déployer un modèle — ${project.name} / ${env.name}`, corps, { wide: true });
  const lancer = (t) => act(async () => {
    toast(`Déploiement de ${t.label}…`);
    const r = await api('POST', `/projects/${project.id}/templates`, { template: t.id, environment_id: env.id, prefix: prefix.value.trim() || null });
    dlg.close();
    location.hash = `#/services/${r.main?.id ?? r.services[0].id}/deployments`;
  });
  corps.replaceChildren(
    h('p', { class: 'mut sm', style: 'margin-top:0' }, 'Chaque modèle crée ses services (application et base), engendre ses secrets, câble les variables entre eux et déploie. Les versions d’images restent modifiables ensuite, service par service.'),
    field('Préfixe des noms', prefix, 'Pour déployer le même modèle deux fois dans un projet'),
    h('div', { class: 'grid' }, modeles.map((t) => h('div', { class: 'card tight' },
      h('div', { class: 'row sp' }, h('strong', {}, t.label), h('span', { class: 'tag' }, t.tags?.[0] || '')),
      h('div', { class: 'sm' }, t.tagline),
      h('div', { class: 'mut sm' }, t.about),
      h('div', { class: 'mut sm mono trunc', title: t.services.map((s) => s.what).join(' + ') }, t.services.map((s) => s.name).join(' + ')),
      h('p', { style: 'margin-bottom:0' }, h('button', { class: 'pri sm', onclick: lancer(t) }, 'Déployer'))))),
  );
  return dlg;
}

// ══════════════════════════════════════════════════════════════════════════
//  Un service
// ══════════════════════════════════════════════════════════════════════════
const TABS = {
  app: [['apercu', 'Aperçu'], ['deployments', 'Déploiements'], ['logs', 'Logs'], ['variables', 'Variables'], ['domains', 'Domaines'], ['settings', 'Réglages']],
  database: [['apercu', 'Aperçu'], ['sql', 'Requêtes'], ['backups', 'Sauvegardes'], ['deployments', 'Déploiements'], ['logs', 'Logs'], ['variables', 'Connexion'], ['settings', 'Réglages']],
  cron: [['apercu', 'Aperçu'], ['runs', 'Exécutions'], ['deployments', 'Déploiements'], ['variables', 'Variables'], ['settings', 'Réglages']],
};

export async function serviceView(id, tab) {
  const s = await api('GET', `/services/${id}`);
  const isDb = s.kind === 'database';
  const parleSql = isDb && (App.cfg.engines || []).find((x) => x.id === s.engine)?.sql;
  const tabs = (TABS[s.kind] || TABS.app).filter(([k]) => (k !== 'sql' || parleSql) && (k !== 'backups' || s.backup?.supported));
  if (!tabs.some(([k]) => k === tab)) tab = 'apercu';
  const state = s.status?.state || 'unknown';
  const stopped = s.desired_state === 'stopped';
  const ecrire = can('member');

  const actions = h('div', { class: 'row' },
    stateBadge(state),
    !ecrire ? null : s.kind === 'cron'
      ? h('button', { class: 'pri', onclick: act(async () => { await api('POST', `/services/${id}/run`); go(id, 'runs'); }, 'Exécution lancée') }, 'Exécuter maintenant')
      : isDb ? null : h('button', { class: 'pri', onclick: act(async () => { await api('POST', `/services/${id}/deploy`, {}); go(id, 'deployments'); }, 'Déploiement lancé') }, 'Déployer'),
    !ecrire ? null : s.active_deployment || s.source_kind === 'image'
      ? h('button', { onclick: act(async () => { await api('POST', `/services/${id}/redeploy`); go(id, 'deployments'); }, 'Redéploiement lancé') }, 'Redéployer') : null,
    !ecrire || s.kind === 'cron' ? null : s.active_deployment && !stopped
      ? h('button', { onclick: act(async () => { await api('POST', `/services/${id}/restart`); App.render(); }, 'Redémarré') }, 'Redémarrer') : null,
    !ecrire ? null : stopped
      ? h('button', { onclick: act(async () => { await api('POST', `/services/${id}/start`); App.render(); }, 'Démarré') }, s.kind === 'cron' ? 'Réactiver' : 'Démarrer')
      : h('button', { onclick: confirmThen(s.kind === 'cron' ? `Suspendre « ${s.name} » ? Les exécutions planifiées s’arrêtent.` : `Arrêter « ${s.name} » ? Le service ne répondra plus jusqu’à son redémarrage.`, async () => { await api('POST', `/services/${id}/stop`); App.render(); }) }, s.kind === 'cron' ? 'Suspendre' : 'Arrêter'));

  const quoi = isDb ? `${s.engine_label || s.engine} · ${s.base_image}`
    : s.source_kind === 'image' ? s.base_image : `${s.repo} · ${s.branch}`;
  const head = h('div', {},
    h('div', { class: 'row sp' },
      h('div', {},
        h('h1', {}, `${kindIcon(s)} ${s.name}`),
        h('div', { class: 'mut mono' },
          h('a', { href: `#/projects/${s.project_id}?env=${s.environment_name}` }, `${s.project_name} / ${s.environment_name}`),
          ` · ${quoi}`)),
      actions),
    s.url ? h('p', {}, '🌐 ', h('a', { href: s.url, target: '_blank', rel: 'noopener' }, s.url)) : null,
    s.kind !== 'app' ? h('p', { class: 'sm' }, 'Réseau privé : ', h('span', { class: 'mono' }, `${s.private_host}${s.kind === 'database' ? `:${s.port}` : ''}`)) : null,
    s.public_endpoint ? h('p', { class: 'sm' }, 'Exposé en TCP : ', h('span', { class: 'mono' }, s.public_endpoint), ' ', copyBtn(s.public_endpoint)) : null,
    s.kind === 'cron' && s.cron?.next ? h('p', { class: 'sm' }, `⏱ ${s.cron.words} — prochaine exécution ${dans(s.cron.next)} (${dateTime(s.cron.next)})`) : null);

  const tabsEl = h('div', { class: 'tabs', role: 'tablist' }, tabs.map(([k, l]) =>
    h('button', { role: 'tab', 'aria-selected': String(tab === k), class: tab === k ? 'on' : '', onclick: () => go(id, k) }, l)));
  const body = h('div', {});
  document.getElementById('app').replaceChildren(
    h('p', {}, h('a', { href: '#/' }, '← Vue d’ensemble')), head, tabsEl, body,
  );

  const vues = {
    apercu: overviewTab, sql: sqlTab, deployments: deploymentsTab, logs: logsTab,
    variables: variablesTab, domains: domainsTab, settings: settingsTab, backups: backupsTab, runs: runsTab,
  };
  await vues[tab](body, s);
}

async function overviewTab(body, s) {
  const [m, events] = await Promise.all([
    api('GET', `/services/${s.id}/metrics?range=${App.range}`),
    api('GET', `/events?service_id=${s.id}&limit=8`),
  ]);
  const st = s.status || {};
  const dep = s.active_deployment;
  const since = st.startedAt || st.since;
  const tuiles = s.kind === 'cron'
    ? [
      tile('État', stateWord(st.state || 'unknown'), s.cron?.words || ''),
      tile('Prochaine', s.cron?.next ? dans(s.cron.next) : '—', s.cron?.next ? dateTime(s.cron.next) : 'sans planification'),
      tile('Dernière', s.cron?.last_run ? ago(s.cron.last_run.started_at) : '—', s.cron?.last_run ? `${s.cron.last_run.status}${s.cron.last_run.exit_code != null ? ` (code ${s.cron.last_run.exit_code})` : ''}` : 'jamais exécutée'),
    ]
    : [
      tile('État', stateWord(st.state || 'unknown'), since ? `depuis ${ago(since).replace('il y a ', '')}` : ''),
      tile('Disponibilité', m.uptime == null ? '—' : `${(m.uptime * 100).toFixed(1)} %`, `sur ${m.range}`),
      tile('Processeur', fmtPct(m.current?.cpu), `limite ${m.limits.cpus} cœur(s)`, m.current?.cpu == null ? null : m.current.cpu / (100 * m.limits.cpus)),
      tile('Mémoire', fmtBytes(m.current?.mem), `limite ${m.limits.memory_mb} Mo`, m.current?.mem == null ? null : m.current.mem / (m.limits.memory_mb * 1024 * 1024)),
      tile('Redémarrages', String(st.restarts ?? 0), 'depuis la création du conteneur'),
    ];
  body.append(
    h('div', { class: 'tiles' }, tuiles),
    s.kind === 'cron' ? null : h('div', { class: 'row sp' }, h('h2', { style: 'margin:0' }, 'Mesures'), rangePicker()),
    s.kind === 'cron' ? null : h('div', { class: 'card' }, chart({ points: m.points, series: [{ key: 'cpu', label: 'Processeur', color: VIZ.s1 }], format: fmtPct, title: `Processeur (${m.range})`, limit: m.limits.cpus * 100, limitLabel: 'limite' })),
    s.kind === 'cron' ? null : h('div', { class: 'card' }, chart({ points: m.points, series: [{ key: 'mem', label: 'Mémoire', color: VIZ.s1 }], format: fmtBytes, title: `Mémoire (${m.range})`, limit: m.limits.memory_mb * 1024 * 1024, limitLabel: 'limite' })),
    s.kind === 'cron' ? null : h('div', { class: 'card' }, chart({
      points: m.points,
      series: [{ key: 'rx', label: 'Entrant', color: VIZ.s1 }, { key: 'tx', label: 'Sortant', color: VIZ.s2 }],
      format: fmtRate, title: `Réseau (${m.range})`,
    })),
    h('div', { class: 'card' },
      h('h3', {}, s.kind === 'cron' ? 'Image en service' : 'Déploiement en service'),
      dep ? h('dl', { class: 'kv' },
        h('dt', {}, 'Numéro'), h('dd', {}, `#${dep.number} (${dep.trigger})`),
        h('dt', {}, 'Image'), h('dd', { class: 'mono trunc' }, dep.image || '—'),
        h('dt', {}, 'Commit'), h('dd', { class: 'mono' }, dep.commit_sha ? `${dep.commit_sha.slice(0, 10)} ${dep.commit_message || ''}` : '—'),
        h('dt', {}, 'Conteneur'), h('dd', { class: 'mono' }, dep.container || (s.kind === 'cron' ? 'aucun (tâche planifiée)' : '—')),
        h('dt', {}, 'Déployé'), h('dd', {}, `${dateTime(dep.finished_at || dep.created_at)} (${ago(dep.finished_at || dep.created_at)})`),
        ...(s.volume ? [h('dt', {}, 'Volume'), h('dd', { class: 'mono' }, `${s.volume.name} → ${s.volume.path}`)] : []))
        : h('div', { class: 'empty' }, 'Aucun déploiement en service.')),
    h('div', { class: 'card' }, h('h3', {}, 'Activité du service'),
      events.length ? h('ul', { class: 'feed' }, events.map(eventLine)) : h('div', { class: 'empty sm' }, 'Rien pour l’instant.')),
  );
  App.refreshIn(8000);
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
        h('td', {}, h('span', { class: 'mono' }, (d.commit_sha || '').slice(0, 7)), ' ', d.commit_message || (s.source_kind === 'image' ? d.image : ''),
          !['push', 'manual'].includes(d.trigger) ? h('span', { class: 'mut' }, ` (${d.trigger === 'rollback' ? 'retour arrière' : 'redéploiement'})`) : ''),
        h('td', { class: 'mut sm' }, dur == null ? '—' : fmtDur(dur)),
        h('td', { class: 'mut sm' }, ago(d.created_at)),
        h('td', { class: 'actions' },
          h('button', { class: 'sm', onclick: () => logDialog(`Déploiement #${d.number}`, `/deployments/${d.id}/logs?follow=1`) }, 'Logs'),
          !can('member') ? null : ['success', 'removed'].includes(d.status) && d.id !== s.active_deployment_id && d.image
            ? h('button', { class: 'sm', onclick: confirmThen(`Remettre le déploiement #${d.number} en service ?`, async () => { await api('POST', `/deployments/${d.id}/rollback`); App.render(); }) }, 'Revenir ici') : null,
          !can('member') ? null : ['queued', 'building', 'deploying'].includes(d.status)
            ? h('button', { class: 'sm dng', onclick: act(async () => { await api('POST', `/deployments/${d.id}/cancel`); App.render(); }) }, 'Annuler') : null));
    })))));
  if (busy) App.refreshIn(2500);
}

function logsTab(body, s) {
  if (!s.active_deployment?.container) { body.append(h('div', { class: 'card empty' }, 'Aucun conteneur en service : déployez d’abord.')); return; }
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
      h('button', { onclick: () => saveText(buf, `${s.name}.log`) }, 'Télécharger'),
      h('span', { class: 'mut sm' }, 'en direct')),
    pre));
  App.onLeave(followLog(`/services/${s.id}/logs?follow=1&tail=400`, pre, { onLine: (t) => { buf += t; if (filter.value) apply(); } }));
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
    saveText([r.columns.join(','), ...r.rows.map((l) => l.map(echappe).join(','))].join('\n'), `${s.name}-resultat.csv`, 'text/csv');
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

// ── sauvegardes ───────────────────────────────────────────────────────────
async function backupsTab(body, s) {
  const d = await api('GET', `/services/${s.id}/backups`);
  const schedule = h('input', { value: d.schedule || '', placeholder: '0 3 * * * (vide = aucune)' });
  const keep = h('input', { type: 'number', value: d.keep, min: 1, max: 365, style: 'width:100%' });
  const presets = h('select', { onchange: (ev) => { if (ev.target.value) { schedule.value = ev.target.value; ev.target.selectedIndex = 0; } } },
    h('option', { value: '' }, 'Choisir une fréquence…'), (App.cfg.cron_presets || []).map((p) => h('option', { value: p.expr }, p.label)));

  body.append(
    h('div', { class: 'card' },
      h('h3', {}, 'Sauvegardes automatiques'),
      h('div', { class: 'grid2' }, field('Planification', schedule, 'minute heure jour mois jour-semaine (heure du serveur)'), field('Sauvegardes gardées', keep)),
      field('Fréquences courantes', presets),
      h('p', { class: 'row' },
        h('button', {
          class: 'pri',
          onclick: act(async () => { await api('PATCH', `/services/${s.id}`, { backup_schedule: schedule.value.trim() || null, backup_keep: +keep.value }); App.render(); }, 'Enregistré'),
        }, 'Enregistrer'),
        h('span', { class: 'mut sm' }, d.schedule ? `Actuellement : ${s.backup?.words || d.schedule}` : 'Aucune sauvegarde automatique'))),
    h('div', { class: 'card' },
      h('div', { class: 'row sp' },
        h('h3', { style: 'margin:0' }, `Sauvegardes sur le serveur (${fmtBytes(d.total_size)})`),
        h('div', { class: 'row' },
          h('button', { class: 'pri sm', onclick: act(async () => { toast('Sauvegarde en cours…'); await api('POST', `/services/${s.id}/backups`, {}); App.render(); }, 'Sauvegarde faite') }, 'Sauvegarder maintenant'),
          h('button', { class: 'sm', onclick: act(async () => { toast('Export en cours…'); await download(`/services/${s.id}/backup`, `${s.name}.sql`); }) }, 'Exporter sans garder'))),
      d.backups.length ? h('table', {},
        h('thead', {}, h('tr', {}, ['Fichier', 'Taille', 'Origine', 'Quand', ''].map((t) => h('th', {}, t)))),
        h('tbody', {}, d.backups.map((b) => h('tr', {},
          h('td', { class: 'mono sm trunc', style: 'max-width:260px' }, b.file,
            b.status !== 'success' ? h('div', { class: 's-failed sm' }, b.error?.split('\n')[0] || 'en échec') : null),
          h('td', { class: 'mono sm' }, fmtBytes(b.size)),
          h('td', { class: 'mut sm' }, b.trigger === 'schedule' ? 'planifiée' : 'à la main'),
          h('td', { class: 'mut sm', title: dateTime(b.created_at) }, ago(b.created_at)),
          h('td', { class: 'actions' },
            b.available ? h('button', { class: 'sm', onclick: act(() => download(`/backups/${b.id}/download`, b.file)) }, 'Télécharger') : h('span', { class: 'mut sm' }, 'fichier absent'),
            !can('member') || !b.available || !d.restorable ? null : h('button', {
              class: 'sm dng',
              onclick: confirmThen(`Restaurer « ${b.file} » ? Les données actuelles de « ${s.name} » seront écrasées.`, async () => {
                toast('Restauration en cours…');
                const r = await api('POST', `/backups/${b.id}/restore`, {});
                toast(`Restauré depuis ${r.restored}`);
                App.render();
              }),
            }, 'Restaurer'),
            !can('member') ? null : h('button', { class: 'sm dng', onclick: confirmThen('Supprimer cette sauvegarde ?', async () => { await api('DELETE', `/backups/${b.id}`); App.render(); }) }, 'Supprimer'))))))
        : h('div', { class: 'empty' }, 'Aucune sauvegarde. Le bouton ci-dessus en fabrique une tout de suite.'),
      h('p', { class: 'mut sm' }, 'Les fichiers vivent sur ce serveur : gardez-en une copie ailleurs (voir ', h('span', { class: 'mono' }, 'paas/sauvegarde.sh'), ').')),
  );
}

// ── exécutions d'une tâche planifiée ──────────────────────────────────────
async function runsTab(body, s) {
  const d = await api('GET', `/services/${s.id}/runs`);
  const schedule = h('input', { value: d.schedule || '', placeholder: '0 3 * * *' });
  const presets = h('select', { onchange: (ev) => { if (ev.target.value) { schedule.value = ev.target.value; ev.target.selectedIndex = 0; } } },
    h('option', { value: '' }, 'Choisir une fréquence…'), (App.cfg.cron_presets || []).map((p) => h('option', { value: p.expr }, p.label)));
  const encours = d.runs.some((r) => r.status === 'running');

  body.append(
    h('div', { class: 'card' },
      h('div', { class: 'grid2' }, field('Planification', schedule, 'minute heure jour mois jour-semaine (heure du serveur)'), field('Fréquences courantes', presets)),
      h('p', { class: 'row' },
        h('button', { class: 'pri', onclick: act(async () => { await api('PATCH', `/services/${s.id}`, { cron_schedule: schedule.value.trim() }); App.render(); }, 'Planification enregistrée') }, 'Enregistrer'),
        h('span', { class: 'mut sm' }, `${d.words || '—'}${d.next ? ` · prochaine ${dans(d.next)} (${dateTime(d.next)})` : ''}`))),
    h('div', { class: 'card' },
      h('div', { class: 'row sp' }, h('h3', { style: 'margin:0' }, 'Historique'),
        h('button', { class: 'pri sm', onclick: act(async () => { await api('POST', `/services/${s.id}/run`); App.render(); }, 'Exécution lancée') }, 'Exécuter maintenant')),
      d.runs.length ? h('table', {},
        h('thead', {}, h('tr', {}, ['#', 'Statut', 'Origine', 'Début', 'Durée', ''].map((t) => h('th', {}, t)))),
        h('tbody', {}, d.runs.map((r) => {
          const dur = r.finished_at ? Math.round((new Date(r.finished_at) - new Date(r.started_at)) / 1000) : null;
          return h('tr', {},
            h('td', { class: 'mono' }, r.number),
            h('td', {}, runBadge(r.status), r.exit_code ? h('span', { class: 'mut sm' }, ` code ${r.exit_code}`) : null),
            h('td', { class: 'mut sm' }, r.trigger === 'schedule' ? 'planifiée' : 'à la main'),
            h('td', { class: 'mut sm', title: dateTime(r.started_at) }, ago(r.started_at)),
            h('td', { class: 'mut sm' }, dur == null ? '…' : fmtDur(dur)),
            h('td', { class: 'actions' }, r.output
              ? h('button', { class: 'sm', onclick: () => dialog(`Exécution #${r.number}`, h('pre', { class: 'log' }, r.output), { wide: true }) }, 'Sortie')
              : null));
        })))
        : h('div', { class: 'empty' }, 'Jamais exécutée. « Exécuter maintenant » ne dépend pas de la planification.')),
  );
  if (encours) App.refreshIn(3000);
}

// ── variables ─────────────────────────────────────────────────────────────
async function variablesTab(body, s) {
  const d = await api('GET', `/services/${s.id}/variables?inherited=1`);
  if (s.kind === 'database') {
    const rows = Object.entries(d.own);
    body.append(h('div', { class: 'card' },
      h('h3', {}, 'Identifiants de connexion'),
      h('p', { class: 'mut sm' }, 'Engendrés à la création, chiffrés au repos. Dans un autre service du même environnement, écrivez ', h('span', { class: 'mono' }, `\${{${s.name}.DATABASE_URL}}`), ' : la valeur est injectée au déploiement.'),
      h('table', {}, h('tbody', {}, rows.map(([k, v]) => h('tr', {},
        h('td', { class: 'mono' }, k),
        h('td', { class: 'mono trunc', style: 'max-width:380px' }, /PASSWORD|URL|KEY/.test(k) ? '•'.repeat(18) : v),
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
  Object.entries(d.own).forEach(([k, v]) => addRow(k, v));
  const save = act(async () => {
    const next = {};
    for (const r of rows.children) { const k = r.querySelector('.k').value.trim(); if (k) next[k] = r.querySelector('.v').value; }
    await api('PUT', `/services/${s.id}/variables`, { variables: next, replace: true });
  }, 'Variables enregistrées — redéployez pour les appliquer');
  /** Coller un .env entier : une ligne par variable. */
  const coller = () => {
    const zone = h('textarea', { placeholder: 'CLE=valeur\nAUTRE=chose', style: 'width:100%;min-height:160px' });
    formDialog('Coller un fichier .env', h('div', {}, zone, h('p', { class: 'mut sm' }, 'Une ligne par variable ; les lignes vides et celles qui commencent par # sont ignorées. Les guillemets autour de la valeur sont retirés.')), async () => {
      let n = 0;
      for (const ligne of zone.value.split('\n')) {
        const t = ligne.trim();
        if (!t || t.startsWith('#')) continue;
        const i = t.indexOf('=');
        if (i < 1) continue;
        const cle = t.slice(0, i).trim().replace(/^export\s+/, '');
        const val = t.slice(i + 1).trim().replace(/^(['"])(.*)\1$/, '$2');
        addRow(cle, val);
        n++;
      }
      toast(`${n} variable(s) ajoutée(s) — « Enregistrer » pour les garder`);
    }, 'Ajouter');
  };
  const partagees = Object.entries(d.shared);
  body.append(h('div', { class: 'card' },
    h('p', { class: 'mut sm' }, 'Fournies à votre application comme variables d’environnement. ', h('span', { class: 'mono' }, 'PORT'), ' et ', h('span', { class: 'mono' }, 'RAIL_*'), ' sont posées par Rail. Chiffrées au repos. Pour pointer une base du même environnement : ', h('span', { class: 'mono' }, '${{ma-base.DATABASE_URL}}'), '.'),
    rows,
    h('div', { class: 'row' },
      h('button', { onclick: () => addRow() }, '+ Variable'),
      h('button', { onclick: coller }, 'Coller un .env'),
      h('button', { class: 'pri', onclick: save }, 'Enregistrer'),
      h('button', { onclick: act(async () => { await save(); await api('POST', `/services/${s.id}/redeploy`); go(s.id, 'deployments'); }) }, 'Enregistrer et redéployer'))),
    partagees.length ? h('div', { class: 'card' },
      h('h3', {}, `Héritées de l’environnement « ${s.environment_name} »`),
      h('table', {}, h('tbody', {}, partagees.map(([k, v]) => h('tr', {},
        h('td', { class: 'mono' }, k),
        h('td', { class: 'mono trunc', style: 'max-width:380px' }, v),
        h('td', { class: 'mut sm' }, k in d.own ? 'remplacée ci-dessus' : ''))))),
      h('p', { class: 'mut sm' }, 'Elles se règlent sur la page du projet, et valent pour tous ses services.')) : null);
}

function domainsTab(body, s) {
  const host = h('input', { placeholder: 'api.mondomaine.com', style: 'flex:1' });
  body.append(h('div', { class: 'card' },
    h('table', {}, h('tbody', {}, s.domains.map((d) => h('tr', {},
      h('td', {}, h('a', { href: d.url || `https://${d.hostname}`, target: '_blank', rel: 'noopener' }, d.hostname)),
      h('td', { class: 'mut' }, d.kind === 'auto' ? 'fourni' : 'personnalisé'),
      h('td', { class: 'actions' },
        copyBtn(d.url || d.hostname),
        !can('member') || s.domains.length < 2 ? null : h('button', { class: 'sm dng', onclick: act(async () => { await api('DELETE', `/services/${s.id}/domains/${d.id}`); App.render(); }) }, 'Retirer')))))),
    !can('member') ? null : h('div', { class: 'row', style: 'margin-top:12px' }, host,
      h('button', { class: 'pri', onclick: act(async () => { await api('POST', `/services/${s.id}/domains`, { hostname: host.value }); App.render(); }, 'Domaine ajouté — redéployez pour l’appliquer') }, 'Ajouter')),
    h('p', { class: 'mut sm' }, `Pour un domaine personnalisé : un enregistrement DNS A (ou CNAME vers ${App.cfg.dashboardHost || 'ce serveur'}) vers ce serveur, puis « Redéployer ». Le certificat HTTPS est demandé automatiquement.`)));
}

// ── réglages ──────────────────────────────────────────────────────────────
function settingsTab(body, s) {
  if (s.kind === 'database') { databaseSettings(body, s); return; }
  const depot = s.source_kind === 'repo';
  const f = {
    repo: h('input', { value: s.repo }),
    branch: h('input', { value: s.branch }),
    root_dir: h('input', { value: s.root_dir }),
    dockerfile_path: h('input', { value: s.dockerfile_path || '', placeholder: 'auto' }),
    base_image: h('input', { value: s.base_image || '', placeholder: 'ghcr.io/org/app:1.0' }),
    port: h('input', { type: 'number', value: s.port }),
    healthcheck_path: h('input', { value: s.healthcheck_path || '', placeholder: '/health' }),
    memory_mb: h('input', { type: 'number', value: s.memory_mb || '', placeholder: 'défaut' }),
    cpus: h('input', { type: 'number', step: '0.1', value: s.cpus || '', placeholder: 'défaut' }),
    volume_path: h('input', { value: s.volume_path || '', placeholder: '/data (facultatif)' }),
    volume_owner: h('input', { type: 'number', value: s.volume_owner ?? '', placeholder: 'défaut (root)' }),
    build_command: h('input', { value: s.build_command || '', placeholder: 'npm run build (auto)' }),
    start_command: h('input', { value: s.start_command || '', placeholder: 'commande de l’image' }),
    watch_paths: h('input', { value: (s.watch_paths || '').split('\n').join(', '), placeholder: 'services/api, paquets/commun' }),
    cron_schedule: h('input', { value: s.cron_schedule || '', placeholder: '0 3 * * *' }),
    name: h('input', { value: s.name, pattern: '[a-z0-9]([a-z0-9\\-]{0,28}[a-z0-9])?' }),
    github_token: h('input', { type: 'password', placeholder: s.has_github_token ? '•••••• (enregistré — laisser vide pour conserver)' : 'hérite du compte relié', autocomplete: 'off' }),
  };
  const auto = h('input', { type: 'checkbox', checked: s.auto_deploy, style: 'width:auto' });
  const save = act(async (e) => {
    e.preventDefault();
    const p = {
      name: f.name.value.trim(),
      port: +f.port.value, healthcheck_path: f.healthcheck_path.value || null,
      memory_mb: f.memory_mb.value ? +f.memory_mb.value : null, cpus: f.cpus.value ? +f.cpus.value : null,
      volume_path: f.volume_path.value || null, volume_owner: f.volume_owner.value === '' ? null : +f.volume_owner.value,
      start_command: f.start_command.value || null,
    };
    if (s.kind === 'cron') p.cron_schedule = f.cron_schedule.value.trim();
    if (depot) {
      Object.assign(p, {
        repo: f.repo.value, branch: f.branch.value, root_dir: f.root_dir.value,
        dockerfile_path: f.dockerfile_path.value || null, auto_deploy: auto.checked,
        build_command: f.build_command.value || null, watch_paths: f.watch_paths.value || null,
      });
      if (f.github_token.value) p.github_token = f.github_token.value;
    } else p.base_image = f.base_image.value;
    await api('PATCH', `/services/${s.id}`, p);
    App.render();
  }, 'Réglages enregistrés — redéployez pour appliquer');

  body.append(
    h('form', { class: 'card', onsubmit: save },
      h('h3', {}, 'Source et exécution'),
      depot
        ? h('div', { class: 'grid2' }, field('Nom', f.name), field('Dépôt', f.repo), field('Branche suivie', f.branch), field('Dossier racine', f.root_dir),
          field('Dockerfile (chemin)', f.dockerfile_path), field('Port', f.port), field('Chemin de santé', f.healthcheck_path), field('Mémoire (Mo)', f.memory_mb),
          field('CPU', f.cpus), s.kind === 'cron' ? field('Planification', f.cron_schedule) : null)
        : h('div', { class: 'grid2' }, field('Nom', f.name), field('Image', f.base_image), field('Port', f.port), field('Chemin de santé', f.healthcheck_path),
          field('Mémoire (Mo)', f.memory_mb), field('CPU', f.cpus), s.kind === 'cron' ? field('Planification', f.cron_schedule) : null),
      depot ? h('div', { class: 'grid2' }, field('Commande de construction', f.build_command, 'Ignorée si le dépôt a son Dockerfile'), field('Commande de démarrage', f.start_command, 'Ignorée si le dépôt a son Dockerfile'))
        : field('Commande de démarrage', f.start_command, 'Remplace la commande par défaut de l’image'),
      depot ? field('Chemins surveillés (monodépôt)', f.watch_paths, 'Un push qui ne touche aucun de ces chemins ne déclenche rien. Vide = tout le dépôt.') : null,
      h('div', { class: 'grid2' }, field('Volume persistant (point de montage)', f.volume_path, 'Attention : avec un volume, la nouvelle version ne tourne pas à côté de l’ancienne (courte interruption).'),
        field('Propriétaire du volume (uid)', f.volume_owner, 'Pour les images qui ne tournent pas en root (Grafana 472, Gitea 1000…)')),
      depot ? field('Jeton GitHub du service', f.github_token) : null,
      depot ? h('label', { class: 'row', style: 'color:var(--fg);margin-top:14px' }, auto, 'Déployer automatiquement à chaque push sur la branche') : null,
      h('p', {}, h('button', { class: 'pri', type: 'submit' }, 'Enregistrer'))),
    exposeCard(s),
    depot ? webhookCard(s) : null,
    dangerCard(s));
}

/** Publier le port du service sur la machine : pour une base, c'est ce qui permet de la joindre depuis un poste de travail. */
function exposeCard(s) {
  const plage = App.cfg.tcp_ports || {};
  const port = h('input', { type: 'number', value: s.public_port || '', placeholder: `${plage.from}–${plage.to} (automatique si vide)`, min: plage.from, max: plage.to });
  return h('div', { class: 'card' },
    h('h3', {}, 'Exposition TCP'),
    s.public_endpoint
      ? h('p', {}, 'Joignable depuis l’extérieur sur ', h('span', { class: 'mono' }, s.public_endpoint), ' ', copyBtn(s.public_endpoint))
      : h('p', { class: 'mut sm' }, 'Ce service n’est joignable que depuis le réseau privé du serveur.'),
    h('p', { class: 'mut sm' }, 'Ouvre le port du conteneur sur la machine : de quoi brancher ', h('span', { class: 'mono' }, 'psql'), ', un client graphique ou un service extérieur. Pensez au pare-feu.'),
    !can('member') ? null : h('div', { class: 'row' }, port,
      h('button', { class: 'pri', onclick: act(async () => { await api('POST', `/services/${s.id}/expose`, port.value ? { port: +port.value } : {}); App.render(); }, 'Exposé — redéployez pour ouvrir le port') }, s.public_port ? 'Changer de port' : 'Exposer'),
      s.public_port ? h('button', { class: 'dng', onclick: act(async () => { await api('DELETE', `/services/${s.id}/expose`); App.render(); }, 'Fermé — redéployez pour appliquer') }, 'Ne plus exposer') : null));
}

function webhookCard(s) {
  return h('div', { class: 'card' },
    h('h3', {}, 'Déploiement à chaque push (webhook GitHub)'),
    h('p', { class: 'mut sm' }, 'Automatique si le jeton relié a le droit « Webhooks: write » :'),
    h('p', {}, h('button', { onclick: act(async () => { await api('POST', `/services/${s.id}/webhook/install`); }, 'Webhook installé sur GitHub') }, 'Installer le webhook')),
    h('p', { class: 'mut sm' }, 'Ou à la main (Settings → Webhooks → Add webhook), type « application/json », événement « push » :'),
    h('div', { class: 'row' }, h('span', { class: 'mono trunc' }, s.webhook.url), copyBtn(s.webhook.url)),
    h('div', { class: 'row' }, h('span', { class: 'mono' }, 'Secret : ••••••••'), copyBtn(s.webhook.secret, 'Copier le secret')));
}

function databaseSettings(body, s) {
  const image = h('input', { value: s.base_image, style: 'width:100%' });
  const memory_mb = h('input', { type: 'number', value: s.memory_mb || '' });
  const cpus = h('input', { type: 'number', step: '0.1', value: s.cpus || '' });
  const name = h('input', { value: s.name, pattern: '[a-z0-9]([a-z0-9\\-]{0,28}[a-z0-9])?' });
  body.append(
    h('form', {
      class: 'card',
      onsubmit: act(async (e) => {
        e.preventDefault();
        await api('PATCH', `/services/${s.id}`, { name: name.value.trim(), base_image: image.value, memory_mb: memory_mb.value ? +memory_mb.value : null, cpus: cpus.value ? +cpus.value : null });
        App.render();
      }, 'Enregistré — « Redéployer » pour appliquer'),
    },
    h('h3', {}, 'Réglages de la base'),
    field('Nom', name, 'Renommer change aussi son hôte privé : mettez à jour les services qui la nomment.'),
    field('Image', image, 'Changer de version majeure peut demander une migration des données : vérifiez la documentation du moteur.'),
    h('div', { class: 'grid2' }, field('Mémoire (Mo)', memory_mb), field('CPU', cpus)),
    h('p', {}, h('button', { class: 'pri', type: 'submit' }, 'Enregistrer'))),
    exposeCard(s),
    dangerCard(s));
}

function dangerCard(s) {
  if (!can('member')) return null;
  const keep = h('input', { type: 'checkbox', style: 'width:auto' });
  return h('div', { class: 'card' },
    h('h3', { style: 'color:var(--ko)' }, 'Zone dangereuse'),
    s.volume ? h('p', { class: 'mut sm' }, 'Supprimer ce service supprime aussi son volume ', h('span', { class: 'mono' }, s.volume.name), ' : les données seront perdues.') : null,
    s.volume ? h('label', { class: 'row', style: 'color:var(--fg)' }, keep, 'Garder le volume (les données restent sur le serveur)') : null,
    h('button', {
      class: 'dng',
      onclick: confirmThen(`Supprimer « ${s.name} » (conteneurs, images${s.volume ? ', et le volume avec ses données' : ''}) ?`,
        async () => { await api('DELETE', `/services/${s.id}${keep.checked ? '?keep_volume=1' : ''}`); location.hash = '#/'; }),
    }, 'Supprimer ce service'));
}
