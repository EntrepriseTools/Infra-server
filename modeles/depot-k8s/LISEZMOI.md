# Modèle de dépôt — application sur la plateforme Kubernetes

À copier dans un dépôt d'application (ou à fusionner avec l'existant).

| Fichier | Rôle |
|---|---|
| `.github/workflows/pipeline.yml` | vos tests, puis `publier` qui **appelle** `k8s-publier.yml` d'Infra-server |
| `Dockerfile` | image Spring Boot, UID 10001, compatible « racine en lecture seule » |
| `Dockerfile.frontend` + `nginx-spa.conf` | l'écran (mode spa), nginx sans privilège |

Remplacer `__APP__` (nom de l'application = dossier `gitops/applications/<app>`)
et `__IMAGE__` (ex. `board/pilotage`).

## Une fois, dans GitHub (dépôt de l'application)

| Type | Nom | Valeur |
|---|---|---|
| Secret | `GITOPS_APP_CLIENT_ID` | le « Client ID » de la GitHub App `plateforme-gitops` |
| Secret | `GITOPS_APP_CLE` | sa clé privée (.pem) |
| Variable | `URL_PUBLIQUE` | `https://<app>.sbp.ma` |

(Ou au niveau de l'**organisation**, une fois pour tous les dépôts.)

## Avant le premier push

1. L'espace de noms existe : entrée `<app>` dans
   `plateforme/terraform/plateforme/terraform.tfvars` (PR sur Infra-server, appliquée).
2. Le dossier `gitops/applications/<app>/values.yaml` existe dans Infra-server,
   avec ses secrets scellés.

Le parcours complet : `docs/plateforme/06-ci-cd-github-actions.md`.
