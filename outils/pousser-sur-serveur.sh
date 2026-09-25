#!/usr/bin/env bash
# =====================================================================
# outils/pousser-sur-serveur.sh — installe (ou met à jour) « infra » sur le
# serveur, depuis votre poste. Le serveur ne connaît pas GitHub : on lui
# apporte l'outil.
#
#   outils/pousser-sur-serveur.sh <admin>@<serveur> [options d'installer.sh]
#   outils/pousser-sur-serveur.sh admin@197.153.58.171 --hote 197.153.58.171
#
# <admin> est un compte qui a sudo (PAS un compte de déploiement : ceux-là ne
# peuvent que « livrer »). La copie est vérifiée (bash -n) sur le serveur
# AVANT d'être posée.
# =====================================================================
set -euo pipefail
ICI="$(cd "$(dirname "$0")/.." && pwd)"
cible="${1:?usage : $0 admin@serveur [--hote IP] [--installer-paquets]}"; shift
echo "  → $(cat "$ICI/VERSION") vers $cible"
tar -czf - -C "$ICI" bin lib modeles VERSION installer.sh \
  | ssh -t "$cible" "d=\$(mktemp -d) && tar -xzf - -C \"\$d\" && sudo bash \"\$d/installer.sh\" $* ; r=\$?; rm -rf \"\$d\"; exit \$r"
