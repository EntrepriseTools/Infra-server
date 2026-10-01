#!/usr/bin/env bash
# =====================================================================
# kubeconfig-pipeline.sh — affiche le kubeconfig d'un compte du pipeline,
# prêt à coller dans un secret GitHub.
#
#   sudo plateforme/amorcage/kubeconfig-pipeline.sh terraform-plan
#   sudo plateforme/amorcage/kubeconfig-pipeline.sh terraform-apply
#
# Le serveur y est écrit https://127.0.0.1:6443 : le pipeline n'atteint
# l'API QUE par le tunnel SSH (compte-tunnel-ci.sh). L'API n'est jamais
# exposée sur Internet.
# =====================================================================
set -euo pipefail
compte="${1:-}"
case "$compte" in
  terraform-plan|terraform-apply) ;;
  *) echo "usage : $0 terraform-plan|terraform-apply" >&2; exit 1 ;;
esac
[ "$(id -u)" = 0 ] || { echo "à lancer en root" >&2; exit 1; }
k() { k3s kubectl "$@"; }

jeton="$(k -n terraform-etat get secret "$compte-jeton" -o jsonpath='{.data.token}' | base64 -d)"
ca="$(k -n terraform-etat get secret "$compte-jeton" -o jsonpath='{.data.ca\.crt}')"
[ -n "$jeton" ] && [ -n "$ca" ] || { echo "jeton introuvable : kubectl apply -f rbac-pipeline.yaml ?" >&2; exit 1; }

secret="PLATEFORME_KUBECONFIG_$(echo "${compte#terraform-}" | tr '[:lower:]' '[:upper:]')"
{
  echo "# ── À poser dans GitHub : environnement « ${compte#terraform-} » → secret $secret"
  echo "# ── (contenu ci-dessous, en entier). Ne PAS le garder ailleurs."
} >&2
cat <<YAML
apiVersion: v1
kind: Config
clusters:
  - name: plateforme
    cluster:
      server: https://127.0.0.1:6443
      certificate-authority-data: $ca
users:
  - name: $compte
    user:
      token: $jeton
contexts:
  - name: $compte@plateforme
    context:
      cluster: plateforme
      user: $compte
current-context: $compte@plateforme
YAML
