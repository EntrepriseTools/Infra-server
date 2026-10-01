# Infra-server

**Le dépôt de déploiement des applications d'EntrepriseTools** — paie
(HR_Management), pilotage (board) et procurement (Purchase_Management) — sur
un serveur Debian unique.

Il porte **deux voies de déploiement**, qui **coexistent** sur le même serveur
et la même base PostgreSQL :

| | **Voie `infra`** (en service) | **Voie Kubernetes** (la plateforme) |
|---|---|---|
| En une phrase | un outil Bash, `infra`, dont chaque commande est un verbe | un cluster k3s piloté par Terraform, Helm et Argo CD (GitOps) |
| Les conteneurs | Docker Compose, engendré par root | pods Kubernetes, décrits par un chart Helm commun |
| Le déploiement | la CI pousse une archive par SSH : `infra livrer` | la CI écrit dans Git ; Argo CD, dans le cluster, applique (*pull*) |
| L'entrée HTTP | nginx de l'hôte, bloc engendré | Traefik (derrière nginx tant que les deux voies coexistent) |
| La base | PostgreSQL natif | **le même** PostgreSQL natif |
| Les secrets | `/etc/infra/secrets/<app>.env` (root 0600) | chiffrés dans Git (Sealed Secrets) |
| La sécurité de la livraison | clé SSH bridée, empreinte du serveur vérifiée | images scannées (Trivy), **signées** (cosign), vérifiées à l'admission (Kyverno) |
| Le retour arrière | `infra revenir <app>` | `git revert` du commit de déploiement |
| Pour qui, pour quoi | la production d'aujourd'hui : simple, éprouvé | apprendre l'outillage standard (Kubernetes, Terraform, Helm, DevSecOps) et préparer la croissance |
| Documentation | la **[partie B](#partie-b--la-voie-infra)** de ce fichier | la **[partie A](#partie-a--la-plateforme-kubernetes)** de ce fichier, puis **[docs/plateforme/](docs/plateforme/00-LISEZMOI.md)** |

**Où en est-on ?** Les trois applications sont livrées par `infra`. La
plateforme Kubernetes est dans le dépôt, testée par la CI, et **pas encore
installée sur le serveur**. On y fait passer les applications **une par une**
— pilotage d'abord, paie en dernier — avec un retour arrière possible à
chaque étape ([migration](docs/plateforme/09-migration.md)).

---

## Sommaire

**Partie A — La plateforme Kubernetes**

- [A.1 Pourquoi une plateforme Kubernetes sur un seul serveur](#a1-pourquoi-une-plateforme-kubernetes-sur-un-seul-serveur)
- [A.2 L'architecture en un schéma](#a2-larchitecture-en-un-schéma)
- [A.3 Chaque outil, son rôle, et pourquoi lui](#a3-chaque-outil-son-rôle-et-pourquoi-lui)
- [A.4 Ce qui se passe quand on pousse du code](#a4-ce-qui-se-passe-quand-on-pousse-du-code)
- [A.5 Ce qui se passe quand on change la plateforme](#a5-ce-qui-se-passe-quand-on-change-la-plateforme)
- [A.6 La sécurité, couche par couche](#a6-la-sécurité-couche-par-couche)
- [A.7 Les workflows GitHub Actions](#a7-les-workflows-github-actions)
- [A.8 Démarrer : le labo, puis le serveur](#a8-démarrer--le-labo-puis-le-serveur)
- [A.9 Les commandes du quotidien](#a9-les-commandes-du-quotidien)
- [A.10 Où est quoi dans le dépôt](#a10-où-est-quoi-dans-le-dépôt)
- [A.11 Ce qui reste à faire](#a11-ce-qui-reste-à-faire)

**Partie B — La voie `infra`**

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

# Partie A — La plateforme Kubernetes

Cette partie explique **ce qu'est la plateforme, comment elle fonctionne et
comment s'en servir**. Chaque sujet est ensuite approfondi dans
[docs/plateforme/](docs/plateforme/00-LISEZMOI.md) (13 chapitres, un parcours
d'apprentissage sur 6 semaines et 15 travaux pratiques).

## A.1 Pourquoi une plateforme Kubernetes sur un seul serveur

La [partie B, §1](#1-pourquoi-ni-helm-ni-terraform) explique pourquoi `infra`
suffit pour un serveur et trois applications — et ce raisonnement reste
juste. La plateforme existe pour deux autres raisons, assumées :

1. **Apprendre** l'outillage que l'industrie utilise (Kubernetes, Terraform,
   Helm, GitOps, signature d'images, politiques d'admission) sur un vrai
   système, plutôt que sur des exemples jetables.
2. **Anticiper** : le jour où il faut un deuxième serveur, de la haute
   disponibilité ou une application de plus, le travail est déjà fait.

Trois règles la gardent raisonnable :

- **Rien n'est cassé** : `infra` reste en service ; les deux voies coexistent.
- **Les données ne bougent pas** : PostgreSQL reste natif, hors du cluster.
  Supprimer tout le cluster ne supprime aucune base.
- **Tout passe d'abord par le labo** : la plateforme entière tourne sur votre
  poste (`plateforme/labo/labo.sh`), avec le même code.

## A.2 L'architecture en un schéma

```
                       ┌──────────────────────────── GitHub ────────────────────────────┐
  Dépôt d'application  │ pipeline.yml ──uses──▶ Infra-server/k8s-publier.yml             │
  (board, HR, Purchase)│   tests       construire → scanner → pousser GHCR → signer      │
                       │               → SBOM → commit dans gitops/ ────────────────┐   │
  Dépôt Infra-server   │ plateforme-qualite.yml   tests, lint, scans (chaque PR)     │   │
                       │ plateforme-terraform.yml plan (PR) / apply (main, approuvé) │   │
                       │ gitops/applications/<app>/values.yaml ◀────────────────────┘   │
                       └───────────────────────────────▲───────────────────┬────────────┘
                                   Argo CD LIT Git ────┘                   │ tunnel SSH
  ┌──────────────────────────────── SERVEUR ──────────────────────────────┼─────────────┐
  │ Internet :443 ─▶ nginx de l'hôte ─┬─▶ applications encore sur `infra` (Compose)      │
  │                  (TLS, certbot)   └─▶ Traefik 10.43.0.80 ─▶ Service ─▶ pods          │
  │                                                                       ▼             │
  │  ┌──────────────── k3s (Kubernetes) ────────────────────────┐   API (127.0.0.1)     │
  │  │ socle, par Terraform : traefik · cert-manager · argocd ·  │                       │
  │  │                        kyverno · observabilite           │                       │
  │  │ par Argo CD          : sealed-secrets · pilotage ·        │                       │
  │  │                        procurement · paie                 │                       │
  │  └──────────────────────────────────┬───────────────────────┘                       │
  │  PostgreSQL NATIF ◀── Service « postgres » de chaque espace d'application            │
  └─────────────────────────────────────────────────────────────────────────────────────┘
```

Trois couches, trois outils, trois rythmes :

| Couche | Contenu | Outil | Change… | Appliqué par |
|---|---|---|---|---|
| **Le cluster** | k3s, pare-feu, comptes du pipeline | scripts `plateforme/amorcage/` | rarement | un humain, en SSH |
| **Le socle** | Traefik, cert-manager, Argo CD, Kyverno, supervision, un espace par application | **Terraform** | toutes les quelques semaines | GitHub Actions, **après approbation** |
| **Les applications** | Deployment, Service, Ingress, secrets, sauvegarde | **Helm** + **Argo CD** | plusieurs fois par jour | Argo CD, depuis Git |

Pourquoi trois couches ? Parce que les risques diffèrent : une erreur dans le
socle peut couper toutes les applications, elle passe donc par un `plan` relu
et une approbation humaine. Une nouvelle version d'application est fréquente
et réversible : un simple commit suffit.

## A.3 Chaque outil, son rôle, et pourquoi lui

| Outil | Ce qu'il fait ici | Pourquoi lui (et pas un autre) |
|---|---|---|
| **k3s** | Kubernetes complet en un binaire, avec etcd embarqué (instantanés toutes les 6 h) | léger, certifié CNCF, cohabite avec Docker ; kubeadm demanderait plus d'entretien pour le même résultat |
| **Terraform** | décrit le socle comme du code ; son *state* est stocké dans le cluster (Secret chiffré, verrouillé pendant un apply) | standard de l'IaC ; le code passe aussi avec OpenTofu |
| **Helm** | un chart **commun** (`plateforme/helm/application`) + des valeurs par application — l'équivalent du `app.conf` d'`infra` | un seul code testé (30 tests unitaires, schéma strict des valeurs), N applications |
| **Argo CD** | lit `gitops/` et fait converger le cluster ; défait toute modification manuelle (*selfHeal*) | modèle *pull* : la CI n'a **aucun** accès au cluster ; Git devient le journal d'audit et le bouton « retour » |
| **Traefik** | contrôleur d'entrée HTTP (taille max des requêtes, en-têtes de sécurité, liste blanche) | celui de k3s ; ingress-nginx a atteint sa fin de maintenance en mars 2026 |
| **cert-manager** | émet et renouvelle les certificats Let's Encrypt (le jour où Traefik prend 80/443) | standard Kubernetes |
| **Kyverno** | refuse (ou signale) les images non signées, hors registre, en `latest`, sans limites de ressources | politiques en YAML, vérification de signatures intégrée |
| **Sealed Secrets** | chiffre les secrets avec la clé publique du cluster : on peut les committer | pas de coffre à héberger ; installé **par Argo CD** pour que le compte du `plan` Terraform ne puisse jamais lire sa clé |
| **Prometheus / Grafana** | métriques, tableaux, alertes (certificat qui expire, sauvegarde échouée, application dégradée) | kube-prometheus-stack, taillé pour un serveur ; facultatif |
| **Trivy, cosign, zizmor** | scan des images et de la configuration ; signature sans clé ; audit des workflows | la chaîne d'approvisionnement logicielle (voir A.6) |

Ce qui reste **hors** du cluster, volontairement : PostgreSQL et ses
sauvegardes quotidiennes (`infra sauvegarder`), nginx et certbot pendant la
coexistence.

## A.4 Ce qui se passe quand on pousse du code

Un développeur pousse sur `main` dans le dépôt `board` :

1. **Tests** — ceux de l'application (ils restent à elle).
2. **`k8s-publier.yml`** (workflow commun d'Infra-server) :
   1. construit l'image `ghcr.io/entreprisetools/board/pilotage:<sha>` ;
   2. la **scanne avec Trivy** *avant* de la pousser : une faille corrigeable
      HIGH/CRITICAL arrête tout, rien n'atteint le registre ;
   3. la pousse sur GHCR et retient son **empreinte** `sha256:…` (immuable,
      contrairement à une étiquette) ;
   4. la **signe avec cosign, sans clé** : un certificat éphémère prouve
      « signé par `Infra-server/k8s-publier.yml@v1` », inscrit dans le journal
      public Rekor ;
   5. produit le **SBOM** (la liste de tout ce que contient l'image) ;
   6. écrit `image.tag` et `image.empreinte` dans
      `gitops/applications/pilotage/values.yaml` — un commit
      `deploy(pilotage): <sha>` signé par une GitHub App au jeton d'une heure.
3. **Argo CD** voit le commit (≤ 2 min) :
   1. **avant tout**, un Job fait un `pg_dump` de la base et le **relit**
      (`pg_restore --list`) — le principe d'`infra`, gardé. S'il échoue, rien
      n'est déployé ;
   2. il applique le nouveau Deployment. **Kyverno** vérifie la signature, le
      registre et les ressources ; **Pod Security** vérifie non-root et sans
      privilège ;
   3. le nouveau pod ne reçoit du trafic qu'une fois sa sonde de préparation
      verte. L'ancien n'est retiré qu'à ce moment-là. S'il ne devient jamais
      prêt, l'ancien continue de servir.
4. **Vérification** : le workflow interroge l'adresse publique jusqu'à lire
   `X-Infra-Version: <sha>`.

**Revenir en arrière** : `git revert` du commit `deploy(pilotage): …` →
Argo CD redéploie l'empreinte précédente (la sauvegarde est refaite avant).

## A.5 Ce qui se passe quand on change la plateforme

1. PR sur Infra-server qui touche `plateforme/terraform/` :
   - **qualité** : `terraform fmt`, `validate`, **`terraform test`** (15 tests,
     providers simulés), tflint, trivy ;
   - **plan** : le workflow ouvre un tunnel SSH vers l'API, se connecte avec le
     compte **`terraform-plan`** (lecture seule) et publie le plan en
     commentaire de la PR.
2. Merge sur `main` → **apply**, dans l'environnement GitHub `production` :
   le travail **attend qu'un relecteur approuve**, puis applique *exactement*
   le plan calculé, avec le compte `terraform-apply`.

Pourquoi deux comptes ? `terraform plan` exécute du code venu de la PR. Avec
un compte en lecture seule, qui ne peut lire ni les secrets des applications
ni la clé de Sealed Secrets, une PR piégée ne peut rien casser ni voler.

## A.6 La sécurité, couche par couche

| Couche | Ce qui protège | Contre quoi |
|---|---|---|
| **Hôte** | garde nftables : API (6443), kubelet, etcd, VXLAN et PostgreSQL fermés vers Internet ; API joignable **seulement** par un tunnel SSH bridé | un scan de ports, un accès direct à l'API |
| **Cluster** | journal d'audit de l'API ; Secrets chiffrés dans etcd ; Pod Security `baseline` par défaut | une action non tracée ; un instantané volé |
| **Espace d'application** | Pod Security **`restricted`** ; quotas ; NetworkPolicy « tout refusé » puis DNS, base et Traefik seulement | une application qui déborde ou qui cherche à atteindre les autres |
| **Admission** | Kyverno : signature, registre, pas de `latest`, ressources déclarées | une image poussée à la main, même avec un jeton volé |
| **Pod** | UID 10001, capacités retirées, seccomp, racine en lecture seule, aucun jeton d'API | un conteneur compromis qui veut devenir root |
| **Chaîne de livraison** | actions GitHub épinglées par SHA ; binaires vérifiés par somme SHA-256 ; Trivy ; SBOM ; zizmor sur tous les workflows | une dépendance ou une action GitHub piégée (cas réel : mars 2026) |
| **Privilèges** | CI des applications sans accès au cluster ; AppProject Argo CD sans objets de cluster ; plan en lecture seule ; apply approuvé | une PR ou une valeur malveillante |

Les écarts assumés (par exemple pas de limite CPU, ou PostgreSQL qui écoute
sur l'IP de l'hôte, derrière le pare-feu) sont écrits et justifiés dans
[07-devsecops.md](docs/plateforme/07-devsecops.md#7-les-écarts-assumés-une-sécurité-honnête-les-écrit).

Kyverno démarre en mode **Audit** (il signale sans refuser). On lit les
rapports, puis on passe en **Enforce** (`kyverno_action` dans
`terraform.tfvars`).

## A.7 Les workflows GitHub Actions

| Workflow | Quand | Ce qu'il fait | Touche au cluster ? |
|---|---|---|---|
| `plateforme-qualite.yml` | chaque PR, chaque push | Terraform (fmt, validate, test, tflint), Helm (lint, unittest, kubeconform), trivy, zizmor, shellcheck ; le travail **`garde (qualité)`** les résume | non |
| `plateforme-terraform.yml` | PR → plan ; `main` → apply approuvé | le socle ; sans les secrets, le plan dit « Plateforme non raccordée » au lieu d'échouer | oui, par tunnel SSH |
| `k8s-publier.yml` | appelé par les dépôts d'application | construire, scanner, pousser, signer, SBOM, promouvoir, vérifier | **non** (écrit dans Git) |
| `ci.yml`, `deployer.yml` | voie `infra` | voir la partie B | — |

**Contrôles à rendre obligatoires** sur `main` : `garde (qualité)` et
`shellcheck et banc`.

Les secrets à créer (détail et valeurs :
[06-ci-cd-github-actions.md §2](docs/plateforme/06-ci-cd-github-actions.md#2-mise-en-route-une-fois-pas-à-pas)) :

| Où | Nom | Rôle |
|---|---|---|
| Infra-server | `PLATEFORME_SSH_HOST`, `_USER`, `_KEY`, `_KNOWN_HOSTS` | le tunnel vers l'API |
| Infra-server | `ARGOCD_CLE_DEPOT`, `ARGOCD_ADMIN_BCRYPT` | l'accès d'Argo CD au dépôt, son mot de passe admin (empreinte seulement) |
| environnement `plateforme-plan` | `PLATEFORME_KUBECONFIG_PLAN` | compte en lecture seule |
| environnement `production` (**relecteur obligatoire**) | `PLATEFORME_KUBECONFIG_APPLY` | compte administrateur |
| organisation | `GITOPS_APP_CLIENT_ID`, `GITOPS_APP_CLE` | la GitHub App qui écrit les promotions dans `gitops/` |

> ⚠ Créer l'environnement `production` **avec un relecteur obligatoire** avant
> de poser les secrets : un environnement créé automatiquement par GitHub n'a
> aucune protection.

## A.8 Démarrer : le labo, puis le serveur

**1. Sur votre poste — le labo** (docker, [k3d](https://k3d.io), kubectl,
helm, terraform) :

```bash
plateforme/labo/labo.sh creer       # cluster k3d + PostgreSQL dans Docker
export TF_VAR_argocd_cle_depot="$(cat ~/.ssh/argocd-depot)"
export TF_VAR_argocd_admin_bcrypt="$(htpasswd -nbBC 12 '' labo | tr -d ':\n')"
plateforme/labo/labo.sh appliquer   # tout le socle, avec le même Terraform
plateforme/labo/labo.sh argocd      # l'interface sur http://localhost:8080
make -C plateforme tout             # les contrôles de la CI, en local
```

Suivre ensuite les [travaux pratiques](docs/plateforme/11-travaux-pratiques.md).

**2. Sur le serveur** (en root) :

```bash
sudo plateforme/amorcage/installer-k3s.sh --pare-feu            # k3s durci + garde nftables
sudo plateforme/amorcage/compte-tunnel-ci.sh                    # le tunnel de la CI (4 secrets)
sudo plateforme/amorcage/kubeconfig-pipeline.sh terraform-plan  # → PLATEFORME_KUBECONFIG_PLAN
sudo plateforme/amorcage/kubeconfig-pipeline.sh terraform-apply # → PLATEFORME_KUBECONFIG_APPLY
sudo plateforme/amorcage/identifiants-registre.sh <robot>       # tirer les images de GHCR
sudo plateforme/amorcage/ouvrir-postgres-aux-pods.sh            # puis redémarrer PostgreSQL au calme
```

**3. Dans GitHub** : environnements, secrets, GitHub App, étiquette `v1`
([06 §2](docs/plateforme/06-ci-cd-github-actions.md)). Puis lancer
`plateforme · terraform` sur `main` et **approuver** l'apply.

**4. Migrer pilotage**, puis procurement, puis paie
([09-migration.md](docs/plateforme/09-migration.md)) : nom de test,
vérification, bascule en quelques secondes, retour arrière possible.

## A.9 Les commandes du quotidien

| Je veux… | Je fais… |
|---|---|
| déployer une version | pousser sur `main` dans le dépôt de l'application |
| revenir en arrière | `git revert` du commit `deploy(<app>): …` dans Infra-server |
| changer la mémoire, une variable, le nom public | PR sur `gitops/applications/<app>/values.yaml` |
| changer un secret | `plateforme/outils/sceller.sh <app> fichier.env`, coller le bloc, PR |
| ajouter une application | une entrée dans `terraform.tfvars`, puis un dossier `gitops/applications/<app>/` ([04 §6](docs/plateforme/04-helm.md#6-ajouter-une-application-pas-à-pas)) |
| voir l'état | `sudo k3s kubectl -n argocd get applications` · `sudo k3s kubectl get pods -A` |
| lire les journaux | `sudo k3s kubectl -n <app> logs deploy/<app> -f` |
| voir les violations de politique | `sudo k3s kubectl get policyreport -A` |
| ouvrir Argo CD ou Grafana | par tunnel SSH ([05 §5](docs/plateforme/05-gitops-argocd.md#5-accéder-à-linterface), [08 §2](docs/plateforme/08-observabilite.md)) |
| réparer | [10-exploitation.md](docs/plateforme/10-exploitation.md) : dépannage par symptôme, restaurations, reconstruction complète |

## A.10 Où est quoi dans le dépôt

```
plateforme/
  amorcage/          ce que Terraform ne peut pas faire : k3s durci, pare-feu, comptes et tunnel
                     de la CI, PostgreSQL ouvert aux pods, pont nginx (coexistence)
  terraform/
    modules/espace-application/   un espace prêt : Pod Security, quotas, réseau fermé, Service « postgres »
    plateforme/                   le socle : Traefik, cert-manager, Argo CD, Kyverno, supervision
  helm/
    application/     LE chart commun des applications (+ tests unitaires, schéma des valeurs)
    socle/           politiques Kyverno, émetteurs TLS, projets et ApplicationSet Argo CD
  outils/sceller.sh  chiffrer un secret pour le cluster
  labo/              la plateforme sur votre poste (k3d)
  Makefile           les contrôles de la CI en local (make tout)
gitops/applications/<app>/values.yaml   l'état voulu de chaque application, lu par Argo CD
modeles/depot-k8s/   le modèle de dépôt d'application (pipeline, Dockerfile non-root, écran)
docs/plateforme/     la documentation détaillée et le parcours d'apprentissage
renovate.json        les mises à jour de dépendances, proposées en PR chaque lundi
```

## A.11 Ce qui reste à faire

- **Installer la plateforme sur le serveur** (A.8) : rien n'a encore tourné
  sur un vrai cluster. Le code est validé par la CI (tests Terraform et Helm,
  schémas Kubernetes stricts, scans), mais les valeurs passées aux charts
  tiers ne sont éprouvées qu'à l'installation : le labo est fait pour ça.
- **Remplacer les valeurs « À VÉRIFIER »** dans `gitops/applications/*/values.yaml`
  (noms publics de pilotage et paie, base de procurement) et `courriel_acme`
  dans `terraform.tfvars`.
- **Sauvegarder hors du serveur** la clé privée de Sealed Secrets dès
  l'installation ([10 §4](docs/plateforme/10-exploitation.md)).
- **Brancher Alertmanager** sur un vrai canal (courriel) : les alertes existent,
  personne n'est encore prévenu.
- **Passer Kyverno en Enforce** une fois les rapports propres.
- Plus tard : mode direct (Traefik sur 80/443), journaux centralisés (Loki),
  déploiements progressifs (Argo Rollouts), un deuxième nœud.

---

# Partie B — La voie `infra`

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

> **Depuis : la voie Kubernetes existe, à côté.** Pour monter en compétence
> sur Kubernetes, Terraform, Helm et le DevSecOps — et préparer le jour où
> l'un des cas ci-dessus arrive — le dépôt porte aussi une **plateforme
> Kubernetes** complète (k3s durci, Terraform, Helm, Argo CD, Kyverno,
> signatures d'images, GitHub Actions). Elle **coexiste** avec `infra` : on
> y migre une application à la fois, avec un retour arrière à chaque étape.
> Les raisons ci-dessus restent vraies ; la plateforme est un choix
> d'apprentissage et d'anticipation, assumé comme tel.
> → **[Partie A](#partie-a--la-plateforme-kubernetes)** et **[docs/plateforme/](docs/plateforme/00-LISEZMOI.md)**

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
- **Plusieurs serveurs** : `infra` en gère un. Voir [§1](#1-pourquoi-ni-helm-ni-terraform)
  et la [plateforme Kubernetes](#partie-a--la-plateforme-kubernetes).
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
  plateforme-qualite.yml   ┐
  plateforme-terraform.yml ├ la voie Kubernetes (docs/plateforme/)
  k8s-publier.yml          ┘
plateforme/                la voie Kubernetes : amorçage k3s, Terraform, charts Helm, labo
gitops/                    l'état voulu des applications, lu par Argo CD
docs/plateforme/           la documentation et le parcours d'apprentissage de la voie Kubernetes
```
