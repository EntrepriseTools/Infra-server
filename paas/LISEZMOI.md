# Rail — un Railway à vous, pour déployer des API depuis GitHub

Rail est une plateforme de déploiement **auto-hébergée** : vous reliez un dépôt
GitHub, chaque `git push` construit l'API, la démarre, vérifie qu'elle répond,
puis lui donne son adresse HTTPS — **sans coupure** et avec **retour arrière en
un clic**. C'est le même geste que Railway, sur votre serveur.

| Railway | Rail |
|---|---|
| Projet → services | Projet → services (une API = un service) |
| Déploiement à chaque push | Webhook GitHub signé, une branche suivie par service |
| Nixpacks / Dockerfile | `Dockerfile` du dépôt, sinon construction automatique **Node, Python, Go, Java** (+ `Procfile`) |
| Variables d'environnement | Variables chiffrées au repos (AES-256-GCM), `PORT` et `RAIL_*` injectées |
| Domaine `*.up.railway.app` + domaine perso | `<service>-<projet>.<votre domaine>` + domaines personnalisés, HTTPS Let's Encrypt automatique |
| Healthcheck, déploiement sans coupure | L'ancien conteneur ne s'arrête qu'**après** que le nouveau répond et que la route a basculé |
| Rollback | Remet l'image d'un déploiement passé, **sans reconstruire** |
| Logs de build et d'exécution | Les deux, en direct dans le tableau de bord et la CLI |
| Réseau privé `*.railway.internal` | `<service>.<projet>.internal` entre vos services |
| Statut de déploiement dans GitHub | Statut de commit `rail/deploy` (en cours / succès / échec) |
| Tableau de bord, CLI, API | Tableau de bord web, `rail` (CLI), API JSON |

Ce que Rail **ne fait pas** (volontairement, c'est « uniquement des API ») : bases de données gérées,
volumes persistants, plusieurs serveurs, réplicas, environnements de prévisualisation par PR.
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
                                 │  (échec avant 6 : l'ancien n'a jamais été touché) │
                                 └───────────────────────────┬──────────────────────┘
                                                             │ socket docker
                                         conteneurs de vos API, réseau « rail »
```

- **Traefik n'a pas accès au socket Docker.** Il lit seulement des fichiers de route que le
  plan de contrôle écrit de façon atomique ; basculer le trafic, c'est réécrire un fichier.
- **Le plan de contrôle** (`src/`) est du Node 22 **sans aucune dépendance npm** : `node:sqlite`,
  `node:http`, `node:crypto`, et les CLI `git` et `docker`. Rien à `npm install`, rien à auditer en dehors du dépôt.
- **Un déploiement à la fois par service**, un plus récent remplace ceux qui attendent. Au plus
  `RAIL_MAX_BUILDS` constructions en parallèle sur la machine.

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

## Premier déploiement

Dans le tableau de bord : **Nouveau projet** → **+ Service** → nom, dépôt `propriétaire/dépôt`, branche, port que
votre API écoute, chemin de santé (`/health`) → **Déployer**. Ou en CLI :

```bash
export RAIL_URL=https://rail.apps.exemple.com RAIL_TOKEN=…
rail project:new demo
rail service:new demo api acme/mon-api --port 8080 --health /health --token ghp_…   # --token : dépôt privé
rail vars:set demo/api DATABASE_URL=postgres://… JWT_SECRET=…
rail deploy demo/api
rail logs demo/api --build -f       # la construction en direct
rail logs demo/api -f               # l'API en marche
```

L'API répond sur `https://api-demo.apps.exemple.com`. (La CLI : `paas/bin/rail.js`, à lier ou copier dans votre `PATH`.)

### Déployer à chaque push

Réglages du service → **Installer le webhook** (nécessite un jeton GitHub avec **Webhooks : écriture**), ou à la main :
*dépôt GitHub → Settings → Webhooks → Add* avec l'URL et le secret affichés, type `application/json`, événement `push`.
Rail vérifie la signature HMAC-SHA256 sur le corps brut, ignore les autres branches et les autres événements, et
déploie **le commit exact poussé** (pas la pointe de la branche, qui peut avoir avancé).

### Jetons GitHub

Un dépôt public n'en demande aucun. Pour un dépôt privé, créez un **jeton à portée limitée** (*fine-grained*,
limité à ce dépôt) : `Contents: read`, plus `Webhooks: write` si vous voulez l'installation automatique, plus
`Commit statuses: write` pour le statut `rail/deploy` sur vos commits. Il se met par service (chiffré au repos, jamais renvoyé par l'API,
jamais écrit dans les logs) ou globalement (`GITHUB_TOKEN` dans `.env`).

## Ce que Rail construit

1. Le **`Dockerfile`** du dépôt (ou du dossier racine du service, ou le chemin indiqué dans les réglages).
2. Sinon, un Dockerfile **engendré** d'après les fichiers :

| Détecté | Construction | Démarrage |
|---|---|---|
| `package.json` | image `node:<engines.node>-slim` ; npm / pnpm / yarn d'après le lockfile ; `build` si présent ; dépendances de dev retirées | `Procfile` `web:`, sinon `npm start`, sinon `main` |
| `go.mod` | `golang:<version du go.mod>`, `CGO_ENABLED=0`, binaire à la racine ou dans `cmd/<un seul>` | le binaire, ou `Procfile` |
| `pom.xml`, `build.gradle(.kts)` | JDK d'après `java.version`, `mvnw`/`gradlew` si présents, tests sautés ; JRE à l'exécution | `java $JAVA_OPTS -Dserver.port=$PORT -jar` (Spring Boot), ou `Procfile` |
| `requirements.txt` / `pyproject.toml` | `python:3.x-slim`, `pip install` | `Procfile`, sinon `main.py`/`app.py`/`server.py` |

Tout est exécuté **sans privilèges** (utilisateur non-root). Un langage non reconnu donne une erreur qui dit quoi faire
(ajouter un `Dockerfile` ou un `Procfile`).

**Votre API doit écouter sur `$PORT`** (injecté, égal au « port » du service) sur `0.0.0.0`.

## Variables, domaines, réseau privé

- **Variables** : onglet *Variables* ou `rail vars:set`. Elles s'appliquent au **prochain déploiement** — « Enregistrer et
  redéployer » relance l'image en service avec la nouvelle configuration, **sans reconstruire**. `PORT`, `PATH`, `HOME`, `LD_*`,
  `DOCKER_*`, `RAIL_*` sont réservés. Fournies à l'API : `RAIL_PROJECT_NAME`, `RAIL_SERVICE_NAME`, `RAIL_GIT_COMMIT_SHA`,
  `RAIL_DEPLOYMENT_ID`, `RAIL_PUBLIC_DOMAIN`, `RAIL_PRIVATE_DOMAIN`.
- **Domaine personnalisé** : enregistrement DNS A vers le serveur, *Domaines → Ajouter*, *Redéployer*. Le certificat est demandé
  automatiquement au premier accès.
- **Entre services** : `http://<service>.<projet>.internal:<port>` (sans HTTPS, sans passer par Internet).
- **PostgreSQL de l'hôte** : depuis un conteneur, l'hôte s'appelle `host.docker.internal`. PostgreSQL doit écouter sur l'adresse
  du pont Docker (`172.17.0.1` ou celle du réseau `rail`) et son `pg_hba.conf` l'autoriser — ne l'ouvrez jamais à Internet.

## Déploiement sans coupure, retour arrière

Ordre exact d'un déploiement : le nouveau conteneur démarre **à côté** de l'ancien → Rail attend qu'il réponde
(`GET <chemin de santé>` en 2xx/3xx, ou simple connexion TCP si aucun chemin n'est donné ; `RAIL_HEALTH_TIMEOUT_S`, 120 s) →
**la route bascule** → 3 s plus tard (`RAIL_SWITCH_GRACE_MS`) l'ancien reçoit SIGTERM (30 s pour finir ses requêtes).
S'il ne devient jamais sain, il est supprimé, ses 30 dernières lignes de logs sont copiées dans le journal du déploiement,
et **l'ancien continue de servir** : l'échec est visible mais jamais subi.

**Retour arrière** : *Déploiements → Revenir ici* (ou `rail rollback <id>`). Les images des `RAIL_KEEP_IMAGES` (5) derniers
déploiements sont conservées ; l'image est relancée telle quelle, en quelques secondes, avec les variables **actuelles**.
Attention : un retour arrière remet du code, pas un schéma de base de données.

## Sécurité — ce qu'il faut savoir

| Sujet | Position |
|---|---|
| **Socket Docker** | Le plan de contrôle y a accès : **qui contrôle Rail est root sur le serveur.** Le jeton d'administration doit être traité comme un accès root (long, jamais committé, `.env` en 0600). Le conteneur tourne en non-root, `no-new-privileges`, et Traefik, exposé à Internet, n'a pas le socket. |
| **Jeton d'admin** | Comparé en temps constant ; 10 échecs par minute et par IP → 429. Le tableau de bord le garde dans `sessionStorage` (effacé à la fermeture de l'onglet) et applique une CSP stricte (`frame-ancestors 'none'`). Mettez le tableau de bord derrière un VPN ou une liste d'IP si possible. |
| **Webhook** | Seule route publique en écriture ; authentifiée par HMAC-SHA256 (secret propre à chaque service), 401 identique que le service existe ou non. |
| **Secrets** | Variables, jeton GitHub et secret de webhook chiffrés (AES-256-GCM) dans SQLite ; clé dans `.env`. Les variables passent au conteneur par l'environnement du client docker (`-e NOM`), **jamais dans les arguments** donc jamais dans `ps`. Le jeton GitHub passe à `git` par `GIT_CONFIG_*`, pas par l'URL, et est masqué des journaux. |
| **Vos conteneurs** | `--cap-drop ALL` (+ `NET_BIND_SERVICE`), `no-new-privileges`, `--pids-limit 512`, mémoire 512 Mo et 1 CPU par défaut (réglables). |
| **Entrées** | Noms, dépôts, branches, chemins, domaines, variables : validés par liste blanche avant de toucher une commande, un chemin ou une règle de routage ; aucun shell n'interprète rien (tableaux d'arguments partout). |
| **À savoir** | Le code construit est celui de **vos** dépôts : ne reliez pas de dépôt que vous ne maîtrisez pas (un `Dockerfile` s'exécute sur le serveur). Tous les services partagent le réseau `rail` : pas d'isolation réseau entre projets. |

## Exploiter

```bash
cd Infra-server/paas
docker compose ps                    # état
docker compose logs -f control       # le plan de contrôle
docker compose logs -f traefik       # accès + certificats
git pull && sudo ./install.sh        # mise à jour (les services en cours ne sont pas touchés)
```

- **Sauvegarde** : le volume `rail_rail-data` (base `rail.db`, journaux de déploiement) et le fichier `.env`.
  `docker run --rm -v rail_rail-data:/d -v "$PWD":/b busybox tar czf /b/rail-data.tgz -C /d .`
- **Redémarrer le plan de contrôle ne coupe aucun service** : vos conteneurs sont indépendants (`--restart unless-stopped`) et
  Traefik garde ses routes. Au redémarrage, un déploiement en cours est marqué échoué, et les routes sont réécrites depuis la base.
- **Tests** : `cd paas && npm test` (37 tests : un vrai dépôt git local, un faux Docker, de vraies requêtes HTTP — sans Docker).

## Dépannage

| Symptôme | Cause probable |
|---|---|
| « Impossible de récupérer … » | dépôt privé sans jeton, jeton sans `Contents: read`, branche inexistante |
| « Langage non reconnu » | pas de `Dockerfile`/`package.json`/`go.mod`/… à la racine du service : régler *Dossier racine* |
| « pas de réponse saine après 120s » | l'API n'écoute pas sur `$PORT`/`0.0.0.0`, ou mauvais chemin de santé ; lire « derniers logs du conteneur » dans le journal |
| 404 sur l'adresse du service | aucun déploiement réussi, ou domaine ajouté sans *Redéployer* |
| Certificat invalide | le DNS ne pointe pas encore sur le serveur ; `docker compose logs traefik` (Let's Encrypt limite les essais) |
| Webhook en échec (401) | secret différent de celui du service : l'afficher dans *Réglages* |
| `permission denied` sur docker.sock | `DOCKER_GID` de `.env` ≠ groupe du socket : relancer `install.sh` |

## Limites

Pas de base de données ni de volume géré (utilisez un PostgreSQL à vous), pas de variables disponibles **pendant** la
construction (voir ci-dessous), un seul serveur, un seul conteneur par service (pas de réplicas ni de mise à l'échelle),
pas d'aperçu par pull request, pas de multi-utilisateur (un seul jeton d'administration), certificats par nom (pas de joker :
Let's Encrypt limite le nombre de nouveaux certificats par domaine et par semaine).

*Variables de construction* : volontairement absentes — un secret passé en `--build-arg` reste lisible dans l'historique de l'image.
Si une étape de build en a besoin, utilisez un `Dockerfile` avec des montages secrets BuildKit.

## Où est quoi

```
paas/
├─ src/        plan de contrôle : main, api, deployer, detect, runtime, source, github, routes, db, crypto, validate, config, logs
├─ web/        le tableau de bord (un seul fichier, sans dépendance)
├─ bin/rail.js la CLI
├─ test/       unitaires, déploiement (faux Docker + vrai git), API/webhook/CLI
├─ compose.yaml  Traefik + plan de contrôle      Dockerfile  image du plan de contrôle
└─ install.sh  installation idempotente          .env.example  toute la configuration
```
