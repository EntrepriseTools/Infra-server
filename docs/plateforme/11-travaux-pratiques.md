# 11 — Travaux pratiques

Quinze exercices, du plus simple au plus exigeant. Chacun : un **objectif**,
des **étapes**, ce qu'il faut **observer**, et une **question** pour vérifier
que c'est compris. Les TP 1 à 14 se font dans le **labo** (`plateforme/labo/labo.sh`).

Prérequis sur votre poste : docker, [k3d](https://k3d.io), kubectl, helm
(+ plugin `helm-unittest`), terraform (ou tofu), kubeseal, cosign, jq, yq.

---

## Semaine 1 — Kubernetes

### TP 1 — Monter le labo et explorer
```bash
plateforme/labo/labo.sh creer
kubectl config use-context k3d-plateforme-labo
kubectl get nodes -o wide ; kubectl get pods -A ; kubectl api-resources | wc -l
```
**Observer** : quels pods tournent dans `kube-system` ? À quoi sert chacun ?
**Question** : pourquoi Traefik n'est-il PAS là ? (indice : `labo.sh`, `--disable`).

### TP 2 — La boucle de réconciliation
```bash
kubectl create ns essai
kubectl -n essai create deployment web --image=nginxinc/nginx-unprivileged:1.29-alpine --replicas=2
kubectl -n essai get pods -w            # dans un autre terminal
kubectl -n essai delete pod <un-des-pods>
kubectl -n essai scale deployment web --replicas=4
kubectl -n essai set image deployment/web nginx-unprivileged=nginxinc/nginx-unprivileged:1.28-alpine
kubectl -n essai rollout history deployment/web
```
**Observer** : le pod supprimé est remplacé ; la mise à jour crée un nouveau ReplicaSet.
**Question** : que se passe-t-il si l'image n'existe pas (`:nexistepas`) ? Combien de pods restent disponibles ? Pourquoi ?

### TP 3 — Pod Security
```bash
kubectl label ns essai pod-security.kubernetes.io/enforce=restricted
kubectl -n essai run root --image=nginx              # refusé : pourquoi exactement ?
kubectl -n essai rollout restart deployment/web      # que devient le Deployment ? (kubectl -n essai get rs ; describe rs)
```
**Question** : quels champs du `securityContext` du chart `application` rendent ses pods conformes ?

## Semaine 2 — Terraform

### TP 4 — Plan, apply, state
```bash
export TF_VAR_argocd_cle_depot="$(cat ~/.ssh/argocd-depot)"   # deploy key (lecture) de votre fork
export TF_VAR_argocd_admin_bcrypt="$(htpasswd -nbBC 12 '' labo | tr -d ':\n')"
plateforme/labo/labo.sh appliquer
cd plateforme/terraform/plateforme
terraform state list
terraform state show 'module.application["pilotage"].kubernetes_namespace_v1.this'
kubectl get secret -n terraform-etat
```
**Question** : où est le state ? Qui peut le lire ? Que contient-il de sensible ?

### TP 5 — La dérive
```bash
kubectl -n pilotage delete networkpolicy sortie-postgres
terraform plan -var-file=../../labo/labo.tfvars      # que propose Terraform ?
kubectl label ns pilotage pod-security.kubernetes.io/enforce=privileged --overwrite
terraform plan -var-file=../../labo/labo.tfvars
```
**Question** : quelle différence entre la dérive que corrige Terraform (au
prochain apply) et celle que corrige Argo CD (seul, en 2 min) ?

### TP 6 — Écrire un test qui échoue, puis le faire passer
Ajouter à `modules/espace-application` une variable `sorties_https` (bool,
défaut false) qui crée une NetworkPolicy autorisant 443 vers Internet.
1. Écrire D'ABORD le test dans `tests/espace.tftest.hcl` (deux `run` : absent par défaut, présent si vrai).
2. `terraform test` → rouge. 3. Implémenter → vert. 4. `tflint`.
**Question** : pourquoi `count` est-il acceptable ici, alors qu'on préfère `for_each` ailleurs ?

## Semaine 3 — Helm

### TP 7 — Rendre et lire
```bash
cd plateforme/helm/application
helm template paie . -f ci/proxy-values.yaml | less
helm template paie . -f ci/proxy-values.yaml -s templates/sauvegarde.yaml
helm template x . --set image.tag=latest          # le schéma refuse : lire le message
helm template x . --set image.tag=abc --set ingress.hote=x.example.org --set ressource.limits.memory=1Gi
```
**Question** : pourquoi la dernière commande échoue-t-elle ? Qu'arriverait-il sans `additionalProperties: false` ?

### TP 8 — Ajouter une fonctionnalité au chart, tests d'abord
Ajouter `annotationsPod: {}` (annotations libres sur le pod).
1. Un test dans `tests/deployment_test.yaml`. 2. La clé dans `values.yaml` et
`values.schema.json`. 3. Le gabarit. 4. `helm unittest .` et `make -C plateforme helm kubeconform`.
**Question** : pourquoi faut-il toucher au schéma ?

### TP 9 — Publier le chart en OCI
```bash
helm package plateforme/helm/application
helm push application-1.0.0.tgz oci://ghcr.io/<vous>/charts
```
Puis modifier (dans votre fork) l'ApplicationSet pour consommer
`oci://ghcr.io/<vous>/charts/application` en version épinglée.
**Question** : quel avantage par rapport à « le chart sur `main` » ? Quel coût ?

## Semaine 4 — GitOps et CI/CD

### TP 10 — Argo CD de bout en bout
1. `labo.sh argocd`, se connecter. 2. Dans votre fork, poser
`image.tag` sur une image publique de test dans `gitops/applications/pilotage/values.yaml`
(et `sauvegardeAvantDeploiement.actif: false`, et un `secrets.existant` créé à la main). 3. Pousser.
4. Observer la synchronisation. 5. `kubectl -n pilotage scale deploy/pilotage --replicas=3` → observer le selfHeal.
6. `git revert` → observer le retour.
**Question** : pourquoi `CreateNamespace=false` ? Que se passe-t-il si on crée `gitops/applications/inconnue/` ?

### TP 11 — Durcir la promotion
Modifier (dans votre fork) `k8s-publier.yml` pour que la promotion ouvre une
**PR** (avec auto-merge) au lieu de pousser sur `main`. Ajouter un travail
« garde » toujours lancé dans `plateforme-qualite.yml` qui dépend des autres
(`needs`, `if: always()`) pour pouvoir le rendre obligatoire.
**Question** : que gagne-t-on en traçabilité ? Que perd-on en délai ?

## Semaine 5 — Sécurité

### TP 12 — Kyverno : de l'Audit à l'Enforce
```bash
kubectl -n pilotage run pirate --image=docker.io/library/nginx:latest   # refusé par PSA ? par Kyverno ?
kubectl get policyreport -A
# passer kyverno_action = "Enforce" dans labo.tfvars, appliquer, recommencer
```
**Question** : pourquoi `mutateDigest` n'est-il activé qu'en Enforce ? Pourquoi
la politique de signature a-t-elle `background: false` ?

### TP 13 — NetworkPolicy : prouver le refus par défaut
Depuis un pod de test dans `pilotage` (02, partie C) :
`pg_isready -h postgres` (doit réussir), `wget -T5 https://example.org`
(doit échouer), `wget -T5 http://pilotage.procurement` (doit échouer).
Puis ajouter `reseau.sorties` (443 vers 0.0.0.0/0) dans les valeurs, et refaire.
**Question** : pourquoi la politique `sortie-dns` est-elle indispensable, et
que verrait-on sans elle ?

### TP 14 — Signer et vérifier soi-même
```bash
# une image à vous sur GHCR, signée en local (identité = votre compte GitHub)
cosign sign ghcr.io/<vous>/essai@sha256:…
cosign verify ghcr.io/<vous>/essai@sha256:… --certificate-identity-regexp '.*' --certificate-oidc-issuer-regexp '.*'
rekor-cli search --sha sha256:…     # l'entrée publique
```
Puis déployer cette image dans le labo avec la politique en Enforce.
**Question** : pourquoi est-elle refusée alors qu'elle est signée ? Que
faudrait-il changer pour l'accepter — et pourquoi ne faut-il pas le faire ?

## Semaine 6 — Production

### TP 15 — La reprise après sinistre, en vrai (dans le labo)
1. Sauvegarder la clé Sealed Secrets du labo (10, §4). 2. `labo.sh detruire`.
3. Reconstruire en suivant **mot pour mot** 10, §6. 4. Les secrets
scellés se déchiffrent-ils ? 5. Chronométrer. 6. Corriger la documentation
là où elle vous a fait hésiter (PR !).

Bonus : activer la collecte des métriques Traefik et brancher Alertmanager
sur un canal réel (08, §3).

---

## Pour aller plus loin

- **Argo Rollouts** : déploiements *canary* / *blue-green* avec analyse automatique.
- **Gateway API** (remplaçant d'Ingress) avec Traefik.
- **External Secrets Operator** + un coffre (Vault, OpenBao) — comparer avec Sealed Secrets.
- **Falco** : détection d'intrusion à l'exécution (appels système suspects).
- **Velero** : sauvegarde des objets et volumes Kubernetes vers un stockage externe.
- **Un second nœud** (k3s agent) : ce qui change pour les volumes local-path, les PDB, les hostPort.
- Certification : **CKA** (administration), **CKAD** (développement), **CKS** (sécurité).
