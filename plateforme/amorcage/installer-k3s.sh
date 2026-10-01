#!/usr/bin/env bash
# =====================================================================
# installer-k3s.sh — pose un cluster Kubernetes (k3s) DURCI sur le serveur.
#
# C'est la SEULE étape que Terraform ne peut pas faire : il faut un cluster
# pour que les providers kubernetes/helm aient quelqu'un à qui parler.
# Tout ce qui vient APRÈS (Traefik, cert-manager, Argo CD, Kyverno…) est
# du code Terraform, relu en PR et appliqué par GitHub Actions.
#
# Usage (en root, sur le serveur) :
#   sudo plateforme/amorcage/installer-k3s.sh [--version v1.36.5+k3s1] [--pare-feu] [--oui]
#
# Sans danger à rejouer : les fichiers sont reposés, k3s n'est réinstallé
# que si la version demandée diffère de celle en place.
#
# Ce que ça fait, dans l'ordre :
#   1. contrôles : root, systemd, mémoire, disque, ports 80/443 ;
#   2. pose /etc/rancher/k3s/{config,admission,audit}.yaml (root 0600) ;
#   3. (--pare-feu) pose et démarre le garde nftables des ports internes ;
#   4. installe k3s à la version ÉPINGLÉE (script officiel, binaire vérifié
#      par sa somme SHA-256) ;
#   5. attend que le nœud soit Ready ;
#   6. pose l'espace de noms du state Terraform et les deux comptes de
#      service du pipeline (terraform-plan : lecture ; terraform-apply : admin).
# =====================================================================
set -euo pipefail

ICI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Une version de PATCH d'une mineure éprouvée, jamais une .0 : le suivi des
# versions est fait par Renovate (renovate.json), relu en PR.
K3S_VERSION="${K3S_VERSION:-v1.36.5+k3s1}"
PARE_FEU=0
OUI=0

vert()  { printf '\033[32m  ✓\033[0m %s\n' "$*"; }
jaune() { printf '\033[33m  ~\033[0m %s\n' "$*"; }
rouge() { printf '\033[31m  ✗\033[0m %s\n' "$*" >&2; }
titre() { printf '\n\033[1m%s\033[0m\n' "$*"; }
mort()  { rouge "$*"; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --version)  K3S_VERSION="${2:?--version demande une valeur}"; shift 2 ;;
    --pare-feu) PARE_FEU=1; shift ;;
    --oui)      OUI=1; shift ;;
    -h|--help)  sed -n '2,27p' "$0"; exit 0 ;;
    *) mort "option inconnue : $1 (voir --help)" ;;
  esac
done

[[ "$K3S_VERSION" =~ ^v1\.[0-9]+\.[0-9]+\+k3s[0-9]+$ ]] || mort "version k3s mal formée : $K3S_VERSION (attendu : v1.36.5+k3s1)"

# ───────────────────────────────────────────────────────────── 1. contrôles
titre "1. Contrôles"
[ "$(id -u)" = 0 ] || mort "à lancer en root :  sudo $0 $*"
command -v systemctl >/dev/null || mort "systemd est requis"
command -v curl >/dev/null || mort "curl est requis :  apt-get install -y curl"

mem_gio=$(( $(awk '/MemTotal/ {print $2}' /proc/meminfo) / 1024 / 1024 ))
if [ "$mem_gio" -lt 8 ]; then
  jaune "mémoire : ${mem_gio} Gio. Le socle (k3s, Argo CD, Kyverno, supervision) en prend ~3 Gio,"
  jaune "          PostgreSQL et les applications le reste. 8 Gio est un minimum confortable."
  [ "$OUI" = 1 ] || { read -r -p "    Continuer quand même ? [o/N] " r; [ "$r" = o ] || exit 1; }
else
  vert "mémoire : ${mem_gio} Gio"
fi

libre_gio=$(df --output=avail -BG /var/lib | tail -1 | tr -dc 0-9)
[ "$libre_gio" -ge 20 ] && vert "disque libre sous /var/lib : ${libre_gio} Gio" \
  || jaune "disque libre sous /var/lib : ${libre_gio} Gio (20 Gio conseillés : images, etcd, journaux)"

# Mode coexistence : le nginx de l'hôte garde 80/443. On le dit, c'est voulu.
if ss -Hltn 'sport = :443' | grep -q .; then
  vert "le port 443 est tenu (nginx de l'hôte) : Traefik sera installé en mode « coexistence »"
fi

# ─────────────────────────────────────────────── 2. configuration de k3s
titre "2. Configuration de k3s"
install -d -m 0755 /etc/rancher/k3s
install -d -m 0700 /var/log/k3s
for f in config.yaml admission.yaml audit.yaml; do
  install -m 0600 -o root -g root "$ICI/k3s/$f" "/etc/rancher/k3s/$f"
  vert "/etc/rancher/k3s/$f"
done

# ───────────────────────────────────────────────────── 3. garde-barrière
if [ "$PARE_FEU" = 1 ]; then
  titre "3. Garde-barrière nftables"
  command -v nft >/dev/null || apt-get install -y nftables >/dev/null
  install -d -m 0755 /etc/infra
  install -m 0644 "$ICI/k3s/garde.nft" /etc/infra/k3s-garde.nft
  nft -c -f /etc/infra/k3s-garde.nft || mort "le garde nftables ne passe pas la vérification (nft -c)"
  install -m 0644 "$ICI/k3s/k3s-garde.service" /etc/systemd/system/k3s-garde.service
  systemctl daemon-reload
  systemctl enable --now k3s-garde.service >/dev/null
  systemctl restart k3s-garde.service
  vert "k3s-garde.service actif :  sudo nft list table inet k3s_garde"
else
  titre "3. Garde-barrière : ignoré (--pare-feu pour le poser)"
  jaune "sans lui, assurez-vous qu'un pare-feu ferme 6443, 10250, 2379-2380, 8472/udp et 5432 vers l'extérieur"
fi

# ─────────────────────────────────────────────────────────── 4. k3s
titre "4. k3s $K3S_VERSION"
en_place="$(k3s --version 2>/dev/null | awk 'NR==1 {print $3}' || true)"
if [ "$en_place" = "$K3S_VERSION" ]; then
  vert "déjà en place ; configuration rechargée"
  systemctl restart k3s
else
  [ -n "$en_place" ] && jaune "mise à jour : $en_place → $K3S_VERSION (lire les notes de version d'abord)"
  tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
  # On télécharge le script, on le GARDE (on sait ce qu'on a lancé), puis on
  # l'exécute. Il vérifie lui-même la somme SHA-256 du binaire k3s.
  curl -sfL --proto '=https' --tlsv1.2 https://get.k3s.io -o "$tmp/install.sh"
  head -1 "$tmp/install.sh" | grep -q '^#!/bin/sh' || mort "get.k3s.io n'a pas rendu un script shell"
  INSTALL_K3S_VERSION="$K3S_VERSION" INSTALL_K3S_EXEC="server" sh "$tmp/install.sh"
  install -d -m 0700 /var/lib/infra/k3s
  cp "$tmp/install.sh" "/var/lib/infra/k3s/install-$K3S_VERSION.sh"
fi

# ───────────────────────────────────────────────────── 5. nœud prêt
titre "5. Le nœud"
export KUBECONFIG=/etc/rancher/k3s/k3s.yaml
for _ in $(seq 1 60); do
  k3s kubectl get node serveur >/dev/null 2>&1 && break
  sleep 2
done
k3s kubectl wait --for=condition=Ready node/serveur --timeout=180s >/dev/null \
  || mort "le nœud n'est pas Ready :  journalctl -u k3s -n 100"
vert "nœud « serveur » Ready"
k3s kubectl get node -o wide

# ─────────────────────────────── 6. state Terraform et comptes du pipeline
titre "6. State Terraform et comptes du pipeline"
k3s kubectl apply -f "$ICI/rbac-pipeline.yaml" >/dev/null
vert "espace de noms terraform-etat, comptes terraform-plan et terraform-apply"

titre "Suite"
cat <<EOF
    1. Le tunnel du pipeline (une fois) :
         sudo $ICI/compte-tunnel-ci.sh
    2. Les kubeconfig du pipeline (à poser dans les secrets GitHub) :
         sudo $ICI/kubeconfig-pipeline.sh terraform-plan
         sudo $ICI/kubeconfig-pipeline.sh terraform-apply
    3. PostgreSQL natif, ouvert aux pods :
         sudo $ICI/ouvrir-postgres-aux-pods.sh
    4. Puis le premier « terraform apply » : docs/plateforme/03-terraform.md
EOF
