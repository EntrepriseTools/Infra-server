// Tout ce qui touche à l'API et aux webhooks de GitHub.
import { createHmac, timingSafeEqual } from 'node:crypto';

/** Vérifie l'en-tête X-Hub-Signature-256 sur le corps BRUT. */
export function verifySignature(rawBody, header, secret) {
  if (!header || !header.startsWith('sha256=')) return false;
  const want = Buffer.from(createHmac('sha256', secret).update(rawBody).digest('hex'));
  const got = Buffer.from(header.slice(7));
  return want.length === got.length && timingSafeEqual(want, got);
}

/** Un événement « push » → { repo, branch, sha, message } ou null s'il ne concerne pas une branche. */
export function parsePush(payload) {
  const ref = payload?.ref;
  const m = /^refs\/heads\/(.+)$/.exec(ref || '');
  if (!m || payload.deleted || !payload.after || /^0+$/.test(payload.after)) return null;
  return {
    repo: payload.repository?.full_name,
    branch: m[1],
    sha: payload.after,
    message: (payload.head_commit?.message || '').split('\n')[0],
  };
}

export class GithubApi {
  constructor({ apiBase, fetchImpl = fetch }) { this.base = apiBase; this.fetch = fetchImpl; }
  async #call(token, method, path, body) {
    const res = await this.fetch(`${this.base}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'content-type': 'application/json', 'user-agent': 'rail-paas' },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error(`GitHub ${method} ${path} → ${res.status}`);
    return res.status === 204 ? null : res.json();
  }
  /** Crée (ou met à jour) le webhook « push » du dépôt. */
  async installWebhook({ token, repo, url, secret }) {
    const hooks = await this.#call(token, 'GET', `/repos/${repo}/hooks?per_page=100`);
    const config = { url, content_type: 'json', secret, insecure_ssl: '0' };
    const existing = hooks.find((h) => h.config?.url === url);
    if (existing) { await this.#call(token, 'PATCH', `/repos/${repo}/hooks/${existing.id}`, { config, events: ['push'], active: true }); return existing.id; }
    return (await this.#call(token, 'POST', `/repos/${repo}/hooks`, { name: 'web', config, events: ['push'], active: true })).id;
  }
  /** Statut de commit « rail/deploy » (pending|success|failure|error) — best effort. */
  async commitStatus({ token, repo, sha, state, description, targetUrl }) {
    try {
      await this.#call(token, 'POST', `/repos/${repo}/statuses/${sha}`, { state, context: 'rail/deploy', description: description.slice(0, 140), target_url: targetUrl });
    } catch { /* le statut est un confort, jamais une cause d'échec */ }
  }
}
