// Récupérer le code : init + fetch d'un seul commit (ou de la branche) + checkout.
// Le jeton passe par l'environnement de git (GIT_CONFIG_*), pas par l'URL ni les arguments.
import fs from 'node:fs';
import path from 'node:path';
import { run } from './proc.js';

export const redact = (text, secrets) => secrets.filter(Boolean).reduce((t, s) => t.split(s).join('***'), text);

export async function fetchSource({ gitBase, repo, branch, sha, token, dir, onLog, signal }) {
  fs.mkdirSync(dir, { recursive: true });
  const secrets = token ? [token, Buffer.from(`x-access-token:${token}`).toString('base64')] : [];
  const env = { PATH: process.env.PATH, HOME: dir, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
  if (token) {
    env.GIT_CONFIG_COUNT = '1';
    env.GIT_CONFIG_KEY_0 = 'http.extraheader';
    env.GIT_CONFIG_VALUE_0 = `Authorization: Basic ${secrets[1]}`;
  }
  const log = (t) => onLog?.(redact(t, secrets));
  const git = (args, { quiet } = {}) => run('git', args, { cwd: dir, env, onData: quiet ? undefined : log, signal, timeoutMs: 300000 });
  const url = `${gitBase}/${repo}.git`;
  await git(['init', '-q']);
  await git(['remote', 'add', 'origin', url]);
  const ref = sha || `refs/heads/${branch}`;
  log(`→ git fetch ${repo} ${sha ? sha.slice(0, 10) : branch}\n`);
  try { await git(['fetch', '-q', '--depth', '1', 'origin', ref]); }
  catch (e) { throw new Error(redact(`Impossible de récupérer ${repo}@${sha || branch} (dépôt privé sans jeton ? branche absente ?)`, secrets), { cause: e }); }
  await git(['checkout', '-q', '--detach', 'FETCH_HEAD']);
  const head = (await git(['rev-parse', 'HEAD'], { quiet: true })).trim();
  const message = (await git(['log', '-1', '--format=%s'], { quiet: true })).trim();
  fs.rmSync(path.join(dir, '.git'), { recursive: true, force: true });
  return { sha: head, message };
}
