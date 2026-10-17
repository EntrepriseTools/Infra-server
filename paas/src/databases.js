// Les bases de données managées : ce que Railway appelle des « plugins ».
// Une base est un service comme un autre (même file d'attente, mêmes journaux,
// mêmes mesures), mais son image est figée, elle a un volume persistant, pas de
// domaine public, et ses identifiants sont engendrés une fois pour toutes.
//
// Ses identifiants SONT ses variables : elles configurent l'image officielle au
// premier démarrage (POSTGRES_PASSWORD…) et servent de point de branchement aux
// autres services (`${{ma-base.DATABASE_URL}}`).
import { randomToken } from './crypto.js';

/**
 * Les images officielles démarrent en root, préparent leur dossier de données
 * (chown/chmod sur le volume), puis redescendent vers leur propre utilisateur
 * (gosu, su-exec). Sans ces capacités, elles s'arrêtent sur « operation not
 * permitted ». C'est le strict nécessaire : tout le reste reste retiré, et
 * `no-new-privileges` tient toujours.
 */
export const DB_CAPS = ['CHOWN', 'DAC_OVERRIDE', 'FOWNER', 'SETUID', 'SETGID'];

/** Mot de passe sûr dans une URL : base64url ne contient que [A-Za-z0-9_-]. */
const password = () => randomToken(18);
/** « mon-api » → « mon_api » : un nom de base acceptable partout. */
const dbName = (name) => name.replace(/-/g, '_').slice(0, 48);

export const ENGINES = {
  postgres: {
    label: 'PostgreSQL 16',
    family: 'Relationnel (SQL)',
    about: 'La base par défaut : transactions, JSON, extensions. Le choix sûr pour une API.',
    image: 'postgres:16-alpine',
    port: 5432,
    volume: '/var/lib/postgresql/data',
    memoryMb: 512,
    client: 'psql "$DATABASE_URL"',
    vars({ host, port, name }) {
      const user = 'rail'; const pass = password(); const db = dbName(name);
      return {
        POSTGRES_USER: user, POSTGRES_PASSWORD: pass, POSTGRES_DB: db,
        PGHOST: host, PGPORT: String(port), PGUSER: user, PGPASSWORD: pass, PGDATABASE: db,
        DATABASE_URL: `postgresql://${user}:${pass}@${host}:${port}/${db}`,
      };
    },
    dump: (v) => ({ args: ['pg_dump', '--clean', '--if-exists', '-U', v.POSTGRES_USER, '-d', v.POSTGRES_DB], env: {}, ext: 'sql' }),
    restore: (v) => ({ args: ['psql', '-q', '-U', v.POSTGRES_USER, '-d', v.POSTGRES_DB, '-v', 'ON_ERROR_STOP=1', '-f', '-'], env: {} }),
    // La requête arrive par l'entrée standard : jamais dans les arguments, donc jamais dans `ps`.
    query: (v, { readOnly = true } = {}) => ({
      args: ['psql', '-U', v.POSTGRES_USER, '-d', v.POSTGRES_DB, '--csv', '-q', '-v', 'ON_ERROR_STOP=1', '-f', '-'],
      env: {},
      prelude: `SET statement_timeout='30s';\n${readOnly ? 'SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY;\n' : ''}`,
      format: 'csv',
    }),
    tablesSql: `SELECT table_schema AS schema, table_name AS nom,
      pg_size_pretty(pg_total_relation_size(quote_ident(table_schema)||'.'||quote_ident(table_name))) AS taille
      FROM information_schema.tables WHERE table_type='BASE TABLE'
      AND table_schema NOT IN ('pg_catalog','information_schema') ORDER BY 1,2`,
  },
  mysql: {
    label: 'MySQL 8',
    family: 'Relationnel (SQL)',
    about: 'Le classique du web. À préférer quand l’application attend MySQL (WordPress…).',
    image: 'mysql:8',
    port: 3306,
    volume: '/var/lib/mysql',
    memoryMb: 1024,
    client: 'mysql -h "$MYSQL_HOST" -u "$MYSQL_USER" -p"$MYSQL_PASSWORD" "$MYSQL_DATABASE"',
    vars({ host, port, name }) {
      const user = 'rail'; const pass = password(); const root = password(); const db = dbName(name);
      return {
        MYSQL_ROOT_PASSWORD: root, MYSQL_USER: user, MYSQL_PASSWORD: pass, MYSQL_DATABASE: db,
        MYSQL_HOST: host, MYSQL_PORT: String(port),
        DATABASE_URL: `mysql://${user}:${pass}@${host}:${port}/${db}`,
      };
    },
    // Le mot de passe passe par l'environnement du client docker, jamais dans les arguments.
    dump: (v) => ({ args: ['mysqldump', '-h', '127.0.0.1', '-u', 'root', '--single-transaction', v.MYSQL_DATABASE], env: { MYSQL_PWD: v.MYSQL_ROOT_PASSWORD }, ext: 'sql' }),
    restore: (v) => ({ args: ['mysql', '-h', '127.0.0.1', '-u', 'root', v.MYSQL_DATABASE], env: { MYSQL_PWD: v.MYSQL_ROOT_PASSWORD } }),
    query: (v, { readOnly = true } = {}) => ({
      args: ['mysql', '--batch', '--raw', '-h', '127.0.0.1', '-u', 'root', v.MYSQL_DATABASE],
      env: { MYSQL_PWD: v.MYSQL_ROOT_PASSWORD },
      prelude: `SET SESSION max_execution_time=30000;\n${readOnly ? 'SET SESSION TRANSACTION READ ONLY;\n' : ''}`,
      format: 'tsv',
    }),
    tablesSql: 'SELECT table_schema AS `schema`, table_name AS nom, table_rows AS lignes FROM information_schema.tables '
      + "WHERE table_type='BASE TABLE' AND table_schema NOT IN ('mysql','information_schema','performance_schema','sys') ORDER BY 1,2",
  },
  mariadb: {
    label: 'MariaDB 11',
    family: 'Relationnel (SQL)',
    about: 'Compatible MySQL, plus légère. Bon remplacement direct de MySQL.',
    image: 'mariadb:11',
    port: 3306,
    volume: '/var/lib/mysql',
    memoryMb: 768,
    client: 'mariadb -h 127.0.0.1 -u root -p"$MARIADB_ROOT_PASSWORD" "$MARIADB_DATABASE"',
    vars({ host, port, name }) {
      const user = 'rail'; const pass = password(); const root = password(); const db = dbName(name);
      return {
        MARIADB_ROOT_PASSWORD: root, MARIADB_USER: user, MARIADB_PASSWORD: pass, MARIADB_DATABASE: db,
        MARIADB_HOST: host, MARIADB_PORT: String(port),
        // Les applications qui ne connaissent que MySQL trouvent aussi leur compte.
        MYSQL_HOST: host, MYSQL_PORT: String(port), MYSQL_USER: user, MYSQL_PASSWORD: pass, MYSQL_DATABASE: db,
        DATABASE_URL: `mysql://${user}:${pass}@${host}:${port}/${db}`,
      };
    },
    dump: (v) => ({ args: ['mariadb-dump', '-h', '127.0.0.1', '-u', 'root', '--single-transaction', v.MARIADB_DATABASE], env: { MYSQL_PWD: v.MARIADB_ROOT_PASSWORD }, ext: 'sql' }),
    restore: (v) => ({ args: ['mariadb', '-h', '127.0.0.1', '-u', 'root', v.MARIADB_DATABASE], env: { MYSQL_PWD: v.MARIADB_ROOT_PASSWORD } }),
    query: (v, { readOnly = true } = {}) => ({
      args: ['mariadb', '--batch', '--raw', '-h', '127.0.0.1', '-u', 'root', v.MARIADB_DATABASE],
      env: { MYSQL_PWD: v.MARIADB_ROOT_PASSWORD },
      prelude: `SET SESSION max_statement_time=30;\n${readOnly ? 'SET SESSION TRANSACTION READ ONLY;\n' : ''}`,
      format: 'tsv',
    }),
    tablesSql: 'SELECT table_schema AS `schema`, table_name AS nom, table_rows AS lignes FROM information_schema.tables '
      + "WHERE table_type='BASE TABLE' AND table_schema NOT IN ('mysql','information_schema','performance_schema','sys') ORDER BY 1,2",
  },
  redis: {
    label: 'Redis 7',
    family: 'Clé-valeur',
    about: 'Cache, files d’attente, sessions. Tout tient en mémoire, avec sauvegarde sur disque.',
    image: 'redis:7-alpine',
    port: 6379,
    volume: '/data',
    memoryMb: 256,
    client: 'redis-cli -u "$REDIS_URL"',
    vars({ host, port }) {
      const pass = password();
      return { REDIS_PASSWORD: pass, REDIS_HOST: host, REDIS_PORT: String(port), REDIS_URL: `redis://default:${pass}@${host}:${port}` };
    },
    // Redis ne lit pas son mot de passe dans l'environnement : il faut le passer à la commande.
    cmd: (v) => ['redis-server', '--requirepass', v.REDIS_PASSWORD, '--appendonly', 'yes'],
  },
  valkey: {
    label: 'Valkey 8',
    family: 'Clé-valeur',
    about: 'La suite libre de Redis, maintenue par la Linux Foundation. Même protocole.',
    image: 'valkey/valkey:8-alpine',
    port: 6379,
    volume: '/data',
    memoryMb: 256,
    client: 'valkey-cli -u "$REDIS_URL"',
    vars({ host, port }) {
      const pass = password();
      return {
        VALKEY_PASSWORD: pass, VALKEY_HOST: host, VALKEY_PORT: String(port),
        REDIS_PASSWORD: pass, REDIS_HOST: host, REDIS_PORT: String(port),
        REDIS_URL: `redis://default:${pass}@${host}:${port}`,
      };
    },
    cmd: (v) => ['valkey-server', '--requirepass', v.VALKEY_PASSWORD, '--appendonly', 'yes'],
  },
  mongo: {
    label: 'MongoDB 7',
    family: 'Documents',
    about: 'Documents JSON sans schéma figé. Pratique quand la forme des données bouge.',
    image: 'mongo:7',
    port: 27017,
    volume: '/data/db',
    memoryMb: 768,
    client: 'mongosh "$MONGO_URL"',
    vars({ host, port, name }) {
      const user = 'rail'; const pass = password(); const db = dbName(name);
      return {
        MONGO_INITDB_ROOT_USERNAME: user, MONGO_INITDB_ROOT_PASSWORD: pass, MONGO_INITDB_DATABASE: db,
        MONGO_HOST: host, MONGO_PORT: String(port), MONGO_USER: user, MONGO_PASSWORD: pass, MONGO_DATABASE: db,
        MONGO_URL: `mongodb://${user}:${pass}@${host}:${port}/${db}?authSource=admin`,
      };
    },
    dump: (v) => ({ args: ['mongodump', '--quiet', '--archive', `--username=${v.MONGO_USER}`, `--password=${v.MONGO_PASSWORD}`, '--authenticationDatabase=admin'], env: {}, ext: 'archive' }),
    restore: (v) => ({ args: ['mongorestore', '--quiet', '--archive', '--drop', `--username=${v.MONGO_USER}`, `--password=${v.MONGO_PASSWORD}`, '--authenticationDatabase=admin'], env: {} }),
  },
  clickhouse: {
    label: 'ClickHouse 24',
    family: 'Analytique (SQL)',
    about: 'Des milliards de lignes agrégées en une seconde : journaux, mesures, tableaux de bord.',
    image: 'clickhouse/clickhouse-server:24.8-alpine',
    port: 8123,
    volume: '/var/lib/clickhouse',
    memoryMb: 2048,
    client: 'clickhouse-client --user "$CLICKHOUSE_USER" --password "$CLICKHOUSE_PASSWORD" --database "$CLICKHOUSE_DB"',
    vars({ host, port, name }) {
      const user = 'rail'; const pass = password(); const db = dbName(name);
      return {
        CLICKHOUSE_USER: user, CLICKHOUSE_PASSWORD: pass, CLICKHOUSE_DB: db,
        CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT: '1',
        CLICKHOUSE_HOST: host, CLICKHOUSE_PORT: String(port), CLICKHOUSE_NATIVE_PORT: '9000',
        DATABASE_URL: `clickhouse://${user}:${pass}@${host}:${port}/${db}`,
      };
    },
    query: (v, { readOnly = true } = {}) => ({
      args: ['clickhouse-client', '--user', v.CLICKHOUSE_USER, '--password', v.CLICKHOUSE_PASSWORD,
        '--database', v.CLICKHOUSE_DB, '--format', 'CSVWithNames', '--multiquery'],
      env: {},
      // L'ordre compte : en lecture seule, ClickHouse refuse les SET qui suivent.
      prelude: `SET max_execution_time=30;\n${readOnly ? 'SET readonly=1;\n' : ''}`,
      format: 'csv',
    }),
    tablesSql: `SELECT database AS schema, name AS nom, formatReadableSize(total_bytes) AS taille
      FROM system.tables WHERE database NOT IN ('system','INFORMATION_SCHEMA','information_schema') ORDER BY 1,2`,
  },
  meilisearch: {
    label: 'Meilisearch 1.11',
    family: 'Recherche',
    about: 'Recherche instantanée, tolérante aux fautes, à brancher sur un champ de recherche.',
    image: 'getmeili/meilisearch:v1.11',
    port: 7700,
    volume: '/meili_data',
    memoryMb: 512,
    client: 'curl -H "Authorization: Bearer $MEILI_MASTER_KEY" http://localhost:7700/indexes',
    vars({ host, port }) {
      const key = password();
      return {
        MEILI_MASTER_KEY: key, MEILI_ENV: 'production', MEILI_NO_ANALYTICS: 'true',
        MEILISEARCH_HOST: host, MEILISEARCH_PORT: String(port),
        MEILISEARCH_URL: `http://${host}:${port}`, MEILISEARCH_KEY: key,
      };
    },
  },
  rabbitmq: {
    label: 'RabbitMQ 4',
    family: 'Messages',
    about: 'File de messages durable entre services : tâches de fond, pics de charge absorbés.',
    image: 'rabbitmq:4-alpine',
    port: 5672,
    volume: '/var/lib/rabbitmq',
    memoryMb: 768,
    client: 'rabbitmqctl list_queues',
    vars({ host, port, name }) {
      const user = 'rail'; const pass = password();
      return {
        RABBITMQ_DEFAULT_USER: user, RABBITMQ_DEFAULT_PASS: pass, RABBITMQ_DEFAULT_VHOST: '/',
        RABBITMQ_HOST: host, RABBITMQ_PORT: String(port),
        AMQP_URL: `amqp://${user}:${pass}@${host}:${port}/`,
        BROKER_URL: `amqp://${user}:${pass}@${host}:${port}/`,
        RABBITMQ_NODENAME: `rabbit@${dbName(name)}`,
      };
    },
  },
};

export const engineList = () => Object.entries(ENGINES).map(([id, e]) => ({
  id, label: e.label, family: e.family, about: e.about, image: e.image, port: e.port, volume: e.volume,
  memory_mb: e.memoryMb, backup: !!e.dump, restore: !!e.restore, sql: !!e.query,
}));

/** Tout ce qu'il faut pour créer la base : champs du service + variables engendrées. */
export function provision({ engine, name, project, host, image }) {
  const e = ENGINES[engine];
  if (!e) throw new Error(`moteur inconnu : ${engine}`);
  return {
    fields: {
      name, kind: 'database', engine, base_image: image || e.image, port: e.port, source_kind: 'image',
      volume_path: e.volume, memory_mb: e.memoryMb, auto_deploy: false, repo: '', branch: '', root_dir: '.',
    },
    vars: e.vars({ host: host || `${name}.${project}.internal`, port: e.port, name }),
  };
}

/** La commande de démarrage (Redis, Valkey), ou null : l'image sait démarrer seule. */
export const engineCmd = (engine, vars) => ENGINES[engine]?.cmd?.(vars) ?? null;
/** Le connecteur de sauvegarde, ou null si le moteur n'en a pas. */
export const engineDump = (engine, vars) => ENGINES[engine]?.dump?.(vars) ?? null;
/** Le connecteur de restauration (lit la sauvegarde sur l'entrée standard). */
export const engineRestore = (engine, vars) => ENGINES[engine]?.restore?.(vars) ?? null;
/** Le connecteur de requête (console SQL), ou null : Redis et Mongo ne parlent pas SQL. */
export const engineQuery = (engine, vars, opts) => ENGINES[engine]?.query?.(vars, opts) ?? null;
/** La requête qui liste les tables du moteur. */
export const engineTables = (engine) => ENGINES[engine]?.tablesSql ?? null;
