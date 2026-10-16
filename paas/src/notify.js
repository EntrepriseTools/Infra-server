// Les alertes : un seul webhook sortant, au format que Slack, Discord et
// n'importe quel récepteur maison comprennent (« text » pour Slack, « content »
// pour Discord, les champs structurés pour le reste).
// Une alerte est un confort : elle ne doit jamais faire échouer un déploiement.
const TIMEOUT_MS = 5000;

export class Notifier {
  constructor({ url, fetchImpl = fetch, onError = () => {} }) {
    this.url = url || null;
    this.fetch = fetchImpl;
    this.onError = onError;
    this.sent = [];
  }
  get enabled() { return !!this.url; }

  /** @param m {{level:'info'|'warn'|'error', title:string, text?:string, url?:string, service?:string}} */
  async send(m) {
    this.sent.push(m);
    if (!this.url) return false;
    const icon = { info: '✅', warn: '⚠️', error: '🚨' }[m.level] || 'ℹ️';
    const line = `${icon} Rail — ${m.title}${m.text ? `\n${m.text}` : ''}${m.url ? `\n${m.url}` : ''}`;
    try {
      const res = await this.fetch(this.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'user-agent': 'rail-paas' },
        body: JSON.stringify({ text: line, content: line, level: m.level, title: m.title, detail: m.text || '', service: m.service || null, url: m.url || null }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) this.onError(new Error(`alerte → HTTP ${res.status}`));
      return res.ok;
    } catch (e) { this.onError(e); return false; }
  }
}
