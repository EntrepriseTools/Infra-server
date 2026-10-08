// Un routeur HTTP minimal : pas de dépendance, pas de magie.
import { HttpError } from './validate.js';

export const STREAMED = Symbol('streamed');

export function createRouter() {
  const routes = [];
  return {
    add(method, pattern, handler, opts = {}) {
      const keys = [];
      const re = new RegExp(`^${pattern.replace(/:([a-z]+)/g, (_, k) => { keys.push(k); return '([^/]+)'; })}/?$`);
      routes.push({ method, re, keys, handler, ...opts });
    },
    match(method, path) {
      for (const r of routes) {
        if (r.method !== method) continue;
        const m = r.re.exec(path);
        if (m) return { route: r, params: Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])])) };
      }
      return null;
    },
    pathExists(path) { return routes.some((r) => r.re.test(path)); },
  };
}

export function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new HttpError(413, 'corps trop gros')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export function send(res, status, body, headers = {}) {
  const isObj = body !== undefined && typeof body === 'object' && !Buffer.isBuffer(body);
  const data = isObj ? JSON.stringify(body) : (body ?? '');
  res.writeHead(status, { 'content-type': isObj ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers });
  res.end(data);
}
