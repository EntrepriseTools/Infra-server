# Audit des pipelines — Purchase_Management, board, HR_Management

*25 septembre 2026. Lu sur `main` des trois dépôts : `.github/workflows/*`,
`deploiement/*` (scripts, compose, gabarits nginx, sudoers, `.env.exemple`,
LISEZMOI).*

## 1. Ce que les trois font — et qui est bon

Les trois dépôts suivent, à peu de chose près, la **même chaîne**, et c'est
une bonne chaîne. Infra-server la **garde** et la rend unique :

```
push main ─▶ tests ─▶ image <nom>:<SHA> ─▶ scp (tar) ─▶ ssh <script>.sh deployer <SHA>
                                                 1. docker load
                                                 2. pg_dump, RELU (pg_restore --list)
                                                 3. étiquette « en-service » (jamais latest), up -d
                                                 4. sonde locale ; rouge → image précédente
                                                 5. bloc nginx engendré d'un gabarit, nginx -t, reload
                                                 6. sonde par le nom, en-tête « X-…-Porte »
```

| Pratique commune | Pourquoi elle est juste |
|---|---|
| Image étiquetée par le **SHA**, étiquette mobile `en-service` | ce qui a été éprouvé est ce qui part ; un retour arrière recule vraiment |
| **PostgreSQL natif**, jamais dans Docker ; `network_mode: host` + écoute sur 127.0.0.1 | pas de `down -v` qui efface une base ; pas de port ouvert |
| **Sauvegarde relue avant chaque déploiement** | le retour arrière remet une image, jamais un schéma |
| Fichier de secrets **lu, jamais sourcé** | un `.env` n'est pas un script |
| Gabarit nginx rendu depuis les réglages, `nginx -t`, bloc retiré si refusé | le nginx est partagé ; un bloc faux ferait tomber les autres sites |
| Sudo **minimal**, arguments figés | le compte de déploiement n'a pas root |
| Verrou hors de `/tmp` (`fs.protected_regular`) | défaut mesuré sur le serveur le 15/09 |
| `concurrency` sans annulation sur `main` | ne jamais couper entre la relance et la sonde |

## 2. Le problème de fond : trois copies qui dérivent

| | HR (`paie.sh`) | board (`pilotage.sh`) | Purchase (`procurement.sh`) |
|---|---|---|---|
| Lignes du script serveur | **892** | **749** | **372** |
| Pipeline | `campagne.yml` (479 l.) | `campagne.yml` (250 l.) | `deploy-serveur.yml` + `ci-backend.yml` + `ci-frontend.yml` |
| Compte de déploiement | `deploy` | `deploy_board` | `procurement` |
| Secrets GitHub | `SSH_HOST`, `SSH_USER`, `SSH_KEY`, `SSH_PASSWORD` | `SSH_HOST`, `SSH_KEY`, `SSH_PASSWORD` (utilisateur en dur) | `PROC_SSH_HOST`, `PROC_SSH_USER`, `PROC_SSH_KEY`, `PROC_SSH_PASSWORD` |
| Variables de base | `PAIE_BASE` (JDBC) + `PAIE_UTILISATEUR`… | `DATABASE_URL` (JDBC) + `DATABASE_USER`… | `PGHOST`, `PGDATABASE`… (libpq) |
| Adresse publique | `PAIE_URL_PUBLIQUE` | `PILOTAGE_URL_PUBLIQUE` | `URL_PUBLIQUE` |
| En-tête de preuve | `X-Paie-Porte` | `X-Pilotage-Porte` | `X-Procurement-Porte` |
| Port local | 8080 | 8084 | 8087 — **attribués à la main, aucun registre** |
| Minuteur de sauvegarde | `hr-sauvegarde` 21 h 00 | `board-sauvegarde` **21 h 30** | `procurement-sauvegarde` **21 h 30** — deux `pg_dump` en même temps |
| Tiroir des prises | `/var/backups/paie/conteneur` | `/var/backups/pilotage` | `/var/backups/procurement` |
| Sonde | `/` puis `/api/moi` | `/` puis `/actuator/health` | `/actuator/health` |

Chaque correctif appris à la dure sur l'un n'a pas été porté aux autres :

| Défaut / correctif | HR | board | Purchase |
|---|---|---|---|
| **Sonde de la porte répétée** après `reload` (nginx recharge en différé — mesuré le 25/09) | ✗ un seul essai | ✓ | ✗ un seul essai après `sleep 1` → **faux échecs** |
| Points du nom **échappés** dans la recherche de `server_name` en double | ✗ (`app.sbp.ma` = `app.sbp.ma` *ou* `appXsbpXma`) | ✓ | ✗ |
| `docker image prune -f` **global** sur un serveur partagé | ✗ le fait | ✓ le refuse | ✗ le fait |
| Retour arrière **re-sondé** ; conteneur arrêté si rien à remettre | ✗ | ✓ | ✗ |
| Contrôles **avant de toucher** (secrets, cookie/https, admin initial, port…) | partiel | ✓ `controler_reglages` | partiel |
| Certificat vérifié **avant** la relance | ✗ après | ✗ après | ✗ après |
| Bloc nginx refusé : **l'ancien est remis** | ✗ supprimé → site sans porte | ✗ supprimé | ✗ supprimé |
| `verifier` (restauration réelle dans une base jetable) | ✓ | ✓ | ✗ absent |
| Prises quotidiennes **chiffrées** (gpg) | ✓ | ✓ | ✗ |
| Porte limitée par adresse (`ACCES_LIMITE`) | ✓ | ✓ | ✗ |
| **Banc** + preuve négative du script serveur | ✓ | ✓ | ✗ aucun test du script |

## 3. Sécurité

| # | Constat | Gravité | Où |
|---|---|---|---|
| S1 | Les comptes de déploiement sont **dans le groupe `docker`** : c'est un équivalent root (`docker run -v /:/h`). | **haute** | les trois LISEZMOI |
| S2 | Le `docker-compose.yml` **arrive par le pipeline**, écrit par le compte de déploiement : qui tient la clé SSH peut monter `/` dans un conteneur privilégié. | **haute** | `scp … docker-compose.yml` (×3) |
| S3 | Le bloc nginx est **rendu par le compte de déploiement** depuis un gabarit qu'il peut réécrire, puis posé par `sudo install`. Une directive `access_log /etc/…` est ouverte par le maître nginx, **en root**. | **haute** | `porte()` (×3) + sudoers |
| S4 | L'empreinte SSH du serveur **n'est pas vérifiée** (`appleboy/*` sans `fingerprint`) ; l'authentification par **mot de passe** est admise. | moyenne | les trois `deployer` |
| S5 | Actions tierces qui **reçoivent la clé SSH**, épinglées par étiquette (`appleboy/scp-action@v0.1.7`, `ssh-action@v1.0.3`). | moyenne | les trois `deployer` |
| S6 | Les clés SSH de déploiement ouvrent un **shell complet** (aucune `command=` forcée). | moyenne | `authorized_keys` |
| S7 | board et HR : l'administrateur pose en root un sudoers **déposé par le compte de déploiement lui-même** (`/opt/board/sudoers-deploy_board`). Réinstallé après une livraison piégée, il donne root. | moyenne | LISEZMOI board/HR |
| S8 | Les `.env` (mot de passe de base, secrets de session) appartiennent au **compte de déploiement**. | basse | les trois |

## 4. Qualité de la CI

| # | Constat | Où |
|---|---|---|
| Q1 | Purchase : le **lint ne bloque pas** (`npm run lint \|\| true` + `continue-on-error`). | `ci-frontend.yml` |
| Q2 | Purchase : les contrôles de PR sont **filtrés par chemin** et séparés ; une PR qui touche `deploiement/` ou la racine n'est pas éprouvée. `deploy-serveur.yml` rejoue tout, mais seulement **après** la fusion. | `ci-*.yml` |
| Q3 | Purchase : `npm cache clean --force` **annule** le cache qu'on vient de restaurer. | `ci-frontend.yml` |
| Q4 | Purchase : un « Run workflow » **déploie toujours** (pas de case à cocher, contrairement à board et HR). | `deploy-serveur.yml` |
| Q5 | HR : l'enregistrement de construction Docker **n'est pas désactivé** (`DOCKER_BUILD_RECORD_UPLOAD`) : un artefact par déploiement, sur un quota **déjà saturé** qui a fait tomber la paie le 14/09. board l'a désactivé. | `campagne.yml` HR |
| Q6 | Versions divergentes : Node 20 / 24, `actions/checkout@v4` / `@v7`, Postgres 16 (CI Purchase) / 18. | ×3 |
| Q7 | Purchase : `ci-backend.yml` déclare un service PostgreSQL **et** des Testcontainers. | `ci-backend.yml` |

## 5. Exploitation

| # | Constat |
|---|---|
| E1 | **Mettre en service une application nouvelle = 10 à 12 étapes manuelles** (board LISEZMOI : compte, clé, base, dossier, `.env`, sudoers, DNS, certificat, secrets GitHub…). |
| E2 | Aucune **vue d'ensemble** du serveur : trois `etat`, trois conventions. |
| E3 | Aucun **historique** des déploiements sur le serveur. |
| E4 | Aucune **copie hors machine** des sauvegardes (dit par les trois, fait par aucun). |
| E5 | La sauvegarde de 21 h n'est **surveillée par rien** (dit par HR). |

## 6. Ce qu'Infra-server en fait

| Constat | Réponse |
|---|---|
| §2 dérive des trois scripts | **Un seul outil** (`infra`), un seul banc, une seule preuve négative. Chaque correctif vaut pour toutes les applications. |
| §2 noms divergents | **Une** convention : `INFRA_SSH_*`, `X-Infra-App`, `/var/backups/infra/<app>`, `infra-sauvegarde@<app>.timer`. Les variables propres à chaque application sont **déclarées** dans son manifeste (`BASE_VARIABLES`), pas imposées. |
| Ports et heures à la main | `infra creer` **attribue** un port libre (8100–8199) et **décale** les heures de sauvegarde ; le registre refuse les doublons. |
| Faux échecs de la porte | sonde répétée (15 essais). |
| Bloc refusé = site sans porte | l'**ancien bloc est remis**. |
| Certificat découvert trop tard | vérifié à l'étape 0, **avant** toute relance. |
| `docker image prune` global | seulement les étiquettes de l'image de l'application. |
| S1, S2, S3, S7, S8 | Le compte de déploiement **n'a plus ni groupe docker, ni fichiers sur le serveur, ni sudoers qu'il écrit**. Son seul droit : `sudo infra livrer <son app> <sha>`. Compose et nginx sont **engendrés par root** depuis un manifeste **validé clé par clé** (volumes nommés seulement, pas de `privileged`, `no-new-privileges`). Les secrets sont `root 0600` dans `/etc/infra/secrets`. |
| S4, S5, S6 | SSH natif, **empreinte vérifiée** (`INFRA_SSH_KNOWN_HOSTS`), clé seule, **commande forcée** (`infra-ssh <app>`) + `restrict`. Aucune action tierce ne voit la clé. |
| Q1–Q7 | modèle de pipeline standard (lint bloquant, PR sur la fusion, case « deployer ») ; `DOCKER_BUILD_RECORD_UPLOAD: false` dans le workflow commun. |
| E1 | **Une commande** : `infra creer`. |
| E2, E3 | `infra etat`, `infra docteur`, `infra historique`. |
| E5 | `infra docteur` signale une prise de plus de 36 h. |
| E4 | **non fait** — voir README, « Ce qui n'est pas fait ». |
