// Tout ce qui touche à l'API et aux webhooks de GitHub.
import { createHmac, timingSafeEqual } from 'node:crypto';

/** Vérifie l'en-tête X-Hub-Signature-256 sur le corps BRUT. */
export function verifySignature(rawBody, header, secret) {
  if (!header || !header.startsWith('sha256=')) return false;
  const want = Buffer.from(createHmac('sha256', secret).update(rawBody).digest('hex'));
  const got = Buffer.from(header.slice(7));
  return want.length === got.length && timingSafeEqual(want, got);
}

/**
 * Un événement « push » → { repo, branch, sha, message, files } ou null s'il ne
 * concerne pas une branche. `files` sert aux chemins surveillés d'un monodépôt :
 * tous les fichiers touchés par les commits du push, sans doublon.
 */
export function parsePush(payload) {
  const ref = payload?.ref;
  const m = /^refs\/heads\/(.+)$/.exec(ref || '');
  if (!m || payload.deleted || !payload.after || /^0+$/.test(payload.after)) return null;
  const files = new Set();
  for (const c of Array.isArray(payload.commits) ? payload.commits : []) {
    for (const liste of [c.added, c.modified, c.removed]) {
      for (const f of Array.isArray(liste) ? liste : []) if (typeof f === 'string') files.add(f);
    }
  }
  return {
    repo: payload.repository?.full_name,
    branch: m[1],
    sha: payload.after,
    message: (payload.head_commit?.message || '').split('\n')[0],
    files: [...files],
  };
}

/** Les messages de GitHub qu'il vaut mieux traduire que recopier. */
const POURQUOI = {
  401: 'jeton GitHub refusé (expiré, révoqué, ou mal copié)',
  403: 'jeton GitHub sans le droit nécessaire (ou quota d\'appels dépassé)',
  404: 'introuvable : dépôt inexistant, ou jeton sans accès à ce dépôt',
  422: 'GitHub a refusé la demande (webhook déjà présent, ou valeur invalide)',
};

export class GithubApi {
  constructor({ apiBase, fetchImpl = fetch }) { this.base = apiBase; this.fetch = fetchImpl; }
  async #call(token, method, path, body) {
    const res = await this.fetch(`${this.base}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'content-type': 'application/json', 'user-agent': 'rail-paas' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) throw new Error(POURQUOI[res.status] || `GitHub ${method} ${path} → ${res.status}`);
    return res.status === 204 ? null : res.json();
  }

  /** À qui appartient ce jeton ? Sert à vérifier un jeton qu'on vient de coller. */
  async me(token) {
    const u = await this.#call(token, 'GET', '/user');
    return { login: u.login, name: u.name || u.login, avatar_url: u.avatar_url || null, html_url: u.html_url || null };
  }

  /**
   * Les dépôts auxquels ce jeton donne accès, les plus récemment poussés d'abord.
   * C'est ce qui remplit la liste « choisissez un dépôt » du tableau de bord.
   */
  async repos(token, { page = 1, perPage = 100 } = {}) {
    const list = await this.#call(token, 'GET', `/user/repos?per_page=${Math.min(perPage, 100)}&page=${page}&sort=pushed&affiliation=owner,collaborator,organization_member`);
    return (list || []).map((r) => ({
      full_name: r.full_name, private: !!r.private, default_branch: r.default_branch || 'main',
      description: r.description || null, language: r.language || null, pushed_at: r.pushed_at || null,
      html_url: r.html_url || null, archived: !!r.archived,
    }));
  }

  /** Les branches d'un dépôt (pour le choix de la branche à suivre). */
  async branches(token, repo) {
    const list = await this.#call(token, 'GET', `/repos/${repo}/branches?per_page=100`);
    return (list || []).map((b) => b.name);
  }

  /** Un dépôt précis : existe-t-il, et quelle est sa branche par défaut ? */
  async repo(token, repo) {
    const r = await this.#call(token, 'GET', `/repos/${repo}`);
    return { full_name: r.full_name, private: !!r.private, default_branch: r.default_branch || 'main', description: r.description || null, html_url: r.html_url || null };
  }

  /** Le dernier commit d'une branche : { sha, message } (pour afficher ce qui va partir). */
  async head(token, repo, branch) {
    const c = await this.#call(token, 'GET', `/repos/${repo}/commits/${encodeURIComponent(branch)}`);
    return { sha: c.sha, message: (c.commit?.message || '').split('\n')[0], author: c.commit?.author?.name || null, at: c.commit?.author?.date || null };
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
