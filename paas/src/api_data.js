// Les routes des données : créer une base managée, la requêter, la sauvegarder,
// la restaurer.
import fs from 'node:fs';
import { HttpError } from './validate.js';
import * as v from './validate.js';
import { ok } from './api_shared.js';
import { STREAMED } from './http.js';
import { ENGINES, engineList, provision, engineDump, engineQuery, engineTables } from './databases.js';
import { toTable } from './sql.js';
import { volumeName, PRODUCTION } from './naming.js';
import { cronValid } from './cron.js';

/** Les ordres qui réécrivent ou détruisent : l'interface fait confirmer. */
const stampName = (name) => `${name}-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}`;

export function mountData(ctx) {
  const { r, config, store, deployer, runtime, backups, H } = ctx;

  // ── créer une base ──────────────────────────────────────────────────────
  r.add('GET', '/api/databases/engines', () => ok(engineList()), { role: 'viewer' });

  r.add('POST', '/api/projects/:id/databases', ({ params, body, ev }) => {
    const project = H.projOr404(params.id);
    let env;
    if (body.environment_id) {
      env = H.envOr404(body.environment_id);
      if (env.project_id !== project.id) throw new HttpError(400, 'cet environnement appartient à un autre projet');
    } else env = store.findEnvironment(project.id, PRODUCTION) ?? store.listEnvironments(project.id)[0];
    const engine = v.oneOf(body.engine, Object.keys(ENGINES), 'moteur');
    const name = v.name(body.name || engine, 'nom de la base');
    if (store.findEnvService(env.id, name)) throw new HttpError(409, `un service « ${name} » existe déjà dans ${project.name}/${env.name}`);
    const host = H.privateFor({ service: name, project: project.name, environment: env.name });
    const { fields, vars } = provision({ engine, name, project: project.name, host, image: body.image ? v.image(body.image) : null });
    const schedule = body.backup_schedule ? String(body.backup_schedule).trim() : null;
    if (schedule && !cronValid(schedule)) throw new HttpError(400, 'planification des sauvegardes invalide (ex. 0 3 * * *)');
    const svc = store.tx(() => {
      const s = store.createService(project.id, { ...fields, environment_id: env.id, backup_schedule: schedule });
      store.setVars(s.id, vars);
      return s;
    });
    ev({
      kind: 'database.created', level: 'info', project_id: project.id, service_id: svc.id, subject: svc.name,
      message: `base ${ENGINES[engine].label} « ${svc.name} » créée dans ${project.name}/${env.name}`,
    });
    deployer.deploy(svc.id, { trigger: 'manual' });
    return ok(H.publicService(store.getService(svc.id)), 201);
  });

  // ── sauvegarde en flux (sans la garder sur le serveur) ──────────────────
  /** `rail backup demo/db > dump.sql` : l'export passe par la connexion, rien n'est écrit ici. */
  r.add('GET', '/api/services/:id/backup', async ({ params, res, ev }) => {
    const s = H.svcOr404(params.id);
    if (s.kind !== 'database') throw new HttpError(400, 'seule une base de données se sauvegarde ainsi');
    const container = H.activeContainer(s);
    if (!container) throw new HttpError(409, 'la base n\'est pas déployée');
    const dump = engineDump(s.engine, store.getVars(s.id));
    if (!dump) throw new HttpError(400, `pas de sauvegarde intégrée pour ${s.engine} : copiez le volume ${volumeName(s.id)}`);
    res.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-disposition': `attachment; filename="${stampName(s.name)}.${dump.ext}"`,
      'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
    });
    try {
      await runtime.exec(container, dump.args, { env: dump.env, onData: (t) => res.write(t), timeoutMs: 1800000 });
      ev({ kind: 'database.backup', level: 'info', project_id: s.project_id, service_id: s.id, subject: s.name, message: `sauvegarde de « ${s.name} » téléchargée` });
    } catch (e) {
      res.write(`\n-- ÉCHEC DE LA SAUVEGARDE : ${e.message}\n`);
    }
    res.end();
    return STREAMED;
  }, { role: 'viewer' });

  // ── sauvegardes gardées sur le serveur ──────────────────────────────────
  const backupOr404 = (id) => store.getBackup(id) ?? (() => { throw new HttpError(404, 'sauvegarde introuvable'); })();

  r.add('GET', '/api/services/:id/backups', ({ params }) => {
    const s = H.svcOr404(params.id);
    return ok({
      schedule: s.backup_schedule, keep: s.backup_keep || config.backupKeep,
      supported: !!ENGINES[s.engine]?.dump, restorable: !!ENGINES[s.engine]?.restore,
      total_size: backups.size(s.id),
      backups: store.listBackups(s.id).map((b) => ({ ...b, available: fs.existsSync(backups.fileOf(b)) })),
    });
  }, { role: 'viewer' });

  r.add('POST', '/api/services/:id/backups', async ({ params }) => {
    const s = H.svcOr404(params.id);
    if (s.kind !== 'database') throw new HttpError(400, 'seule une base de données se sauvegarde');
    try {
      const rec = await backups.create(s.id, { trigger: 'manual' });
      if (rec.status !== 'success') throw new HttpError(500, `sauvegarde en échec : ${String(rec.error || '').split('\n')[0]}`);
      return ok(rec, 201);
    } catch (e) { throw e instanceof HttpError ? e : new HttpError(409, e.message); }
  });

  r.add('GET', '/api/backups/:id/download', ({ params, res }) => {
    const rec = backupOr404(params.id);
    const file = backups.fileOf(rec);
    if (!fs.existsSync(file)) throw new HttpError(404, 'le fichier de cette sauvegarde a disparu du serveur');
    res.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-disposition': `attachment; filename="${rec.file}"`,
      'content-length': String(fs.statSync(file).size),
      'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
    });
    fs.createReadStream(file).pipe(res);
    return STREAMED;
  }, { role: 'viewer' });

  r.add('DELETE', '/api/backups/:id', ({ params, ev }) => {
    const rec = backupOr404(params.id);
    const s = store.getService(rec.service_id);
    backups.remove(rec.id);
    ev({ kind: 'database.backup.deleted', level: 'warn', project_id: s?.project_id, service_id: rec.service_id, subject: rec.file, message: `sauvegarde ${rec.file} supprimée` });
    return ok({ deleted: true });
  });

  /** Restaurer écrase les données actuelles : l'interface fait confirmer, et l'activité le garde. */
  r.add('POST', '/api/backups/:id/restore', async ({ params }) => {
    const rec = backupOr404(params.id);
    try { return ok(await backups.restore(rec.service_id, rec.id)); } catch (e) { throw new HttpError(409, e.message); }
  });

  // ── console SQL ─────────────────────────────────────────────────────────
  // La requête part par l'entrée standard du client (psql, mysql) : elle n'apparaît
  // ni dans les arguments de la commande, ni dans le `ps` de l'hôte.
  async function runSql(s, sql, { readOnly }) {
    const container = H.activeContainer(s);
    if (!container) throw new HttpError(409, 'la base n\'est pas déployée');
    const q = engineQuery(s.engine, store.getVars(s.id), { readOnly });
    if (!q) throw new HttpError(400, `pas de console SQL pour ${s.engine} : ce moteur ne parle pas SQL`);
    const t0 = Date.now();
    let out = ''; let err = '';
    try {
      await runtime.exec(container, q.args, {
        env: q.env,
        input: `${q.prelude}${sql}\n`,
        onData: (t) => { if (out.length < 4_000_000) out += t; },
        onErr: (t) => { err += t; },
        timeoutMs: 60_000,
      });
    } catch (e) {
      const why = (err || e.output || e.message || '').trim().split('\n').slice(0, 8).join('\n');
      throw new HttpError(400, why || 'la requête a échoué');
    }
    return { ...toTable(out, q.format), ms: Date.now() - t0, read_only: readOnly, notice: err.trim() || null };
  }

  r.add('POST', '/api/services/:id/query', async ({ params, body, ev }) => {
    const s = H.svcOr404(params.id);
    if (s.kind !== 'database') throw new HttpError(400, 'seule une base de données se requête');
    const sql = typeof body.sql === 'string' ? body.sql.trim() : '';
    if (!sql) throw new HttpError(400, 'requête vide');
    if (sql.length > 200_000) throw new HttpError(413, 'requête trop longue');
    const readOnly = body.read_only !== false;
    const res = await runSql(s, sql, { readOnly });
    // Une écriture laisse une trace : qui a changé quoi, et quand, se lit dans l'activité.
    if (!readOnly) {
      ev({
        kind: 'database.write', level: 'warn', project_id: s.project_id, service_id: s.id, subject: s.name,
        message: `requête en écriture sur « ${s.name} » : ${sql.replace(/\s+/g, ' ').slice(0, 120)}`,
      });
    }
    return ok(res);
  }, { role: 'member' });

  r.add('GET', '/api/services/:id/tables', async ({ params }) => {
    const s = H.svcOr404(params.id);
    if (s.kind !== 'database') throw new HttpError(400, 'seule une base de données a des tables');
    const sql = engineTables(s.engine);
    if (!sql) throw new HttpError(400, `pas de liste de tables pour ${s.engine}`);
    return ok(await runSql(s, sql, { readOnly: true }));
  }, { role: 'viewer' });
}
