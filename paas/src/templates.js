// Les modèles : des piles prêtes à l'emploi, déployées en un clic.
//
// Un modèle décrit un ou plusieurs services. Un service de modèle est soit une
// image publique (une application), soit un moteur de base (« engine »), et Rail
// les crée tous d'un coup, les câble entre eux, puis les déploie.
//
// Deux sortes de marques dans les valeurs :
//   %secret%, %password%, %host%, %url%, %project%, %env%
//        remplacées MAINTENANT, à la création (un mot de passe est tiré une fois)
//   ${{autre-service.CLE}}
//        laissée telle quelle : résolue À CHAQUE DÉPLOIEMENT (voir vars.js), de
//        sorte qu'une base recréée n'oblige pas à recopier son mot de passe.
//
// Les étiquettes d'image sont volontairement peu précises (majeure, ou « latest ») :
// elles survivent au temps, et chaque service garde son image modifiable dans ses
// réglages — « épingler » une version est à un champ de distance.
import { randomToken } from './crypto.js';
import { ENGINES } from './databases.js';

/** Les capacités qu'une image qui prépare son volume en root puis redescend réclame. */
const CAPS_ENTREE = 'CHOWN,DAC_OVERRIDE,FOWNER,SETUID,SETGID';

export const TEMPLATES = [
  {
    id: 'n8n',
    label: 'n8n',
    tagline: 'Automatisation entre vos outils, sans écrire de code',
    about: 'Des « scénarios » qui relient vos API, bases et services (l’équivalent libre de Zapier). Les données restent chez vous.',
    tags: ['automatisation', 'sans-code'],
    services: [
      {
        name: 'n8n',
        image: 'docker.n8n.io/n8nio/n8n:latest',
        port: 5678,
        volume: '/home/node/.n8n',
        volumeOwner: 1000,
        memoryMb: 1024,
        health: '/healthz',
        vars: {
          N8N_HOST: '%host%', N8N_PORT: '5678', N8N_PROTOCOL: 'https', WEBHOOK_URL: '%url%/',
          N8N_ENCRYPTION_KEY: '%secret%', GENERIC_TIMEZONE: 'Europe/Paris', N8N_RUNNERS_ENABLED: 'true',
          N8N_DIAGNOSTICS_ENABLED: 'false',
          DB_TYPE: 'postgresdb', DB_POSTGRESDB_HOST: '${{base.PGHOST}}', DB_POSTGRESDB_PORT: '5432',
          DB_POSTGRESDB_DATABASE: '${{base.PGDATABASE}}', DB_POSTGRESDB_USER: '${{base.PGUSER}}',
          DB_POSTGRESDB_PASSWORD: '${{base.PGPASSWORD}}',
        },
      },
      { name: 'base', engine: 'postgres' },
    ],
  },
  {
    id: 'ghost',
    label: 'Ghost',
    tagline: 'Blog et infolettre, prêt à écrire',
    about: 'Un moteur de publication soigné : articles, abonnements payants, infolettre. Première visite = création du compte auteur.',
    tags: ['site', 'contenu'],
    services: [
      {
        name: 'ghost',
        image: 'ghost:5-alpine',
        port: 2368,
        volume: '/var/lib/ghost/content',
        volumeOwner: 1000,
        memoryMb: 768,
        vars: {
          url: '%url%', NODE_ENV: 'production',
          database__client: 'mysql',
          database__connection__host: '${{base.MYSQL_HOST}}',
          database__connection__port: '3306',
          database__connection__user: '${{base.MYSQL_USER}}',
          database__connection__password: '${{base.MYSQL_PASSWORD}}',
          database__connection__database: '${{base.MYSQL_DATABASE}}',
        },
      },
      { name: 'base', engine: 'mysql' },
    ],
  },
  {
    id: 'wordpress',
    label: 'WordPress',
    tagline: 'Le site web le plus répandu au monde',
    about: 'WordPress et sa base MariaDB. L’assistant d’installation s’ouvre à la première visite.',
    tags: ['site', 'contenu'],
    services: [
      {
        name: 'wordpress',
        image: 'wordpress:6-apache',
        port: 80,
        volume: '/var/www/html',
        memoryMb: 768,
        vars: {
          WORDPRESS_DB_HOST: '${{base.MYSQL_HOST}}:3306',
          WORDPRESS_DB_USER: '${{base.MYSQL_USER}}',
          WORDPRESS_DB_PASSWORD: '${{base.MYSQL_PASSWORD}}',
          WORDPRESS_DB_NAME: '${{base.MYSQL_DATABASE}}',
          WORDPRESS_CONFIG_EXTRA: "define('WP_HOME','%url%'); define('WP_SITEURL','%url%');",
        },
      },
      { name: 'base', engine: 'mariadb' },
    ],
  },
  {
    id: 'metabase',
    label: 'Metabase',
    tagline: 'Questions et tableaux de bord sur vos bases',
    about: 'Branchez-y une base du projet (hôte privé, par exemple base.monprojet.internal) et posez des questions sans écrire de SQL.',
    tags: ['données', 'tableaux de bord'],
    services: [
      {
        name: 'metabase',
        image: 'metabase/metabase:latest',
        port: 3000,
        memoryMb: 2048,
        health: '/api/health',
        vars: {
          MB_DB_TYPE: 'postgres', MB_DB_HOST: '${{base.PGHOST}}', MB_DB_PORT: '5432',
          MB_DB_DBNAME: '${{base.PGDATABASE}}', MB_DB_USER: '${{base.PGUSER}}', MB_DB_PASS: '${{base.PGPASSWORD}}',
          MB_SITE_URL: '%url%', JAVA_TIMEZONE: 'Europe/Paris',
        },
      },
      { name: 'base', engine: 'postgres' },
    ],
  },
  {
    id: 'umami',
    label: 'Umami',
    tagline: 'Mesure d’audience respectueuse de la vie privée',
    about: 'Une alternative à Google Analytics : pas de cookie, pas de données personnelles. Compte par défaut admin / umami, à changer tout de suite.',
    tags: ['analytique'],
    services: [
      {
        name: 'umami',
        image: 'ghcr.io/umami-software/umami:postgresql-latest',
        port: 3000,
        memoryMb: 768,
        health: '/api/heartbeat',
        vars: { DATABASE_URL: '${{base.DATABASE_URL}}', DATABASE_TYPE: 'postgresql', APP_SECRET: '%secret%' },
      },
      { name: 'base', engine: 'postgres' },
    ],
  },
  {
    id: 'uptime-kuma',
    label: 'Uptime Kuma',
    tagline: 'Surveillance de sites et alertes',
    about: 'Vérifie que vos sites répondent et prévient par courriel, Slack, Telegram… Complète la surveillance interne de Rail en vue « de l’extérieur ».',
    tags: ['supervision'],
    services: [
      { name: 'uptime', image: 'louislam/uptime-kuma:1', port: 3001, volume: '/app/data', memoryMb: 512 },
    ],
  },
  {
    id: 'gitea',
    label: 'Gitea',
    tagline: 'Votre forge Git, chez vous',
    about: 'Dépôts Git, demandes de fusion, tickets. Rail peut ensuite déployer depuis cette forge en réglant RAIL_GIT_BASE.',
    tags: ['développement'],
    services: [
      {
        name: 'gitea',
        image: 'gitea/gitea:1.22',
        port: 3000,
        volume: '/data',
        volumeOwner: 1000,
        caps: CAPS_ENTREE,
        memoryMb: 1024,
        vars: {
          USER_UID: '1000', USER_GID: '1000',
          GITEA__server__ROOT_URL: '%url%/', GITEA__server__DOMAIN: '%host%', GITEA__server__HTTP_PORT: '3000',
          GITEA__database__DB_TYPE: 'postgres', GITEA__database__HOST: '${{base.PGHOST}}:5432',
          GITEA__database__NAME: '${{base.PGDATABASE}}', GITEA__database__USER: '${{base.PGUSER}}',
          GITEA__database__PASSWD: '${{base.PGPASSWORD}}',
          GITEA__service__DISABLE_REGISTRATION: 'true',
        },
      },
      { name: 'base', engine: 'postgres' },
    ],
  },
  {
    id: 'minio',
    label: 'MinIO',
    tagline: 'Stockage de fichiers compatible S3',
    about: 'Un S3 sur votre disque. La console web est publiée ; l’API S3 reste privée sur le port 9000 (http://minio.<projet>.internal:9000).',
    tags: ['stockage'],
    services: [
      {
        name: 'minio',
        image: 'minio/minio:latest',
        port: 9001,
        volume: '/data',
        memoryMb: 1024,
        start: 'minio server /data --console-address :9001',
        vars: {
          MINIO_ROOT_USER: 'rail', MINIO_ROOT_PASSWORD: '%password%',
          MINIO_BROWSER_REDIRECT_URL: '%url%',
          S3_ENDPOINT: 'http://%privatehost%:9000', S3_ACCESS_KEY: 'rail', S3_REGION: 'us-east-1',
        },
      },
    ],
  },
  {
    id: 'vaultwarden',
    label: 'Vaultwarden',
    tagline: 'Coffre à mots de passe (compatible Bitwarden)',
    about: 'Les applications et extensions Bitwarden s’y connectent. L’inscription est fermée : ouvrez-la le temps de créer votre compte (SIGNUPS_ALLOWED).',
    tags: ['sécurité'],
    services: [
      {
        name: 'vaultwarden',
        image: 'vaultwarden/server:alpine',
        port: 80,
        volume: '/data',
        memoryMb: 512,
        health: '/alive',
        vars: { DOMAIN: '%url%', SIGNUPS_ALLOWED: 'false', ADMIN_TOKEN: '%secret%', ROCKET_PORT: '80' },
      },
    ],
  },
  {
    id: 'nocodb',
    label: 'NocoDB',
    tagline: 'Un tableur qui est une vraie base',
    about: 'L’équivalent libre d’Airtable : des tables, des vues, des formulaires, une API REST engendrée.',
    tags: ['sans-code', 'données'],
    services: [
      {
        name: 'nocodb',
        image: 'nocodb/nocodb:latest',
        port: 8080,
        volume: '/usr/app/data',
        memoryMb: 1024,
        health: '/api/v1/health',
        vars: {
          NC_DB: 'pg://${{base.PGHOST}}:5432?u=${{base.PGUSER}}&p=${{base.PGPASSWORD}}&d=${{base.PGDATABASE}}',
          NC_PUBLIC_URL: '%url%', NC_AUTH_JWT_SECRET: '%secret%', NC_DISABLE_TELE: 'true',
        },
      },
      { name: 'base', engine: 'postgres' },
    ],
  },
  {
    id: 'grafana',
    label: 'Grafana',
    tagline: 'Tableaux de bord de mesures',
    about: 'Pour aller plus loin que la page Système : courbes, seuils, alertes, sur vos propres sources de données.',
    tags: ['supervision', 'tableaux de bord'],
    services: [
      {
        name: 'grafana',
        image: 'grafana/grafana:11.3.0',
        port: 3000,
        volume: '/var/lib/grafana',
        volumeOwner: 472,
        memoryMb: 512,
        health: '/api/health',
        vars: { GF_SECURITY_ADMIN_USER: 'admin', GF_SECURITY_ADMIN_PASSWORD: '%password%', GF_SERVER_ROOT_URL: '%url%', GF_ANALYTICS_REPORTING_ENABLED: 'false' },
      },
    ],
  },
  {
    id: 'directus',
    label: 'Directus',
    tagline: 'CMS « headless » et API sur une base',
    about: 'Une interface d’administration et une API REST/GraphQL par-dessus PostgreSQL : le dos d’une application mobile ou d’un site statique.',
    tags: ['contenu', 'développement'],
    services: [
      {
        name: 'directus',
        image: 'directus/directus:11',
        port: 8055,
        volume: '/directus/uploads',
        volumeOwner: 1000,
        memoryMb: 1024,
        health: '/server/health',
        vars: {
          KEY: '%secret%', SECRET: '%secret%', PUBLIC_URL: '%url%',
          DB_CLIENT: 'pg', DB_HOST: '${{base.PGHOST}}', DB_PORT: '5432',
          DB_DATABASE: '${{base.PGDATABASE}}', DB_USER: '${{base.PGUSER}}', DB_PASSWORD: '${{base.PGPASSWORD}}',
          ADMIN_EMAIL: 'admin@%host%', ADMIN_PASSWORD: '%password%', TELEMETRY: 'false',
        },
      },
      { name: 'base', engine: 'postgres' },
    ],
  },
  {
    id: 'mailpit',
    label: 'Mailpit',
    tagline: 'Boîte aux lettres d’essai pour vos applications',
    about: 'Un serveur SMTP qui n’envoie rien : vos services lui écrivent (mailpit.<projet>.internal:1025) et vous lisez les courriels dans le navigateur.',
    tags: ['développement'],
    services: [
      {
        name: 'mailpit',
        image: 'axllent/mailpit:latest',
        port: 8025,
        memoryMb: 256,
        vars: { MP_SMTP_AUTH_ACCEPT_ANY: 'true', MP_SMTP_AUTH_ALLOW_INSECURE: 'true', SMTP_HOST: '%privatehost%', SMTP_PORT: '1025' },
      },
    ],
  },
  {
    id: 'excalidraw',
    label: 'Excalidraw',
    tagline: 'Tableau blanc à main levée',
    about: 'Schémas et croquis à plusieurs, dans le navigateur. Aucune base, aucun réglage : le modèle le plus simple pour vérifier que tout fonctionne.',
    tags: ['outils'],
    services: [
      { name: 'excalidraw', image: 'excalidraw/excalidraw:latest', port: 80, memoryMb: 256 },
    ],
  },
];

export const templateList = () => TEMPLATES.map((t) => ({
  id: t.id, label: t.label, tagline: t.tagline, about: t.about, tags: t.tags,
  services: t.services.map((s) => ({
    name: s.name,
    kind: s.engine ? 'database' : 'app',
    what: s.engine ? (ENGINES[s.engine]?.label ?? s.engine) : s.image,
    http: !s.engine,
  })),
}));

export const getTemplate = (id) => TEMPLATES.find((t) => t.id === id) || null;

/**
 * Prépare la création : résout les marques « %…% » (un secret tiré une seule fois
 * par valeur) et renvoie, pour chaque service du modèle, de quoi appeler le magasin.
 *
 * @param hostOf (nomDuService) → nom d'hôte public attribué par Rail
 * @param privateHostOf (nomDuService) → nom d'hôte privé
 * @param urlOf (nomDuService) → adresse publique complète
 */
export function instantiate(template, { hostOf, privateHostOf, urlOf, project, environment }) {
  const out = [];
  for (const s of template.services) {
    const marks = {
      '%host%': hostOf(s.name),
      '%privatehost%': privateHostOf(s.name),
      '%url%': urlOf(s.name),
      '%project%': project,
      '%env%': environment,
    };
    const vars = {};
    for (const [k, raw] of Object.entries(s.vars || {})) {
      // %secret% et %password% : une valeur neuve à chaque occurrence.
      vars[k] = String(raw)
        .replace(/%secret%/g, () => randomToken(24))
        .replace(/%password%/g, () => randomToken(12))
        .replace(/%host%|%privatehost%|%url%|%project%|%env%/g, (m) => marks[m]);
    }
    out.push({
      spec: s,
      vars,
      fields: s.engine ? null : {
        name: s.name, kind: 'app', source_kind: 'image', base_image: s.image,
        port: s.port, healthcheck_path: s.health || null, volume_path: s.volume || null,
        volume_owner: s.volumeOwner ?? null, extra_caps: s.caps || null,
        memory_mb: s.memoryMb ?? null, start_command: s.start || null,
        auto_deploy: false, repo: '', branch: '', root_dir: '.', template: template.id,
      },
    });
  }
  return out;
}
