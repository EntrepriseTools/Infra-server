// Secrets au repos : AES-256-GCM, un IV neuf à chaque chiffrement.
// Format : v1:<iv>.<tag>.<texte chiffré>, le tout en base64url.
import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual, createHash } from 'node:crypto';

export function encrypt(key, plain) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return `v1:${[iv, c.getAuthTag(), ct].map((b) => b.toString('base64url')).join('.')}`;
}

export function decrypt(key, blob) {
  const m = /^v1:([^.]+)\.([^.]*)\.([^.]*)$/.exec(blob || '');
  if (!m) throw new Error('secret illisible (format)');
  const [iv, tag, ct] = m.slice(1).map((s) => Buffer.from(s, 'base64url'));
  const d = createDecipheriv('aes-256-gcm', key, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
}

export const randomToken = (bytes = 24) => randomBytes(bytes).toString('base64url');
export const shortId = () => randomBytes(6).toString('hex');

// Comparaison en temps constant, indifférente à la longueur (on compare des empreintes).
export function safeEqual(a, b) {
  const ha = createHash('sha256').update(String(a)).digest();
  const hb = createHash('sha256').update(String(b)).digest();
  return timingSafeEqual(ha, hb);
}
