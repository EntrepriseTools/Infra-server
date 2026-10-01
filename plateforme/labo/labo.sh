#!/usr/bin/env bash
# =====================================================================
# labo.sh — la plateforme ENTIÈRE sur votre poste, pour apprendre et casser
# sans risque : k3d (k3s dans Docker) + un PostgreSQL dans Docker + le même
# code Terraform/Helm que la production.
#
#   plateforme/labo/labo.sh creer       cluster + PostgreSQL + comptes
#   plateforme/labo/labo.sh appliquer   terraform init/plan/apply (labo.tfvars)
#   plateforme/labo/labo.sh argocd      ouvre l'interface Argo CD (localhost:8080)
#   plateforme/labo/labo.sh traefik     publie Traefik sur localhost:8081
#   plateforme/labo/labo.sh detruire    tout effacer
#
# Prérequis : docker, k3d (https://k3d.io), kubectl, terraform (ou tofu), helm.
# Variables : TF_VAR_argocd_cle_depot (deploy key du dépôt) et
#             TF_VAR_argocd_admin_bcrypt (htpasswd -nbBC 12 '' motdepasse | tr -d ':\n')
# =====================================================================
set -euo pipefail
ICI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RACINE="$(cd "$ICI/.." && pwd)"
CLUSTER=plateforme-labo
CONTEXTE="k3d-$CLUSTER"
RESEAU=plateforme-labo
PG_IP=172.30.0.10
K3S_IMAGE="${K3S_IMAGE:-rancher/k3s:v1.36.5-k3s1}"
TF="${TF:-$(command -v terraform || command -v tofu)}"

creer() {
  docker network inspect "$RESEAU" >/dev/null 2>&1 \
    || docker network create --subnet 172.30.0.0/24 "$RESEAU" >/dev/null
  if ! docker inspect labo-postgres >/dev/null 2>&1; then
    # Le PostgreSQL « natif » du labo : HORS du cluster, comme en production.
    docker run -d --name labo-postgres --network "$RESEAU" --ip "$PG_IP" \
      -e POSTGRES_PASSWORD=labo -e POSTGRES_USER=postgres \
      docker.io/library/postgres:17-alpine >/dev/null
  fi
  if ! k3d cluster list "$CLUSTER" >/dev/null 2>&1; then
    # Mêmes choix que plateforme/amorcage/k3s/config.yaml (sans audit ni
    # chiffrement, inutiles ici).
    k3d cluster create "$CLUSTER" \
      --image "$K3S_IMAGE" \
      --network "$RESEAU" \
      --servers 1 --agents 0 \
      --k3s-arg "--disable=traefik@server:0" \
      --k3s-arg "--disable=servicelb@server:0" \
      --wait
  fi
  kubectl --context "$CONTEXTE" apply -f "$RACINE/amorcage/rbac-pipeline.yaml"
  echo "  ✓ labo prêt : kubectl --context $CONTEXTE get nodes"
  echo "    PostgreSQL : $PG_IP:5432 (postgres / labo) — créer une base :"
  echo "    docker exec -it labo-postgres psql -U postgres -c \"create role pilotage login password 'labo'\" -c 'create database pilotage owner pilotage'"
}

appliquer() {
  : "${TF_VAR_argocd_cle_depot:?exporter TF_VAR_argocd_cle_depot (deploy key du dépôt)}"
  : "${TF_VAR_argocd_admin_bcrypt:?exporter TF_VAR_argocd_admin_bcrypt}"
  cd "$RACINE/terraform/plateforme"
  # Le state du labo vit dans le cluster du labo (même backend qu'en production).
  "$TF" init -reconfigure \
    -backend-config="config_path=${KUBECONFIG:-$HOME/.kube/config}" \
    -backend-config="config_context=$CONTEXTE"
  "$TF" plan -var-file="$ICI/labo.tfvars" -out=labo.tfplan
  "$TF" apply labo.tfplan
  rm -f labo.tfplan
}

argocd() {
  echo "  Argo CD : http://localhost:8080 (admin / le mot de passe de l'empreinte bcrypt)"
  kubectl --context "$CONTEXTE" -n argocd port-forward svc/argocd-server 8080:80
}

traefik() {
  echo "  Traefik : http://localhost:8081  (curl -H 'Host: pilotage.labo' localhost:8081)"
  kubectl --context "$CONTEXTE" -n traefik port-forward svc/traefik 8081:80
}

detruire() {
  k3d cluster delete "$CLUSTER" || true
  docker rm -f labo-postgres >/dev/null 2>&1 || true
  docker network rm "$RESEAU" >/dev/null 2>&1 || true
  echo "  ✓ labo effacé"
}

case "${1:-}" in
  creer|appliquer|argocd|traefik|detruire) "$1" ;;
  *) sed -n '2,18p' "$0"; exit 1 ;;
esac
