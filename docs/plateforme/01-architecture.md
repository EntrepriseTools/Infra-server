# 01 — Architecture

## 1. La vue d'ensemble

```
                         ┌──────────────────────────── GitHub ─────────────────────────────┐
                         │                                                                  │
  Dépôt d'application    │  pipeline.yml ──uses──▶ Infra-server/k8s-publier.yml             │
  (board, HR, Purchase)  │     tests        1 construire  2 scanner (Trivy)  3 pousser GHCR │
                         │                  4 signer (cosign)  5 SBOM  6 commit gitops/ ────┼──┐
                         │                                                                  │  │
  Dépôt Infra-server     │  plateforme-qualite.yml   (PR) tests · lint · scans               │  │
                         │  plateforme-terraform.yml (PR) plan ─ (main) apply ──┐            │  │
                         │  gitops/applications/*/values.yaml ◀─────────────────┼────────────┼──┘
                         └──────────────────────────────────────────────────────┼────────────┘
                                         ▲ Argo CD LIT (pull, deploy key)        │ tunnel SSH
                                         │                                       │ (6443 seulement)
  ┌──────────────────────────────── SERVEUR (Debian, une machine) ──────────────┼─────────────┐
  │                                      │                                       ▼             │
  │  Internet :443 ─▶ nginx de l'hôte ─┬─▶ applications encore livrées par `infra` (Compose)   │
  │                  (TLS, certbot)    └─▶ 10.43.0.80 Traefik ──▶ Service ──▶ Pods            │
  │                                                                              │             │
  │  ┌──────────────────────── k3s (Kubernetes) ──────────────────────────┐     │             │
  │  │ socle (Terraform)  traefik · cert-manager · argocd · kyverno ·      │     │             │
  │  │                    observabilite (Prometheus, Grafana)              │     │             │
  │  │ par Argo CD        sealed-secrets · pilotage · procurement · paie   │     │             │
  │  └─────────────────────────────────────────────────────────────────────┘     │             │
  │                                                                              ▼             │
  │  PostgreSQL NATIF (hors cluster) ◀── Service « postgres » de chaque espace ──┘             │
  └────────────────────────────────────────────────────────────────────────────────────────────┘
```

Trois **couches**, trois **outils**, trois **cycles de vie** :

| Couche | Outil | Change… | Qui l'applique |
|---|---|---|---|
| **Le cluster** (k3s, noyau, pare-feu) | scripts d'amorçage | rarement (mise à jour de k3s) | un humain, en SSH |
| **Le socle** (Traefik, Argo CD, Kyverno, espaces) | **Terraform** | toutes les quelques semaines | GitHub Actions, après approbation |
| **Les applications** | **Helm** + **Argo CD** | plusieurs fois par jour | Argo CD, depuis Git |

Pourquoi trois et pas un ? Parce que les risques ne sont pas les mêmes.
Une erreur dans le socle peut couper toutes les applications : elle passe par
un `plan` relu et une approbation. Une nouvelle version d'application est
fréquente et réversible : elle passe par un simple commit.

---

## 2. Le flux d'un déploiement d'application

```
dev pousse sur main (board)
  └─ tests (à l'application)
  └─ k8s-publier.yml
       1. docker build                              image ghcr.io/entreprisetools/board/pilotage:<sha>
       2. trivy image  ── CVE HIGH/CRITICAL corrigeable ? ──▶ ÉCHEC, rien n'est poussé
       3. push → empreinte sha256:abc…
       4. cosign sign (identité : Infra-server/k8s-publier.yml@v1, inscrite dans Rekor)
       5. SBOM (SPDX)
       6. commit « deploy(pilotage): <sha> » dans Infra-server/gitops/applications/pilotage/values.yaml
              image.tag: <sha>   image.empreinte: sha256:abc…
  └─ Argo CD (≤ 2 min) voit le commit
       PreSync  : Job pg_dump → pg_restore --list (relue) ── échec ? ──▶ STOP, l'ancienne version sert
       Sync     : Deployment mis à jour
                  Kyverno vérifie : registre permis, pas « latest », ressources, SIGNATURE
                  Pod Security vérifie : non-root, pas de privilège
                  nouveau pod ── sonde de préparation verte ? ── oui ─▶ l'ancien est retiré
                                                              └─ non (10 min) ─▶ Degraded, l'ancien sert
  └─ k8s-publier.yml étape 7 : curl https://pilotage… → X-Infra-Version == <sha> ? ✓
```

**Revenir en arrière** : `git revert` du commit `deploy(pilotage): …` → Argo CD
redéploie l'empreinte précédente (le hook de sauvegarde s'exécute aussi).

## 3. Le flux d'un changement du socle

```
PR sur Infra-server (plateforme/terraform/**)
  └─ plateforme-qualite : fmt · validate · terraform test · tflint · trivy
  └─ plateforme-terraform (plan) : tunnel SSH → compte terraform-plan (LECTURE) → plan en commentaire
relecture, merge
  └─ plateforme-terraform (apply) : environnement « production » → ATTENTE d'approbation
       └─ approuvé → compte terraform-apply → plan → apply DU MÊME plan
```

---

## 4. Les décisions (et ce qu'on a écarté)

Chaque décision suit le format court d'un *ADR* (Architecture Decision Record) :
contexte, décision, conséquences.

### D1 — k3s plutôt que kubeadm, MicroK8s ou un Kubernetes géré
- **Contexte** : un serveur, qui fait déjà tourner PostgreSQL, nginx et Docker.
- **Décision** : k3s — un binaire, peu de mémoire, Kubernetes certifié CNCF,
  etcd embarqué (instantanés), installation reproductible.
- **Écarté** : kubeadm (plus d'éléments à maintenir pour le même résultat) ;
  Kubernetes géré (pas de cloud ici, et la base est sur le serveur).

### D2 — PostgreSQL reste NATIF, hors du cluster
- **Contexte** : les trois dépôts l'avaient décidé et mesuré ; les données
  sont le plus précieux.
- **Décision** : un Service sans sélecteur (`postgres`) dans chaque espace,
  qui pointe sur l'hôte. Les pods écrivent `postgres:5432`.
- **Conséquences** : un `kubectl delete namespace` n'emporte jamais une base ;
  les sauvegardes d'`infra` (`infra sauvegarder`, minuteurs) continuent ;
  il faut ouvrir PostgreSQL aux pods (et seulement à eux : garde nftables,
  `pg_hba` en scram-sha-256).

### D3 — Traefik (et non ingress-nginx)
- **Contexte** : le projet ingress-nginx de Kubernetes est arrivé en fin de
  maintenance en mars 2026.
- **Décision** : Traefik, celui que k3s livre — mais installé par NOUS
  (Terraform) pour en épingler la version et relire ses valeurs.

### D4 — Coexistence : le nginx de l'hôte reste devant
- **Contexte** : des applications restent livrées par `infra` pendant la
  migration ; deux programmes ne peuvent pas écouter sur 443.
- **Décision** : mode `coexistence` — Traefik a une adresse de Service FIXE
  (10.43.0.80), joignable depuis l'hôte seulement ; nginx termine TLS et lui
  passe la main nom par nom (`brancher-nginx.sh`). Quand tout est migré :
  mode `direct` (Traefik prend 80/443, cert-manager les certificats).

### D5 — GitOps avec Argo CD (pull) plutôt qu'un `helm upgrade` depuis la CI (push)
- **Décision** : la CI n'a AUCUN accès au cluster pour déployer une
  application ; elle écrit dans Git. Argo CD, dans le cluster, applique.
- **Pourquoi** : pas de porte entrante, pas d'identifiant cluster dans 3
  dépôts ; Git = journal d'audit et bouton « retour » ; dérive corrigée
  (selfHeal). Voir 05.

### D6 — Le state Terraform dans le cluster (backend « kubernetes »)
- **Écarté** : un bucket S3 (pas de cloud), Terraform Cloud (un compte de
  plus, des données hors de chez nous), un fichier local (perdu, pas de
  verrou, pas partagé avec la CI).
- **Limite assumée** : le state vit sur la machine qu'il décrit (voir 10, « reconstruire »).

### D7 — Deux comptes Terraform (plan en lecture, apply en admin)
- `terraform plan` exécute du code venu de la PR. Il ne doit rien pouvoir
  écrire, ni lire la clé de Sealed Secrets. Voir 07, §4.

### D8 — Sealed Secrets (et non External Secrets + un coffre)
- **Décision** : les secrets sont dans Git, CHIFFRÉS pour le cluster.
- **Écarté** : Vault / un gestionnaire de secrets cloud (un service de plus à
  héberger, sauvegarder, déverrouiller) ; SOPS (très bien aussi, mais demande
  de gérer des clés age/GPG pour chaque personne et un plugin Argo CD).

### D9 — Kyverno (et non OPA Gatekeeper)
- Politiques écrites en YAML (pas de Rego à apprendre), vérification des
  signatures d'images intégrée.

### D10 — Un chart COMMUN, des valeurs par application
- Comme `infra` : un seul code, des manifestes (app.conf) par application.
  Le chart est versionné et testé ; les valeurs sont relues en PR.

---

## 5. Les ressources du serveur

Mesures indicatives (requêtes / limites posées dans le code) :

| Composant | Mémoire (demande → limite) |
|---|---|
| k3s (API, etcd, kubelet, containerd) | ~500–700 Mio (hors limites) |
| Traefik | 64 Mio → 256 Mio |
| cert-manager (3 pods) | 160 Mio → 640 Mio |
| Argo CD (5 pods) | ~550 Mio → 2,1 Gio |
| Kyverno (4 pods) | ~400 Mio → ~1,5 Gio |
| Sealed Secrets | 32 Mio → 128 Mio |
| Supervision (Prometheus, Grafana, Alertmanager, exporters) | ~800 Mio → ~2,5 Gio |
| **Socle total** | **~2,5–3 Gio** au repos |
| pilotage / procurement / paie | 1 Gio / 1 Gio (+64 Mio écran) / 2 Gio |

Le kubelet **réserve** 2,5 Gio pour le système et PostgreSQL
(`system-reserved`, `kube-reserved` dans `config.yaml`) : l'ordonnanceur ne
promettra jamais cette mémoire aux pods. **8 Gio est un minimum**, 16 Gio
confortable. Sans la supervision (`observabilite = false`) on économise ~1 Gio.

---

## 6. Ce qui ne change PAS

- **PostgreSQL** et ses sauvegardes quotidiennes (`infra sauvegarder`).
- **nginx de l'hôte** et certbot, tant qu'on est en coexistence.
- **`infra`** lui-même : chaque application y reste livrable jusqu'à sa
  bascule, et peut y revenir (09, « retour arrière »).
