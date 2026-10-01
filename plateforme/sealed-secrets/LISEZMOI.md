# Le certificat public de Sealed Secrets

`certificat.pem` (à poser ici) est la **clé publique** du contrôleur Sealed
Secrets du cluster. Elle sert à **chiffrer** ; elle ne sait pas déchiffrer.
On peut donc la versionner sans risque : c'est ce qui permet à n'importe qui
de l'équipe de sceller un secret **sans accès au cluster**.

## La récupérer (une fois, après le premier déploiement d'Argo CD)

Sur le serveur :

```bash
sudo k3s kubectl -n sealed-secrets get secret \
  -l sealedsecrets.bitnami.com/sealed-secrets-key=active \
  -o jsonpath='{.items[0].data.tls\.crt}' | base64 -d > certificat.pem
```

Puis la committer ici (`plateforme/sealed-secrets/certificat.pem`).

## Ce qu'il faut savoir

- Le contrôleur **renouvelle** sa paire tous les 30 jours (il garde les
  anciennes pour déchiffrer). Les anciens chiffrés restent valides ; mettre à
  jour `certificat.pem` de temps en temps suffit.
- **La clé PRIVÉE est le trésor** : sans elle, aucun secret du dépôt ne peut
  être déchiffré. Si le serveur est perdu, il faut la restaurer AVANT
  qu'Argo CD ne recrée le contrôleur — sinon il en génère une nouvelle et
  tous les secrets sont à re-sceller. La sauvegarder hors du serveur,
  chiffrée (procédure : `docs/plateforme/10-exploitation.md`, « clé Sealed Secrets »).
