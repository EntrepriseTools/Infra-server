# La plateforme Kubernetes — documentation et parcours d'apprentissage

Cette documentation a deux buts :

1. **faire tourner** la plateforme (installer, déployer, réparer) ;
2. **vous rendre autonome** en Kubernetes, Terraform, Helm, GitOps et
   DevSecOps — chaque choix est expliqué, avec ce qu'on aurait pu faire
   d'autre et pourquoi on ne l'a pas fait.

> **Le cadre, honnêtement.** Pour un seul serveur et trois applications,
> l'outil `infra` (Bash + Docker Compose, voir le [README](../../README.md))
> suffit, et le README explique pourquoi. Cette plateforme est un choix
> **d'apprentissage et d'anticipation** : c'est l'outillage standard de
> l'industrie, monté proprement, à petite échelle. Les deux voies
> **coexistent** : on migre une application à la fois, et on peut revenir
> en arrière à chaque étape.

---

## La carte

| # | Document | Vous y apprenez |
|---|---|---|
| 01 | [Architecture](01-architecture.md) | la vue d'ensemble, les flux, les décisions et leurs raisons |
| 02 | [Kubernetes et k3s](02-kubernetes-k3s.md) | les objets Kubernetes, à travers NOTRE cluster ; l'installation durcie |
| 03 | [Terraform](03-terraform.md) | state, providers, modules, plan/apply, tests ; notre code ligne à ligne |
| 04 | [Helm](04-helm.md) | charts, gabarits, valeurs, schéma, hooks, tests ; ajouter une application |
| 05 | [GitOps et Argo CD](05-gitops-argocd.md) | le modèle « pull », ApplicationSet, synchronisation, retour arrière, secrets scellés |
| 06 | [CI/CD GitHub Actions](06-ci-cd-github-actions.md) | les workflows, la mise en route pas à pas, tous les secrets |
| 07 | [DevSecOps](07-devsecops.md) | modèle de menace, chaîne d'approvisionnement, défense en profondeur, écarts assumés |
| 08 | [Observabilité](08-observabilite.md) | Prometheus, Grafana, alertes, journaux |
| 09 | [Migration](09-migration.md) | passer pilotage, procurement puis paie d'`infra` à Kubernetes |
| 10 | [Exploitation](10-exploitation.md) | le manuel du quotidien et des mauvais jours |
| 11 | [Travaux pratiques](11-travaux-pratiques.md) | 15 exercices progressifs, du labo à la production |
| 12 | [Glossaire](12-glossaire.md) | les mots, en français et en anglais |

---

## Le parcours conseillé (6 semaines, quelques heures par semaine)

| Semaine | Objectif | Lire | Faire |
|---|---|---|---|
| 1 | Comprendre Kubernetes | 01, 02 | TP 1 à 3 (labo k3d sur votre poste) |
| 2 | Comprendre Terraform | 03 | TP 4 à 6 (plan, state, module, tests) |
| 3 | Comprendre Helm | 04 | TP 7 à 9 (rendre, casser, tester le chart) |
| 4 | GitOps et CI/CD | 05, 06 | TP 10 à 11 ; mettre en route GitHub (06, « mise en route ») |
| 5 | Sécurité | 07 | TP 12 à 14 (Kyverno, NetworkPolicy, signatures) |
| 6 | Production | 08, 09, 10 | installer sur le serveur ; migrer **pilotage** ; TP 15 |

**Règle d'or : tout se fait d'abord dans le labo.** `plateforme/labo/labo.sh`
monte la plateforme entière sur votre poste (k3d), avec le même code. Ce qui
casse là ne coûte rien.

---

## Ce qui est où, dans le dépôt

```
plateforme/
  amorcage/                  ce que Terraform NE PEUT PAS faire (il faut un cluster d'abord)
    installer-k3s.sh           k3s durci, version épinglée
    k3s/                       config.yaml, admission.yaml (PSA), audit.yaml, garde nftables
    rbac-pipeline.yaml         les comptes terraform-plan (lecture) / terraform-apply (admin)
    compte-tunnel-ci.sh        le compte SSH « tunnel seulement » de la CI
    kubeconfig-pipeline.sh     le kubeconfig à mettre dans GitHub
    ouvrir-postgres-aux-pods.sh  PostgreSQL natif joignable des pods, et d'eux seuls
    identifiants-registre.sh   le droit de tirer les images privées de GHCR
    brancher-nginx.sh          coexistence : un nom public passe de nginx à Traefik
    creer-base.sh              rôle + base d'une NOUVELLE application
  terraform/
    modules/espace-application/  un espace de noms prêt : quotas, réseau fermé, base
    plateforme/                  le socle : Traefik, cert-manager, Argo CD, Kyverno, supervision
  helm/
    application/               LE chart commun des applications (+ tests unitaires)
    socle/                     politiques Kyverno, émetteurs TLS, projets et ApplicationSet Argo CD
  outils/sceller.sh          chiffrer un secret pour le cluster
  sealed-secrets/            le certificat PUBLIC de Sealed Secrets
  labo/                      la plateforme sur votre poste (k3d)
  Makefile                   les contrôles de la CI, en local : make tout
gitops/applications/<app>/values.yaml   l'état voulu de chaque application (lu par Argo CD)
modeles/depot-k8s/          le modèle de dépôt d'application (pipeline, Dockerfile)
.github/workflows/
  plateforme-qualite.yml     tests, lint, scans — sur chaque PR
  plateforme-terraform.yml   plan sur PR, apply (avec approbation) sur main
  k8s-publier.yml            LE workflow réutilisable de livraison des applications
.github/actions/tunnel-plateforme/   le tunnel SSH vers l'API Kubernetes
renovate.json               les mises à jour de dépendances, en PR
```

---

## Les commandes à connaître par cœur

```bash
# Sur le serveur (k3s embarque kubectl)
sudo k3s kubectl get nodes,pods -A          # tout ce qui tourne
sudo k3s kubectl -n pilotage get all        # une application
sudo k3s kubectl -n pilotage logs deploy/pilotage -f
sudo k3s kubectl get applications -n argocd # l'état GitOps
sudo k3s kubectl get policyreport -A        # les violations Kyverno

# Sur votre poste
make -C plateforme tout                     # ce que fait la CI
plateforme/labo/labo.sh creer               # le labo
```

> Astuce : sur le serveur, `sudo ln -s /etc/rancher/k3s/k3s.yaml /root/.kube/config`
> puis `alias k='sudo k3s kubectl'` — on écrit `k get pods -A`.
