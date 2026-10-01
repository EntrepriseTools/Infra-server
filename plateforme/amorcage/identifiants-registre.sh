#!/usr/bin/env bash
# =====================================================================
# identifiants-registre.sh — donne au nœud le droit de TIRER les images
# privées de GHCR (ghcr.io/entreprisetools/…).
#
#   sudo plateforme/amorcage/identifiants-registre.sh <compte-github>
#   (le jeton est demandé au clavier, jamais en argument : il finirait
#    dans l'historique du shell et dans `ps`)
#
# Le jeton : un « personal access token (classic) » d'un compte robot,
# portée `read:packages` SEULEMENT. GHCR n'accepte pas encore les jetons
# à grain fin pour les paquets d'organisation.
#
# Pourquoi au niveau du NŒUD (/etc/rancher/k3s/registries.yaml) et pas un
# imagePullSecret par application ?  Un seul serveur, une seule
# organisation : un identifiant au lieu de N copies dans N espaces de noms,
# et aucun Secret que Terraform devrait gérer dans les espaces des
# applications (voir rbac-pipeline.yaml : terraform-plan ne les lit pas).
# Kyverno limite de son côté les registres permis.
# =====================================================================
set -euo pipefail
utilisateur="${1:?usage : $0 <compte-github-robot>}"
[ "$(id -u)" = 0 ] || { echo "à lancer en root" >&2; exit 1; }
read -r -s -p "Jeton GHCR (read:packages) : " jeton; echo
[ -n "$jeton" ] || { echo "jeton vide" >&2; exit 1; }

umask 077
cat > /etc/rancher/k3s/registries.yaml.nouveau <<YAML
# Posé par identifiants-registre.sh — root 0600. Rotation : relancer le script.
configs:
  "ghcr.io":
    auth:
      username: "$utilisateur"
      password: "$jeton"
YAML
mv /etc/rancher/k3s/registries.yaml.nouveau /etc/rancher/k3s/registries.yaml
systemctl restart k3s
echo "  ✓ registries.yaml posé ; k3s relancé (les pods en cours ne sont pas interrompus)."
