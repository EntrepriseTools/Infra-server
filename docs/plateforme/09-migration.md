# 09 — Migrer les applications d'`infra` vers Kubernetes

## Le principe

**Une application à la fois, la moins critique d'abord, et un retour
possible à chaque étape.** L'ordre : **pilotage**, puis **procurement**,
puis **paie**. Entre deux migrations, laisser tourner au moins une semaine.

Ce qui ne bouge pas : la base (même PostgreSQL, même rôle, même base), les
sauvegardes quotidiennes d'`infra`, le nom public, le certificat (certbot).

```
AVANT    Internet → nginx (bloc infra pilotage.conf) → 127.0.0.1:8084 → conteneur Compose → PostgreSQL
PENDANT  les deux tournent ; nginx pointe encore sur Compose ; on éprouve k8s par un nom de test
APRÈS    Internet → nginx (bloc k8s-pilotage.sbp.ma.conf) → Traefik → pod → Service postgres → PostgreSQL
```

## 0. Prérequis (une fois)

- La plateforme est installée et `terraform apply` a réussi (06, mise en route).
- `k -n argocd get applications` montre `pilotage`, `procurement`, `paie`
  (en erreur « ni image.tag ni image.empreinte » : normal, rien n'est publié).
- `plateforme/sealed-secrets/certificat.pem` est committé.
- PostgreSQL est ouvert aux pods (`ouvrir-postgres-aux-pods.sh`, redémarrage fait au calme).

## 1. pilotage

### 1.1 Les secrets
Sur le serveur, les valeurs actuelles sont dans `/etc/infra/secrets/pilotage.env`
(root 0600) — c'est `infra` qui les a créées, sous les noms que lit
l'application :

```bash
sudo grep -E '^(DATABASE_USER|DATABASE_PASSWORD|AUTH_SECRET|ADMIN_PASSWORD)=' /etc/infra/secrets/pilotage.env > /root/pilotage-k8s.env
# copier sur votre poste par un canal sûr (scp), puis :
plateforme/outils/sceller.sh pilotage pilotage-k8s.env      # bloc à coller dans gitops/applications/pilotage/values.yaml
shred -u pilotage-k8s.env ; ssh admin@SERVEUR sudo shred -u /root/pilotage-k8s.env
```
`DATABASE_URL` n'est pas un secret : il est déjà dans `env` (`jdbc:postgresql://postgres:5432/pilotage`).

### 1.2 Vérifier les valeurs
Dans `gitops/applications/pilotage/values.yaml` : `ingress.hote` (le vrai nom :
`PILOTAGE_URL_PUBLIQUE`), la base, les sondes. Pour l'essai, mettre d'abord
un nom de TEST : `ingress.hote: pilotage-k8s.sbp.ma` (+ enregistrement DNS, + certificat).

### 1.3 Le dépôt board
Ajouter le travail `publier` (modèle : `modeles/depot-k8s/.github/workflows/pipeline.yml`)
**à côté** du `deployer` existant :

```yaml
  publier:
    needs: [tests]
    if: github.ref == 'refs/heads/main' && github.event_name == 'push'
    permissions: { contents: read, packages: write, id-token: write, attestations: write }
    uses: EntrepriseTools/Infra-server/.github/workflows/k8s-publier.yml@v1
    with:
      application: pilotage
      image: board/pilotage
      contexte: .
      url-publique: https://pilotage-k8s.sbp.ma
    secrets:
      GITOPS_APP_CLIENT_ID: ${{ secrets.GITOPS_APP_CLIENT_ID }}
      GITOPS_APP_CLE: ${{ secrets.GITOPS_APP_CLE }}
```
⚠ Le Dockerfile doit utiliser un **UID numérique** (`USER 10001`) — voir
`modeles/depot-k8s/Dockerfile`. Sinon : `securite.utilisateur` doit
correspondre à l'UID de l'image, ou le pod sera refusé.

### 1.4 Le nom de test
```bash
sudo certbot certonly --nginx -d pilotage-k8s.sbp.ma
sudo plateforme/amorcage/brancher-nginx.sh pilotage-k8s.sbp.ma
```
Pousser sur `main` dans board. Les deux voies déploient : `infra` (l'actuelle)
et k8s (le nom de test). **Éprouver** sur `https://pilotage-k8s.sbp.ma` :
connexion, écrans, écriture en base. Les deux versions partagent **la même
base** : c'est voulu (même code, même schéma), mais n'y faites pas de tests destructifs.

### 1.5 La bascule (quelques secondes de coupure)
```bash
# 1. le vrai nom dans les valeurs : ingress.hote: pilotage.sbp.ma  (PR, merge, Argo CD synchronise)
# 2. sur le serveur — mettre de côté le bloc nginx d'infra (nginx refuse deux
#    server_name identiques), puis poser le pont vers Traefik :
sudo infra etat pilotage                      # repérer la porte (par défaut /etc/nginx/conf.d/pilotage.conf)
sudo mv /etc/nginx/conf.d/pilotage.conf /root/pilotage.conf.infra
sudo plateforme/amorcage/brancher-nginx.sh pilotage.sbp.ma     # nginx -t, reload, sonde
curl -sI https://pilotage.sbp.ma | grep -i '^x-infra'          # X-Infra-Voie: k8s, X-Infra-App: pilotage
# 3. arrêter l'ancien conteneur (sans le supprimer : c'est le retour arrière)
sudo docker ps -q --filter label=com.docker.compose.project=pilotage | xargs -r sudo docker stop
```

### 1.6 Revenir en arrière (si besoin)
```bash
sudo plateforme/amorcage/brancher-nginx.sh --retirer pilotage.sbp.ma
sudo infra relancer pilotage        # compose ET porte réengendrés, conteneur relancé, sondé
```
L'application est de nouveau servie par `infra`, sur la même base.
(`/root/pilotage.conf.infra` n'est alors plus utile : `infra relancer` a reposé la porte.)

### 1.7 Nettoyer (après une semaine sans souci)
- retirer le travail `deployer` du pipeline de board ;
- `brancher-nginx.sh --retirer pilotage-k8s.sbp.ma` (le nom de test) ;
- **ne pas lancer `infra retirer pilotage` tout de suite** : ce verbe retire
  aussi le minuteur `infra-sauvegarde@pilotage.timer`, qui fait la sauvegarde
  QUOTIDIENNE de la base — or la base n'a pas bougé et doit rester
  sauvegardée. Laisser le conteneur arrêté suffit. (Quand la sauvegarde
  quotidienne sera prise en charge autrement — un CronJob, TP « pour aller
  plus loin » — `infra retirer` pourra faire le ménage.)

## 2. procurement (mode spa)

Mêmes étapes, avec :
- **deux images** : `image: procurement/backend` (`contexte: ./backend`) et
  `frontend-image: procurement/frontend` (`frontend-contexte: ./frontend`).
  L'écran a besoin du `Dockerfile.frontend` et de `nginx-spa.conf` du modèle ;
- secrets : `PGUSER`, `PGPASSWORD`, `JWT_SECRET` (depuis `/etc/infra/secrets/procurement.env`) ;
- vérifier `PGDATABASE` (le nom réel de la base, `--base` utilisé par `infra creer`) ;
- le tableau de bord IA répond en flux (SSE) : le pont nginx a
  `proxy_buffering off` et 300 s de délai ; Traefik ne coupe pas les réponses longues.

## 3. paie (la plus critique, en dernier)

En plus :
- **les volumes** `hr_paie-etat` et `hr_paie-journaux` (Docker) contiennent
  des données : les copier dans les PVC **pendant une fenêtre de maintenance** :
  ```bash
  # 1. créer les PVC sans démarrer l'appli : repliques: 0 dans les valeurs, synchroniser
  # 2. trouver le répertoire du PVC (local-path) :
  k -n paie get pv $(k -n paie get pvc paie-etat -o jsonpath='{.spec.volumeName}') -o jsonpath='{.spec.hostPath.path}{.spec.local.path}'
  # 3. arrêter l'ancien conteneur (projet compose « hr »), copier, donner les fichiers à l'UID 10001 :
  sudo docker ps -q --filter label=com.docker.compose.project=hr | xargs -r sudo docker stop
  sudo rsync -a /var/lib/docker/volumes/hr_paie-etat/_data/ <répertoire-du-pvc>/
  sudo chown -R 10001:10001 <répertoire-du-pvc>
  # (idem pour journaux) puis repliques: 1
  ```
- la supervision propre à la paie (`paie.sh supervision`, Loki) lit
  `hr_paie-journaux` : à réévaluer (08, « journaux »).
- prévoir le retour arrière **avec les volumes** : recopier dans l'autre sens.

## 4. Le mode direct (quand plus rien ne passe par `infra`)

Traefik prend 80/443, cert-manager les certificats ; le nginx de l'hôte s'arrête.

1. Pour chaque application : `ingress.tls.actif: true`, `ingress.proxysDevant: 0`
   (et essayer d'abord `ingress.tls.emetteur: letsencrypt-staging`).
2. `mode_ingress = "direct"` dans `terraform.tfvars` — PR, plan relu.
3. Fenêtre de maintenance : `sudo systemctl stop nginx && sudo systemctl disable nginx`,
   puis approuver l'apply (Traefik prend les ports).
4. cert-manager demande les certificats (défi HTTP-01 via Traefik) :
   `k get certificate -A` → `READY True`. Repasser l'émetteur sur `letsencrypt`.
5. Retour arrière : `mode_ingress = "coexistence"`, réactiver nginx.
