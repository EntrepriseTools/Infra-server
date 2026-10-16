# Rail — un Railway à vous : déployer, surveiller, exploiter

Rail est une plateforme de déploiement **auto-hébergée**. Vous reliez un dépôt
GitHub : chaque `git push` construit l'API, la démarre, vérifie qu'elle répond,
puis lui donne son adresse HTTPS — **sans coupure**, avec **retour arrière en un
clic**. À côté, vous ajoutez des **bases de données** en un clic, et vous **voyez
ce qui se passe** : processeur, mémoire, réseau, disponibilité, fil d'activité,
alertes. C'est le geste de Railway, sur votre serveur.

| Railway | Rail |
|---|---|
| Projet → services | Projet → services (une API = un service, une base = un service) |
| Déploiement à chaque push | Webhook GitHub signé, une branche suivie par service |
| Nixpacks / Dockerfile | `Dockerfile` du dépôt, sinon construction automatique **Node, Python, Go, Java** (+ `Procfile`) |
| Variables d'environnement | Variables chiffrées au repos (AES-256-GCM), `PORT` et `RAIL_*` injectées |
| Références `${{Postgres.DATABASE_URL}}` | **Mêmes références** : `${{ma-base.DATABASE_URL}}`, résolues au déploiement |
| Bases managées (plugins) | **PostgreSQL, MySQL, Redis, MongoDB** : identifiants engendrés, volume persistant, sauvegarde en un clic |
| Onglet *Data* (requêter la base) | **Console SQL** dans le navigateur et en CLI : liste des tables, résultats en tableau, export CSV, lecture seule par défaut |
| — (Railway ne voit que ses services) | **Tous les conteneurs de la machine** : ceux de Rail et les autres (piles compose, services installés à la main), mesurés, journalisés, redémarrables |
| Volumes | Volume persistant par service (point de montage libre) |
| Domaine `*.up.railway.app` + domaine perso | `<service>-<projet>.<votre domaine>` + domaines personnalisés, HTTPS Let's Encrypt automatique |
| Healthcheck, déploiement sans coupure | L'ancien conteneur ne s'arrête qu'**après** que le nouveau répond et que la route a basculé |
| Rollback | Remet l'image d'un déploiement passé, **sans reconstruire** |
| Métriques (CPU, RAM, réseau) | **Mêmes mesures**, relevées toutes les 15 s, gardées 3 jours, avec disponibilité et redémarrages |
| Logs de build et d'exécution | Les deux, en direct, filtrables et téléchargeables |
| Observability / alertes | Fil d'activité + **webhook d'alerte** (Slack, Discord, le vôtre) sur panne et échec |
| Arrêt / démarrage / redémarrage d'un service | Les trois, sans reconstruire |
| Réseau privé `*.railway.internal` | `<service>.<projet>.internal` entre vos services |
| Statut de déploiement dans GitHub | Statut de commit `rail/deploy` (en cours / succès / échec) |
| Tableau de bord, CLI, API | Tableau de bord web, `rail` (CLI), API JSON |

Ce que Rail **ne fait pas** (volontairement) : plusieurs serveurs, réplicas et
mise à l'échelle, environnements de prévisualisation par pull request, comptes
multiples. Voir [Limites](#limites).

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
2. **Installation** :
   ```bash
   git clone https://github.com/EntrepriseTools/Infra-server && cd Infra-server/paas
   sudo ./install.sh          # demande le domaine et le courriel Let's Encrypt, fabrique .env, lance tout
   ```
   Le script affiche l'adresse du tableau de bord et le **jeton d'administration**.
   **Sauvegardez `.env`** : sans `RAIL_SECRET_KEY`, les variables chiffrées sont perdues.
3. Ouvrez `https://rail.apps.exemple.com`, entrez le jeton.

> **Ce serveur fait déjà tourner nginx sur le 80/443** (voie `infra`, voir le README à la racine) ?
> Rail refuse alors de s'installer, pour ne rien casser. Donnez-lui une IP à lui (`RAIL_BIND=<ip>` dans `.env`, et
> nginx doit n'écouter que l'autre IP), ou un autre serveur.

**Mise à jour** : `git pull && sudo ./install.sh`. Le catalogue SQLite se met à niveau tout seul au
démarrage (migrations numérotées) ; vos conteneurs ne sont pas touchés.

## Premier déploiement

Dans le tableau de bord : **Nouveau projet** → **+ Service** → nom, dépôt `propriétaire/dépôt`, branche, port que
votre API écoute, chemin de santé (`/health`) → **Déployer**. Ou en CLI :

```bash
export RAIL_URL=https://rail.apps.exemple.com RAIL_TOKEN=…
rail project:new demo
rail service:new demo api acme/mon-api --port 8080 --health /health --token ghp_…   # --token : dépôt privé
rail vars:set demo/api JWT_SECRET=…
rail deploy demo/api
rail logs demo/api --build -f       # la construction en direct
rail logs demo/api -f               # l'API en marche
rail status                         # le serveur et tous les services, d'un coup d'œil
rail containers                     # tout ce que Docker fait tourner sur la machine
```

L'API répond sur `https://api-demo.apps.exemple.com`. (La CLI : `paas/bin/rail.js`, à lier ou copier dans votre `PATH`.)

### Déployer à chaque push

Réglages du service → **Installer le webhook** (nécessite un jeton GitHub avec **Webhooks : écriture**), ou à la main :
*dépôt GitHub → Settings → Webhooks → Add* avec l'URL et le secret affichés, type `application/json`, événement `push`.
Rail vérifie la signature HMAC-SHA256 sur le corps brut, ignore les autres branches et les autres événements, et
déploie **le commit exact poussé** (pas la pointe de la branche, qui peut avoir avancé).

### Jetons GitHub

Un dépôt public n'en demande aucun. Pour un dépôt privé, créez un **jeton à portée limitée** (*fine-grained*,
limité à ce dépôt) : `Contents: read`, plus `Webhooks: write` pour l'installation automatique, plus
`Commit statuses: write` pour le statut `rail/deploy`. Il se met par service (chiffré au repos, jamais renvoyé par
l'API, jamais écrit dans les logs) ou globalement (`GITHUB_TOKEN` dans `.env`).

## Bases de données

**+ Base de données** dans un projet, ou `rail db:new demo base --engine postgres`.

| Moteur | Image | Port | Volume | Sauvegarde intégrée |
|---|---|---|---|---|
| PostgreSQL | `postgres:16-alpine` | 5432 | `/var/lib/postgresql/data` | `pg_dump` |
| MySQL | `mysql:8` | 3306 | `/var/lib/mysql` | `mysqldump` |
| Redis | `redis:7-alpine` | 6379 | `/data` (AOF) | — (copiez le volume) |
| MongoDB | `mongo:7` | 27017 | `/data/db` | `mongodump` |

Rail engendre les identifiants, crée le volume, démarre le conteneur et attend qu'il accepte les
connexions. La base **n'est jamais publiée sur Internet** : ni domaine, ni port ouvert. On l'atteint
par le réseau privé, à `<nom>.<projet>.internal:<port>`.

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

**Sauvegarder** : *Réglages → Télécharger une sauvegarde*, ou `rail backup demo/base > dump.sql`.
C'est un export **logique** (il se restaure dans une autre version du moteur, ailleurs). Pour l'image
complète du serveur, voir [Sauvegardes](#sauvegardes).

> **Attention aux volumes.** Un service avec volume ne peut pas tourner en double : au redéploiement,
> l'ancien conteneur est arrêté **avant** le démarrage du nouveau (quelques secondes d'interruption).
> Si le nouveau n'est pas sain, l'ancien est remis en marche. Supprimer le service supprime le volume
> et ses données (`DELETE …?keep_volume=1` pour le garder).

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
| **Déployer** | reconstruit depuis le dépôt | — |

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
  `DOCKER_*`, `RAIL_*` sont réservés. Fournies à l'API : `RAIL_PROJECT_NAME`, `RAIL_SERVICE_NAME`, `RAIL_GIT_COMMIT_SHA`,
  `RAIL_DEPLOYMENT_ID`, `RAIL_PUBLIC_DOMAIN`, `RAIL_PRIVATE_DOMAIN`.
- **Références** : `${{autre-service.CLE}}` dans n'importe quelle valeur (voir [Bases de données](#bases-de-données)).
- **Domaine personnalisé** : enregistrement DNS A vers le serveur, *Domaines → Ajouter*, *Redéployer*. Le certificat est
  demandé automatiquement au premier accès.
- **Entre services** : `http://<service>.<projet>.internal:<port>` (sans HTTPS, sans passer par Internet).
- **PostgreSQL de l'hôte** (plutôt qu'une base managée) : depuis un conteneur, l'hôte s'appelle `host.docker.internal`.
  PostgreSQL doit écouter sur l'adresse du pont Docker et son `pg_hba.conf` l'autoriser — ne l'ouvrez jamais à Internet.
- **Volume persistant** sur un service ordinaire : *Réglages → Volume persistant*, un chemin absolu (`/data`).

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
| Une base, export logique | *Réglages → Télécharger une sauvegarde*, ou `rail backup demo/base > dump.sql` | avant une migration, ou chaque jour en cron |
| Tout le serveur | `sudo ./sauvegarde.sh [dossier]` — `.env`, le catalogue SQLite, les journaux, et **tous** les volumes | en cron, puis copié hors du serveur |

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
| **Jeton d'admin** | Comparé en temps constant ; 10 échecs par minute et par IP → 429. Le tableau de bord le garde dans `sessionStorage` (effacé à la fermeture de l'onglet) et applique une CSP stricte (`script-src 'self'`, `frame-ancestors 'none'`) : tout le code de la page vient de fichiers servis par Rail. Mettez le tableau de bord derrière un VPN ou une liste d'IP si possible. |
| **Webhook** | Seule route publique en écriture ; authentifiée par HMAC-SHA256 (secret propre à chaque service), 401 identique que le service existe ou non. |
| **Secrets** | Variables, identifiants de bases, jeton GitHub et secret de webhook chiffrés (AES-256-GCM) dans SQLite ; clé dans `.env`. Les variables passent au conteneur par l'environnement du client docker (`-e NOM`), **jamais dans les arguments** donc jamais dans `ps` — y compris le mot de passe d'un `mysqldump`. Le jeton GitHub passe à `git` par `GIT_CONFIG_*` et est masqué des journaux. |
| **Vos conteneurs** | `--cap-drop ALL` (+ `NET_BIND_SERVICE`), `no-new-privileges`, `--pids-limit 512`, journaux tournés, mémoire 512 Mo et 1 CPU par défaut (réglables). |
| **Bases de données** | Jamais de port publié, jamais de domaine : seulement le réseau privé `rail`. Mots de passe engendrés (18 octets aléatoires), jamais affichés en clair dans l'interface sans un clic. |
| **Console SQL** | Réservée au jeton d'administration, lecture seule par défaut, minuterie de 30 s, requête passée par l'entrée standard (jamais dans `ps`), toute écriture inscrite dans l'activité. Elle donne, de fait, un accès complet aux données de vos bases : c'est le même niveau de confiance que le jeton lui-même. |
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
- **Tests** : `cd paas && npm test` (78 tests : un vrai dépôt git local, un faux Docker, de vraies requêtes HTTP — sans Docker).
  `./test/integration.sh` joue le tout contre un **vrai** Docker : construction de l'image, déploiement d'un vrai
  PostgreSQL, mesures, console SQL (lecture, écriture, refus en lecture seule), sauvegarde logique, inventaire des
  conteneurs, arrêt, redéploiement avec persistance des données, suppression. La CI joue les deux.
  Le tableau de bord se teste dans un vrai navigateur (facultatif, hors CI : il demande une dépendance) :
  `npm i --no-save playwright-core && CHROME=/usr/bin/google-chrome node test/navigateur.mjs --photos /tmp/rail` —
  il clique tous les gestes (créer, déployer, arrêter, filtrer les journaux, survoler un graphique, téléphone) et
  échoue à la moindre erreur de console.

## Dépannage

| Symptôme | Cause probable |
|---|---|
| « Impossible de récupérer … » | dépôt privé sans jeton, jeton sans `Contents: read`, branche inexistante |
| « Langage non reconnu » | pas de `Dockerfile`/`package.json`/`go.mod`/… à la racine du service : régler *Dossier racine* |
| « pas de réponse saine après 120s » | l'API n'écoute pas sur `$PORT`/`0.0.0.0`, ou mauvais chemin de santé ; lire « derniers logs du conteneur » dans le journal |
| 404 sur l'adresse du service | aucun déploiement réussi, service **arrêté**, ou domaine ajouté sans *Redéployer* |
| Service « dégradé » | le conteneur tourne mais le chemin de santé ne répond plus en 2xx/3xx : regarder les logs d'exécution |
| Certificat invalide | le DNS ne pointe pas encore sur le serveur ; `docker compose logs traefik` (Let's Encrypt limite les essais) |
| Webhook en échec (401) | secret différent de celui du service : l'afficher dans *Réglages* |
| `permission denied` sur docker.sock | `DOCKER_GID` de `.env` ≠ groupe du socket : relancer `install.sh` |
| « référence non résolue » dans un journal | le service visé n'existe pas dans **ce** projet, ou la clé n'existe pas : voir l'onglet *Connexion* de la base |
| Pas de mesures | moins d'une minute d'historique, ou `docker stats` indisponible : `docker compose logs control` |
| « cannot execute INSERT in a read-only transaction » | la console SQL est en lecture seule : décochez la case (ou `--write`) |
| « pas de console SQL pour redis » | Redis et MongoDB ne parlent pas SQL : voir la commande `docker exec` de l'onglet *Connexion* |
| Un conteneur hors Rail n'apparaît pas | il est arrêté : cochez « tout » (`rail containers --all`) |
| Disque plein | *Système → Nettoyer les images orphelines*, puis vérifier les volumes des bases supprimées (`docker volume ls`) |

## Limites

Un seul serveur, un seul conteneur par service (pas de réplicas ni de mise à l'échelle), pas d'aperçu par pull request,
pas de multi-utilisateur (un seul jeton d'administration), pas de variables disponibles **pendant** la construction
(voir ci-dessous), certificats par nom (pas de joker : Let's Encrypt limite le nombre de nouveaux certificats par
domaine et par semaine), mesures gardées 72 h par défaut (ce n'est pas un Prometheus).

*Variables de construction* : volontairement absentes — un secret passé en `--build-arg` reste lisible dans l'historique de l'image.
Si une étape de build en a besoin, utilisez un `Dockerfile` avec des montages secrets BuildKit.

## Où est quoi

```
paas/
├─ src/          plan de contrôle
│   ├─ main.js       câblage et démarrage          api.js       API JSON, webhook, fichiers du tableau de bord
│   ├─ deployer.js   la file et le déploiement     monitor.js   relevés, états, réparation automatique
│   ├─ runtime.js    tout ce qui parle à Docker    databases.js catalogue des moteurs managés
│   ├─ detect.js     construction sans Dockerfile  source.js    git fetch d'un commit précis
│   ├─ db.js         SQLite : catalogue, mesures, événements, migrations
│   ├─ sql.js        console SQL : lire le CSV de psql, le TSV de mysql
│   ├─ routes.js     fichiers de route Traefik     vars.js      références ${{service.CLE}}
│   ├─ crypto.js     secrets au repos              notify.js    alertes sortantes
│   ├─ github.js     webhooks et statuts           validate.js  listes blanches d'entrées
│   └─ logs.js       journaux de déploiement       config.js    toute la configuration
├─ web/          le tableau de bord (index.html, style.css, ui.js, app.js — aucune dépendance)
├─ bin/rail.js   la CLI
├─ test/         unitaires, déploiement, bases de données, surveillance, API/CLI, et integration.sh (vrai Docker)
├─ compose.yaml  Traefik + plan de contrôle        Dockerfile    image du plan de contrôle
├─ install.sh    installation idempotente          sauvegarde.sh archive complète
└─ .env.example  toute la configuration
```
