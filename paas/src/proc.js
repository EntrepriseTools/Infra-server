// Lancer un programme sans shell : les arguments sont un tableau, jamais une chaîne à interpréter.
import { spawn } from 'node:child_process';

export class ProcError extends Error {
  constructor(msg, code, out, err = '') { super(msg); this.code = code; this.output = out; this.stderr = err; }
}

/**
 * Exécute `cmd args`, envoie chaque morceau de sortie à onData, rejette si code ≠ 0.
 * `input` passe une chaîne par l'entrée standard ; `inputStream` y verse un flux
 * (une sauvegarde de plusieurs gigaoctets ne tient pas en mémoire).
 */
export function run(cmd, args, { env, cwd, onData, onErr, signal, timeoutMs, input, inputStream } = {}) {
  return new Promise((resolve, reject) => {
    const avecEntree = input !== undefined || !!inputStream;
    const child = spawn(cmd, args, { env, cwd, signal, stdio: [avecEntree ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    let timer;
    const take = (b) => { const t = b.toString('utf8'); out = (out + t).slice(-20000); onData?.(t); };
    // Sans onErr, les deux flux se mélangent comme avant (les journaux de build les veulent ensemble).
    const takeErr = (b) => { const t = b.toString('utf8'); err = (err + t).slice(-20000); if (onErr) onErr(t); else take(b); };
    child.stdout.on('data', take);
    child.stderr.on('data', takeErr);
    if (inputStream) {
      // Une entrée fermée par l'autre bout (le client a fini de lire) n'est pas une panne.
      child.stdin.on('error', () => {});
      inputStream.on('error', (e) => reject(e));
      inputStream.pipe(child.stdin);
    } else if (input !== undefined) { child.stdin.on('error', () => {}); child.stdin.end(input); }
    if (timeoutMs) timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    child.on('error', (e) => { clearTimeout(timer); reject(e.name === 'AbortError' ? new ProcError('annulé', null, out, err) : e); });
    child.on('close', (code, sig) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new ProcError(`${cmd} ${args[0] ?? ''} a échoué (${sig ? `signal ${sig}` : `code ${code}`})`, code, out, err));
    });
  });
}
