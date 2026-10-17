// Le serveur : l'API JSON (`/api/*`), le webhook GitHub (`/webhooks/github/:id`)
// et le tableau de bord (`/`).
//
// Ici on ne fait que trois choses : trouver la route, décider qui a le droit de
// l'appeler, et servir les fichiers du tableau de bord. Le reste est dans les
// quatre groupes de routes (plateforme, comptes, applications, données).
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRouter, readBody, send, STREAMED } from './http.js';
import { HttpError } from './validate.js';
import { Auth } from './auth.js';
import { COOKIE, parseCookies } from './users.js';
import { makeHelpers } from './api_shared.js';
import { mountPlatform } from './api_platform.js';
import { mountAccount } from './api_account.js';
import { mountApps } from './api_apps.js';
import { mountData } from './api_data.js';

const WEB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web');
const TYPES = { html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8' };
// Les fichiers du tableau de bord : une liste fermée, servie telle quelle.
const STATIC = ['index.html', 'app.js', 'ui.js', 'views.js', 'style.css'];

export function createApp({
  config, store, deployer, runtime, logs, github,
  monitor = null, notifier = null, backups = null, scheduler = null, auth = null,
}) {
  const routes = createRouter();
  const A = auth || new Auth({ store, config });
  const H = makeHelpers({ config, store, monitor });

  // Un GET se lit avec le rôle « lecteur », tout le reste demande « membre »,
  // sauf quand la route dit autre chose (les comptes et la machine : administrateur).
  const r = {
    add(method, pattern, handler, opts = {}) {
      const role = opts.public ? null : (opts.role || (method === 'GET' ? 'viewer' : 'member'));
      routes.add(method, pattern, handler, { ...opts, role });
    },
  };

  const ctx = { r, config, store, deployer, runtime, logs, github, monitor, notifier, backups, scheduler, auth: A, H };
  mountPlatform(ctx);
  mountAccount(ctx);
  mountApps(ctx);
  mountData(ctx);

  // ── tableau de bord (fichiers statiques) ──
  for (const file of STATIC) {
    const route = file === 'index.html' ? '/' : `/${file}`;
    r.add('GET', route, () => ({ file: path.join(WEB, file), type: TYPES[file.split('.').pop()] }), { public: true });
  }

  // ── le serveur ──
  const csp = "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x');
      const m = routes.match(req.method, url.pathname);
      if (!m) {
        if (routes.pathExists(url.pathname)) throw new HttpError(405, 'méthode non permise');
        throw new HttpError(404, 'introuvable');
      }
      let who = null;
      if (!m.route.public) {
        const ip = req.socket.remoteAddress;
        if (A.throttled(ip)) throw new HttpError(429, 'trop d\'essais, patientez');
        who = A.identify(req);
        if (!who) {
          // Un jeton ou un cookie présenté et refusé compte comme un essai ;
          // une page ouverte sans être connecté, non (sinon se connecter deviendrait
          // impossible après quelques rafraîchissements).
          const presente = !!req.headers.authorization || !!parseCookies(req.headers.cookie)[COOKIE];
          if (presente) A.fail(ip);
          throw new HttpError(401, presente ? 'identifiants refusés' : 'connexion nécessaire');
        }
        A.pass(ip);
        A.authorize(req, who, m.route.role);
        if (who.via === 'session') store.touchSession(who.session.id);
      }
      let body = {}; let raw = Buffer.alloc(0);
      if (['POST', 'PUT', 'PATCH'].includes(req.method)) {
        raw = await readBody(req, m.route.rawBody ? 10 * 1024 * 1024 : 1024 * 1024);
        if (!m.route.rawBody && raw.length) {
          try { body = JSON.parse(raw.toString('utf8')); } catch { throw new HttpError(400, 'JSON invalide'); }
          if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'un objet JSON est attendu');
        }
      }
      // Tout événement écrit depuis une route porte le nom de qui l'a demandé.
      const ev = (e) => store.addEvent({ actor: who?.user?.login ?? null, ...e });
      const out = await m.route.handler({
        req, res, params: m.params, query: url.searchParams, headers: req.headers, body, raw,
        who, user: who?.user ?? null, ev,
      });
      if (out === STREAMED) return;
      if (out.file) {
        send(res, 200, fs.readFileSync(out.file), { 'content-type': out.type, 'content-security-policy': csp, 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer' });
      } else send(res, out.status, out.body);
    } catch (e) {
      const status = e instanceof HttpError ? e.status : /UNIQUE constraint/.test(e?.message) ? 409 : 500;
      if (status === 500) console.error('[api]', e);
      if (!res.headersSent) send(res, status, { error: status === 500 ? 'erreur interne' : status === 409 && !(e instanceof HttpError) ? 'ce nom existe déjà' : e.message });
      else res.end();
    }
  });
  return server;
}
