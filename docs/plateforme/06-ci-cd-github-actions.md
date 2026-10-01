# 06 — CI/CD avec GitHub Actions

## 1. Les workflows

| Workflow | Déclencheur | Rôle | Touche au cluster ? |
|---|---|---|---|
| `plateforme-qualite.yml` | PR, push (plateforme/, gitops/) | fmt, validate, **terraform test**, tflint, helm lint, **helm unittest**, kubeconform, trivy, zizmor, shellcheck | non |
| `plateforme-terraform.yml` | PR → **plan** ; main → **apply** (approbation) | le socle | oui, par tunnel SSH |
| `k8s-publier.yml` | appelé par les dépôts d'application | construire, scanner, pousser, signer, SBOM, promouvoir, vérifier | **non** (écrit dans Git) |
| `ci.yml`, `deployer.yml` | (existants) | la voie `infra` | — |

### Les notions GitHub Actions utilisées (et à connaître)

| Notion | Où | Ce que ça apporte |
|---|---|---|
| **Workflow réutilisable** (`workflow_call`) | `k8s-publier.yml` | un seul pipeline de livraison pour tous les dépôts |
| **Action composite** | `.github/actions/tunnel-plateforme` | factoriser des étapes (tunnel) entre deux travaux |
| **Environnements** | `plateforme-plan`, `production` | secrets propres à un environnement + **relecteurs obligatoires** |
| **OIDC** (`id-token: write`) | signature cosign, attestations | une identité courte, sans secret stocké |
| **GitHub App** | promotion GitOps | un jeton d'1 h, limité à UN dépôt et une permission |
| **`permissions:`** | partout | le `GITHUB_TOKEN` n'a que ce dont le travail a besoin |
| **`concurrency:`** | terraform, promotion | jamais deux apply à la fois ; jamais deux promotions de la même app |
| **matrice** | `construire` (backend, frontend) | le même travail pour deux images |
| **artefacts** | empreintes, SBOM | passer des données entre travaux |
| **épinglage par SHA** | toutes les actions | une étiquette se déplace, un SHA non (07, §3) |

## 2. Mise en route (une fois), pas à pas

### 2.1 Sur le serveur
```bash
sudo plateforme/amorcage/installer-k3s.sh --pare-feu
sudo plateforme/amorcage/compte-tunnel-ci.sh                 # affiche 4 secrets
sudo plateforme/amorcage/kubeconfig-pipeline.sh terraform-plan
sudo plateforme/amorcage/kubeconfig-pipeline.sh terraform-apply
sudo plateforme/amorcage/identifiants-registre.sh <compte-robot>
sudo plateforme/amorcage/ouvrir-postgres-aux-pods.sh
```

### 2.2 La deploy key d'Argo CD (lecture seule)
```bash
ssh-keygen -t ed25519 -N "" -C argocd-plateforme -f argocd-depot
```
Infra-server → *Settings → Deploy keys → Add* : `argocd-depot.pub`, **sans**
« Allow write access ». La clé privée → secret `ARGOCD_CLE_DEPOT`.

### 2.3 Le mot de passe admin d'Argo CD (seule l'empreinte voyage)
```bash
htpasswd -nbBC 12 "" 'un-long-mot-de-passe' | tr -d ':\n'     # paquet apache2-utils
```
→ secret `ARGOCD_ADMIN_BCRYPT`. Le mot de passe lui-même va dans votre
gestionnaire de mots de passe, nulle part ailleurs.

### 2.4 Les environnements (Infra-server → *Settings → Environments*)
| Environnement | Protection | Secret |
|---|---|---|
| `plateforme-plan` | aucune | `PLATEFORME_KUBECONFIG_PLAN` |
| `production` | **Required reviewers** : vous (et un collègue si possible) ; **Deployment branches** : `main` seulement | `PLATEFORME_KUBECONFIG_APPLY` |

⚠ **Créer `production` AVANT de merger la PR de la plateforme.** Si un
workflow cite un environnement qui n'existe pas, GitHub le crée tout seul…
**sans aucune protection** : l'apply partirait sans approbation.

Tant que les secrets ne sont pas posés, le plan des PR affiche un
avertissement « Plateforme non raccordée » et ne fait rien (il ne rougit pas
la PR) ; l'apply sur `main`, lui, échoue en nommant les secrets manquants.

### 2.5 Les secrets du dépôt Infra-server (*Settings → Secrets and variables → Actions*)
| Secret | Valeur | D'où |
|---|---|---|
| `PLATEFORME_SSH_HOST` | adresse du serveur | `compte-tunnel-ci.sh` |
| `PLATEFORME_SSH_USER` | `tunnel-ci` | idem |
| `PLATEFORME_SSH_KEY` | clé privée du tunnel | idem (affichée une fois) |
| `PLATEFORME_SSH_KNOWN_HOSTS` | `<hôte> ssh-ed25519 AAAA…` | idem |
| `ARGOCD_CLE_DEPOT` | clé privée de la deploy key | 2.2 |
| `ARGOCD_ADMIN_BCRYPT` | `$2y$12$…` | 2.3 |

### 2.6 La GitHub App de promotion (au niveau de l'organisation)
*Organization settings → Developer settings → GitHub Apps → New GitHub App* :
- nom : `plateforme-gitops` ; *Webhook* : décoché ;
- *Repository permissions* : **Contents : Read and write** (Metadata : Read, imposé) ; rien d'autre ;
- *Where can this app be installed* : Only on this account ;
- créer, puis *Generate a private key* (.pem) et noter le **Client ID** ;
- *Install App* → **Only select repositories** → `Infra-server`.

Secrets **de l'organisation** (accès : les dépôts d'application) :
`GITOPS_APP_CLIENT_ID`, `GITOPS_APP_CLE` (le contenu du .pem).

Pourquoi une App et pas un jeton personnel (PAT) ? Le jeton de l'App vit
**une heure**, ne vaut que pour **Infra-server**, avec **une** permission,
et n'est attaché à aucune personne (départ d'un collègue = rien ne casse).

### 2.7 Protéger `main` (Infra-server → *Settings → Rules → Rulesets*)
- exiger une PR, et ces vérifications : **`garde (qualité)`** (il résume tous
  les travaux de `plateforme · qualité`, qui tourne sur TOUTES les PR) et
  **`shellcheck et banc`** (`campagne`). Ne pas exiger `plan (lecture seule)` :
  il ne tourne que si la PR touche au socle (un contrôle filtré par chemins
  resterait « en attente » sur les autres PR) ;
- interdire le force-push et la suppression ;
- **Bypass list** : l'App `plateforme-gitops` (elle commit directement les
  promotions `deploy(<app>)` ; elle ne peut toucher qu'au contenu, et
  chacun de ses commits est tracé).

Variante plus stricte : la promotion ouvre une PR (auto-merge quand la CI est
verte). Plus de traçabilité, un peu plus de latence (TP 11).

### 2.8 Les workflows réutilisables accessibles
Infra-server → *Settings → Actions → General → Access* : « Accessible from
repositories in the EntrepriseTools organization » (déjà fait pour `deployer.yml`).

### 2.9 Publier la version `v1`
Les dépôts appellent `k8s-publier.yml@v1`, et Kyverno n'accepte que les
signatures produites par ce workflow à `main` ou à une étiquette `vN`. Après
le merge :
```bash
git tag -f v1 && git push -f origin v1      # v1 suit la dernière version compatible
```
(`deployer.yml` est inchangé : déplacer `v1` ne casse pas les dépôts qui l'utilisent.)

### 2.10 Le premier apply
Merger la PR qui ajoute la plateforme → `plateforme · terraform` → *apply*
attend → **Review deployments → Approve**. Suivre le journal ; à la fin,
`terraform output` est dans le résumé.

## 3. Le workflow de publication, en détail

```
construire (matrice backend[, frontend])
  ├─ refuse si la branche n'est pas la branche par défaut
  ├─ docker build (cache GitHub Actions)                         load, pas de push
  ├─ trivy image --ignore-unfixed --severity CRITICAL,HIGH       échec = rien n'est poussé
  ├─ docker push (même construction, depuis le cache)            → empreinte sha256
  ├─ cosign sign --yes <image>@<empreinte>                       OIDC → Fulcio → Rekor
  ├─ (option) attest-build-provenance                            SLSA, dans GHCR
  ├─ SBOM SPDX (syft) en artefact ; (option) attest-sbom
  └─ artefact « empreinte-<composant> »
promouvoir
  ├─ jeton de l'App (Infra-server, contents:write, 1 h)
  ├─ yq : image.tag = <sha>, image.empreinte = sha256:…           (et frontend.image.*)
  └─ commit « deploy(<app>): <sha7> », pull --rebase + push (5 essais)
verifier (si url-publique)
  └─ jusqu'à 15 min : X-Infra-Version == <sha> puis code HTTP 2xx/3xx
```

**Pourquoi construire, scanner, puis pousser ?** Une image vulnérable ne doit
jamais atteindre le registre, d'où le cluster pourrait la tirer.

**Pourquoi l'empreinte dans gitops/ ?** C'est l'objet exact qui a été scanné
et signé. Une étiquette pourrait être repoussée vers autre chose.

**Les attestations GitHub** (provenance SLSA, SBOM attesté) sont gratuites
pour les dépôts publics ; pour un dépôt **privé**, il faut GitHub Enterprise
Cloud. D'où `attestations-github: false` par défaut. La **signature cosign**,
elle, fonctionne partout (Sigstore, service public) — mais elle inscrit dans
le journal **public** Rekor le nom du dépôt et l'empreinte de l'image
(07, « écarts assumés »).

## 4. Le workflow Terraform, en détail

- PR : `terraform plan -lock=false -detailed-exitcode` avec le compte
  **terraform-plan** ; le plan complet en commentaire (mis à jour à chaque push).
- main : environnement `production` → **attente d'approbation** → plan → apply
  **du fichier de plan** (on applique exactement ce qui a été calculé).
- `concurrency: plateforme-terraform`, `cancel-in-progress: false` : un apply
  n'est jamais interrompu par un autre push.
- Les PR venues d'un fork ne reçoivent pas de secrets (et ne lancent pas de plan).

## 5. Dépanner la CI

| Symptôme | Cause probable |
|---|---|
| `le tunnel ne s'est pas ouvert` | `PLATEFORME_SSH_*` faux ; empreinte du serveur changée ; le garde ou sshd bloque `tunnel-ci` |
| `Unauthorized` au `terraform init` | le jeton du kubeconfig a été tourné : régénérer avec `kubeconfig-pipeline.sh` |
| `forbidden: User "system:serviceaccount:terraform-etat:terraform-plan" cannot get resource "secrets"` | un nouvel espace géré par Terraform sans RoleBinding : il vient avec l'apply suivant (espaces.tf) ; ou une ressource lue hors des espaces prévus |
| trivy bloque la publication | une CVE corrigeable : mettre à jour l'image de base / la dépendance ; en dernier recours, `.trivyignore` **dans le dépôt de l'application**, avec justification et date d'expiration |
| `deploy(...)` : push refusé | la règle de `main` ne laisse pas passer l'App (2.7) |
| `verifier` expire | voir l'Application dans Argo CD : hook de sauvegarde en échec ? pod qui ne devient pas prêt ? Kyverno qui refuse (Enforce) ? |
