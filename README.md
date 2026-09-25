# Infra-server

**Une seule façon de déployer, pour toutes les applications d'EntrepriseTools.**

- Sur le serveur, un outil, `infra`, dont chaque commande est un **verbe** :
  `infra creer`, `infra livrer`, `infra revenir`, `infra sauvegarder`,
  `infra etat`…
- Dans GitHub, **un workflow réutilisable** que chaque dépôt appelle.
- Pour démarrer une application, **un modèle de dépôt**.

Il remplace `paie.sh` (HR_Management), `pilotage.sh` (board) et
`procurement.sh` (Purchase_Management) : trois copies du même script qui
avaient dérivé. L'audit qui l'a motivé est dans **[AUDIT.md](AUDIT.md)**.

```
 DÉPÔT D'APPLICATION                         SERVEUR (Debian, 1 machine)
 ───────────────────                         ─────────────────────────────────────────────
 pipeline.yml                                 infra-ssh <app>        (commande forcée de la clé)
   ├─ vos tests (à vous)                        └─ sudo infra livrer <app> <sha>
   └─ deployer ──uses──▶ Infra-server/             0. contrôles (secrets, base, port, certificat)
        deployer.yml@v1                            1. docker load  <image>:<sha>
          1. bâtit l'image <image>:<sha>           2. pg_dump RELU (tjs, avant de toucher)
          2. bâtit l'écran (mode spa)              3. compose ENGENDRÉ, en-service, up -d
          3. une archive : app.conf +              4. sondes ; rouge → RETOUR ARRIÈRE re-sondé
             image.tar.gz [+ frontend.tar.gz]      5. écran (spa), bascule atomique
          4. ssh <compte>@serveur livrer <sha> ─▶  6. bloc nginx ENGENDRÉ, nginx -t, reload,
             (empreinte du serveur vérifiée)          sonde par le nom (X-Infra-App)
          5. sonde publique, depuis Internet       7. ménage (N versions gardées), historique

 Internet ─▶ nginx de l'hôte :80/:443 ─┬─▶ 127.0.0.1:<port> ─▶ conteneur (réseau de l'hôte) ─▶ PostgreSQL natif
                                        └─▶ /var/lib/infra/<app>/ecran/courant   (mode spa)
```

---

## Sommaire

1. [Pourquoi ni Helm ni Terraform](#1-pourquoi-ni-helm-ni-terraform)
2. [Les idées qui tiennent tout](#2-les-idées-qui-tiennent-tout)
3. [Installer infra sur le serveur (une fois)](#3-installer-infra-sur-le-serveur-une-fois)
4. [Mettre une application en service](#4-mettre-une-application-en-service)
5. [Les verbes](#5-les-verbes)
6. [Le manifeste — `deploiement/app.conf`](#6-le-manifeste--deploiementappconf)
7. [La fiche serveur — `/etc/infra/apps/<app>.conf`](#7-la-fiche-serveur--etcinfraappsappconf)
8. [Les secrets — `/etc/infra/secrets/<app>.env`](#8-les-secrets--etcinfrasecretsappenv)
9. [Le workflow réutilisable](#9-le-workflow-réutilisable)
10. [Un déploiement, pas à pas](#10-un-déploiement-pas-à-pas)
11. [Sécurité : qui peut quoi](#11-sécurité--qui-peut-quoi)
12. [Sauvegardes et restauration](#12-sauvegardes-et-restauration)
13. [Ce qui est où, sur le serveur](#13-ce-qui-est-où-sur-le-serveur)
14. [Tests : le banc et la preuve négative](#14-tests--le-banc-et-la-preuve-négative)
15. [Migrer les trois applications](#15-migrer-les-trois-applications)
16. [Dépannage](#16-dépannage)
17. [Ce qui n'est pas fait](#17-ce-qui-nest-pas-fait)
18. [Arborescence du dépôt](#18-arborescence-du-dépôt)

---

## 1. Pourquoi ni Helm ni Terraform

La question a été posée ; la réponse tient à **ce qu'est le serveur**.

| Outil | Ce qu'il fait | Pourquoi pas ici |
|---|---|---|
| **Helm** | Il installe des applications **dans un cluster Kubernetes** (des *charts*). | Il n'y a pas de Kubernetes, et il n'en faut pas : un serveur, trois applications, quelques utilisateurs chacune. Monter un k3s pour cela ajouterait un plan de contrôle, un réseau superposé, un registre d'images et un ingress, qu'il faudrait tous surveiller, sauvegarder et mettre à jour. Surtout, **la base est le PostgreSQL natif du serveur** (décision prise et mesurée par les trois dépôts), et nginx y est déjà partagé. |
| **Terraform** | Il **crée des ressources d'infrastructure** chez un fournisseur (VM, réseaux, DNS, buckets) et tient leur état. | Le serveur existe déjà (197.153.58.171), et le DNS est dans cPanel. Terraform n'a rien à créer. Il ne sait pas non plus faire ce qu'on lui demande ici : charger une image, sauvegarder, sonder, revenir en arrière. |
| **Ansible** | Il configure des machines (paquets, fichiers, services) de manière idempotente. | C'est le plus proche. Mais pour **une** machine, `sudo infra preparer` est idempotent, se lit en 60 lignes, et ne demande ni inventaire ni Python sur le poste. |

**Ce qu'on a retenu** : un outil en Bash avec des verbes, **systemd** pour les
minuteurs, **Docker Compose** (engendré) pour les conteneurs, le **nginx** de
l'hôte, et **GitHub Actions** avec un workflow **réutilisable**. Ce sont les
outils standards d'un serveur Debian. On les trouve documentés partout, et
aucun n'ajoute une couche à maintenir.

**Quand changer d'avis :**

- **Terraform**, le jour où l'on gère **plusieurs serveurs** ou des ressources
  cloud (une VM de secours, un bucket pour les sauvegardes hors machine, le
  DNS chez un fournisseur doté d'une API).
- **Ansible**, le jour où il y a **plusieurs serveurs** à préparer à
  l'identique. `infra` reste alors ce qu'Ansible installe.
- **Kubernetes et Helm**, le jour où une application doit tenir sur
  **plusieurs machines à la fois** (haute disponibilité, montée en charge).
  Rien de ce qui est connu aujourd'hui ne l'appelle.

Le **manifeste** (`app.conf`) a été pensé pour ne pas bloquer cette évolution.
Il décrit image, sondes, volumes et variables, soit exactement ce qu'un chart
Helm demanderait.

---

## 2. Les idées qui tiennent tout

1. **Un fait, un domicile.** Ce qui dépend du **code** est dans le dépôt de
   l'application (`deploiement/app.conf`, le *manifeste*). Ce qui dépend du
   **serveur** (compte, port, nom public, base, heure de sauvegarde) est dans
   la *fiche serveur* (`/etc/infra/apps/<app>.conf`). Les **secrets** sont dans
   `/etc/infra/secrets/<app>.env`. Il n'y a rien d'autre.
2. **Root engendre, le pipeline livre.** Le pipeline n'apporte que trois
   fichiers de données (manifeste, image, écran). Le compose et le bloc nginx
   sont **écrits par root**, depuis des gabarits posés par root et un
   manifeste **validé clé par clé**.
3. **Rien ne se touche sans une copie relue.** Chaque déploiement, chaque
   retour arrière, chaque restauration commence par un `pg_dump` qu'on relit
   (`pg_restore --list`).
4. **Un réglage faux arrête le passage *avant* la relance**, pendant que
   l'ancienne version sert encore.
5. **Une version qui ne répond pas est retirée d'elle-même.** La précédente
   est remise, sondée à nouveau, et le passage échoue **en le disant**.
6. **Une application ne touche jamais aux autres.** Chacune a son compte, son
   port, son projet compose, son bloc nginx, son tiroir de prises et son
   minuteur. Le nginx partagé est protégé par un verrou global, et un bloc
   refusé rend la place à **l'ancien**.
7. **Tout se dit.** Chaque refus nomme la cause et la commande qui corrige.
   Chaque passage s'inscrit dans `/var/log/infra/deploiements.log`.

---

## 3. Installer infra sur le serveur (une fois)

Le serveur ne connaît pas GitHub (ni git, ni jeton) : **c'est votre poste qui
lui apporte l'outil**.

```bash
# Depuis votre poste, dans une copie de ce dépôt.
# « admin » = un compte qui a sudo (PAS un compte de déploiement).
outils/pousser-sur-serveur.sh admin@197.153.58.171 --hote 197.153.58.171 --installer-paquets
```

Ce que cela fait :

1. envoie `bin/`, `lib/`, `modeles/`, `VERSION` et `installer.sh` par SSH ;
2. `installer.sh` (en root) vérifie chaque script (`bash -n`) **avant** de
   poser quoi que ce soit. Il copie ensuite l'outil dans un répertoire neuf,
   puis bascule vers `/opt/infra` en une fois, et pose :
   - `/usr/local/bin/infra` → `/opt/infra/bin/infra`
   - `/usr/local/bin/infra-ssh` (la commande forcée des clés de pipeline) ;
3. enchaîne sur **`infra preparer`**, qui :
   - vérifie les outils (nginx, client PostgreSQL, curl, openssl, ss, visudo,
     systemd, ssh-keygen) et les installe avec `--installer-paquets` ;
   - vérifie Docker et **compose v2**. S'ils manquent, il le dit et donne la
     marche à suivre officielle : il ne l'installe pas lui-même ;
   - vérifie que le compte `postgres` atteint PostgreSQL par le socket local
     (authentification *peer*, le défaut Debian) ;
   - crée `/etc/infra/{apps,secrets}` (les secrets en 0700),
     `/var/lib/infra`, `/var/backups/infra` (0700) et `/var/log/infra` ;
   - pose les unités systemd **modèles** `infra-sauvegarde@.service` et
     `infra-sauvegarde@.timer` ;
   - vérifie que `nginx.conf` inclut `conf.d/*.conf` et que `nginx -t` passe.

**Mettre à jour `infra`** : la même commande. Les fiches, secrets, états et
prises ne sont jamais touchés par une réinstallation.

Vérifier : `sudo infra version`, puis `sudo infra docteur`.

---

## 4. Mettre une application en service

### 4.1 Un dépôt neuf (ou ajouter l'outillage à un dépôt existant)

```bash
outils/nouveau-depot.sh facturation ../facturation --mode spa --frontend frontend --backend backend
# --github EntrepriseTools/facturation   → crée aussi le dépôt (gh) et pousse
```

Cela crée, sans jamais écraser un fichier existant :

| Fichier | Rôle |
|---|---|
| `.github/workflows/pipeline.yml` | vos tests (`serveur`, `ecran`), puis `deployer` qui **appelle** le workflow commun |
| `deploiement/app.conf` | le manifeste, à compléter ([§6](#6-le-manifeste--deploiementappconf)) |
| `deploiement/LISEZMOI.md` | la marche à suivre, pour ce dépôt |
| `Dockerfile.exemple`, `.dockerignore` | un point de départ pour l'image |

*Mode `proxy`* : le jar sert tout, et l'image se bâtit depuis la racine.
*Mode `spa`* : nginx sert l'écran, et l'image est celle du backend seul.

> **Le « repo template ».** `modeles/depot/` *est* le modèle, et
> `nouveau-depot.sh` l'instancie : il remplace les jetons (`__APP__`…) et
> retire le travail `ecran` s'il n'y a pas d'écran. On aurait pu utiliser la
> fonction « Template repository » de GitHub, mais elle copie les fichiers
> **sans les adapter**. Il aurait fallu ensuite éditer six fichiers à la main,
> ce qui est précisément ce qu'on veut éviter.

### 4.2 Sur le serveur : une commande

```bash
scp deploiement/app.conf admin@SERVEUR:/tmp/facturation.conf
ssh admin@SERVEUR
sudo infra creer facturation --manifeste /tmp/facturation.conf --url https://facturation.sbp.ma
```

`infra creer` fait, dans l'ordre :

| Étape | Ce qui est fait |
|---|---|
| 1. Compte | compte système `facturation`, **sans mot de passe** et hors du groupe docker |
| 2. Base | rôle et base `facturation` dans le PostgreSQL natif, avec un mot de passe **tiré au sort**. `log_statement` est coupé le temps de la commande, pour que le mot de passe n'atterrisse pas dans le journal. S'ils existent déjà, ils ne sont **pas** touchés. |
| 3. Secrets | `/etc/infra/secrets/facturation.env` (root 0600). On y trouve : les variables de base **sous les noms que l'application lit** (`BASE_VARIABLES`), les secrets tirés au sort (`SECRETS`), et les lignes vides à remplir (`VARIABLES_OBLIGATOIRES`). |
| 4. Fiche | `/etc/infra/apps/facturation.conf`, avec un **port libre** attribué entre 8100 et 8199 et une **heure de sauvegarde décalée** des autres |
| 5. Sudo | `/etc/sudoers.d/infra-facturation`, éprouvé par `visudo` **avant** d'être posé : `facturation` peut lancer `infra livrer/etat/historique facturation`, **et rien d'autre** |
| 6. Clé | une paire ed25519. La publique est posée **bridée** (`restrict,command="infra-ssh facturation"`). La privée est **affichée une fois** et n'est gardée nulle part sur le serveur. |
| 7. Minuteur | `infra-sauvegarde@facturation.timer`, armé |

Il affiche ensuite **exactement** ce qu'il faut poser dans GitHub.

### 4.3 Dans GitHub

Dans le dépôt de l'application : *Settings → Secrets and variables → Actions*.

| Type | Nom | Valeur |
|---|---|---|
| Secret | `INFRA_SSH_HOST` | l'adresse du serveur |
| Secret | `INFRA_SSH_USER` | le compte (affiché) |
| Secret | `INFRA_SSH_KEY` | la clé privée affichée, en entier |
| Secret | `INFRA_SSH_KNOWN_HOSTS` | la ligne affichée : `<hôte> ssh-ed25519 AAAA…` |
| Variable | `URL_PUBLIQUE` | `https://facturation.sbp.ma` (sonde depuis Internet) |

**Une fois pour toute l'organisation**, dans le dépôt Infra-server : *Settings
→ Actions → General → Access → « Accessible from repositories in the
EntrepriseTools organization »*. Sans ce réglage, les dépôts privés ne peuvent
pas appeler le workflow réutilisable. Poser aussi l'étiquette **`v1`** sur la
version validée (`git tag v1 && git push origin v1`) : les dépôts appellent
`deployer.yml@v1`.

### 4.4 Certificat, puis premier déploiement

```bash
# L'enregistrement DNS A doit pointer sur le serveur AVANT :
sudo certbot certonly --nginx -d facturation.sbp.ma
sudo infra editer facturation      # remplir ce qui est resté vide
```

Ensuite, **poussez sur `main`**. `sudo infra etat facturation` montre le
résultat.

> Pour éprouver l'application sur l'adresse publique **avant** d'avoir un
> certificat : `--url http://…`, et restreindre la porte à votre adresse IP
> avec `sudo infra regler facturation ACCES_LIMITE="1.2.3.4"`.

---

## 5. Les verbes

Tous se lancent en root (`sudo infra …`). Le compte de déploiement d'une
application ne peut lancer que `livrer`, `etat` et `historique`, et
**seulement pour elle**.

### Serveur

| Verbe | Ce qu'il fait |
|---|---|
| `infra preparer [--hote IP] [--installer-paquets]` | prépare le serveur ([§3](#3-installer-infra-sur-le-serveur-une-fois)). Sans danger à rejouer. |
| `infra docteur` | passe tout en revue **sans rien toucher** : nginx, docker, PostgreSQL, disque, et pour chaque application les secrets en 0600, le sudo, la clé, le minuteur, l'**âge de la dernière prise** (> 36 h = erreur), le conteneur, les sondes, la porte et le certificat (< 21 jours = erreur). Il signale aussi les restes de l'ancien outillage. Rend 1 s'il trouve une erreur. |
| `infra etat` | un tableau de toutes les applications : version, conteneur, sonde, dernière prise, URL |
| `infra etat <app>` | le détail d'une application : compose, sondes, minuteur, certificat, versions relançables |
| `infra liste` | les noms, un par ligne |
| `infra historique [app]` | les 30 derniers passages : déploiements, échecs, sauvegardes, réglages, et qui les a faits |

### Application

| Verbe | Ce qu'il fait |
|---|---|
| `infra creer <app> --manifeste F --url URL [options]` | [§4.2](#42-sur-le-serveur--une-commande). Options : `--port N`, `--compte C`, `--base B`, `--role R`, `--heure HH:MM`, `--projet P` (nom du projet compose), `--fichier-nginx F`, `--secrets FICHIER` (reprendre un .env existant), `--adopter` (compte ou base déjà là), `--depuis RÉP` (reprendre une application existante : son `.env` **et** sa version en service) |
| `infra regler <app>` | affiche la fiche |
| `infra regler <app> CLE=valeur …` | règle la fiche. La valeur est **validée** : une URL sans schéma ou un « ; » sont refusés, et la fiche reste alors intacte. Réglables : `URL PORT TLS_CERT TLS_CLE ACCES_LIMITE SAUVEGARDE_HEURE SAUVEGARDE_GARDER SAUVEGARDE_CLE_GPG GARDER_VERSIONS`. L'heure s'applique au minuteur tout de suite. Pour les autres clés, `infra relancer <app>`. |
| `infra editer <app>` | ouvre les secrets dans `$EDITOR`, puis les remet en root 0600 |
| `infra cle <app>` | tire une **nouvelle** clé de pipeline : l'ancienne cesse de fonctionner, et la nouvelle est affichée |
| `infra retirer <app> --confirmer <app>` | retire l'application du **service** : conteneur, porte, minuteur, sudo et clé. Base, prises, volumes et secrets **restent**, et le verbe dit comment les supprimer si c'est vraiment voulu. |

### Déploiement

| Verbe | Ce qu'il fait |
|---|---|
| `infra livrer <app> <sha>` | **ce que lance le pipeline.** Il reçoit l'archive sur l'entrée standard (6 Gio au plus). Avant d'extraire, il vérifie que l'archive ne contient que des **fichiers ordinaires**, et seulement `app.conf`, `image.tar.gz`, `frontend.tar.gz` ou `VERSION`. Puis il déploie ([§10](#10-un-déploiement-pas-à-pas)). |
| `infra deployer <app> <sha>` | déploie une version déjà reçue ou déjà chargée. Si c'est la version en service **et** qu'elle tourne, il reprend à l'écran et à la porte, sans relancer quoi que ce soit. |
| `infra revenir <app> [sha]` | remet la version **précédente** (d'après l'historique des versions acceptées), ou celle qu'on nomme. Il suit le même chemin qu'un déploiement : contrôles, **prise**, sondes, écran, porte. |
| `infra relancer <app>` | même image, compose et porte **réengendrés**. À lancer après `editer` ou `regler`. |
| `infra porte <app>` | repose seulement le bloc nginx |
| `infra journaux <app> [N \| -f]` | les journaux du conteneur |

### Base

| Verbe | Ce qu'il fait |
|---|---|
| `infra sauvegarder <app>` / `--toutes` `[--garder N]` | prend une prise **relue**, la chiffre si `SAUVEGARDE_CLE_GPG` est posée, et fait la rotation. C'est ce que lance le minuteur chaque soir. |
| `infra prises <app>` | les prises en magasin |
| `infra verifier <app> [prise]` | **restaure pour de vrai** dans une base jetable, puis compare **table par table** avec la base vivante. Sans argument, il utilise une prise neuve. La base jetable et la prise temporaire sont **toujours** balayées, même sur une erreur. |
| `infra restaurer <app> <prise> --confirmer <app>` | remplace la base **vivante**. Dans l'ordre : prise de l'état présent (le filet), arrêt du service, `pg_restore --clean --role=<rôle>`, relance, sondes. |

---

## 6. Le manifeste — `deploiement/app.conf`

Il est versionné dans le dépôt de l'application et livré avec **chaque**
déploiement. Sa syntaxe est `CLE=valeur` ; une liste se met entre guillemets,
avec des espaces. Il est **lu, jamais exécuté**. Une clé inconnue est refusée,
pour qu'une faute de frappe ne passe pas en silence.

| Clé | Défaut | Sens | Validation |
|---|---|---|---|
| `APP` | — | nom de l'application | doit être **égal** au nom sous lequel on livre : un manifeste d'une autre application est refusé |
| `IMAGE` | — | image, **sans** étiquette (l'étiquette est le SHA) | `[a-z0-9._/-]` |
| `SERVICE` | `app` | nom du service dans le compose engendré | |
| `MODE_WEB` | `proxy` | `proxy` : nginx renvoie tout à l'application. `spa` : nginx sert l'écran et renvoie `API_PREFIXE` | |
| `API_PREFIXE` | `/api/` | (spa) le chemin renvoyé à l'application | finit par `/` |
| `SONDES` | `/` | chemins sondés sur `127.0.0.1:<port>`, **dans l'ordre**. **Tous** doivent rendre 200. Le dernier doit toucher **la base** (`/api/moi`, `/actuator/health`). | chemins absolus |
| `SONDE_PUBLIQUE` | `/` | sondé par le nom, derrière nginx | |
| `VARIABLE_PORT` | `SERVER_PORT` | la variable qui reçoit le port | identifiant |
| `VARIABLE_ADRESSE` | `SERVER_ADDRESS` | la variable qui reçoit `127.0.0.1` | identifiant |
| `VOLUMES` | vide | `"nom:/chemin …"`, **volumes nommés seulement** | un chemin de l'hôte (`/:/x`) est **refusé** |
| `MEMOIRE` | `1g` | plafond mémoire du conteneur (la JVM en prend 70 %) | `512m`, `2g`… |
| `CORPS_MAX` | `16m` | `client_max_body_size` de nginx | |
| `DELAI_PROXY` | `120` | `proxy_read_timeout`, en secondes | |
| `BASE_VARIABLES` | vide | comment l'application lit sa base. Rendu **une fois**, par `infra creer`, dans les secrets. Jetons : `@JDBC@ @HOTE@ @PORT_BASE@ @BASE@ @ROLE@ @MOTDEPASSE@` | `CLE=valeur` sans espace ni guillemet |
| `SECRETS` | vide | secrets tirés au sort par `infra creer` : `CLE=hex:32`, `base64:64`, `mdp:20` | |
| `VARIABLES_FIXES` | vide | posées dans l'environnement du conteneur **à chaque déploiement**, et prioritaires sur les secrets. Jetons : `@URL@ @NOM@ @HTTPS@` (`true`/`false`) `@PORT@` | |
| `VARIABLES_OBLIGATOIRES` | vide | le déploiement est **refusé** si l'une d'elles est vide dans les secrets | |

Exemples réels : [`migration/*/app.conf`](migration/). Celui de la paie, par
exemple :

```ini
APP=paie
IMAGE=hr/paie
SERVICE=paie
MODE_WEB=proxy
SONDES="/ /api/moi"
VARIABLE_PORT=PAIE_PORT
VARIABLE_ADRESSE=PAIE_ADRESSE
VOLUMES="paie-etat:/var/lib/paie paie-journaux:/var/lib/paie/journaux"
BASE_VARIABLES="PAIE_BASE=@JDBC@ PAIE_UTILISATEUR=@ROLE@ PAIE_MOTDEPASSE=@MOTDEPASSE@"
VARIABLES_FIXES="PAIE_URL_PUBLIQUE=@URL@"
```

C'est ce mécanisme qui **unifie sans rien imposer** aux applications.
Chacune garde ses noms de variables (`PAIE_BASE`, `DATABASE_URL`, `PGHOST`),
et l'outil ne connaît que les siennes.

---

## 7. La fiche serveur — `/etc/infra/apps/<app>.conf`

Elle est écrite par `infra creer`, réglée par `infra regler`, et appartient à
root.

| Clé | Sens |
|---|---|
| `COMPTE` | le compte de déploiement (sa clé est bridée sur cette application) |
| `PROJET` | le nom du projet compose (préfixe des conteneurs et des volumes). Pour reprendre une application existante, on garde l'ancien (`hr`, `board`…), sinon ses volumes seraient recréés vides. |
| `PORT` | port de l'application sur 127.0.0.1. Unique dans le registre. |
| `URL` | l'adresse publique. Le schéma est **obligatoire** : c'est lui qui décide HTTP ou HTTPS. |
| `TLS_CERT`, `TLS_CLE` | vides = `/etc/letsencrypt/live/<nom>/…` |
| `ACCES_LIMITE` | adresses admises (les autres reçoivent 403). La boucle locale est toujours admise, pour les sondes. |
| `BASE_NOM`, `BASE_ROLE`, `BASE_PORT` | la base, dans le PostgreSQL natif |
| `FICHIER_NGINX` | `/etc/nginx/conf.d/<ceci>.conf` |
| `SAUVEGARDE_HEURE` | `HH:MM`, appliquée au minuteur |
| `SAUVEGARDE_GARDER` | nombre de prises quotidiennes gardées (30) |
| `SAUVEGARDE_CLE_GPG` | clé **publique** qui chiffre les prises quotidiennes. La privée n'est pas sur le serveur, et c'est voulu. |
| `GARDER_VERSIONS` | images et écrans relançables (5) |

---

## 8. Les secrets — `/etc/infra/secrets/<app>.env`

Ce fichier appartient à root, en 0600. Il est passé **tel quel** au conteneur
(`env_file`), et `infra` refuse de le lire si c'est un lien. Il n'est **jamais**
lu pour sauvegarder : la base est atteinte par le compte `postgres` sur le
socket local. Un secret faux ne peut donc pas empêcher la sauvegarde.

Pour les valeurs, s'en tenir à des caractères simples : lettres, chiffres,
tirets. Docker Compose interprète `$` et les guillemets. Les secrets tirés au
sort respectent déjà cette règle.

---

## 9. Le workflow réutilisable

[`.github/workflows/deployer.yml`](.github/workflows/deployer.yml) :

```yaml
  deployer:
    needs: [vos, travaux, de, test]
    if: github.ref == 'refs/heads/main' && (github.event_name == 'push' || inputs.deployer)
    uses: EntrepriseTools/Infra-server/.github/workflows/deployer.yml@v1
    with:
      application: procurement
      contexte: ./backend          # contexte de l'image
      frontend: frontend           # mode spa seulement
      url-publique: ${{ vars.URL_PUBLIQUE }}
    secrets: inherit
```

| Entrée | Défaut | Sens |
|---|---|---|
| `application` | — | = `APP` du manifeste (vérifié) |
| `manifeste` | `deploiement/app.conf` | |
| `contexte`, `dockerfile` | `.`, `<contexte>/Dockerfile` | |
| `frontend` | vide | répertoire de l'écran. **Obligatoire en mode spa** : le workflow refuse de livrer sans. |
| `frontend-node`, `frontend-commande`, `frontend-sortie` | `20`, `npm ci … && npm run build`, `dist` | |
| `frontend-env` | `VITE_API_URL=/api` `VITE_BASE_PATH=/` | une `CLE=valeur` par ligne |
| `url-publique` | vide | sondée **depuis Internet** : elle doit répondre avec `X-Infra-App: <app>` |
| `environnement` | `production` | environnement GitHub (règles d'approbation possibles) |

Ce qu'il fait, en détail :

1. il vérifie les quatre secrets et refuse `root` ;
2. il vérifie que le manifeste est celui de `application`, et qu'un mode
   `spa` a bien un `frontend` ;
3. il bâtit `<IMAGE>:<sha>` avec buildx, en utilisant le cache GitHub (portée
   = l'application). `DOCKER_BUILD_RECORD_UPLOAD: false` évite de remplir le
   quota d'artefacts, partagé à l'échelle du compte ;
4. il bâtit l'écran si c'est demandé, et vérifie `index.html` ;
5. il emballe l'archive, puis
   `ssh … "$COMPTE@$HOTE" "livrer $SHA" < livraison.tar`. Le SSH est
   **natif** : l'empreinte est vérifiée (`StrictHostKeyChecking=yes`) et le
   passage coupe au bout de 25 minutes. Aucune action tierce ne voit la clé.
6. il sonde l'URL publique (12 × 10 s), puis écrit un résumé dans la page du
   passage.

`concurrency: infra-deployer-<app>` : jamais deux livraisons de la même
application à la fois, et jamais une livraison annulée en route.

---

## 10. Un déploiement, pas à pas

Ce que fait `infra livrer <app> <sha>` sur le serveur. Chaque étape nomme ses
fichiers ; les renvois `lib/…` indiquent où lire le code.

| # | Étape | Détail | Si ça tombe |
|---|---|---|---|
| — | Réception | archive → `/var/lib/infra/<app>/livraisons/<sha>/`. Liste (`tar -tv`) **avant** extraction : que des fichiers ordinaires, que des noms attendus. Extraction `--no-same-owner`. `lib/verbes_deploiement.sh` | refus, rien n'est touché |
| 0 | Contrôles | manifeste validé (`lib/registre.sh`) ; secrets présents, fichier ordinaire, `root 600` ; `VARIABLES_OBLIGATOIRES` non vides ; la base existe ; le port n'est tenu ni par un conteneur étranger ni par un autre processus, ni par une autre application du registre ; **certificat présent** si https | refus, **l'ancienne version sert encore** |
| 1 | Image | `gunzip \| docker load`, puis `<IMAGE>:<sha>` doit exister | refus |
| 2 | Sauvegarde | `runuser -u postgres -- pg_dump -Fc` → `/var/backups/infra/<app>/avant-<date>_<sha>.dump`, **relue** par `pg_restore --list`. On garde les 10 dernières. `lib/base.sh` | refus, **rien n'est relancé** |
| 3 | Mise en service | compose **engendré** dans `/var/lib/infra/<app>/docker-compose.yml` (`lib/conteneur.sh`), `docker tag <sha> en-service`, `docker compose up -d <service>` | → 4 |
| 4 | Sondes | chaque chemin de `SONDES` sur `127.0.0.1:<port>`, 40 × 3 s | **retour arrière** : l'ancien manifeste, l'ancien compose et l'ancienne étiquette sont remis, puis **re-sondés**. S'il n'y a rien à remettre, le conteneur est arrêté. La prise est indiquée, avec la commande `infra restaurer`. Le passage est noté ÉCHEC. |
| — | Acceptation | le manifeste livré devient le manifeste accepté ; `<sha>` est noté dans `versions` et `en-service` | |
| 5 | Écran (spa) | `frontend.tar.gz` est vérifié (fichiers ordinaires, aucun chemin hors de l'archive), extrait dans `ecran/versions/<sha>`, puis le lien `ecran/courant` bascule **atomiquement** (`mv -T`). Il ne bascule **qu'après** un serveur vert. | refus, l'écran ne change pas |
| 6 | Porte | sous **verrou nginx global** : le bloc est rendu depuis `modeles/nginx/<mode>.conf.gabarit`, les `server_name` en double ailleurs sont refusés, l'ancien bloc est gardé de côté, le neuf est posé, puis `nginx -t`. **Refusé → l'ancien bloc est remis.** Accepté → reload, puis sonde par le nom (`--resolve nom:443:127.0.0.1`), 15 essais, qui exige `X-Infra-App: <app>`. Enfin, le certificat est vérifié : un certificat qui ne couvre pas le nom est signalé. `lib/porte.sh` | l'application tourne ; relancer `infra porte <app>` |
| 7 | Ménage | seulement les étiquettes **de cette image** au-delà de `GARDER_VERSIONS`, les vieux écrans et la livraison. Le passage est noté OK dans l'historique. | |

**Relancer le même SHA** (après une porte refusée, par exemple) : si la
version tourne déjà, on reprend directement aux étapes 5 et 6. Le passage ne
sort **jamais** en vert en disant « rien à faire » alors que la porte est
fermée. C'était un défaut de la paie, corrigé le 15 septembre.

---

## 11. Sécurité : qui peut quoi

| Acteur | Ce qu'il peut | Ce qu'il ne peut pas |
|---|---|---|
| **Le pipeline** (clé SSH d'une application) | envoyer une archive et lancer `infra livrer <son app> <sha>`, `etat`, `historique` | ouvrir un shell (commande forcée `infra-ssh` + `restrict` : ni pty, ni redirection de port) ; viser une autre application (le nom est **figé par la clé**) ; écrire un fichier sur le serveur ; toucher au compose, à nginx ou au sudoers |
| **Le compte de déploiement** | ce que `sudo` lui permet : les trois verbes ci-dessus, pour **son** application | docker (il n'est pas dans le groupe) ; lire les secrets (`root 0600`) |
| **Le code de l'application** (l'image) | tourner dans son conteneur, sur le réseau de l'hôte, avec ses volumes **nommés** et son plafond mémoire | monter l'hôte, être privilégié, gagner des privilèges (`no-new-privileges`) : le compose est écrit par root |
| **Le manifeste** (vient du dépôt) | décrire image, sondes, variables, volumes nommés | tout ce qui n'est pas dans la liste des clés ; un chemin de l'hôte ; un caractère qui ouvrirait une directive nginx ou YAML |
| **root** (`sudo infra`) | tout | — |

Les choix qui portent ce modèle :

- **Root ne lit que des fichiers qu'il possède**, sauf à un seul endroit : le
  manifeste d'une livraison, qui est validé clé par clé. L'état,
  l'historique, le compose et les blocs nginx vivent dans `/var/lib/infra`
  et `/etc/infra`, où personne d'autre n'écrit.
- **`sudo` remet l'environnement à zéro** (`env_reset`), et `bin/infra` fixe
  lui-même son `PATH` quand il est appelé par un autre compte. Les chemins
  de test (`INFRA_BANC`) sont refusés sous sudo.
- **Le sudoers est éprouvé par `visudo` avant d'être posé** : un fichier faux
  bloquerait `sudo` pour tout le monde.
- **La clé privée n'est gardée nulle part** sur le serveur. Pour en changer :
  `infra cle <app>`.
- **L'empreinte du serveur est vérifiée** par le pipeline.

Limites connues, dites plutôt que tues :

- le conteneur est sur le **réseau de l'hôte** : il atteint tout ce qui écoute
  sur 127.0.0.1, y compris les autres applications et PostgreSQL (avec son
  propre rôle). C'était déjà le cas dans les trois dépôts ; c'est ce qui
  évite d'ouvrir PostgreSQL au pont Docker ;
- `docker load` d'une image hostile ne donne que ce que donne l'image :
  c'est le code qu'on déploie, et il est éprouvé par vos tests.

---

## 12. Sauvegardes et restauration

| | Où | Quand | Gardées | Chiffrées |
|---|---|---|---|---|
| **quotidienne** | `/var/backups/infra/<app>/quotidien_<date>.dump[.gpg]` | `infra-sauvegarde@<app>.timer`, à `SAUVEGARDE_HEURE` (±5 min, rattrapée au redémarrage : `Persistent=true`) | `SAUVEGARDE_GARDER` (30) | si `SAUVEGARDE_CLE_GPG` est posée |
| **avant-déploiement** | `…/avant-<date>_<sha>.dump` | chaque `livrer`, `deployer` ou `revenir` | 10 | non (c'est celle qu'on restaure dans l'urgence) |
| **filet de restauration** | `…/avant-restauration-<date>.dump` | chaque `restaurer` | — | non |

Le minuteur lance `/usr/local/bin/infra`, que **seul root** peut modifier. Un
compte de déploiement ne peut donc pas faire exécuter son code en root chaque
soir. Le script de board le faisait déjà ; celui de Purchase le faisait à
moitié.

**Chiffrer** : importer la clé **publique** du cabinet dans le trousseau de
root (`sudo gpg --import cabinet.pub`), puis
`sudo infra regler <app> SAUVEGARDE_CLE_GPG=<id ou courriel>`.

**Éprouver la chaîne** (à faire après chaque changement notable) :
`sudo infra verifier <app>`.

**Restaurer** : `sudo infra prises <app>`, puis
`sudo infra restaurer <app> <prise> --confirmer <app>`.

---

## 13. Ce qui est où, sur le serveur

```
/opt/infra/                         l'outil (root, 0755) — bin/ lib/ modeles/ VERSION
/usr/local/bin/infra                → /opt/infra/bin/infra
/usr/local/bin/infra-ssh            commande forcée des clés de pipeline

/etc/infra/
  serveur.conf                      HOTE_PUBLIC
  apps/<app>.conf                   les FICHES (root 0644)
  secrets/<app>.env                 les SECRETS (root 0600, répertoire 0700)
/etc/sudoers.d/infra-<app>          le seul droit root du compte de l'application
/etc/systemd/system/
  infra-sauvegarde@.service|.timer  modèles
  infra-sauvegarde@<app>.timer.d/heure.conf
/etc/nginx/conf.d/<FICHIER_NGINX>.conf   la porte (ENGENDRÉE)

/var/lib/infra/<app>/
  app.conf                          le manifeste ACCEPTÉ (dernier déploiement vert)
  docker-compose.yml                ENGENDRÉ
  nginx.conf, nginx.precedent       le bloc rendu, et celui d'avant
  en-service, versions              la version qui sert, et l'historique des versions acceptées
  ecran/versions/<sha>/, ecran/courant   (mode spa)
  livraisons/<sha>/                 le temps d'un déploiement
/var/backups/infra/<app>/           les prises (0700)
/var/log/infra/deploiements.log     l'historique (date, app, sha, résultat, qui, détail)
/home/<compte>/.ssh/authorized_keys la clé bridée (… infra:<app>)
```

---

## 14. Tests : le banc et la preuve négative

```bash
sudo bash tests/banc.sh        # 82 contrôles, ≈ 10 s
sudo bash tests/mutations.sh   # 13 mutations, ≈ 2 min
```

**Le banc** lance les **vrais** verbes dans un répertoire jetable
(`INFRA_BANC=1`, `INFRA_PREFIXE=…`), avec des doubles de docker, PostgreSQL,
nginx, curl, systemctl, ss, visudo et ssh-keygen (`tests/doubles/`). Ces
doubles notent **l'ordre des gestes** dans `ordre.log`. Le banc ne lit pas des
intentions dans le code : il vérifie ce qui s'est passé. Il couvre :
préparation, création, adoption (`--depuis`), une livraison verte, une version
qui ne démarre pas (retour arrière), une relivraison de la même version, une
sauvegarde qui tombe (**rien n'est relancé**), un bloc nginx refusé (**l'ancien
revient**), `revenir`, les livraisons piégées (lien symbolique, fichier
inattendu, manifeste étranger, montage de l'hôte, clé inconnue), `regler`,
`sauvegarder`, `verifier`, `restaurer`, `infra-ssh`, `etat`, `docteur` et
`retirer`.

**La preuve négative** réintroduit, dans une copie du dépôt, treize défauts
précis (souvent des défauts vécus par l'un des trois dépôts), et exige que le
banc **tombe** à chaque fois. Une mutation qui survit signale un contrôle
manquant. Pendant l'écriture, elle a trouvé trois contrôles qui passaient pour
une mauvaise raison : l'un était mal visé, l'un trop faible, et le troisième
reposait sur un double de `ss` qui ne lisait pas le port. Tous trois sont
corrigés. Le banc, lui, a trouvé un vrai défaut dans l'outil : un
`tr < /dev/urandom | head` qui mourait sur SIGPIPE sous `pipefail`.

La CI d'Infra-server ([`.github/workflows/ci.yml`](.github/workflows/ci.yml))
joue shellcheck, `bash -n`, le banc et la preuve négative. Elle passe aussi
`actionlint` sur le workflow réutilisable et sur un dépôt engendré par le
modèle.

> Le banc crée un **compte système jetable**, qu'il supprime à la fin. Le
> lancer en CI ou dans un conteneur, **pas sur le serveur de production**.

---

## 15. Migrer les trois applications

Voir **[migration/LISEZMOI.md](migration/LISEZMOI.md)** : l'ordre de bascule,
les manifestes prêts (`migration/{paie,pilotage,procurement}/app.conf`),
la commande `infra creer --depuis` exacte pour chacune, le travail
`deployer` qui remplace l'ancien, et ce qu'on retire **après**.

La bascule ne déplace **aucune donnée** : mêmes bases, mêmes volumes (même
projet compose), même port, même fichier nginx.

---

## 16. Dépannage

| Symptôme | Cause probable | Faire |
|---|---|---|
| Pipeline : `Host key verification failed` | `INFRA_SSH_KNOWN_HOSTS` faux | sur le serveur : `ssh-keyscan -t ed25519 localhost`, puis remplacer `localhost` par l'adresse publique |
| Pipeline : `Permission denied (publickey)` | clé changée ou mal copiée | `sudo infra cle <app>`, puis recopier `INFRA_SSH_KEY` (BEGIN et END compris) |
| Pipeline : `sudo: a password is required` | sudoers absent | `sudo infra docteur`, puis recréer (`infra retirer` / `infra creer --adopter --depuis …`) |
| `workflow was not found` / `not accessible` | accès au workflow réutilisable | Infra-server → Settings → Actions → Access (§4.3), et l'étiquette `v1` |
| `variables obligatoires vides` | secrets incomplets | `sudo infra editer <app>` |
| `sonde /actuator/health → 000` | l'application n'a pas démarré | `sudo infra journaux <app> 200` : base, migration, secret… Le retour arrière est déjà fait. |
| `sonde … → 503` | l'application tourne, la base ne répond pas | `sudo -u postgres psql -l`, et le mot de passe dans les secrets |
| `« nom » est déjà servi par un autre bloc` | un autre fichier de nginx porte le même `server_name` | le retirer, ou changer l'URL |
| `ne répond pas par « app »` après le reload | un autre bloc répond (serveur par défaut), ou le nom ne résout pas | `curl -skD- -o/dev/null --resolve nom:443:127.0.0.1 https://nom/` |
| `un autre passage est en cours` | un déploiement tourne (ou a été tué) | attendre. Le verrou est un `flock` : il disparaît avec le processus. |
| Mauvaise version en service | | `sudo infra revenir <app>` |
| Tout vérifier | | `sudo infra docteur` |

---

## 17. Ce qui n'est pas fait

- **Copie des sauvegardes hors machine.** Les prises sont sur le disque qui
  porte la base (les trois dépôts le disaient déjà). Prochaine étape : un
  `rsync`/`rclone` vers un stockage externe, après la prise, avec les
  prises chiffrées.
- **Alerte active.** `infra docteur` voit une prise trop vieille ou un
  certificat qui expire, mais personne n'est prévenu. On pourrait le brancher
  sur un minuteur qui envoie un courriel, ou sur la supervision de la paie.
- **La supervision de la paie** (`paie.sh supervision …`, Loki/Grafana) est
  propre à HR_Management et n'est pas reprise par `infra`. Voir la migration.
- **La voie native de la paie** (`paie_kotlin/deploiement/debian/`, gelée)
  n'est pas touchée.
- **Plusieurs serveurs** : `infra` en gère un. Voir [§1](#1-pourquoi-ni-helm-ni-terraform).
- **Rien n'a encore tourné sur le vrai serveur.** Le banc et la preuve
  négative éprouvent la logique contre des doubles. Le premier passage réel
  se fait application par application, en suivant la migration, en
  commençant par la moins critique (Pilotage).

---

## 18. Arborescence du dépôt

```
README.md                  ce fichier
AUDIT.md                   l'audit des trois pipelines
VERSION                    1.0.0
installer.sh               pose /opt/infra et lance « infra preparer »
bin/infra                  le point d'entrée : un verbe → une fonction
bin/infra-ssh              la commande forcée des clés de pipeline
lib/
  commun.sh                affichage, chemins, validations, lecture des réglages, verrous
  registre.sh              fiche serveur + manifeste (chargement, validation)
  base.sh                  PostgreSQL : rôle, base, prise relue, comptage
  conteneur.sh             compose engendré, sondes, ménage, versions
  porte.sh                 nginx : rendu, pose, retour à l'ancien, sonde
  verbes_serveur.sh        preparer, etat, liste, journaux, historique, docteur
  verbes_app.sh            creer, regler, editer, cle, retirer
  verbes_deploiement.sh    livrer, deployer, revenir, relancer, porte
  verbes_base.sh           sauvegarder, prises, verifier, restaurer
modeles/
  nginx/proxy.conf.gabarit, spa.conf.gabarit
  systemd/infra-sauvegarde@.service, infra-sauvegarde@.timer
  depot/                   le modèle de dépôt d'application
outils/
  nouveau-depot.sh         instancie modeles/depot
  pousser-sur-serveur.sh   installe / met à jour infra sur le serveur
migration/                 manifestes et marche à suivre pour les trois applications
tests/
  banc.sh, mutations.sh, doubles/
.github/workflows/
  deployer.yml             LE workflow réutilisable
  ci.yml                   la campagne d'Infra-server
```
