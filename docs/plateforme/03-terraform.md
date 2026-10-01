# 03 — Terraform

## 1. Ce que fait Terraform, en une phrase

Vous **décrivez** des ressources dans des fichiers `.tf` ; Terraform compare
cette description à ce qu'il a **mémorisé** (le *state*) et à la **réalité**,
calcule les différences (le *plan*), et les applique (*apply*).

```
   *.tf (le voulu)  ──┐
                      ├──▶ terraform plan ──▶ « + 3 à créer, ~ 1 à modifier, - 0 à détruire »
   state (le connu) ──┤                              │
                      │                     terraform apply
   réalité (API) ─────┘  (refresh)                   ▼
                                           providers → API Kubernetes / Helm
```

Ici, les ressources ne sont pas des VM dans un cloud : ce sont des objets
Kubernetes et des releases Helm. Terraform sert à **décrire le socle de la
plateforme comme du code** : relu en PR, versionné, reproductible.

## 2. Les notions, avec NOTRE code

### Providers — les « pilotes »
`versions.tf` déclare les providers et leurs versions ; `providers.tf` les configure :

```hcl
provider "helm" {
  kubernetes = {
    config_path    = var.kubeconfig
    config_context = var.contexte_kube
  }
}
```
- `hashicorp/kubernetes` : écrit des objets Kubernetes (`kubernetes_namespace_v1`…).
- `hashicorp/helm` : installe des charts (`helm_release`).
- `hashicorp/random` : tire des mots de passe (`random_password`).

`version = "~> 3.2"` veut dire « ≥ 3.2 et < 4.0 » : on accepte les
correctifs et ajouts, pas les ruptures. Le fichier **`.terraform.lock.hcl`**
(créé au premier `terraform init`) fige la version exacte et les sommes de
contrôle : **committez-le** (`terraform providers lock -platform=linux_amd64 -platform=darwin_arm64`).

### Ressources et références
```hcl
resource "kubernetes_namespace_v1" "socle" { ... }

resource "helm_release" "traefik" {
  namespace = kubernetes_namespace_v1.socle["traefik"].metadata[0].name
  ...
}
```
La référence `kubernetes_namespace_v1.socle["traefik"]...` crée une
**dépendance implicite** : Terraform crée l'espace avant la release. Quand il
n'y a pas de référence mais un ordre nécessaire, on écrit `depends_on`
(exemple : `socle.tf` attend cert-manager, Kyverno et Argo CD, dont il utilise
les CRD).

### Variables, valeurs, sorties
- `variables.tf` : les **entrées**, avec type, description, défaut et
  **validation** (`mode_ingress` doit être coexistence/direct/labo ;
  `argocd_admin_bcrypt` doit ressembler à une empreinte bcrypt).
- `terraform.tfvars` : les **valeurs** de production, non secrètes.
- Les secrets arrivent par l'environnement : `TF_VAR_argocd_cle_depot`.
- `sensitive = true` : la valeur est masquée dans le plan et les journaux
  (mais **elle est dans le state** : protégez le state).
- `outputs.tf` : ce que Terraform rend après l'apply (`terraform output`).

### for_each et count — une ressource, plusieurs exemplaires
```hcl
resource "kubernetes_namespace_v1" "socle" {
  for_each = local.espaces_socle        # { traefik = "restricted", argocd = "baseline", … }
  metadata { name = each.key ... each.value ... }
}

resource "helm_release" "observabilite" {
  count = var.observabilite ? 1 : 0     # 0 ou 1 exemplaire : une ressource facultative
}
```
Préférez `for_each` (clé stable : retirer `argocd` ne décale pas les autres)
à `count` (index : retirer l'élément 0 renumérote tout).

### Modules — des fonctions
`modules/espace-application` prend un nom et une adresse de base, et rend un
espace de noms complet. Le module racine l'appelle une fois par application :

```hcl
module "application" {
  source   = "../modules/espace-application"
  for_each = var.applications
  nom              = each.key
  adresse_postgres = var.adresse_postgres
  quota            = each.value.quota
}
```

### Le state — et pourquoi on y fait attention
Le state lie `kubernetes_namespace_v1.socle["traefik"]` à l'objet réel.
Ici, il est dans un Secret du cluster (`backend.tf`, backend « kubernetes ») :
- **chiffré au repos** (secrets-encryption de k3s) ;
- **verrouillé** pendant un apply (objet Lease) : deux apply simultanés sont impossibles ;
- lisible par `terraform-plan`, écrivable par `terraform-apply`.

```bash
k -n terraform-etat get secret                    # tfstate-default-plateforme
terraform state list                              # ce que Terraform gère
terraform state show 'module.application["pilotage"].kubernetes_namespace_v1.this'
```

**Jamais** éditer le state à la main. Les opérations sûres : `terraform state mv`
(renommer sans détruire), `terraform import` / blocs `import {}` (adopter un
objet existant), blocs `moved {}` (refactorer sans détruire), `removed {}`.

### Les tests — `terraform test`
`tests/*.tftest.hcl` avec `mock_provider` : Terraform calcule le plan contre
des providers **simulés**, sans cluster, et on vérifie des assertions :

```hcl
run "direct_prend_80_et_443" {
  command = plan
  variables { mode_ingress = "direct" }
  assert {
    condition     = yamldecode(helm_release.traefik.values[0]).ports.websecure.hostPort == 443
    error_message = "En direct, Traefik doit écouter sur 443."
  }
}
```
On teste les **décisions** (modes, niveaux de sécurité, refus des valeurs
fausses avec `expect_failures`), pas Helm lui-même. 15 tests, quelques secondes.

## 3. Le socle, fichier par fichier

| Fichier | Contenu |
|---|---|
| `versions.tf`, `providers.tf`, `backend.tf` | outils, connexion, state |
| `variables.tf`, `terraform.tfvars`, `outputs.tf` | entrées, valeurs, sorties |
| `espaces.tf` | les espaces du socle et leur niveau Pod Security (justifié) ; les RoleBindings de `terraform-plan` |
| `ingress.tf` | Traefik, trois modes |
| `certificats.tf` | cert-manager (+ ses CRD) |
| `argocd.tf` | Argo CD + l'accès au dépôt GitOps |
| `kyverno.tf` | Kyverno |
| `observabilite.tf` | kube-prometheus-stack (facultatif) |
| `socle.tf` | le chart local `helm/socle` : ce qui dépend des CRD |
| `applications.tf` | un `module.application` par application |

**Pourquoi un chart « socle » plutôt que `kubernetes_manifest` ?**
`kubernetes_manifest` interroge l'API au moment du **plan** pour connaître le
schéma de l'objet — or au premier plan, la CRD (`ClusterIssuer`,
`ClusterPolicy`…) n'existe pas encore : le plan échoue. Une release Helm,
elle, n'est rendue qu'à l'apply, après ses `depends_on`. C'est le contournement
standard de cette limite.

## 4. Le premier apply (depuis le serveur ou via la CI)

Le chemin normal est la CI (06). Pour le tout premier, ou pour comprendre,
on peut le faire à la main **depuis le serveur** :

```bash
# Sur le serveur, en root, avec le kubeconfig admin
export KUBE_CONFIG_PATH=/etc/rancher/k3s/k3s.yaml
export TF_VAR_kubeconfig=$KUBE_CONFIG_PATH
export TF_VAR_argocd_cle_depot="$(cat /root/argocd-deploy-key)"
export TF_VAR_argocd_admin_bcrypt='$2y$12$...'      # htpasswd -nbBC 12 '' 'motdepasse' | tr -d ':\n'
cd plateforme/terraform/plateforme
terraform init
terraform plan -out=tfplan          # LIRE le plan
terraform apply tfplan
```

Ordre de création (Terraform le déduit) : espaces → Traefik, observabilité →
cert-manager, Kyverno, Argo CD → secret du dépôt → modules applications →
socle (politiques, ApplicationSet) → Argo CD installe Sealed Secrets et les
applications.

## 5. Le quotidien

| Je veux… | Je fais… |
|---|---|
| ajouter une application | une entrée dans `applications = { … }` de `terraform.tfvars`, PR |
| changer un quota | idem |
| passer Kyverno en Enforce | `kyverno_action = "Enforce"`, PR (07, §6) |
| mettre à jour un chart du socle | Renovate ouvre la PR ; lire les notes de version ; le plan montre la différence |
| passer en mode direct | `mode_ingress = "direct"` (09, « mode direct ») |
| voir ce qui a dérivé | `terraform plan` : toute différence non voulue est une modification hors Terraform |

## 6. Les pièges classiques

| Symptôme | Cause | Remède |
|---|---|---|
| `Error acquiring the state lock` | un apply interrompu a laissé le verrou | vérifier qu'aucun apply ne tourne, puis `terraform force-unlock <ID>` |
| le plan veut **détruire et recréer** un espace | un attribut immuable a changé (ou une clé de `for_each` renommée) | `moved {}` ou `terraform state mv` ; JAMAIS appliquer sans comprendre un `-/+` sur un espace de noms |
| `no matches for kind "ClusterIssuer"` | un objet à CRD écrit hors du chart socle | le mettre dans `helm/socle` |
| un `helm_release` en échec, release « failed » | une valeur refusée par le chart, un pod qui ne démarre pas (wait) | `helm -n <ns> history <release>`, `k -n <ns> get events` ; corriger, réappliquer |
| Terraform veut changer quelque chose que personne n'a touché | un contrôleur réécrit un champ (défauts) | `lifecycle { ignore_changes = [...] }`, avec un commentaire |

## 7. Terraform ou OpenTofu ?

OpenTofu est le *fork* libre de Terraform (après le changement de licence de
HashiCorp en 2023). Ce code fonctionne avec les deux (`tofu init`, `tofu plan`…).
La CI utilise Terraform ; changer est une ligne (`setup-opentofu`).
