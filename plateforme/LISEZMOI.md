# plateforme/ — la voie Kubernetes

Le code de la plateforme : amorçage du cluster (k3s), socle (Terraform),
charts (Helm), outils et labo.

**Toute la documentation est dans [docs/plateforme/](../docs/plateforme/00-LISEZMOI.md)** —
commencer par le LISEZMOI, qui donne la carte et le parcours.

Contrôles locaux (les mêmes que la CI) :

```bash
make -C plateforme aide
make -C plateforme tout
```
