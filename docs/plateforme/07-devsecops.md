# 07 — DevSecOps

> DevSecOps n'est pas une liste d'outils : c'est **décider, pour chaque menace,
> où on l'arrête, et le prouver par un contrôle automatique.** Ce document
> part des menaces, puis montre où chaque défense vit dans le code.

## 1. Ce qu'on protège, et contre qui

**Les biens** : les bases de données (paie : données personnelles et
salariales), les secrets (mots de passe, clés JWT), la disponibilité des
trois applications, et le serveur lui-même.

**Les attaquants plausibles** :
- quelqu'un sur Internet qui scanne les ports et les failles connues ;
- une **dépendance piégée** (bibliothèque npm/Maven, image de base, action GitHub) ;
- un **jeton volé** (PAT d'un développeur, secret de CI) ;
- une **PR malveillante** ou une erreur honnête dans une PR ;
- une application **compromise** (faille dans son code) qui cherche à aller plus loin.

## 2. Le modèle de menace (STRIDE, condensé)

| Menace | Exemple concret | Défenses (où dans le code) |
|---|---|---|
| **S**poofing — usurpation | pousser sur GHCR une image avec un jeton volé | signature **cosign sans clé** exigée par Kyverno (`plateforme-signatures`) : seul `k8s-publier.yml` d'Infra-server, à `main`/`vN`, produit une signature valable |
| **T**ampering — altération | déplacer l'étiquette d'une image ou d'une action GitHub | images par **empreinte** (`image.empreinte`) ; actions par **SHA** ; binaires de CI par **somme SHA-256** écrite dans le workflow |
| **R**epudiation — déni | « ce n'est pas moi qui ai changé la prod » | tout passe par **Git** (commits, PR, approbations d'environnement) ; **journal d'audit** de l'API (`k3s/audit.yaml`) |
| **I**nformation disclosure — fuite | un secret dans Git ; un instantané etcd volé | **Sealed Secrets** ; `trivy fs --scanners secret` bloquant ; **secrets-encryption** de k3s ; audit `Metadata` seulement sur les Secrets |
| **D**enial of service | une application qui prend toute la mémoire et fait tomber PostgreSQL | **requests/limits** (Kyverno `plateforme-ressources`), **ResourceQuota**, **LimitRange**, `system-reserved`, `eviction-hard` |
| **E**levation of privilege | un conteneur compromis qui devient root sur l'hôte | **Pod Security restricted**, pas de jeton d'API monté, **NetworkPolicy** refus par défaut, AppProject sans objets cluster, comptes Terraform séparés |

## 3. La chaîne d'approvisionnement logicielle (supply chain)

C'est aujourd'hui la menace n° 1 : on n'attaque plus le serveur, on attaque
ce qu'on y installe. Exemple réel : en **mars 2026**, les étiquettes de
l'action `aquasecurity/trivy-action` ont été réécrites pour pointer vers du
code qui volait les secrets des CI qui l'utilisaient. Les dépôts qui
l'épinglaient **par SHA** n'ont rien eu.

Notre chaîne, maillon par maillon :

```
code source ─▶ dépendances ─▶ construction ─▶ image ─▶ registre ─▶ déploiement ─▶ exécution
   PR relue     Renovate        CI éphémère    Trivy     GHCR        GitOps         Kyverno + PSA
   CODEOWNERS   (PR, CI)        actions@SHA    SBOM      empreinte   commit relu    signature vérifiée
                                binaires@sha256 cosign   attestation
```

| Maillon | Contrôle | Fichier |
|---|---|---|
| Actions GitHub | épinglées par SHA de commit, mises à jour par Renovate (`helpers:pinGitHubActionDigests`) | tous les workflows, `renovate.json` |
| Outils téléchargés | somme SHA-256 **écrite dans le workflow** (pas lue sur le même serveur que le binaire) | `plateforme-qualite.yml`, `k8s-publier.yml` |
| Workflows eux-mêmes | **zizmor** : injection de modèles, permissions excessives, identifiants persistés… | `plateforme-qualite.yml` |
| Image | **Trivy** avant le push (CVE corrigeables HIGH/CRITICAL bloquantes) | `k8s-publier.yml` |
| Contenu | **SBOM** SPDX (la liste de tout ce qu'il y a dans l'image) | `k8s-publier.yml` |
| Origine | **signature cosign sans clé** + (option) **provenance SLSA** | `k8s-publier.yml` |
| Admission | **Kyverno** vérifie la signature, le registre, l'étiquette | `helm/socle/templates/kyverno-politiques.yaml` |

### La signature sans clé, expliquée

```
k8s-publier.yml ──(jeton OIDC GitHub : « je suis Infra-server/.github/workflows/k8s-publier.yml@refs/tags/v1 »)──▶ Fulcio
Fulcio ──▶ certificat valable 10 min, avec cette identité ──▶ cosign signe l'empreinte
cosign ──▶ inscrit signature + certificat dans Rekor (journal de transparence, public, append-only)
Kyverno (à l'admission) ──▶ vérifie : signature valide, certificat émis par Fulcio pour l'émetteur
                            https://token.actions.githubusercontent.com, identité qui correspond à
                            ^https://github\.com/EntrepriseTools/Infra-server/\.github/workflows/k8s-publier\.yml@refs/(heads/main|tags/v…)$
```

Aucune clé privée à garder, à faire tourner, à se faire voler. Pour un
workflow **réutilisable**, l'identité est celle du workflow réutilisable : un
workflow écrit dans un dépôt d'application ne peut donc pas produire une
signature acceptée, même avec les droits de pousser sur GHCR.

Vérifier à la main :
```bash
cosign verify ghcr.io/entreprisetools/board/pilotage@sha256:… \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  --certificate-identity-regexp '^https://github\.com/EntrepriseTools/Infra-server/\.github/workflows/k8s-publier\.yml@'
# et la provenance (si attestations-github) :
gh attestation verify oci://ghcr.io/entreprisetools/board/pilotage@sha256:… --owner EntrepriseTools
```

## 4. Le moindre privilège, acteur par acteur

| Acteur | Peut | Ne peut pas | Comment c'est tenu |
|---|---|---|---|
| **CI d'une application** | pousser une image sur GHCR ; commit dans `gitops/` (via l'App) | toucher au cluster ; écrire ailleurs qu'Infra-server | aucun identifiant cluster ; jeton d'App 1 h, 1 dépôt, `contents:write` |
| **Une valeur dans `gitops/`** | décrire un Deployment, Service, Ingress, NetworkPolicy, SealedSecret dans SON espace | objets cluster, autre espace, quotas, RBAC | AppProject `applications` |
| **Une PR sur Infra-server** | lancer un plan en lecture | modifier le cluster ; lire la clé Sealed Secrets ou les secrets des applications | compte `terraform-plan` (`rbac-pipeline.yaml`) |
| **Le merge sur main** | appliquer le socle | le faire sans qu'un humain approuve | environnement `production`, relecteurs obligatoires |
| **Le tunnel de CI** | ouvrir 127.0.0.1:6443 | shell, pty, autre destination | `restrict,port-forwarding,permitopen=…,command="/bin/false"` |
| **Le code d'une application** | parler à PostgreSQL (son rôle), à DNS, recevoir de Traefik | parler à l'API Kubernetes, à Internet, aux autres applications ; root ; écrire hors `/tmp` et ses volumes | pas de jeton monté ; NetworkPolicy ; PSA restricted ; `readOnlyRootFilesystem` |
| **Argo CD** | appliquer ce que Git décrit | — (il est puissant : c'est pourquoi son UI n'est pas publique et `exec` est désactivé) | tunnel SSH, `exec.enabled: false`, admin par empreinte bcrypt |

### Pourquoi terraform-plan ne lit pas tous les Secrets

`terraform plan` **exécute du code de la PR** (une `data "external"`, un
provider modifié, un `local-exec`…). Si le compte du plan pouvait lire tous
les Secrets, une PR pourrait exfiltrer la clé privée de Sealed Secrets — et
donc déchiffrer tous les secrets du dépôt, pour toujours. Donc :
- lecture **sans** les Secrets au niveau du cluster (`terraform-plan-lecture`) ;
- lecture des Secrets **seulement** dans `terraform-etat` et les espaces du
  socle que Terraform gère (`espaces.tf`) ;
- Sealed Secrets est installé **par Argo CD**, pas par Terraform, pour que
  son espace reste hors de portée du plan.

Ce que le plan peut lire reste sensible (le state contient le mot de passe
Grafana et la deploy key d'Argo CD) : c'est pour cela que le plan ne tourne
que sur les PR **du dépôt** (pas des forks), et que l'environnement
`plateforme-plan` peut être restreint à certaines branches.

## 5. La défense en profondeur, couche par couche

| Couche | Défense | Vérifier |
|---|---|---|
| Hôte | garde nftables : 6443, 10250, etcd, VXLAN, 5432 fermés vers l'extérieur | `sudo nft list table inet k3s_garde` ; `nc -zv <ip> 6443` depuis l'extérieur |
| Cluster | audit, chiffrement des Secrets, PSA par défaut `baseline` | `sudo tail /var/log/k3s/audit.log` |
| Espace | PSA `restricted`, quotas, LimitRange, NetworkPolicy refus par défaut | `k get ns pilotage --show-labels` ; `k -n pilotage get netpol,quota,limits` |
| Admission | Kyverno : registres (ghcr.io/entreprisetools, postgres, solveur ACME), pas de latest, ressources, signatures | `k get clusterpolicy` ; `k get policyreport -A` |
| Pod | non-root (UID 10001), capacités retirées, seccomp, racine en lecture seule, pas de jeton | `k -n pilotage get pod -o yaml \| yq '.items[].spec.securityContext'` |
| Réseau d'entrée | Traefik : corps max, en-têtes de sécurité, liste blanche | `curl -I https://…` |
| Données | PostgreSQL scram-sha-256 depuis les pods ; sauvegarde relue avant chaque déploiement | `k -n pilotage logs job/pilotage-sauvegarde` |

## 6. Passer Kyverno en Enforce

On commence en **Audit** : rien n'est refusé, tout est noté. On lit, on corrige, puis on durcit.

```bash
k get policyreport -A
k -n pilotage get policyreport -o yaml | yq '.items[].results[] | select(.result == "fail")'
```
Quand il n'y a plus d'échec (images signées par la CI, ressources déclarées) :
`kyverno_action = "Enforce"` dans `terraform.tfvars`, PR, apply. Ensuite, une
image non signée est refusée avec le message de la politique — essayez (TP 12).

## 7. Les écarts assumés (une sécurité honnête les écrit)

| Écart | Pourquoi | Ce qui compense |
|---|---|---|
| `protect-kernel-defaults` (CIS) désactivé | exige `vm.overcommit_memory=1`, mauvais pour PostgreSQL | kubelet `eviction-hard`, réservations mémoire |
| `limits.cpu` non posé | le *throttling* ralentit la JVM sans protéger grand-chose | `requests.cpu` (partage équitable), quotas |
| PostgreSQL écoute sur l'IP de l'hôte | les pods doivent le joindre | garde nftables (5432 fermé dehors), `pg_hba` restreint au CIDR des pods + scram |
| Traefik `privileged` en mode direct | `hostPort` est interdit par `baseline` | exception écrite dans `espaces.tf`, seul espace concerné |
| `observabilite` en `privileged` | node-exporter lit l'hôte | idem |
| signature cosign → Rekor **public** | le nom du dépôt et l'empreinte de l'image deviennent publics | rien de secret dans un nom d'image ; alternative : instance Sigstore privée, ou cosign avec clé (KMS) |
| `terraform-plan` lit le state | indispensable à un plan | plan seulement sur les PR internes ; secrets applicatifs hors de sa portée |
| jetons de comptes de service sans expiration | la CI ne peut pas en demander de nouveaux sans en avoir un | rotation documentée (10) ; tunnel SSH obligatoire pour s'en servir |
| trivy LOW/MEDIUM restants (KSV-0011 pas de limite CPU, KSV-0125 registre « non reconnu ») | choix ci-dessus ; ghcr.io est notre registre | rapport complet dans Code scanning (si GHAS) ; TP 13 |

## 8. Les réflexes à garder

- **Rien en clair dans Git.** `trivy fs --scanners secret` le vérifie ; si un
  secret a été poussé, il est **compromis** : le changer d'abord, nettoyer ensuite.
- **Une exception = une justification écrite**, limitée à un fichier (`.trivyignore.yaml`).
- **Épingler** : versions de charts, de providers, de k3s, d'actions, d'images.
  Et **mettre à jour** (Renovate) : un épinglage jamais mis à jour devient une dette.
- **Moindre privilège par défaut**, et on ouvre explicitement (NetworkPolicy,
  RBAC, permissions GitHub, sorties réseau).
- **Tester les défenses** : une défense jamais éprouvée n'existe pas. Les
  `expect_failures` de Terraform, les `failedTemplate` du chart et les TP 12
  à 14 sont là pour ça.
