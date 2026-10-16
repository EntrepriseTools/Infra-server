# Déployer Rail sur le serveur — le déroulé, pas à pas

Ce document est fait pour être suivi **depuis une session SSH sur le serveur**, par une
personne ou par un agent. Il dit quoi lancer, quoi vérifier après chaque étape, et quoi
faire quand ça coince. La référence complète (fonctionnalités, sécurité, limites) est
dans [LISEZMOI.md](LISEZMOI.md) ; ici, c'est l'ordre des gestes.

> **Avant tout** : le jeton d'administration de Rail vaut un **accès root** sur cette
> machine (le plan de contrôle tient le socket Docker). Ne le collez ni dans un ticket,
> ni dans un canal d'équipe, ni dans un dépôt.

---

## 0. Ce qu'il faut avant de commencer

| Vérification | Commande | Attendu |
|---|---|---|
| Debian/Ubuntu, accès root | `id -u` | `0` (ou `sudo` disponible) |
| Docker Engine | `docker version --format '{{.Server.Version}}'` | 24 ou plus |
| Compose v2 | `docker compose version` | `v2.x` |
| Groupe `docker` | `getent group docker` | une ligne (sinon : `groupadd docker`) |
| Place disque | `df -h /var/lib/docker` | au moins 10 Go libres |
| Qui tient le 80/443 | `ss -ltnp '( sport = :80 or sport = :443 )'` | voir l'étape 2 |
| DNS | `dig +short rail.apps.exemple.com` et `dig +short nimporte.apps.exemple.com` | l'IP du serveur |

Le DNS demande **deux** enregistrements vers l'IP du serveur : `rail.apps.exemple.com`
(le tableau de bord) et le joker `*.apps.exemple.com` (les services). Sans eux, Let's
Encrypt ne peut pas délivrer de certificat — on peut installer quand même, mais le
tableau de bord restera en « certificat invalide » jusqu'à ce que le DNS soit en place.

---

## 1. Récupérer le code

```bash
sudo git clone https://github.com/EntrepriseTools/Infra-server.git /opt/Infra-server
cd /opt/Infra-server/paas
```

Déjà installé ? Alors on met à jour, **après une sauvegarde** :

```bash
cd /opt/Infra-server/paas
sudo ./sauvegarde.sh              # .env, catalogue, tous les volumes
sudo git pull
sudo ./install.sh                 # la base SQLite se met à niveau toute seule (v1 → v2)
```

---

## 2. Choisir par où le monde entre

C'est **la seule vraie décision** de l'installation. Elle dépend de qui tient déjà les
ports 80 et 443 (`ss -ltnp '( sport = :80 or sport = :443 )'`).

### Cas A — la machine est à Rail (80 et 443 libres)

```bash
sudo ./install.sh
```

Le script demande le domaine de base (ex. `apps.exemple.com`) et un courriel pour
Let's Encrypt, fabrique `.env`, et lance tout. Les certificats arrivent seuls.

### Cas B — nginx (ou autre) tient déjà le 443, et le garde

Rail se met **derrière** : il n'écoute qu'en clair sur un port à lui, c'est nginx qui
fait le HTTPS.

```bash
sudo RAIL_TLS=proxy RAIL_HTTP_PORT=8080 ./install.sh
```

À la fin, le script **affiche le bloc nginx à copier** (il contient déjà les en-têtes
`Host` et `X-Forwarded-*` et le délai long nécessaire aux journaux en direct). Il faut
ensuite :

```bash
sudo nano /etc/nginx/sites-available/rail      # coller le bloc affiché, ajuster ssl_certificate
sudo ln -sf /etc/nginx/sites-available/rail /etc/nginx/sites-enabled/rail
sudo nginx -t && sudo systemctl reload nginx
```

Un certificat **joker** `*.apps.exemple.com` évite d'en demander un par service
(`certbot certonly --dns-… -d '*.apps.exemple.com' -d apps.exemple.com`).

### Cas C — pas de proxy devant, mais le 80 n'est pas libre

Rail prend des ports à lui et obtient ses certificats par **DNS-01** :

```bash
sudo RAIL_TLS=dns RAIL_HTTP_PORT=8080 RAIL_HTTPS_PORT=8443 \
     RAIL_ACME_DNS_PROVIDER=cloudflare ./install.sh
sudo nano .env.dns          # CF_DNS_API_TOKEN=... (droit « DNS:Edit » sur la zone)
sudo docker compose up -d   # relance Traefik avec les identifiants
```

Les adresses porteront alors le port : `https://rail.apps.exemple.com:8443`.

> Le défi HTTP-01 de Let's Encrypt **exige le port 80 public** : c'est pour cela que des
> ports exotiques imposent le cas B ou le cas C. Ce n'est pas un choix de Rail.

---

## 3. Vérifier que c'est debout

```bash
docker compose ps                                              # deux services : traefik, control
docker inspect -f '{{.State.Health.Status}}' rail-control      # healthy
docker compose logs --tail 30 control                          # « plan de contrôle sur :4000 »
docker compose logs --tail 30 traefik                          # certificats (cas A et C)
```

Puis, depuis la machine, avec le jeton affiché par `install.sh` :

```bash
export RAIL_URL=https://rail.apps.exemple.com     # + :8443 dans le cas C
export RAIL_TOKEN=...                             # affiché par install.sh ; aussi dans .env
./bin/rail.js status          # le serveur, les projets, l'état de chaque service
./bin/rail.js containers      # TOUT ce que Docker fait tourner ici, Rail ou non
```

`rail status` qui répond, c'est l'installation réussie. Ouvrez ensuite le tableau de
bord dans un navigateur et entrez le jeton.

---

## 4. Le premier service, et la première base

```bash
./bin/rail.js project:new demo
./bin/rail.js db:new demo base --engine postgres          # volume + identifiants engendrés
./bin/rail.js service:new demo api proprietaire/depot --port 8080 --health /health
./bin/rail.js vars:set demo/api DATABASE_URL='${{base.DATABASE_URL}}'
./bin/rail.js deploy demo/api
./bin/rail.js logs demo/api --build -f                    # la construction en direct
```

Pour un dépôt privé, ajoutez `--token ghp_…` (jeton *fine-grained* limité au dépôt,
droit `Contents: read`). Pour déployer à chaque `git push` :
`./bin/rail.js webhook demo/api` (le jeton doit avoir `Webhooks: write`).

Vérifications :

```bash
curl -I https://api-demo.apps.exemple.com     # 200 (ou 301 si votre API redirige)
./bin/rail.js sql demo/base "SELECT version()"
./bin/rail.js metrics demo/api
```

---

## 5. Mettre le filet

```bash
# Alertes (pannes et échecs de déploiement) vers Slack, Discord ou votre webhook
sudo sed -i 's|^#\?RAIL_NOTIFY_URL=.*|RAIL_NOTIFY_URL=https://hooks.exemple/xxx|' .env
sudo ./install.sh                      # relance avec la nouvelle configuration

# Sauvegarde quotidienne, 14 jours gardés, hors du serveur ensuite
sudo crontab -l 2>/dev/null | { cat; echo "15 3 * * * cd /opt/Infra-server/paas && ./sauvegarde.sh >> /var/log/rail-sauvegarde.log 2>&1"; } | sudo crontab -
sudo ./sauvegarde.sh                   # une première, tout de suite
```

**Mettez `.env` en lieu sûr** (hors du serveur) : sans `RAIL_SECRET_KEY`, les variables
et les identifiants de bases chiffrés sont définitivement illisibles.

---

## 6. Quand ça coince

| Ce qu'on voit | Ce que c'est | Quoi faire |
|---|---|---|
| `le port 80 est déjà utilisé` | un serveur web tient la machine | étape 2, cas B ou C |
| `le groupe « docker » n'existe pas` | Docker installé autrement | `sudo groupadd docker && sudo ./install.sh` |
| `permission denied` sur `/var/run/docker.sock` | `DOCKER_GID` ne correspond plus | `sudo ./install.sh` (il le recalcule) |
| le plan de contrôle ne devient pas `healthy` | voir la cause | `docker compose logs control` |
| certificat invalide | DNS pas encore propagé, ou quota Let's Encrypt | `dig +short rail.<domaine>`, puis `docker compose logs traefik` |
| 404 sur un service | aucun déploiement réussi, service arrêté, ou domaine ajouté sans redéployer | `./bin/rail.js status` |
| `pas de réponse saine après 120s` | l'API n'écoute pas sur `$PORT` / `0.0.0.0` | lire « derniers logs du conteneur » dans le journal du déploiement |
| disque plein | images orphelines | page *Système* → *Nettoyer*, ou `./bin/rail.js prune` |

Rien de tout cela ne touche aux conteneurs déjà en marche : redémarrer le plan de
contrôle ne coupe aucun service.

---

## 7. Ce qu'il ne faut pas faire

- **Ne pas** committer `.env`, `.env.dns`, ni le jeton d'administration.
- **Ne pas** éditer `traefik.local.yml` à la main : `install.sh` le réécrit. Changez
  `.env` puis relancez le script.
- **Ne pas** arrêter `rail-control` depuis le tableau de bord (il refuse, exprès) :
  `docker compose restart control` depuis le serveur.
- **Ne pas** supprimer un service de base de données pour « le recréer propre » : son
  volume part avec lui. Sauvegardez d'abord (`./bin/rail.js backup projet/base > dump.sql`).
- **Ne pas** relier un dépôt GitHub que vous ne maîtrisez pas : son `Dockerfile`
  s'exécute sur ce serveur.

---

## Le strict minimum, si vous êtes pressé

```bash
sudo git clone https://github.com/EntrepriseTools/Infra-server.git /opt/Infra-server
cd /opt/Infra-server/paas
ss -ltnp '( sport = :80 or sport = :443 )'     # si ça répond, voir l'étape 2
sudo ./install.sh                               # garder le jeton affiché
export RAIL_URL=https://rail.<domaine> RAIL_TOKEN=<jeton>
./bin/rail.js status
```
