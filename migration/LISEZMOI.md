# Migrer paie, Pilotage et Procurement vers `infra`

Ce qui ne bouge **pas** pendant la bascule : les bases, les volumes (on garde
le même projet compose), le port, le nom public et le fichier nginx. On
change **qui déploie**, pas **où vivent les données**. À chaque étape,
l'ancien outillage reste en place et peut reprendre la main, jusqu'au
nettoyage final.

**Ordre conseillé** : Pilotage (le moins critique), puis Procurement, puis la
paie (110 salariés vivants, et une voie native encore en service).

## 0. Une fois : installer infra

```bash
# depuis le poste, dans une copie d'Infra-server
outils/pousser-sur-serveur.sh admin@197.153.58.171 --hote 197.153.58.171 --installer-paquets
ssh admin@197.153.58.171 sudo infra docteur
```

Dans GitHub, dépôt **Infra-server** : Settings → Actions → General → Access →
*Accessible from repositories in the EntrepriseTools organization*, puis
`git tag v1 && git push origin v1` sur la version validée.

## 1. Enregistrer l'application (sur le serveur)

`--depuis` reprend **l'ancien `.env`** (copié, root 0600, dans
`/etc/infra/secrets/`) et **la version qui tourne** (`tag-en-service`, plus
l'écran pour Procurement). Sans cette reprise, le premier déploiement sous
`infra` n'aurait aucune version où revenir. `--adopter` est implicite : le
compte et la base existants sont repris **sans être modifiés**.

Avant de lancer quoi que ce soit, vérifier le nom de la base et du rôle :
`sudo -u postgres psql -l`.

### Pilotage (dépôt `board`)

```bash
scp migration/pilotage/app.conf admin@SERVEUR:/tmp/pilotage.conf
sudo infra creer pilotage --manifeste /tmp/pilotage.conf \
     --depuis /opt/board --compte deploy_board --projet board --fichier-nginx pilotage \
     --port 8084 --base pilotage --role pilotage \
     --url "$(sudo sed -n 's/^PILOTAGE_URL_PUBLIQUE=//p' /opt/board/.env)"
# ce que l'ancien .env réglait ailleurs :
sudo infra regler pilotage ACCES_LIMITE="…"        # si PILOTAGE_ACCES_LIMITE était posée
sudo infra regler pilotage TLS_CERT=… TLS_CLE=…    # si PILOTAGE_TLS_* étaient posées
sudo infra regler pilotage SAUVEGARDE_CLE_GPG=…    # si PILOTAGE_SAUVEGARDE_CLE était posée
```

### Procurement (dépôt `Purchase_Management`)

```bash
scp migration/procurement/app.conf admin@SERVEUR:/tmp/procurement.conf
sudo infra creer procurement --manifeste /tmp/procurement.conf \
     --depuis /opt/procurement --compte procurement --projet procurement --fichier-nginx procurement \
     --port 8087 --base "$(sudo sed -n 's/^PGDATABASE=//p' /opt/procurement/.env)" \
     --role "$(sudo sed -n 's/^PGUSER=//p' /opt/procurement/.env)" \
     --url https://app.purchase.sbp.ma
```

### La paie (dépôt `HR_Management`)

```bash
scp migration/paie/app.conf admin@SERVEUR:/tmp/paie.conf
sudo infra creer paie --manifeste /tmp/paie.conf \
     --depuis /opt/hr --compte deploy --projet hr --fichier-nginx paie \
     --port 8080 --base paie --role paie \
     --url "$(sudo sed -n 's/^PAIE_URL_PUBLIQUE=//p' /opt/hr/.env)" \
     --heure 21:00
sudo infra regler paie ACCES_LIMITE="…" TLS_CERT=… TLS_CLE=… SAUVEGARDE_CLE_GPG=…   # selon PAIE_* de l'ancien .env
```

⚠ `--projet hr` n'est pas négociable : les volumes `hr_paie-etat` et
`hr_paie-journaux` sont repris **parce que** le projet garde son nom. La
supervision (Alloy) continue ainsi de lire `hr_paie-journaux`.

Chaque `infra creer` affiche les quatre secrets `INFRA_SSH_*`. Les poser dans
le dépôt correspondant. Puis :

```bash
sudo infra docteur     # « jamais déployée » est normal à ce stade
```

## 2. Changer le pipeline (dans chaque dépôt, par une PR)

1. Poser le manifeste : `deploiement/app.conf` ← `migration/<app>/app.conf`.
2. **Remplacer** le travail de déploiement par l'appel au workflow commun.
   Les travaux de test ne changent pas.

**board** — `.github/workflows/campagne.yml`, remplacer le travail `deployer` :

```yaml
  deployer:
    needs: [ecran, serveur, script]
    if: github.ref == 'refs/heads/main' && (github.event_name == 'push' || inputs.deployer)
    uses: EntrepriseTools/Infra-server/.github/workflows/deployer.yml@v1
    with:
      application: pilotage
      contexte: .
      url-publique: ${{ vars.URL_PUBLIQUE }}
    secrets: inherit
```

**HR_Management** — `.github/workflows/campagne.yml`, remplacer `deployer` :

```yaml
  deployer:
    needs: [ecran, kotlin]
    if: github.ref == 'refs/heads/main' && (github.event_name == 'push' || inputs.deployer)
    uses: EntrepriseTools/Infra-server/.github/workflows/deployer.yml@v1
    with:
      application: paie
      contexte: ./paie_kotlin
      url-publique: ${{ vars.URL_PUBLIQUE }}
    secrets: inherit
```

⚠ L'ancien travail déposait aussi `paie_kotlin/supervision/` dans
`/opt/hr/supervision`. Ce dépôt propre à la paie n'est **pas** repris par
`infra`. Tant que la supervision n'a jamais démarré (cf. CLAUDE.md de HR), le
plus simple est de la déposer à la main le jour où on la démarre. Sinon, on
garde un petit travail `scp` dédié.

**Purchase_Management** — remplacer `deploy-serveur.yml` par le pipeline du
modèle (`outils/nouveau-depot.sh procurement <dépôt> --mode spa` écrit
`pipeline.yml` sans toucher à l'existant). À défaut, remplacer seulement son
travail `deployer` :

```yaml
  deployer:
    needs: verifier
    uses: EntrepriseTools/Infra-server/.github/workflows/deployer.yml@v1
    with:
      application: procurement
      contexte: ./backend
      frontend: frontend
      frontend-node: "20"
      url-publique: ${{ vars.PROC_URL_PUBLIQUE }}
    secrets: inherit
```

Pour Purchase, en profiter pour corriger l'audit : lint **bloquant** (retirer
`|| true` et `continue-on-error`), contrôles de PR **sans filtre de chemin**,
et une case `deployer` sur le « Run workflow ».

## 3. Le premier déploiement sous infra

Fusionner la PR. Le pipeline livre, puis `infra` :

- prend une prise relue ;
- réengendre le compose, sous le **même projet** et avec le **même
  service** : le conteneur est recréé en place, et les volumes sont
  repris ;
- réécrit le **même fichier nginx**. L'en-tête de preuve devient
  `X-Infra-App`, et l'ancien `X-…-Porte` disparaît.

S'il tombe, il revient à la version reprise par `--depuis`. Vérifier :

```bash
sudo infra etat <app>
sudo infra historique <app>
sudo infra verifier <app>          # la chaîne de sauvegarde, pour de vrai
```

## 4. Le nettoyage (seulement une fois que tout est vert)

| | Pilotage | Procurement | Paie |
|---|---|---|---|
| Ancien minuteur | `sudo systemctl disable --now board-sauvegarde.timer` | `… procurement-sauvegarde.timer` | `… hr-sauvegarde.timer` |
| Ancien sudo | `sudo rm /etc/sudoers.d/deploy_board` | `sudo rm /etc/sudoers.d/procurement-procurement` | `sudo rm /etc/sudoers.d/deploy` |
| Groupe docker (plus nécessaire) | `sudo gpasswd -d deploy_board docker` | `sudo gpasswd -d procurement docker` | `sudo gpasswd -d deploy docker` ⚠ seulement si rien d'autre ne s'en sert |
| Anciennes clés du pipeline | retirer de `~deploy_board/.ssh/authorized_keys` les lignes **sans** `infra:pilotage` | idem | idem |
| Anciens secrets GitHub | `SSH_HOST`, `SSH_KEY`, `SSH_PASSWORD` | `PROC_SSH_*` | `SSH_*` |
| Anciens fichiers du dépôt | `deploiement/pilotage.sh`, gabarit, compose, sudoers, bancs | `deploiement/procurement.sh`, gabarit, compose | `deploiement/paie.sh` : ⚠ **le garder** tant que `supervision` et `retirer-base-docker` servent |
| Ancien `/opt/<app>/.env` | le vider **après** avoir vérifié `/etc/infra/secrets/<app>.env` | idem | idem (la voie **native** lit `/etc/paie/paie.env` : ne pas y toucher) |

Puis `sudo infra docteur`. Il ne doit plus signaler de minuteur de l'ancien
outillage, ni de compte dans le groupe docker.

## Revenir à l'ancien outillage (si besoin, avant le nettoyage)

L'ancien script est toujours dans `/opt/<app>/`. `bash /opt/board/pilotage.sh
deployer <sha>` repose son compose et son bloc nginx. Côté GitHub, il suffit de
revenir au commit du pipeline précédent : les anciens secrets sont encore là.
