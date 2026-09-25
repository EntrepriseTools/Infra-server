# Déployer __APP__

Ce dépôt se déploie avec **Infra-server** (`EntrepriseTools/Infra-server`),
comme toutes les applications de l'organisation. Il n'y a **aucun script de
serveur dans ce dépôt** : seulement

| Fichier | Rôle |
|---|---|
| `deploiement/app.conf` | le manifeste : image, sondes, variables, volumes |
| `.github/workflows/pipeline.yml` | vos contrôles, puis l'appel au workflow commun |
| `Dockerfile` | l'image de l'application |

## Une fois, sur le serveur

```bash
scp deploiement/app.conf admin@SERVEUR:/tmp/__APP__.conf
ssh admin@SERVEUR
sudo infra creer __APP__ --manifeste /tmp/__APP__.conf --url https://__APP__.exemple.ma
sudo infra editer __APP__          # compléter ce qui reste vide
sudo certbot certonly --nginx -d __APP__.exemple.ma    # si https (DNS posé avant)
```

`infra creer` affiche les quatre secrets à poser dans GitHub (Settings →
Secrets and variables → Actions) : `INFRA_SSH_HOST`, `INFRA_SSH_USER`,
`INFRA_SSH_KEY`, `INFRA_SSH_KNOWN_HOSTS`. Et la variable `URL_PUBLIQUE`.

## Tous les jours

**Pousser sur `main`.** C'est tout. Sur le serveur :

```bash
sudo infra etat __APP__        # ce qui tourne, sondes, dernière sauvegarde
sudo infra historique __APP__  # les déploiements
sudo infra revenir __APP__     # remettre la version précédente
sudo infra journaux __APP__ -f
```
