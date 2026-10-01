# 04 — Helm

## 1. Ce qu'est Helm

Un **chart** est un paquet de gabarits de manifestes Kubernetes, avec des
**valeurs** par défaut. `helm template` (ou Argo CD) remplit les gabarits
avec les valeurs et produit du YAML. `helm install/upgrade` l'envoie au
cluster et garde un historique (*release*).

```
templates/*.yaml  +  values.yaml (défauts)  +  -f mes-valeurs.yaml  ──▶  manifestes Kubernetes
     (Go template)       (chart)                (gitops/applications/<app>/)
```

Chez nous, Helm sert de deux façons :
- **Terraform** installe les charts du socle (`helm_release`) ;
- **Argo CD** rend le chart `application` avec les valeurs de chaque
  application (Argo CD fait le `helm template` puis applique lui-même :
  `helm list` ne montre donc pas les applications — c'est normal).

## 2. Anatomie de `plateforme/helm/application`

```
Chart.yaml              nom, version DU CHART (à monter quand on le change), kubeVersion
values.yaml             les défauts, commentés — le « manifeste » d'une application
values.schema.json      le SCHÉMA des valeurs : types, motifs, clés permises
templates/
  _helpers.tpl          les fonctions : nom, étiquettes, image, secret…
  deployment.yaml       le backend
  service.yaml          son nom stable
  ingress.yaml          l'entrée HTTP (Traefik)
  middlewares.yaml      corps max, en-têtes, liste blanche (CRD Traefik)
  frontend.yaml         l'écran (mode spa)
  secret-scelle.yaml    les secrets chiffrés (CRD SealedSecret)
  sauvegarde.yaml       le hook PreSync : pg_dump relu
  volumes.yaml          les PVC (gardés à la suppression)
  serviceaccount.yaml, hpa.yaml, pdb.yaml, networkpolicy.yaml, servicemonitor.yaml
  tests/test-sonde.yaml `helm test`
  NOTES.txt             le texte affiché après installation
tests/*_test.yaml       tests unitaires (helm-unittest)
ci/*.yaml               jeux de valeurs pour la CI
```

## 3. Le langage des gabarits, par l'exemple

```yaml
{{- $nom := include "application.nom" . -}}       # une variable ; « - » mange les espaces
metadata:
  name: {{ $nom }}
  labels:
    {{- include "application.etiquettes" . | nindent 4 }}   # appel + indentation
spec:
  {{- if not .Values.autoscaling.actif }}                  # condition
  replicas: {{ .Values.repliques }}
  {{- end }}
  env:
    {{- range $cle, $valeur := .Values.env }}               # boucle sur un dictionnaire
    - name: {{ $cle }}
      value: {{ $valeur | toString | quote }}               # tuyaux : fonctions enchaînées
    {{- end }}
```

- `.` est le **contexte** : `.Values`, `.Release.Name`, `.Chart.Version`…
  Dans un `range`, `.` change : on garde la racine dans `$` ou une variable.
- `include` (plutôt que `template`) pour pouvoir passer le résultat à `nindent`.
- `quote` partout où une valeur pourrait être lue comme un nombre ou un booléen
  (`"true"`, `"5432"`, un SHA tout en chiffres…).
- `fail "message"` : arrêter le rendu avec une explication. Le chart refuse
  ainsi de rendre sans image (`application.image`) plutôt que de tirer
  `latest` en silence.
- `required`, `default`, `toYaml`, `sha256sum`, `dict`, `list`… : la
  bibliothèque Sprig.

### Les choix du chart qui méritent explication

| Choix | Où | Pourquoi |
|---|---|---|
| L'empreinte prime sur l'étiquette | `_helpers.tpl` `application.image` | une étiquette peut être déplacée ; `@sha256:` est immuable, et c'est ce qui est signé |
| Le sélecteur ne contient pas la version | `application.selecteur` | `spec.selector` d'un Deployment est **immuable** |
| `enableServiceLinks: false` | `deployment.yaml` | sinon Kubernetes injecte `POSTGRES_PORT=tcp://…` (à cause du Service `postgres`) et écrase la config d'une appli qui lit `POSTGRES_PORT` |
| Empreinte des secrets en annotation du pod | `deployment.yaml` | changer un secret change l'annotation → les pods sont relancés et lisent la nouvelle valeur |
| `Recreate` dès qu'il y a un volume | `deployment.yaml` | un volume ReadWriteOnce, un seul écrivain |
| `maxUnavailable: 0` | `deployment.yaml` | l'ancienne version n'est retirée qu'une fois la nouvelle **prête** |
| Écoute sur `0.0.0.0` | `variableAdresse` | dans un pod le trafic arrive par l'interface du pod, pas par 127.0.0.1 |
| `X-Infra-Version` | `middlewares.yaml` | la CI vérifie depuis Internet que la bonne version répond |
| PVC avec `helm.sh/resource-policy: keep` | `volumes.yaml`, `sauvegarde.yaml` | supprimer l'application ne supprime jamais des données |

### Les hooks : la sauvegarde avant déploiement

`sauvegarde.yaml` porte deux jeux d'annotations :
- `argocd.argoproj.io/hook: PreSync` (+ `sync-wave`) : Argo CD l'exécute
  **avant** d'appliquer le reste ; si le Job échoue, la synchronisation
  s'arrête et l'ancienne version continue de servir ;
- `helm.sh/hook: pre-upgrade` : la même chose pour un `helm upgrade` direct (labo).

Le volume des prises est lui-même un hook en vague `-1` (créé avant le Job),
jamais supprimé.

## 4. Le schéma des valeurs (`values.schema.json`)

Helm valide les valeurs contre le schéma **avant** de rendre. Le nôtre
refuse : une clé inconnue (`additionalProperties: false` — une faute de
frappe ne passe plus en silence), l'étiquette `latest`, un UID < 1000, une
empreinte mal formée, une limite mémoire absente, une image de sauvegarde
hors liste…

```bash
helm template t plateforme/helm/application --set image.tag=latest
# Error: values don't meet the specifications of the schema(s)…
```

## 5. Les tests

```bash
helm lint plateforme/helm/application --strict -f plateforme/helm/application/ci/proxy-values.yaml
helm unittest plateforme/helm/application          # 30 tests
helm template ci plateforme/helm/application -f …/ci/spa-values.yaml | kubeconform -strict -summary -
```

- **lint** : la structure du chart et les erreurs de rendu.
- **unittest** : « avec ces valeurs, ce champ vaut ceci » — et « avec
  celles-là, le rendu échoue avec ce message ». Exemple :

```yaml
- it: préfère l'empreinte à l'étiquette quand les deux sont données
  set:
    image.empreinte: sha256:1111…
  asserts:
    - equal:
        path: spec.template.spec.containers[0].image
        value: ghcr.io/entreprisetools/board/pilotage@sha256:1111…
```

- **kubeconform** : chaque objet rendu est valide pour l'API Kubernetes
  (et pour les CRD : Traefik, Sealed Secrets, Prometheus, via le catalogue
  datreeio/CRDs-catalog).
- **helm test** (dans le cluster) : `helm -n pilotage test pilotage` — ne
  marche que pour une release Helm ; avec Argo CD, lancer le pod de test via
  `k -n pilotage apply` du rendu, ou simplement vérifier la sonde.

## 6. Ajouter une application, pas à pas

1. **Terraform** — dans `terraform.tfvars` :
   ```hcl
   applications = {
     ...
     facturation = { quota = { memoire_limites = "2Gi" } }
   }
   ```
   PR → plan → merge → apply approuvé. L'espace `facturation` existe, fermé.
2. **Base** — sur le serveur : `sudo plateforme/amorcage/creer-base.sh facturation`.
3. **Secrets** — sur votre poste : renommer les clés du fichier selon ce que lit
   l'application, puis :
   ```bash
   plateforme/outils/sceller.sh facturation /tmp/facturation-base.env
   ```
4. **Valeurs** — `gitops/applications/facturation/values.yaml` (partir de `pilotage`) :
   image (sans tag), sondes, ressources, `ingress.hote`, bloc `secrets.scelles`,
   `sauvegardeAvantDeploiement`. Vérifier en local :
   ```bash
   helm template facturation plateforme/helm/application -n facturation \
     -f gitops/applications/facturation/values.yaml --set image.tag=essai | less
   ```
5. **Dépôt de l'application** — copier `modeles/depot-k8s/` (pipeline, Dockerfile), poser
   les secrets `GITOPS_APP_*` et la variable `URL_PUBLIQUE`.
6. **DNS + certificat + pont** (coexistence) :
   ```bash
   sudo certbot certonly --nginx -d facturation.sbp.ma
   sudo plateforme/amorcage/brancher-nginx.sh facturation.sbp.ma
   ```
7. Pousser sur `main` dans le dépôt de l'application. Suivre dans Argo CD.

## 7. Déboguer un rendu

```bash
helm template x plateforme/helm/application -f valeurs.yaml --debug   # montre le YAML même invalide
helm template x … -s templates/ingress.yaml                            # un seul gabarit
helm template x … | yq 'select(.kind == "Deployment") | .spec.template.spec.containers[0].env'
```

## 8. Versionner le chart

Le chart est consommé **depuis le même dépôt, sur `main`** par Argo CD : un
changement du chart touche TOUTES les applications à la synchronisation
suivante. Donc : monter `version` dans `Chart.yaml`, tests verts, et relire
le diff rendu des trois applications (le job `helm` de la CI les rend). Pour
aller plus loin : publier le chart en OCI sur GHCR (`helm push`) et épingler
sa version par application (TP 9).
