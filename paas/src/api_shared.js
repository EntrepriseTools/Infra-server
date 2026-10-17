// Ce que tous les groupes de routes partagent : les raccourcis « ou 404 », la
// forme publique d'un service (celle que voient le tableau de bord et la CLI),
// et les noms d'hôtes.
import { HttpError } from './validate.js';
import { volumeName, autoHost, privateHost } from './naming.js';
import { ENGINES } from './databases.js';
import { cronWords, cronNext, cronValid } from './cron.js';

export const ok = (body, status = 200) => ({ status, body });
export const nowS = () => Math.floor(Date.now() / 1000);

export function makeHelpers({ config, store, monitor }) {
  const svcOr404 = (id) => store.getService(id) ?? (() => { throw new HttpError(404, 'service introuvable'); })();
  const depOr404 = (id) => store.getDeployment(id) ?? (() => { throw new HttpError(404, 'déploiement introuvable'); })();
  const projOr404 = (id) => store.getProject(id) ?? (() => { throw new HttpError(404, 'projet introuvable'); })();
  const envOr404 = (id) => store.getEnvironment(id) ?? (() => { throw new HttpError(404, 'environnement introuvable'); })();
  const userOr404 = (id) => store.getUser(id) ?? (() => { throw new HttpError(404, 'compte introuvable'); })();

  const activeContainer = (s) => {
    const dep = s.active_deployment_id ? store.getDeployment(s.active_deployment_id) : null;
    return dep?.container || null;
  };

  /** Le nom d'hôte public que Rail attribue à un service de cet environnement. */
  const hostFor = ({ service, project, environment }) => autoHost({ service, project, environment, domain: config.domain });
  const privateFor = ({ service, project, environment }) => privateHost({ service, project, environment });

  /** L'état d'un service : celui du moniteur, sauf pour une tâche planifiée (pas de conteneur permanent). */
  const statusOf = (s) => {
    if (s.kind === 'cron') {
      const dernier = store.listRuns(s.id, 1)[0] || null;
      const state = s.desired_state === 'stopped' ? 'stopped'
        : dernier?.status === 'running' ? 'job-running'
          : s.active_deployment_id ? 'scheduled' : 'never';
      return { state, since: dernier?.started_at ?? null, restarts: 0, health: null, sample: null };
    }
    return monitor ? monitor.status(s.id) : { state: 'unknown', since: null, restarts: 0, health: null, sample: null };
  };

  /** La forme publique d'un service. Tout ce que l'interface affiche vient d'ici. */
  const publicService = (s) => {
    const domains = store.listDomains(s.id).map((d) => ({ ...d, url: config.urlFor(d.hostname) }));
    const project = store.getProject(s.project_id);
    const environment = store.getEnvironment(s.environment_id);
    const out = {
      ...s,
      project_name: project?.name ?? null,
      environment_name: environment?.name ?? null,
      domains,
      url: s.kind === 'app' && domains[0] ? domains[0].url : null,
      private_host: project ? privateFor({ service: s.name, project: project.name, environment: environment?.name }) : null,
      volume: s.volume_path ? { name: volumeName(s.id), path: s.volume_path, owner: s.volume_owner } : null,
      active_deployment: s.active_deployment_id ? store.getDeployment(s.active_deployment_id) : null,
      latest_deployment: store.listDeployments(s.id, 1)[0] ?? null,
      status: statusOf(s),
      // Exposition TCP : l'adresse à donner à un client extérieur (psql, un poste de travail).
      public_endpoint: s.public_port ? `${config.publicHost || config.domain}:${s.public_port}` : null,
    };
    if (s.kind === 'cron') {
      out.cron = {
        schedule: s.cron_schedule,
        words: s.cron_schedule ? cronWords(s.cron_schedule) : null,
        valid: s.cron_schedule ? cronValid(s.cron_schedule) : false,
        next: s.cron_schedule && cronValid(s.cron_schedule) ? (cronNext(s.cron_schedule)?.toISOString() ?? null) : null,
        last_run: store.listRuns(s.id, 1)[0] ?? null,
      };
    }
    if (s.kind === 'database') {
      const e = ENGINES[s.engine];
      out.engine_label = e?.label ?? s.engine;
      out.backup = {
        schedule: s.backup_schedule,
        words: s.backup_schedule ? cronWords(s.backup_schedule) : null,
        keep: s.backup_keep || config.backupKeep,
        supported: !!e?.dump,
        last_at: store.lastBackupAt(s.id),
      };
    }
    return out;
  };

  const webhookUrl = (s) => `${config.publicUrl}/webhooks/github/${s.id}`;

  /**
   * Le jeton GitHub à utiliser : celui du service, sinon celui du compte connecté,
   * sinon celui réglé pour toute la plateforme, sinon celui du .env.
   */
  const githubTokenFor = (user, svc = null) => (svc && store.githubToken(svc.id))
    || (user && !user.root ? store.userGithubToken(user.id) : null)
    || store.getSetting('github_token')
    || config.defaultGithubToken
    || null;

  return {
    svcOr404, depOr404, projOr404, envOr404, userOr404, activeContainer,
    hostFor, privateFor, statusOf, publicService, webhookUrl, githubTokenFor,
  };
}
