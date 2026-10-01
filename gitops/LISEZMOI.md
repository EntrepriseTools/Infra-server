# gitops/ — ce qu'Argo CD fait tourner

**Ce dossier EST l'état voulu de la production.** Argo CD (dans le cluster)
le lit toutes les deux minutes et fait converger le cluster vers lui.

```
gitops/applications/<app>/values.yaml   →   Application Argo CD « <app> »
                                             = chart plateforme/helm/application
                                               + ces valeurs
                                             dans l'espace de noms « <app> »
```

| Qui écrit ici | Quoi | Comment |
|---|---|---|
| **La CI d'une application** | `image.tag` et `image.empreinte` | commit automatique `deploy(<app>): <sha>` (workflow `k8s-publier.yml`) |
| **Vous** | tout le reste (sondes, mémoire, nom public, secrets scellés…) | une PR, relue |

- **Revenir en arrière** : `git revert <commit deploy(...)>` → Argo CD redéploie l'image précédente.
- **Ajouter une application** : d'abord son espace dans
  `plateforme/terraform/plateforme/terraform.tfvars` (quotas, réseau, base), ensuite le dossier ici.
- **Un secret** : jamais en clair. `plateforme/outils/sceller.sh <app> fichier.env`
  produit le bloc `secrets.scelles` à coller.

Le détail : [docs/plateforme/05-gitops-argocd.md](../docs/plateforme/05-gitops-argocd.md).
