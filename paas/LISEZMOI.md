# Rail — un Railway à vous : déployer, surveiller, exploiter

Rail est une plateforme de déploiement **auto-hébergée**. On s'y connecte avec un
**identifiant et un mot de passe**, on choisit un dépôt GitHub **dans une liste**, et
chaque `git push` construit l'application, la démarre, vérifie qu'elle répond, puis lui
donne son adresse HTTPS — **sans coupure**, avec **retour arrière en un clic**. À côté,
on ajoute des **bases de données**, des **tâches planifiées**, des **piles entières prises
dans un catalogue** (n8n, Ghost, WordPress, Metabase…), et on **voit ce qui se passe** :
processeur, mémoire, réseau, disponibilité, fil d'activité, alertes. C'est le geste de
Railway, sur votre serveur.

| Railway | Rail |
|---|---|
| Comptes et équipe | **Comptes avec mot de passe** (scrypt), sessions en cookie `HttpOnly` + anti-CSRF, trois rôles (lecteur, membre, administrateur), jetons d'API pour la CLI |
| Projet → environnements → services | **Mêmes trois étages** : un projet a « production » et ce qu'on veut à côté ; un environnement se **duplique** (services et variables recopiés, bases vides et identifiants neufs) |
| Déploiement à chaque push | Webhook GitHub signé, une branche suivie par service, **chemins surveillés** pour un monodépôt |
| Dépôt choisi dans une liste | **Idem** : on relie un jeton GitHub, Rail liste les dépôts et les branches, devine le nom, installe le webhook et déploie |
| Déployer une image Docker | **Idem** : un service peut partir d'une image publique au lieu d'un dépôt |
| Templates (déploiement en un clic) | **14 modèles** : n8n, Ghost, WordPress, Metabase, Umami, Uptime Kuma, Gitea, MinIO, Vaultwarden, NocoDB, Grafana, Directus, Mailpit, Excalidraw — services créés, secrets engendrés, variables câblées, déploiement lancé |
| Nixpacks / Dockerfile | `Dockerfile` du dépôt, sinon construction automatique **Node, Python, Go, Java** (+ `Procfile`), avec **commandes de construction et de démarrage** réglables |
| Variables d'environnement | Variables chiffrées au repos (AES-256-GCM), **variables partagées par environnement**, `PORT` et `RAIL_*` injectées, collage d'un `.env` entier |
| Références `${{Postgres.DATABASE_URL}}` | **Mêmes références** : `${{ma-base.DATABASE_URL}}`, résolues au déploiement, dans le même environnement |
| Bases managées (plugins) | **9 moteurs** : PostgreSQL, MySQL, MariaDB, Redis, Valkey, MongoDB, ClickHouse, Meilisearch, RabbitMQ — identifiants engendrés, volume persistant |
| Onglet *Data* (requêter la base) | **Console SQL** dans le navigateur et en CLI : liste des tables, résultats en tableau, export CSV, lecture seule par défaut |
| Sauvegardes de base | **Manuelles ou planifiées** (expression cron), gardées sur le serveur, listées, téléchargeables, **restaurables en un clic**, élaguées automatiquement |
| TCP proxy (joindre une base de l'extérieur) | **Exposition TCP** en un clic : un port de la plage `RAIL_TCP_PORTS` publié sur la machine |
| Cron jobs | **Tâches planifiées** : une image ou un dépôt, une expression cron, un historique des exécutions avec code de sortie et sortie complète |
| — (Railway ne voit que ses services) | **Tous les conteneurs de la machine** : ceux de Rail et les autres (piles compose, services installés à la main), mesurés, journalisés, redémarrables |
| Volumes | Volume persistant par service (point de montage libre, propriétaire réglable pour les images qui ne tournent pas en root) |
| Domaine `*.up.railway.app` + domaine perso | `<service>-<projet>.<votre domaine>` (et `-<environnement>` hors production) + domaines personnalisés, HTTPS Let's Encrypt automatique |
| Healthcheck, déploiement sans coupure | L'ancien conteneur ne s'arrête qu'**après** que le nouveau répond et que la route a basculé |
| Rollback | Remet l'image d'un déploiement passé, **sans reconstruire** |
| Métriques (CPU, RAM, réseau) | **Mêmes mesures**, relevées toutes les 15 s, gardées 3 jours, avec disponibilité et redémarrages |
| Logs de build et d'exécution | Les deux, en direct, filtrables et téléchargeables |
| Observability / alertes | Fil d'activité **signé du compte qui a agi** + webhook d'alerte (Slack, Discord, le vôtre) sur panne, échec de déploiement, échec de tâche et de sauvegarde |
| Arrêt / démarrage / redémarrage d'un service | Les trois, sans reconstruire |
| Réseau privé `*.railway.internal` | `<service>.<projet>.internal` entre vos services |
| Statut de déploiement dans GitHub | Statut de commit `rail/deploy` (en cours / succès / échec) |
| Tableau de bord, CLI, API | Tableau de bord web, `rail` (CLI), API JSON |

Ce que Rail **ne fait pas** (volontairement) : plusieurs serveurs, réplicas et mise à
l'échelle horizontale, environnements de prévisualisation par pull request.
Voir [Limites](#limites).

## Comment ça marche

```
 git push ──▶ GitHub ──webhook signé (HMAC)──▶ https://rail.<domaine>/webhooks/github/<service>
                                                          │
                                 ┌────────────────────────▼─────────────────────────┐
  Internet :443 ─▶ Traefik ──────┤ plan de contrôle « rail-control » (Node, SQLite)  │
        ▲  (TLS Let's Encrypt)   │  1. git fetch du commit exact (jeton hors argv)   │
        │                        │  2. Dockerfile du dépôt, sinon généré             │
        │ lit les fichiers       │  3. docker build  →  image rail/<service>:<n>     │
        │ de route               │  4. docker run (durci, limites CPU/mémoire)       │
        │                        │  5. attend la santé (GET /health ou TCP)          │
  /data/traefik/dynamic/*.yml ◀──┤  6. écrit la route  →  7. arrête l'ancien         │
                                 │                                                   │
                                 │  toutes les 15 s : docker stats + inspect         │
                                 │   → séries CPU/mémoire/réseau, état, disponibilité│
                                 │   → fil d'activité, alertes, relance d'un tombé   │
                                 │  toutes les 30 s : l'heure                        │
                                 │   → tâches planifiées, sauvegardes automatiques   │
                                 └───────────────────────────┬──────────────────────┘
                                                             │ socket docker
                              conteneurs de vos API et de vos bases, réseau « rail »
                                     (les bases : volume persistant, jamais publiées)
```

- **Traefik n'a pas accès au socket Docker.** Il lit seulement des fichiers de route que le
  plan de contrôle écrit de façon atomique ; basculer le trafic, c'est réécrire un fichier.
- **Le plan de contrôle** (`src/`) est du Node 22 **sans aucune dépendance npm** : `node:sqlite`,
  `node:http`, `node:crypto`, et les CLI `git` et `docker`. Rien à `npm install`, rien à auditer en dehors du dépôt.
- **Un déploiement à la fois par service** — arrêts, démarrages et redémarrages passent par la
  même file : jamais deux opérations concurrentes sur un même service. Au plus `RAIL_MAX_BUILDS`
  constructions en parallèle sur la machine.

## Installer

Prérequis : un serveur Debian/Ubuntu avec **Docker Engine + Compose v2**, les ports **80 et 443 libres**,
et un domaine dont vous gérez le DNS.

1. **DNS** — deux enregistrements vers l'IP du serveur :
   `*.apps.exemple.com` (les services) et `rail.apps.exemple.com` (le tableau de bord ; couvert par le joker).
2. **Installation** (déroulé complet, pas à pas, sur le serveur : **[DEPLOIEMENT.md](DEPLOIEMENT.md)**) :
   ```bash
   git clone https://github.com/EntrepriseTools/Infra-server && cd Infra-server/paas
   sudo ./install.sh          # demande le domaine et le courriel Let's Encrypt, fabrique .env, lance tout
   ```
   Le script demande le domaine, le courriel Let's Encrypt, puis **l'identifiant et le mot de
   passe du compte administrateur** (il en tire un au sort si on n'en propose pas). Il affiche
   l'adresse du tableau de bord, ces identifiants, et le **jeton d'administration** (la clé de
   secours : API, CLI, et création d'un premier compte si besoin).
   **Sauvegardez `.env`** : sans `RAIL_SECRET_KEY`, les variables chiffrées sont perdues.
3. Ouvrez `https://rail.apps.exemple.com` et connectez-vous avec cet identifiant et ce mot de passe.

### Les ports 80 et 443 sont déjà pris ?

C'est le cas si le serveur fait déjà tourner nginx (voie `infra`, voir le README à la racine). Rail ne force rien :
il s'arrête et propose trois chemins, selon qui doit faire le HTTPS.

| Mode | Qui fait le HTTPS | Ports pris par Rail | Quand |
|---|---|---|---|
| `acme` (défaut) | Rail, Let's Encrypt par défi HTTP-01 | **80 et 443** obligatoirement | le serveur est à lui |
| `proxy` | votre nginx, devant | un seul port en clair (ex. **8080**) | nginx reste maître du 80/443 |
| `dns` | Rail, Let's Encrypt par défi DNS-01 | ceux que vous voulez (ex. 8080/8443) | pas de proxy devant, mais le 80 n'est pas libre |

```bash
# nginx garde le 443 et transmet à Rail (le script affiche le bloc nginx à copier)
sudo RAIL_TLS=proxy RAIL_HTTP_PORT=8080 ./install.sh

# des ports à soi, certificat obtenu par le DNS (identifiants dans paas/.env.dns)
sudo RAIL_TLS=dns RAIL_HTTP_PORT=8080 RAIL_HTTPS_PORT=8443 RAIL_ACME_DNS_PROVIDER=cloudflare ./install.sh

# ou une IP rien qu'à lui, sur les ports standards
sudo RAIL_BIND=203.0.113.10 ./install.sh
```

Le défi **HTTP-01 exige le port 80 public** : c'est pourquoi des ports exotiques imposent `proxy` ou `dns`.
En mode `proxy`, Rail n'écoute qu'en clair sur `127.0.0.1`-ou-l'IP choisie, ne demande aucun certificat, et les
adresses affichées restent celles que votre nginx publie (`RAIL_SITE_SCHEME`, `RAIL_SITE_PORT` si besoin).
Votre nginx doit transmettre `Host`, `X-Forwarded-Proto`, et laisser passer les réponses longues (journaux en direct).

Toute la configuration statique de Traefik est **engendrée par `install.sh`** dans `paas/traefik.local.yml`
(d'après `traefik.exemple.yml`) : on peut la lire, et elle est réécrite à chaque passage du script.

**Mise à jour** : `git pull && sudo ./install.sh`. Le catalogue SQLite se met à niveau tout seul au
démarrage (migrations numérotées) ; vos conteneurs ne sont pas touchés.

## Comptes, rôles et jetons

On entre dans Rail avec un **identifiant et un mot de passe**. Le mot de passe est haché
(scrypt, sel propre à chacun) ; la session est un **cookie `HttpOnly` + `SameSite=Lax`**
(12 h, `RAIL_SESSION_HOURS`), et toute écriture venue du navigateur porte en plus
**l'anti-CSRF** de la session : un autre site ne peut rien déclencher à votre place.

| Rôle | Ce qu'il peut |
|---|---|
| **Lecteur** | tout voir : services, mesures, journaux, activité, tables d'une base. Rien changer. |
| **Membre** | tout ce qui précède, plus : créer des projets et des services, déployer, arrêter, régler les variables, requêter et sauvegarder les bases. |
| **Administrateur** | tout ce qui précède, plus : les **comptes** et la **machine** (nettoyage des images, jeton GitHub partagé). |

- **Page Comptes** (administrateur) : créer un compte, changer un rôle, remettre un mot de
  passe à zéro (les sessions de la personne se ferment aussitôt). Le **dernier administrateur**
  ne peut être ni rétrogradé ni supprimé, et personne ne supprime son propre compte.
- **Page Mon compte** : changer son mot de passe (ce qui ferme les autres sessions), voir et
  fermer ses sessions ouvertes, relier son **compte GitHub**, fabriquer des **jetons d'API**.
- **Jetons d'API** (`rail_…`) : pour la CLI et les scripts. Ils valent le rôle de leur
  propriétaire, ne sont affichés **qu'une fois**, et seule leur empreinte SHA-256 est gardée.
- **`RAIL_ADMIN_TOKEN`** reste la **clé de secours** de l'installation : il vaut administrateur,
  crée le premier compte si la base est vide, et sert à la CLI quand on n'a pas encore de jeton.
  Qui l'a est root sur le serveur (voir [Sécurité](#sécurité--ce-quil-faut-savoir)).

```bash
rail whoami                                        # qui je suis, avec quel rôle
rail users                                         # les comptes (administrateur)
rail user:new marie --password '…' --role member
rail token:new mon-portable                        # un jeton d'API, affiché une fois
```

## Premier déploiement

Dans le tableau de bord : **Nouveau projet** → **+ Service**. Deux onglets :

- **Dépôt GitHub** — reliez votre compte GitHub (un jeton collé une fois, voir plus bas) et
  **choisissez un dépôt dans la liste** : Rail devine le nom du service, propose les branches du
  dépôt, et, à la création, **installe le webhook** puis **lance le premier déploiement**.
- **Image Docker** — une image publique (`nginx:1.27-alpine`, `ghcr.io/org/app:1.0`), son port,
  un volume si besoin : rien à construire, l'image est récupérée et démarrée.

Ou en CLI :

```bash
export RAIL_URL=https://rail.apps.exemple.com RAIL_TOKEN=…   # jeton d'API ou jeton d'administration
rail project:new demo
rail service:new demo api acme/mon-api --port 8080 --health /health --deploy
rail image:new demo vitrine nginx:1.27-alpine --port 80      # depuis une image
rail vars:set demo/api JWT_SECRET=…
rail deploy demo/api
rail logs demo/api --build -f       # la construction en direct
rail logs demo/api -f               # l'API en marche
rail status                         # le serveur et tous les services, d'un coup d'œil
rail containers                     # tout ce que Docker fait tourner sur la machine
```

L'API répond sur `https://api-demo.apps.exemple.com`. (La CLI : `paas/bin/rail.js`, à lier ou copier dans votre `PATH`.)

### Modèles : une pile entière en un clic

Page **Catalogue** (ou `rail templates`) : 14 piles prêtes à l'emploi. Un clic crée les services
(application **et** base), engendre les secrets, câble les variables entre eux, puis déploie.

| Modèle | Ce que c'est | Services |
|---|---|---|
| **n8n** | automatisation entre vos outils, sans code | n8n + PostgreSQL |
| **Ghost** | blog et infolettre | ghost + MySQL |
| **WordPress** | le site le plus répandu | wordpress + MariaDB |
| **Metabase** | questions et tableaux de bord sur vos bases | metabase + PostgreSQL |
| **Umami** | mesure d'audience sans cookie | umami + PostgreSQL |
| **Uptime Kuma** | surveillance de sites et alertes | uptime |
| **Gitea** | votre forge Git | gitea + PostgreSQL |
| **MinIO** | stockage de fichiers compatible S3 | minio |
| **Vaultwarden** | coffre à mots de passe (Bitwarden) | vaultwarden |
| **NocoDB** | un tableur qui est une vraie base | nocodb + PostgreSQL |
| **Grafana** | tableaux de bord de mesures | grafana |
| **Directus** | CMS « headless » et API sur une base | directus + PostgreSQL |
| **Mailpit** | boîte aux lettres d'essai (SMTP qui n'envoie rien) | mailpit |
| **Excalidraw** | tableau blanc à main levée | excalidraw |

```bash
rail templates                                  # le catalogue
rail template demo n8n                          # déployer dans demo/production
rail template demo ghost --prefix blog          # deux fois le même modèle dans un projet
```

Les versions d'images sont volontairement peu précises (majeure, ou `latest`) pour survivre au
temps : chaque service garde son image **modifiable dans ses réglages**, et épingler une version
est à un champ de distance. Un modèle n'est qu'un point de départ : après coup, ce sont des
services ordinaires (variables, domaines, sauvegardes, mesures).

### Déployer à chaque push

Réglages du service → **Installer le webhook** (nécessite un jeton GitHub avec **Webhooks : écriture**), ou à la main :
*dépôt GitHub → Settings → Webhooks → Add* avec l'URL et le secret affichés, type `application/json`, événement `push`.
Rail vérifie la signature HMAC-SHA256 sur le corps brut, ignore les autres branches et les autres événements, et
déploie **le commit exact poussé** (pas la pointe de la branche, qui peut avoir avancé).

### Jetons GitHub

Un dépôt public n'en demande aucun pour être construit. Pour **lister vos dépôts**, et pour un dépôt privé, créez un
**jeton à portée limitée** (*fine-grained*) : `Contents: read`, plus `Webhooks: write` pour l'installation automatique,
plus `Commit statuses: write` pour le statut `rail/deploy`.

Trois endroits où le poser, du plus précis au plus large — Rail prend le premier qui existe :

| Où | Pour qui | Quand |
|---|---|---|
| *Mon compte → Compte GitHub* | vous seul | le cas normal : chacun relie le sien |
| *Mon compte → « partager avec toute la plateforme »* (administrateur) | tout le monde | les dépôts d'une organisation, un jeton de service |
| `GITHUB_TOKEN` dans `.env` | tout le monde | dernier recours, hérité d'avant les comptes |
| *Réglages d'un service → Jeton GitHub du service* | ce service | un dépôt qui demande un autre accès |

Tous sont chiffrés au repos, jamais renvoyés par l'API, jamais écrits dans les journaux.

## Environnements

Un projet a toujours **« production »**. On peut en ajouter d'autres (« preprod », « demo »,
le nom d'un client) : **page du projet → + Environnement**. Le même service y porte le même
nom, et tout est séparé.

| | production | un autre environnement (« preprod ») |
|---|---|---|
| Adresse publique | `api-demo.apps.exemple.com` | `api-demo-preprod.apps.exemple.com` |
| Réseau privé | `api.demo.internal` | `api.demo-preprod.internal` |
| Variables, bases, volumes | les leurs | les leurs |
| Références `${{base.DATABASE_URL}}` | résolues **dans** production | résolues **dans** preprod |

**Dupliquer** un environnement recrée la *description* de ses services (dépôt, branche, image,
variables, domaines, planifications) — pas leurs données : les bases repartent vides avec des
**identifiants neufs**, et rien n'est déployé tant qu'on ne le demande pas. C'est le geste
« je veux la même chose, pour essayer ».

**Variables partagées** : page du projet → *Variables partagées*. Elles sont fournies à **tous**
les services de l'environnement ; une variable du service, de même nom, l'emporte. L'onglet
*Variables* d'un service montre les deux listes.

```bash
rail envs demo                                  # les environnements d'un projet
rail env:new demo preprod --copy production     # dupliquer
rail env:vars:set demo/preprod ZONE=bac-a-sable # variables partagées
rail service demo/preprod/api                   # « projet/env/service » désigne un service
rail env:rm demo/preprod                        # avec ses services et ses volumes
```

## Bases de données

**+ Base de données** dans un projet, ou `rail db:new demo base --engine postgres`.

| Moteur | Image | Port | Volume | Console SQL | Sauvegarde / restauration |
|---|---|---|---|---|---|
| PostgreSQL 16 | `postgres:16-alpine` | 5432 | `/var/lib/postgresql/data` | oui | `pg_dump` / `psql` |
| MySQL 8 | `mysql:8` | 3306 | `/var/lib/mysql` | oui | `mysqldump` / `mysql` |
| MariaDB 11 | `mariadb:11` | 3306 | `/var/lib/mysql` | oui | `mariadb-dump` / `mariadb` |
| Redis 7 | `redis:7-alpine` | 6379 | `/data` (AOF) | — | — (copiez le volume) |
| Valkey 8 | `valkey/valkey:8-alpine` | 6379 | `/data` (AOF) | — | — (copiez le volume) |
| MongoDB 7 | `mongo:7` | 27017 | `/data/db` | — | `mongodump` / `mongorestore` |
| ClickHouse 24 | `clickhouse/clickhouse-server:24.8-alpine` | 8123 | `/var/lib/clickhouse` | oui | — (copiez le volume) |
| Meilisearch 1.11 | `getmeili/meilisearch:v1.11` | 7700 | `/meili_data` | — | — (copiez le volume) |
| RabbitMQ 4 | `rabbitmq:4-alpine` | 5672 | `/var/lib/rabbitmq` | — | — (copiez le volume) |

Rail engendre les identifiants, crée le volume, démarre le conteneur et attend qu'il accepte les
connexions. Par défaut la base **n'est pas publiée sur Internet** : ni domaine, ni port ouvert. On
l'atteint par le réseau privé, à `<nom>.<projet>.internal:<port>` — et, si on le demande
explicitement, par [exposition TCP](#joindre-une-base-depuis-lextérieur-exposition-tcp).

**Brancher une API dessus** — onglet *Variables* du service, puis une référence :

```
DATABASE_URL = ${{base.DATABASE_URL}}
```

La valeur est résolue **au déploiement**, dans le projet du service : aucun mot de passe recopié à la
main, et changer la base suffit à changer tout le monde. Les clés disponibles sont listées dans
l'onglet *Connexion* de la base (`DATABASE_URL`, `PGHOST`, `REDIS_URL`…), avec un bouton « Copier la référence ».
Une référence qui ne se résout pas reste telle quelle et laisse un avertissement dans le journal du déploiement.

### Requêter la base (console SQL)

Onglet **Requêtes** d'une base PostgreSQL ou MySQL : la liste des tables à gauche (un clic ouvre
les 100 premières lignes), l'éditeur au milieu, le résultat en tableau — exportable en CSV.
`Ctrl`/`⌘` + `Entrée` exécute. En ligne de commande :

```bash
rail tables demo/base                                   # tables et tailles
rail sql demo/base "SELECT count(*) FROM clients"       # lecture seule par défaut
rail sql demo/base "DELETE FROM sessions WHERE expire < now()" --write
rail sql demo/base < migration.sql --write              # la requête peut venir d'un fichier
```

Ce que la console garantit :

| Garde-fou | Pourquoi |
|---|---|
| **Lecture seule par défaut** (case à cocher, `--write` en CLI) | une requête d'exploration ne peut rien casser : la transaction est ouverte en lecture seule côté moteur |
| **Minuterie de 30 s** (`statement_timeout`) | une requête oubliée ne bloque pas la base |
| **La requête passe par l'entrée standard** du client (`psql -f -`) | elle n'apparaît ni dans les arguments de la commande, ni dans le `ps` de l'hôte |
| **2 000 lignes affichées au plus** | le navigateur ne se fige pas sur un `SELECT *` d'une grosse table |
| **Toute écriture est inscrite dans l'activité** | on sait qui a changé quoi, et quand |
| Confirmation avant `DROP`, `DELETE`, `TRUNCATE`, `ALTER`… | le geste dangereux demande un second clic |

La console parle au client officiel du moteur (`psql`, `mysql`) **dans le conteneur de la base** :
aucun pilote SQL n'est embarqué dans le plan de contrôle, et la base reste fermée à Internet.
Redis et MongoDB n'ont pas de console (ils ne parlent pas SQL) : utilisez
`docker exec -it <conteneur> redis-cli -u "$REDIS_URL"`, affiché dans l'onglet *Connexion*.

### Joindre une base depuis l'extérieur (exposition TCP)

*Réglages de la base → Exposition TCP → Exposer* publie son port sur la machine, dans la plage
`RAIL_TCP_PORTS` (20000-20050 par défaut) — de quoi brancher `psql`, un client graphique ou un
service extérieur. Le port s'ouvre **au redéploiement suivant**, et l'adresse à donner est affichée.

```bash
rail expose demo/base              # un port libre de la plage
rail expose demo/base --port 20010 # ou celui-là
rail redeploy demo/base            # c'est le redéploiement qui ouvre le port
rail unexpose demo/base
```

Rien n'est exposé sans ce geste. Deux précautions : **ouvrez le port dans le pare-feu** du serveur
seulement si l'accès doit venir d'Internet (sinon `RAIL_TCP_BIND=127.0.0.1` + un tunnel SSH), et
rappelez-vous que la base devient alors joignable par qui a le mot de passe.

### Sauvegardes d'une base

Onglet **Sauvegardes** d'une base : une sauvegarde maintenant, une **planification** (expression
cron), le nombre de sauvegardes à garder, et pour chacune : télécharger, **restaurer**, supprimer.
Les fichiers vivent dans `/data/backups/<service>/` du volume de Rail (donc dans l'archive de
`sauvegarde.sh`), et les plus vieilles sont élaguées automatiquement.

```bash
rail backup demo/base > dump.sql        # un export en flux, rien n'est gardé sur le serveur
rail backup:new demo/base               # une sauvegarde gardée sur le serveur
rail backups demo/base                  # la liste, avec tailles et origines
rail backup:get <id> > dump.sql         # télécharger une sauvegarde gardée
rail backup:restore <id>                # ÉCRASE les données actuelles
rail backup:auto demo/base "0 3 * * *" --keep 14
```

Une sauvegarde en échec est **inscrite en échec, avec sa raison**, et déclenche une alerte : c'est la
seule façon de s'apercevoir qu'elle ne marchait plus. Restaurer écrase les données actuelles —
l'interface fait confirmer, et l'activité garde la trace. C'est un export **logique** (il se restaure
dans une autre version du moteur, ailleurs) ; pour l'image complète du serveur, voir
[Sauvegardes](#sauvegardes).

> **Attention aux volumes.** Un service avec volume ne peut pas tourner en double : au redéploiement,
> l'ancien conteneur est arrêté **avant** le démarrage du nouveau (quelques secondes d'interruption).
> Si le nouveau n'est pas sain, l'ancien est remis en marche. Supprimer le service supprime le volume
> et ses données (`DELETE …?keep_volume=1` pour le garder).

## Tâches planifiées (cron)

**+ Tâche planifiée** dans un projet : une image ou un dépôt, une commande, et une **expression
cron** à cinq champs (`minute heure jour mois jour-semaine`, ou `@daily`). Rail construit (ou
récupère) l'image **une fois**, puis lance un conteneur **jetable** (`--rm`) à l'heure dite.

```
0 3 * * *     chaque nuit à 3 h          */15 * * * *   tous les quarts d'heure
30 6 * * 1-5  en semaine à 6 h 30        0 5 1 * *      le 1er du mois à 5 h
```

Une tâche n'a ni domaine, ni conteneur permanent : son onglet **Exécutions** garde l'historique
(début, durée, **code de sortie**, sortie complète), et le bouton *Exécuter maintenant* ne dépend
pas de la planification. Une exécution qui sort en erreur est un échec visible, et une alerte part.
L'heure est celle du serveur (UTC dans un conteneur par défaut) ; une tâche **suspendue** ne part plus.

```bash
rail job:new demo menage --schedule "0 3 * * *" --image alpine:3 --start "sh /nettoie.sh"
rail job:new demo rapports --schedule "@daily" acme/mon-api --start "node scripts/rapport.js"
rail run demo/menage      # tout de suite
rail runs demo/menage     # l'historique, et la prochaine exécution
```

Deux garde-fous : jamais deux exécutions en parallèle pour une même tâche, et jamais deux fois la
même minute (même si l'horloge tourne plus souvent) — y compris après un redémarrage du plan de
contrôle, qui marque en échec ce qui avait été coupé en vol.

## Surveiller

Le plan de contrôle interroge Docker **toutes les 15 secondes** (`RAIL_METRICS_INTERVAL_S`) et garde
**72 heures** d'historique (`RAIL_METRICS_RETENTION_H`) dans le même SQLite.

- **Aperçu d'un service** : état (en ligne, dégradé, arrêté, planté), disponibilité sur la fenêtre,
  redémarrages, processeur, mémoire, réseau entrant/sortant, le déploiement en service, l'activité du service.
  Fenêtres : 15 min, 1 h, 6 h, 24 h, 7 j.
- **Page Système** : processeur, mémoire et disque du serveur, place prise par Docker (images,
  conteneurs, volumes, cache de construction), bouton de nettoyage des images orphelines, versions.
- **Activité** : déploiements, arrêts, redémarrages, pannes détectées, sauvegardes — filtrable.
- **Logs** : construction (en direct, par déploiement) et exécution (en direct, filtrable, téléchargeable).
  Les journaux de vos conteneurs sont **tournés** (10 Mo × 3 par défaut) : un service bavard ne remplit plus le disque.

**Un conteneur qui tombe** est repéré au tick suivant : un événement, une alerte, et une relance
automatique (`RAIL_AUTO_HEAL=non` pour seulement alerter). Un service dont le contrôle de santé échoue
alors que le conteneur tourne est marqué **dégradé** — signalé, jamais redémarré en boucle.

**Alertes** : renseignez `RAIL_NOTIFY_URL` dans `.env` (une URL de webhook Slack, Discord, ou la vôtre).
Rail y poste un JSON qui contient `text` (Slack), `content` (Discord) et les champs structurés ;
les pannes et les échecs de déploiement partent toujours, les succès seulement si `RAIL_NOTIFY_SUCCESS=oui`.

## Tous les conteneurs de la machine

Un serveur porte rarement Rail et rien d'autre. La page **Conteneurs** liste **tout** ce que Docker
fait tourner sur la machine : les conteneurs de Rail (reliés à leur service) et les autres — pile
`docker compose` installée avant, base montée à la main, outil maison.

Pour chacun : état, image, processeur, mémoire, ports publiés, origine. Pour ceux que Rail n'a pas
déployés : le **journal en direct**, les **mesures** (elles sont relevées et gardées comme celles des
services) et les gestes **redémarrer / arrêter / démarrer**.

```bash
rail containers                 # tout ce qui tourne, Rail ou non
rail containers --all           # y compris les conteneurs arrêtés
rail container:logs nginx-maison -f
rail container:restart nginx-maison
```

Ce que Rail ne fait **pas** sur ces conteneurs : il ne les redéploie pas, ne change pas leur
configuration et ne les supprime pas — ils appartiennent à qui les a créés. Deux refus volontaires :
un conteneur **géré par Rail** se pilote depuis son service (pour que l'état voulu et la route
suivent), et le conteneur du **plan de contrôle** ne peut pas s'arrêter lui-même depuis sa propre
interface (`docker compose restart control`, sur le serveur).

> Traefik apparaît comme un conteneur ordinaire : le redémarrer coupe le trafic quelques secondes,
> l'arrêter coupe tout, tableau de bord compris. À faire en connaissance de cause.

## Marche, arrêt, redémarrage

| Geste | Ce qui se passe | Ce qui ne se passe pas |
|---|---|---|
| **Redémarrer** | `docker restart` du conteneur en service | aucune reconstruction, aucun nouveau déploiement |
| **Arrêter** | le conteneur est stoppé et la route retirée (404) ; l'état voulu devient « arrêté » | rien n'est supprimé : image, volume et variables restent |
| **Démarrer** | le conteneur repart et la route revient ; s'il a disparu, l'image est relancée | aucune reconstruction |
| **Redéployer** | relance l'image en service avec la configuration actuelle | aucune reconstruction |
| **Déployer** | reconstruit depuis le dépôt (ou récupère l'image) | — |
| **Suspendre** (tâche planifiée) | les exécutions planifiées ne partent plus | l'historique et l'image restent |
| **Exécuter maintenant** (tâche planifiée) | un conteneur jetable, tout de suite | la planification n'est pas touchée |

Un service arrêté le reste après un redémarrage du plan de contrôle ; un conteneur resté sur le carreau
après un reboot de la machine est relancé et re-routé automatiquement.

## Ce que Rail construit

1. Le **`Dockerfile`** du dépôt (ou du dossier racine du service, ou le chemin indiqué dans les réglages).
2. Sinon, un Dockerfile **engendré** d'après les fichiers :

| Détecté | Construction | Démarrage |
|---|---|---|
| `package.json` | image `node:<engines.node>-slim` ; npm / pnpm / yarn d'après le lockfile ; `build` si présent ; dépendances de dev retirées | `Procfile` `web:`, sinon `npm start`, sinon `main` |
| `go.mod` | `golang:<version du go.mod>`, `CGO_ENABLED=0`, binaire à la racine ou dans `cmd/<un seul>` | le binaire, ou `Procfile` |
| `pom.xml`, `build.gradle(.kts)` | JDK d'après `java.version`, `mvnw`/`gradlew` si présents, tests sautés ; JRE à l'exécution | `java $JAVA_OPTS -Dserver.port=$PORT -jar` (Spring Boot), ou `Procfile` |
| `requirements.txt` / `pyproject.toml` | `python:3.x-slim`, `pip install` | `Procfile`, sinon `main.py`/`app.py`/`server.py` |

Tout est exécuté **sans privilèges** (utilisateur non-root). Un langage non reconnu donne une erreur qui dit quoi faire.

**Votre API doit écouter sur `$PORT`** (injecté, égal au « port » du service) sur `0.0.0.0`.

## Variables, domaines, réseau privé

- **Variables** : onglet *Variables* ou `rail vars:set`. Elles s'appliquent au **prochain déploiement** — « Enregistrer et
  redéployer » relance l'image en service avec la nouvelle configuration, **sans reconstruire**. `PORT`, `PATH`, `HOME`, `LD_*`,
  `DOCKER_*`, `RAIL_*` sont réservés. Fournies à l'application : `RAIL_PROJECT_NAME`, `RAIL_ENVIRONMENT_NAME`,
  `RAIL_SERVICE_NAME`, `RAIL_SERVICE_ID`, `RAIL_GIT_COMMIT_SHA`, `RAIL_DEPLOYMENT_ID`, `RAIL_PUBLIC_DOMAIN`, `RAIL_PRIVATE_DOMAIN`.
  Un bouton **« Coller un .env »** ajoute tout un fichier d'un coup. `rail vars demo/api --resolved` montre ce que le
  conteneur recevra vraiment (partagées comprises, références résolues).
- **Variables partagées** : page du projet, par environnement. Celles du service l'emportent.
- **Références** : `${{autre-service.CLE}}` dans n'importe quelle valeur (voir [Bases de données](#bases-de-données)).
- **Domaine personnalisé** : enregistrement DNS A vers le serveur, *Domaines → Ajouter*, *Redéployer*. Le certificat est
  demandé automatiquement au premier accès.
- **Entre services** : `http://<service>.<projet>.internal:<port>` (sans HTTPS, sans passer par Internet).
- **PostgreSQL de l'hôte** (plutôt qu'une base managée) : depuis un conteneur, l'hôte s'appelle `host.docker.internal`.
  PostgreSQL doit écouter sur l'adresse du pont Docker et son `pg_hba.conf` l'autoriser — ne l'ouvrez jamais à Internet.
- **Volume persistant** sur un service ordinaire : *Réglages → Volume persistant*, un chemin absolu (`/data`). Pour une
  image qui ne tourne pas en root (Grafana 472, Gitea ou n8n 1000), renseignez le **propriétaire du volume** : Rail le
  prépare avec le bon utilisateur à la création.
- **Monodépôt** : *Réglages → Chemins surveillés* (`services/api, paquets/commun`). Un push qui ne touche aucun de ces
  chemins ne déclenche aucune construction — et l'activité dit pourquoi.
- **Commandes** : *Réglages → Commande de construction / de démarrage*, pour les dépôts sans `Dockerfile` (un dépôt qui a
  son `Dockerfile` garde le sien, et Rail le dit dans le journal).

## Déploiement sans coupure, retour arrière

Ordre exact d'un déploiement : le nouveau conteneur démarre **à côté** de l'ancien → Rail attend qu'il réponde
(`GET <chemin de santé>` en 2xx/3xx, ou une connexion TCP si aucun chemin n'est donné ; `RAIL_HEALTH_TIMEOUT_S`, 120 s) →
**la route bascule** → 3 s plus tard (`RAIL_SWITCH_GRACE_MS`) l'ancien reçoit SIGTERM (30 s pour finir ses requêtes).
S'il ne devient jamais sain, il est supprimé, ses 30 dernières lignes de logs sont copiées dans le journal du déploiement,
et **l'ancien continue de servir** : l'échec est visible mais jamais subi. (Avec un volume, voir l'exception plus haut.)

**Retour arrière** : *Déploiements → Revenir ici* (ou `rail rollback <id>`). Les images des `RAIL_KEEP_IMAGES` (5) derniers
déploiements sont conservées ; l'image est relancée telle quelle, en quelques secondes, avec les variables **actuelles**.
Attention : un retour arrière remet du code, pas un schéma de base de données.

## Sauvegardes

| Quoi | Comment | Quand |
|---|---|---|
| Une base, gardée sur le serveur | onglet *Sauvegardes* → *Sauvegarder maintenant*, ou `rail backup:new demo/base` | avant une migration |
| Une base, automatiquement | onglet *Sauvegardes* → une planification cron, ou `rail backup:auto demo/base "0 3 * * *"` | tous les jours, sans y penser |
| Une base, en flux vers chez vous | `rail backup demo/base > dump.sql` | pour emporter le dump ailleurs |
| Tout le serveur | `sudo ./sauvegarde.sh [dossier]` — `.env`, le catalogue SQLite, les journaux, les sauvegardes de bases, et **tous** les volumes | en cron, puis copié hors du serveur |

```bash
# tous les jours à 3 h 15, 14 jours de rétention (RETENTION_J pour changer)
15 3 * * *  cd /chemin/Infra-server/paas && ./sauvegarde.sh >> /var/log/rail-sauvegarde.log 2>&1
```

Le script met le plan de contrôle en pause quelques secondes (pour que SQLite soit cohérent) : **vos services ne
bougent pas**. Il affiche la procédure de restauration à la fin. Une sauvegarde qui reste sur le serveur ne sauve de
rien : copiez l'archive ailleurs.

## Sécurité — ce qu'il faut savoir

| Sujet | Position |
|---|---|
| **Socket Docker** | Le plan de contrôle y a accès : **qui contrôle Rail est root sur le serveur.** Le jeton d'administration doit être traité comme un accès root (long, jamais committé, `.env` en 0600). Le conteneur tourne en non-root, `no-new-privileges`, et Traefik, exposé à Internet, n'a pas le socket. |
| **Mots de passe** | Jamais stockés : seul le haché **scrypt** (coût 2^14, sel de 16 octets propre à chacun) entre en base. 10 caractères au moins, et les évidences refusées. Une connexion ratée coûte le même temps de calcul qu'une connexion à un compte inexistant : le délai de réponse ne dit pas si le compte existe. 10 essais par minute et par IP → 429. |
| **Sessions** | Un jeton de 32 octets dans un cookie `HttpOnly`, `SameSite=Lax`, `Secure` (hors mode `proxy` en clair) ; en base, seule son **empreinte SHA-256**. Toute écriture venue d'un cookie exige l'**anti-CSRF** de la session. Changer son mot de passe ferme les autres sessions ; un administrateur qui remet un mot de passe à zéro ferme celles de la personne. Durée 12 h par défaut. |
| **Rôles** | Chaque route demande un rang minimum (lecteur < membre < administrateur) : les comptes et la machine sont réservés aux administrateurs, les écritures aux membres. Un jeton d'API vaut le rôle de son propriétaire, jamais plus. |
| **Jeton d'admin** | Comparé en temps constant ; même limite d'essais. Il vaut un **accès root au serveur** : long, jamais committé, `.env` en 0600. Le tableau de bord applique une CSP stricte (`script-src 'self'`, `frame-ancestors 'none'`) : tout le code de la page vient de fichiers servis par Rail. Mettez le tableau de bord derrière un VPN ou une liste d'IP si possible. |
| **Activité** | Chaque événement porte **qui l'a demandé** (compte, jeton d'administration, GitHub, l'horloge) : connexions, créations, suppressions, écritures SQL, restaurations. L'histoire survit à la suppression d'un service. |
| **Webhook** | Seule route publique en écriture ; authentifiée par HMAC-SHA256 (secret propre à chaque service), 401 identique que le service existe ou non. |
| **Secrets** | Variables, identifiants de bases, jeton GitHub et secret de webhook chiffrés (AES-256-GCM) dans SQLite ; clé dans `.env`. Les variables passent au conteneur par l'environnement du client docker (`-e NOM`), **jamais dans les arguments** donc jamais dans `ps` — y compris le mot de passe d'un `mysqldump`. Le jeton GitHub passe à `git` par `GIT_CONFIG_*` et est masqué des journaux. |
| **Vos conteneurs** | `--cap-drop ALL` (+ `NET_BIND_SERVICE`), `no-new-privileges`, `--pids-limit 512`, journaux tournés, mémoire 512 Mo et 1 CPU par défaut (réglables). |
| **Conteneurs de bases** | Mêmes règles, plus cinq capacités que les images officielles exigent pour préparer leur volume puis redescendre vers leur utilisateur (`CHOWN`, `DAC_OVERRIDE`, `FOWNER`, `SETUID`, `SETGID`). C'est le strict nécessaire, et `no-new-privileges` tient toujours. |
| **Bases de données** | Aucun domaine, et **aucun port publié sans un geste explicite** (*Exposition TCP*, dans une plage réglée à l'avance) : sinon, seulement le réseau privé `rail`. Mots de passe engendrés (18 octets aléatoires), jamais affichés en clair dans l'interface sans un clic. |
| **Console SQL** | Réservée aux membres et plus, lecture seule par défaut, minuterie de 30 s, requête passée par l'entrée standard (jamais dans `ps`), toute écriture inscrite dans l'activité avec son auteur. Elle donne, de fait, un accès complet aux données de vos bases. |
| **Tâches planifiées** | Conteneur jetable, même durcissement que les services, minuterie (`RAIL_JOB_TIMEOUT_S`, 1 h), jamais deux en parallèle, sortie tronquée à 20 000 caractères en base. |
| **Jetons GitHub** | Chiffrés au repos, par compte (chacun le sien) ou partagés par un administrateur pour toute la plateforme. Jamais renvoyés par l'API, jamais écrits dans un journal (masqués à la source). |
| **Conteneurs hors Rail** | Rail peut les lire, les journaliser et les redémarrer (le jeton vaut déjà un accès root via le socket Docker). Il ne modifie jamais leur configuration, et refuse d'arrêter son propre conteneur. |
| **Entrées** | Noms, dépôts, branches, chemins, domaines, images, variables : validés par liste blanche avant de toucher une commande, un chemin ou une règle de routage ; aucun shell n'interprète rien (tableaux d'arguments partout). |
| **À savoir** | Le code construit est celui de **vos** dépôts : ne reliez pas de dépôt que vous ne maîtrisez pas (un `Dockerfile` s'exécute sur le serveur). Tous les services partagent le réseau `rail` : pas d'isolation réseau entre projets, donc une API d'un projet peut joindre la base d'un autre projet si elle en connaît le mot de passe. |

## Exploiter

```bash
cd Infra-server/paas
docker compose ps                    # état
docker compose logs -f control       # le plan de contrôle
docker compose logs -f traefik       # accès + certificats
git pull && sudo ./install.sh        # mise à jour (les services en cours ne sont pas touchés)
./sauvegarde.sh                      # archive complète
rail status                          # le serveur et les services, depuis n'importe où
```

- **Redémarrer le plan de contrôle ne coupe aucun service** : vos conteneurs sont indépendants (`--restart unless-stopped`)
  et Traefik garde ses routes. Au redémarrage, un déploiement en cours est marqué échoué, les routes sont réécrites depuis
  la base, et un conteneur arrêté par accident est relancé.
- **Tests** : `cd paas && npm test` (107 tests : un vrai dépôt git local, un faux Docker, de vraies requêtes HTTP — sans Docker).
  `./test/integration.sh` joue le tout contre un **vrai** Docker : construction de l'image, déploiement d'un vrai
  PostgreSQL, mesures, console SQL (lecture, écriture, refus en lecture seule), sauvegarde logique, inventaire des
  conteneurs, arrêt, redéploiement avec persistance des données, suppression. La CI joue les deux.
  Le tableau de bord se teste dans un vrai navigateur (facultatif, hors CI : il demande une dépendance) :
  `npm i --no-save playwright-core && CHROME=/usr/bin/google-chrome node test/navigateur.mjs --photos /tmp/rail` —
  26 gestes : se connecter, créer un projet, choisir un dépôt dans la liste, déployer une image, dupliquer un
  environnement, régler des variables, lire les journaux, requêter une base, sauvegarder, exécuter une tâche,
  déployer un modèle, fabriquer un jeton, créer un compte, vérifier qu'un **lecteur** ne peut rien changer, et
  qu'un téléphone ne déborde pas. Il échoue à la moindre erreur de console.

## Dépannage

| Symptôme | Cause probable |
|---|---|
| « Impossible de récupérer … » | dépôt privé sans jeton, jeton sans `Contents: read`, branche inexistante |
| « Langage non reconnu » | pas de `Dockerfile`/`package.json`/`go.mod`/… à la racine du service : régler *Dossier racine* |
| « pas de réponse saine après 120s » | l'API n'écoute pas sur `$PORT`/`0.0.0.0`, ou mauvais chemin de santé ; lire « derniers logs du conteneur » dans le journal |
| 404 sur l'adresse du service | aucun déploiement réussi, service **arrêté**, ou domaine ajouté sans *Redéployer* |
| Service « dégradé » | le conteneur tourne mais le chemin de santé ne répond plus en 2xx/3xx : regarder les logs d'exécution |
| Certificat invalide | le DNS ne pointe pas encore sur le serveur ; `docker compose logs traefik` (Let's Encrypt limite les essais) |
| « le port 80 est déjà utilisé » | un serveur web tient déjà la machine : voir [Les ports 80 et 443 sont déjà pris ?](#les-ports-80-et-443-sont-déjà-pris) |
| En mode `proxy`, 404 ou boucle de redirection | nginx ne transmet pas l'en-tête `Host`, ou vise le mauvais port (`RAIL_HTTP_PORT`) |
| En mode `dns`, pas de certificat | identifiants du fournisseur absents de `paas/.env.dns`, ou `RAIL_ACME_DNS_PROVIDER` faux ; `docker compose logs traefik` |
| Webhook en échec (401) | secret différent de celui du service : l'afficher dans *Réglages* |
| `permission denied` sur docker.sock | `DOCKER_GID` de `.env` ≠ groupe du socket : relancer `install.sh` |
| « référence non résolue » dans un journal | le service visé n'existe pas dans **ce** projet, ou la clé n'existe pas : voir l'onglet *Connexion* de la base |
| Pas de mesures | moins d'une minute d'historique, ou `docker stats` indisponible : `docker compose logs control` |
| « cannot execute INSERT in a read-only transaction » | la console SQL est en lecture seule : décochez la case (ou `--write`) |
| « pas de console SQL pour redis » | Redis et MongoDB ne parlent pas SQL : voir la commande `docker exec` de l'onglet *Connexion* |
| Un conteneur hors Rail n'apparaît pas | il est arrêté : cochez « tout » (`rail containers --all`) |
| Disque plein | *Système → Nettoyer les images orphelines*, puis vérifier les volumes des bases supprimées (`docker volume ls`) et les sauvegardes gardées (`rail backups …`) |
| « jeton anti-CSRF manquant » | la page a été laissée ouverte trop longtemps : rechargez-la (la session a changé) |
| « réservé au rôle … » | votre compte est lecteur, ou l'action demande un administrateur |
| « aucun jeton GitHub » | reliez votre compte dans *Mon compte → Compte GitHub* (ou demandez à un administrateur un jeton partagé) |
| Un modèle ne démarre pas | l'image demande souvent un volume à elle : vérifiez le **propriétaire du volume** dans ses réglages, et lisez ses logs d'exécution |
| Une tâche planifiée ne part pas | elle est suspendue, sa planification est invalide, ou l'heure du serveur n'est pas celle que vous croyez (UTC) |
| Le port exposé ne répond pas | il faut **redéployer** après *Exposer*, et ouvrir le port dans le pare-feu de la machine |

## Limites

Un seul serveur, un seul conteneur par service (pas de réplicas ni de mise à l'échelle horizontale), pas d'aperçu
par pull request, pas de variables disponibles **pendant** la construction (voir ci-dessous), pas de registre privé
pour les images (seulement des images publiques ; pour une image privée, construisez depuis le dépôt), certificats
par nom (pas de joker : Let's Encrypt limite le nombre de nouveaux certificats par domaine et par semaine), mesures
gardées 72 h par défaut (ce n'est pas un Prometheus), et pas d'isolation réseau entre projets (tous les services
partagent le réseau `rail`).

*Variables de construction* : volontairement absentes — un secret passé en `--build-arg` reste lisible dans l'historique de l'image.
Si une étape de build en a besoin, utilisez un `Dockerfile` avec des montages secrets BuildKit.

## Où est quoi

```
paas/
├─ src/          plan de contrôle
│   ├─ main.js       câblage et démarrage          config.js    toute la configuration
│   ├─ api.js        le serveur : routes, droits, fichiers du tableau de bord
│   ├─ api_platform.js  santé, vue d'ensemble, machine, conteneurs, activité
│   ├─ api_account.js   installation, connexion, comptes, jetons, GitHub
│   ├─ api_apps.js      projets, environnements, services, déploiements, modèles, webhook
│   ├─ api_data.js      bases managées, console SQL, sauvegardes
│   ├─ api_shared.js    la forme publique d'un service, les « ou 404 »
│   ├─ auth.js       qui parle, et avec quel droit  users.js     mots de passe, rôles, cookies
│   ├─ deployer.js   la file et le déploiement     monitor.js   relevés, états, réparation automatique
│   ├─ scheduler.js  l'horloge (cron, sauvegardes) backup.js    fabriquer, garder, restaurer
│   ├─ cron.js       les planifications            naming.js    les noms d'hôtes et de volumes
│   ├─ runtime.js    tout ce qui parle à Docker    databases.js catalogue des moteurs managés
│   ├─ templates.js  le catalogue en un clic       detect.js    construction sans Dockerfile
│   ├─ db.js         SQLite : catalogue, comptes, mesures, événements, migrations
│   ├─ sql.js        console SQL : lire le CSV de psql, le TSV de mysql
│   ├─ routes.js     fichiers de route Traefik     vars.js      références ${{service.CLE}}
│   ├─ crypto.js     secrets au repos              notify.js    alertes sortantes
│   ├─ github.js     dépôts, branches, webhooks    validate.js  listes blanches d'entrées
│   ├─ source.js     git fetch d'un commit précis  proc.js      lancer un programme sans shell
│   └─ logs.js       journaux de déploiement       http.js      routeur minimal
├─ web/          le tableau de bord (index.html, style.css, ui.js, app.js, views.js — aucune dépendance)
├─ bin/rail.js   la CLI
├─ test/         unitaires, comptes, fonctionnalités, déploiement, bases, surveillance, API/CLI,
│                navigateur.mjs (vrai navigateur) et integration.sh (vrai Docker)
├─ compose.yaml  Traefik + plan de contrôle        Dockerfile    image du plan de contrôle
├─ install.sh    installation idempotente          sauvegarde.sh archive complète
├─ traefik.exemple.yml  modèle de la configuration statique (install.sh engendre traefik.local.yml)
└─ .env.example  toute la configuration            DEPLOIEMENT.md  le déroulé, pas à pas, sur le serveur
```
