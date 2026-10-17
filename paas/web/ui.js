// La boîte à outils du tableau de bord : construction du DOM, appels à l'API,
// formats, et les graphiques (SVG, sans bibliothèque).

// ── l'état partagé ────────────────────────────────────────────────────────
// Rempli par app.js au démarrage ; les vues s'en servent sans se connaître.
export const App = {
  cfg: {},            // /api/config
  me: null,           // /api/me
  render: () => {},   // repeindre la vue courante
  onLeave: () => {},  // enregistrer un arrêt (flux, minuterie) pour le changement de vue
  refreshIn: () => {},
  range: '1h',
};
export const can = (role) => {
  const rang = { viewer: 1, member: 2, admin: 3 };
  return (rang[App.me?.user?.role] || 0) >= rang[role];
};

// ── DOM ───────────────────────────────────────────────────────────────────
// h() pose toujours le texte avec textContent : aucune donnée venue du serveur
// n'est jamais interprétée comme du HTML.
export function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, '');
    else if (v !== false && v != null) el.setAttribute(k, v);
  }
  for (const k of kids.flat(9)) if (k != null && k !== false) el.append(k.nodeType ? k : document.createTextNode(String(k)));
  return el;
}
export const svgEl = (tag, attrs) => {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs || {})) if (v != null) el.setAttribute(k, v);
  return el;
};
export function toast(msg, err) {
  const t = h('div', { class: `toast${err ? ' err' : ''}`, role: 'status' }, msg);
  document.getElementById('toasts').append(t);
  setTimeout(() => t.remove(), err ? 6000 : 2600);
}
export const field = (label, input, hint) => h('div', {}, h('label', {}, label), input, hint ? h('div', { class: 'mut sm' }, hint) : null);

/** Enveloppe un gestionnaire : désactive le bouton, montre l'erreur, confirme. */
export const act = (fn, okMsg) => async (ev) => {
  const b = ev?.currentTarget;
  if (b) b.disabled = true;
  try { const r = await fn(ev); if (okMsg) toast(okMsg); return r; }
  catch (e) { toast(e.message, true); }
  finally { if (b) b.disabled = false; }
};
export const confirmThen = (question, fn) => act(async (ev) => { if (confirm(question)) await fn(ev); });
export const copy = (t) => navigator.clipboard?.writeText(t).then(() => toast('Copié'), () => toast('Copie impossible', true));
export const copyBtn = (text, label = 'Copier') => h('button', { class: 'sm', onclick: () => copy(text) }, label);

export function dialog(title, content, { wide = false } = {}) {
  const dlg = h('dialog', wide ? { style: 'width:min(820px,96vw)' } : {});
  dlg.append(h('div', { class: 'row sp' }, h('h1', {}, title), h('button', { onclick: () => dlg.close() }, 'Fermer')), content);
  dlg.addEventListener('close', () => dlg.remove());
  document.body.append(dlg);
  dlg.showModal();
  return dlg;
}
/** Un formulaire dans une fenêtre : validation du navigateur, erreurs affichées, fermeture au succès. */
export function formDialog(title, content, onSubmit, submitLabel = 'Créer', { wide = false } = {}) {
  const form = h('form', { method: 'dialog', onsubmit: act(async (e) => { e.preventDefault(); await onSubmit(); dlg.close(); }) },
    content, h('p', { class: 'row' }, h('button', { class: 'pri', type: 'submit' }, submitLabel), h('button', { type: 'button', onclick: () => dlg.close() }, 'Annuler')));
  const dlg = dialog(title, form, { wide });
  form.querySelector('input,select,textarea')?.focus();
  return dlg;
}

// ── API ───────────────────────────────────────────────────────────────────
// La session est un cookie httpOnly : le navigateur l'envoie seul. Les écritures
// portent en plus l'anti-CSRF de la session — un autre site ne peut rien déclencher.
let csrf = '';
let onUnauthorized = () => {};
export const setCsrf = (c) => { csrf = c || ''; };
export const setUnauthorizedHandler = (fn) => { onUnauthorized = fn; };

const entetes = (method, body) => ({
  ...(body ? { 'content-type': 'application/json' } : {}),
  ...(method !== 'GET' && csrf ? { 'x-rail-csrf': csrf } : {}),
});

export async function api(method, path, body) {
  const res = await fetch(`/api${path}`, { method, headers: entetes(method, body), body: body ? JSON.stringify(body) : undefined });
  if (res.status === 401) { onUnauthorized(); throw new Error('Session expirée : reconnectez-vous'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Erreur ${res.status}`);
  return data;
}
/** Télécharge un flux (une sauvegarde) en gardant le nom donné par le serveur. */
export async function download(path, filename) {
  const res = await fetch(`/api${path}`);
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `Erreur ${res.status}`);
  const nom = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') || '')?.[1] || filename;
  const url = URL.createObjectURL(await res.blob());
  const a = h('a', { href: url, download: nom });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
/** Enregistre un texte sous un nom de fichier, sans passer par le serveur. */
export function saveText(text, filename, type = 'text/plain') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = h('a', { href: url, download: filename });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
/** Suit un journal en continu (fetch en flux : EventSource ne sait pas porter l'autorisation). */
export function followLog(path, pre, { onLine } = {}) {
  const ac = new AbortController();
  (async () => {
    try {
      const res = await fetch(`/api${path}`, { signal: ac.signal });
      if (!res.ok) { pre.textContent = (await res.json().catch(() => ({}))).error || 'Journal indisponible'; return; }
      const rd = res.body.getReader(); const dec = new TextDecoder();
      pre.textContent = '';
      for (;;) {
        const { done, value } = await rd.read();
        if (done) break;
        const atEnd = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 40;
        const text = dec.decode(value, { stream: true });
        pre.append(text);
        onLine?.(text);
        if (atEnd) pre.scrollTop = pre.scrollHeight;
      }
    } catch { /* fermé */ }
  })();
  return () => ac.abort();
}

// ── formats ───────────────────────────────────────────────────────────────
export const fmtBytes = (n) => {
  if (n == null) return '—';
  const u = ['o', 'ko', 'Mo', 'Go', 'To'];
  let i = 0; let x = n;
  while (x >= 1024 && i < u.length - 1) { x /= 1024; i++; }
  return `${x < 10 && i ? x.toFixed(1) : Math.round(x)} ${u[i]}`;
};
export const fmtRate = (n) => (n == null ? '—' : `${fmtBytes(n)}/s`);
export const fmtPct = (n) => (n == null ? '—' : `${n < 10 ? n.toFixed(1) : Math.round(n)} %`);
export const fmtNum = (n) => (n == null ? '—' : String(Math.round(n)));
export function fmtDur(s) {
  if (s == null) return '—';
  const d = Math.floor(s / 86400); const hh = Math.floor((s % 86400) / 3600); const mm = Math.floor((s % 3600) / 60);
  if (d) return `${d} j ${hh} h`;
  if (hh) return `${hh} h ${mm} min`;
  if (mm) return `${mm} min`;
  return `${Math.floor(s)} s`;
}
export function ago(iso) {
  if (!iso) return '';
  const s = (Date.now() - new Date(iso)) / 1000;
  if (s < 60) return 'à l’instant';
  if (s < 3600) return `il y a ${Math.floor(s / 60)} min`;
  if (s < 86400) return `il y a ${Math.floor(s / 3600)} h`;
  return `il y a ${Math.floor(s / 86400)} j`;
}
/** « dans 3 h » : l'inverse de ago(), pour une prochaine exécution. */
export function dans(iso) {
  if (!iso) return '';
  const s = (new Date(iso) - Date.now()) / 1000;
  if (s <= 0) return 'imminente';
  if (s < 60) return 'dans moins d’une minute';
  if (s < 3600) return `dans ${Math.floor(s / 60)} min`;
  if (s < 86400) return `dans ${Math.floor(s / 3600)} h`;
  return `dans ${Math.floor(s / 86400)} j`;
}
export const clock = (epochS) => new Date(epochS * 1000).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
export const dateTime = (iso) => (iso ? new Date(iso).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—');

// ── états ─────────────────────────────────────────────────────────────────
const DEPLOY_WORDS = { queued: 'en file', building: 'construction', deploying: 'démarrage', success: 'déployé', failed: 'échec', canceled: 'annulé', skipped: 'remplacé', removed: 'remplacé' };
const STATE = {
  running: ['en ligne', 's-running'], degraded: ['dégradé', 's-degraded'], restarting: ['redémarre', 's-restarting'],
  exited: ['arrêté (plantage)', 's-exited'], stopped: ['arrêté', 's-stopped'], missing: ['conteneur absent', 's-missing'],
  never: ['jamais déployé', 's-never'], created: ['pas démarré', 's-never'], paused: ['en pause', 's-stopped'],
  scheduled: ['planifié', 's-running'], 'job-running': ['en cours d’exécution', 's-building'], unknown: ['—', 's-unknown'],
};
export const stateWord = (state) => (STATE[state] || [state])[0];
/** Pastille + mot : l'état n'est jamais porté par la couleur seule. */
export function stateBadge(state) {
  const [word, cls] = STATE[state] || [state, 's-unknown'];
  return h('span', { class: `badge ${cls}` }, h('i', { class: 'dot' }), word);
}
export const deployBadge = (s) => h('span', { class: `badge s-${s || 'none'}` }, DEPLOY_WORDS[s] || 'jamais déployé');
const RUN_WORDS = { running: ['en cours', 's-building'], success: ['réussie', 's-success'], failed: ['en échec', 's-failed'] };
export const runBadge = (s) => {
  const [mot, cls] = RUN_WORDS[s] || [s, 's-unknown'];
  return h('span', { class: `badge ${cls}` }, mot);
};
const NIVEAU = { error: ['s-bad', 'erreur'], warn: ['s-wait', 'avertissement'], info: ['s-none', 'information'] };
/** Une pastille seule, avec son mot en infobulle et pour les lecteurs d'écran. */
export const levelDot = (level) => {
  const [cls, mot] = NIVEAU[level] || NIVEAU.info;
  return h('span', { class: cls, title: mot, role: 'img', 'aria-label': mot }, h('i', { class: 'dot' }));
};
/** L'emblème d'un service, selon ce qu'il est. */
export const kindIcon = (s) => (s.kind === 'database' ? '🗄' : s.kind === 'cron' ? '⏱' : s.source_kind === 'image' ? '📦' : '▲');

// ── graphiques ────────────────────────────────────────────────────────────
// Une série = une aire bleue ; deux séries = bleu puis orange, dans cet ordre,
// jamais recyclé. Les textes vivent dans le HTML autour du SVG : le SVG est
// étiré horizontalement (preserveAspectRatio="none") et déformerait les lettres.
const VW = 600; const VH = 120;

export function chart({ points, series, format = fmtNum, title, limit = null, limitLabel = null }) {
  const wrap = h('div', { class: 'chart' });
  if (!points || points.length < 2) {
    return h('div', {}, title ? h('h3', {}, title) : null, h('div', { class: 'empty sm' }, 'Pas encore de mesures — elles arrivent dans une minute.'));
  }
  const vals = series.map((s) => points.map((p) => (typeof p[s.key] === 'number' ? p[s.key] : null)));
  const top = Math.max(1, ...vals.flat().filter((x) => x != null), limit && limit > 0 ? limit * 0.25 : 0);
  const max = top * 1.15;
  const x = (i) => (i / (points.length - 1)) * VW;
  const y = (v) => VH - (Math.max(0, v) / max) * (VH - 2) - 1;

  const haut = Math.max(...vals.flat().filter((v) => v != null));
  const svg = svgEl('svg', { viewBox: `0 0 ${VW} ${VH}`, preserveAspectRatio: 'none', role: 'img' });
  for (const f of [0, 0.5, 1]) {
    svg.append(svgEl('line', { x1: 0, x2: VW, y1: y(max * f), y2: y(max * f), stroke: 'var(--grid)', 'stroke-width': 1, 'vector-effect': 'non-scaling-stroke' }));
  }
  // La limite n'est tracée que si elle entre dans l'échelle ; l'étiquette, elle, le dit toujours.
  if (limit && limit <= max) {
    svg.append(svgEl('line', { x1: 0, x2: VW, y1: y(limit), y2: y(limit), stroke: 'var(--mut)', 'stroke-width': 1, 'stroke-dasharray': '4 4', 'vector-effect': 'non-scaling-stroke' }));
  }
  series.forEach((s, si) => {
    const pts = vals[si].map((v, i) => [x(i), y(v ?? 0)]);
    const line = pts.map(([px, py], i) => `${i ? 'L' : 'M'}${px.toFixed(1)} ${py.toFixed(1)}`).join(' ');
    svg.append(svgEl('path', { d: `${line} L${VW} ${VH} L0 ${VH} Z`, fill: s.color, opacity: series.length > 1 ? 0.1 : 0.14, stroke: 'none' }));
    svg.append(svgEl('path', { d: line, fill: 'none', stroke: s.color, 'stroke-width': 2, 'stroke-linejoin': 'round', 'vector-effect': 'non-scaling-stroke' }));
  });
  const marks = series.map((s) => svgEl('circle', { r: 3.2, fill: s.color, stroke: 'var(--card)', 'stroke-width': 2, opacity: 0, 'vector-effect': 'non-scaling-stroke' }));
  marks.forEach((m) => svg.append(m));

  const last = (si) => vals[si].at(-1);
  const summary = series.map((s, si) => `${s.label} : ${format(last(si))}`).join(', ');
  svg.setAttribute('aria-label', `${title || 'série'} — ${summary} (maximum ${format(Math.max(...vals.flat().filter((v) => v != null)))})`);

  const cursor = h('div', { class: 'cursor' });
  const tip = h('div', { class: 'tip' });
  wrap.append(svg, cursor, tip);
  const move = (ev) => {
    const r = wrap.getBoundingClientRect();
    const i = Math.max(0, Math.min(points.length - 1, Math.round(((ev.clientX - r.left) / r.width) * (points.length - 1))));
    const px = (i / (points.length - 1)) * r.width;
    cursor.style.display = 'block'; cursor.style.left = `${px}px`;
    marks.forEach((m, si) => { m.setAttribute('opacity', 1); m.setAttribute('cx', x(i)); m.setAttribute('cy', y(vals[si][i] ?? 0)); });
    tip.replaceChildren(h('div', { class: 'mut sm' }, clock(points[i].at)),
      ...series.map((s, si) => h('div', {}, h('i', { style: `display:inline-block;width:9px;height:9px;border-radius:2px;margin-right:6px;background:${s.color}` }), `${s.label} : ${format(vals[si][i])}`)));
    tip.style.display = 'block';
    tip.style.left = `${Math.min(Math.max(px - tip.offsetWidth / 2, 0), r.width - tip.offsetWidth)}px`;
    // Au-dessus du point, ou en dessous s'il n'y a pas la place : l'infobulle ne cache jamais la courbe.
    const py = (y(vals[0][i] ?? 0) / VH) * r.height;
    const dessous = py < r.height / 2;
    tip.style.top = `${Math.max(0, Math.min(r.height - tip.offsetHeight, dessous ? py + 14 : py - tip.offsetHeight - 14))}px`;
  };
  wrap.addEventListener('pointermove', move);
  wrap.addEventListener('pointerleave', () => { cursor.style.display = 'none'; tip.style.display = 'none'; marks.forEach((m) => m.setAttribute('opacity', 0)); });

  const header = h('div', { class: 'row sp' },
    h('h3', { style: 'margin:0' }, title || ''),
    h('div', { class: 'legend' }, series.length > 1
      ? series.map((s) => h('span', {}, h('i', { style: `background:${s.color}` }), `${s.label} ${format(last(series.indexOf(s)))}`))
      : h('strong', {}, format(last(0)))));
  const axis = h('div', { class: 'axis' },
    h('span', {}, clock(points[0].at)),
    h('span', {}, `max ${format(haut)}${limit ? ` · ${limitLabel || 'limite'} ${format(limit)}` : ''}`),
    h('span', {}, clock(points.at(-1).at)));
  return h('div', {}, header, wrap, axis);
}

export const VIZ = { s1: 'var(--viz-1)', s2: 'var(--viz-2)' };

export const RANGES = ['15m', '1h', '6h', '24h', '7d'];
export function rangePicker() {
  return h('div', { class: 'row' }, RANGES.map((r) => h('button', {
    class: `sm${App.range === r ? ' pri' : ''}`,
    onclick: () => { App.range = r; try { localStorage.setItem('rail_range', r); } catch { /* navigation privée */ } App.render(); },
  }, r)));
}
