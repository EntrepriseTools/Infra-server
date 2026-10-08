// Lancer un programme sans shell : les arguments sont un tableau, jamais une chaîne à interpréter.
import { spawn } from 'node:child_process';

export class ProcError extends Error {
  constructor(msg, code, out) { super(msg); this.code = code; this.output = out; }
}

/** Exécute `cmd args`, envoie chaque morceau de sortie à onData, rejette si code ≠ 0. */
export function run(cmd, args, { env, cwd, onData, signal, timeoutMs, input } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { env, cwd, signal, stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
    let out = '';
    let timer;
    const take = (b) => { const t = b.toString('utf8'); out = (out + t).slice(-20000); onData?.(t); };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    if (input) child.stdin.end(input);
    if (timeoutMs) timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    child.on('error', (e) => { clearTimeout(timer); reject(e.name === 'AbortError' ? new ProcError('annulé', null, out) : e); });
    child.on('close', (code, sig) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new ProcError(`${cmd} ${args[0] ?? ''} a échoué (${sig ? `signal ${sig}` : `code ${code}`})`, code, out));
    });
  });
}
