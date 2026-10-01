# 05 — GitOps et Argo CD

## 1. GitOps : quatre principes

1. **Déclaratif** — l'état voulu est décrit (valeurs Helm), pas scripté.
2. **Versionné et immuable** — cet état vit dans Git : historique, auteur, relecture.
3. **Tiré automatiquement** — un agent DANS le cluster va le chercher (pull).
4. **Réconcilié en continu** — tout écart (dérive) est détecté et corrigé.

### Push contre pull

| | Push (`infra`, ou `helm upgrade` depuis la CI) | Pull (Argo CD) |
|---|---|---|
| Qui a les droits sur la production | la CI (clé SSH / kubeconfig dans chaque dépôt) | l'agent dans le cluster ; la CI n'a que le droit d'écrire dans Git |
| Porte entrante | oui (SSH) | **aucune** : le cluster sort vers GitHub |
| Retour arrière | relancer l'ancienne version | `git revert` |
| Modification à la main | reste jusqu'au prochain déploiement | défaite en ~2 min (selfHeal) |
| Audit | journaux de CI | l'historique Git |

## 2. Ce qu'Argo CD fait chez nous

```
socle (Terraform) ──▶ ApplicationSet « applications »
                        générateur git : un dossier gitops/applications/* = une Application
                         ├─ Application pilotage     → espace pilotage
                         ├─ Application procurement  → espace procurement
                         └─ Application paie         → espace paie
                      Application « sealed-secrets » → espace sealed-secrets
```

Chaque Application a **deux sources** (le *multi-source* d'Argo CD) :
1. le chart `plateforme/helm/application` ;
2. le même dépôt, nommé `$valeurs`, d'où vient
   `$valeurs/gitops/applications/<app>/values.yaml`.

La politique de synchronisation (`helm/socle/templates/argocd-applications.yaml`) :

| Réglage | Effet |
|---|---|
| `automated.prune: true` | ce qui disparaît de Git disparaît du cluster |
| `automated.selfHeal: true` | ce qui est modifié à la main est remis comme dans Git |
| `CreateNamespace=false` | l'espace est créé par Terraform (avec quotas et réseau), jamais par Argo CD |
| `ServerSideApply=true` | application côté serveur : gestion fine des champs, gros objets |
| `PruneLast=true` | les suppressions à la fin, une fois le reste en place |
| `retry` | 5 essais, de 15 s à 5 min |
| `preserveResourcesOnDeletion` (ApplicationSet) | supprimer un dossier supprime l'Application, PAS les objets en service |

### Les projets (AppProject) : des barrières

`applications` :
- source : seulement le dépôt GitOps ;
- destinations : seulement les espaces des applications ;
- **aucun** objet de niveau cluster ;
- interdit : ResourceQuota, LimitRange, Role, RoleBinding (la plateforme les tient).

Une valeur malveillante dans un `values.yaml` ne peut donc ni s'élever en
cluster-admin, ni lever ses quotas, ni déployer dans l'espace d'une autre application.

## 3. Le cycle de vie, concrètement

```bash
k -n argocd get applications                       # SYNC STATUS / HEALTH STATUS
k -n argocd get application pilotage -o yaml | yq .status
```

| Sync | Health | Signification |
|---|---|---|
| Synced | Healthy | tout va bien |
| OutOfSync | — | Git a changé (synchro dans ≤ 2 min) ou quelqu'un a modifié le cluster |
| Synced | Progressing | nouveau pod en cours de démarrage |
| Synced | Degraded | le Deployment a dépassé `progressDeadlineSeconds` : la nouvelle version ne devient pas prête — **l'ancienne sert toujours** |
| — | Missing | objets absents (premier déploiement, ou erreur de rendu) |
| Unknown + « ComparisonError » | | le chart ne se rend pas : lire le message (souvent un `fail` du chart : image ou secret manquant) |

## 4. Revenir en arrière

**La bonne façon** — par Git :
```bash
git log --oneline -- gitops/applications/pilotage/values.yaml
git revert <commit « deploy(pilotage): abc1234 »>
git push         # (ou une PR)
```
Argo CD redéploie l'empreinte précédente. Le hook de sauvegarde tourne aussi :
la base est copiée avant le retour.

**En urgence** — depuis l'interface Argo CD : *History and rollback* →
choisir une révision. Argo CD **désactive l'auto-sync** pour que votre retour
ne soit pas aussitôt défait. Ensuite : faire le `git revert` et réactiver
l'auto-sync (le Git doit redevenir la vérité).

⚠ **Un retour arrière remet une image, jamais un schéma de base.** Si la
version fautive a migré le schéma (Flyway/Liquibase), il faut soit une
migration compatible ascendante (recommandé : *expand/contract*), soit
restaurer la prise faite par le hook (10, « restaurer une prise »).

## 5. Accéder à l'interface

Pas d'Ingress public pour Argo CD (surface d'attaque). Par tunnel SSH :

```bash
# Sur votre poste — une commande :
ssh -L 8080:$(ssh admin@SERVEUR "sudo k3s kubectl -n argocd get svc argocd-server -o jsonpath='{.spec.clusterIP}'"):80 admin@SERVEUR
# puis http://localhost:8080 — utilisateur admin, le mot de passe dont l'empreinte est dans ARGOCD_ADMIN_BCRYPT
```

(Les adresses de Service 10.43.x.y sont joignables depuis l'hôte : le tunnel
les amène jusqu'à vous.)

En ligne de commande : `argocd login localhost:8080 --plaintext`, puis
`argocd app list`, `argocd app diff pilotage`, `argocd app history pilotage`.

## 6. Les secrets : Sealed Secrets

Le problème : Git doit contenir TOUT l'état… mais pas les mots de passe en clair.

La solution : **chiffrer pour le cluster**.

```
  votre poste                                   cluster
  ───────────                                   ───────
  fichier.env ─▶ kubeseal (clé PUBLIQUE) ─▶ AgB…  ──Git──▶  SealedSecret ─▶ contrôleur (clé PRIVÉE)
                                                                              │
                                                                              ▼
                                                                    Secret pilotage-secrets
                                                                    (envFrom dans le pod)
```

```bash
cat > /tmp/pilotage.env <<'EOF'
DATABASE_USER=pilotage
DATABASE_PASSWORD=…
AUTH_SECRET=…
ADMIN_PASSWORD=…
EOF
plateforme/outils/sceller.sh pilotage /tmp/pilotage.env    # affiche le bloc secrets.scelles
shred -u /tmp/pilotage.env
```
Coller le bloc dans `gitops/applications/pilotage/values.yaml`, PR, merge.

- **Portée `strict`** : le chiffré n'est valable que pour `pilotage-secrets`
  dans l'espace `pilotage`.
- **Changer UNE valeur** : re-sceller seulement cette clé (`sceller.sh` sur un
  fichier d'une ligne) et remplacer la ligne.
- Les valeurs reprises de `/etc/infra/secrets/<app>.env` (migration) : voir 09.
- **La clé privée du contrôleur est le trésor** : la sauvegarder hors du serveur (10).

## 7. Déboguer Argo CD

| Symptôme | Où regarder |
|---|---|
| l'application ne voit pas le nouveau commit | `k -n argocd logs deploy/argocd-repo-server` ; la deploy key est-elle valide ? (`k -n argocd get secret depot-gitops`) |
| « ComparisonError » / « Unable to generate manifests » | le message contient l'erreur de `helm template` : la reproduire en local |
| OutOfSync en permanence sur un champ | un contrôleur réécrit ce champ ; `ignoreDifferences` (avec commentaire) |
| bloqué en « Running » sur le hook PreSync | `k -n <app> logs job/<app>-sauvegarde` ; base joignable ? secret présent ? |
| « namespace not permitted in project » | l'espace n'est pas dans `applications` de `terraform.tfvars` (et donc pas dans l'AppProject) |
