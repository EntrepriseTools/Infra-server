#!/usr/bin/env bash
# =====================================================================
# sceller.sh — chiffre les secrets d'une application pour CE cluster, et
# affiche le bloc à coller dans gitops/applications/<app>/values.yaml.
#
#   plateforme/outils/sceller.sh <app> <fichier.env>
#
# Le fichier .env est LU, jamais sourcé (règle n° 1 d'infra) : une ligne
# CLE=valeur par secret ; tout ce qui suit le premier « = » est la valeur,
# telle quelle (pas de guillemets à retirer, pas de $ à interpréter).
#
# Il suffit du CERTIFICAT PUBLIC du contrôleur (plateforme/sealed-secrets/
# certificat.pem, versionné) : sceller ne demande aucun accès au cluster.
# Seul le contrôleur, qui garde la clé privée, sait déchiffrer.
#
# Portée « strict » : le chiffré n'est valable que pour le Secret
# <app>-secrets dans l'espace <app>. Recopié ailleurs, il ne sert à rien.
# =====================================================================
set -euo pipefail
ICI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CERT="${SCELLER_CERT:-$ICI/../sealed-secrets/certificat.pem}"

app="${1:-}"; fichier="${2:-}"
[[ "$app" =~ ^[a-z][a-z0-9-]{1,30}$ ]] && [ -f "$fichier" ] \
  || { echo "usage : $0 <app> <fichier.env>" >&2; exit 1; }
command -v kubeseal >/dev/null || { echo "kubeseal absent : https://github.com/bitnami-labs/sealed-secrets#kubeseal" >&2; exit 1; }
grep -q "BEGIN CERTIFICATE" "$CERT" 2>/dev/null \
  || { echo "certificat introuvable ($CERT) : voir plateforme/sealed-secrets/LISEZMOI.md" >&2; exit 1; }

echo "secrets:"
echo "  scelles:"
n=0
while IFS= read -r ligne || [ -n "$ligne" ]; do
  case "$ligne" in ''|'#'*) continue ;; esac
  cle="${ligne%%=*}"; valeur="${ligne#*=}"
  [[ "$cle" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] && [ "$cle" != "$ligne" ] \
    || { echo "ligne refusée (attendu CLE=valeur) : ${cle:0:20}…" >&2; exit 1; }
  [ -n "$valeur" ] || { echo "valeur vide pour $cle" >&2; exit 1; }
  chiffre="$(printf '%s' "$valeur" | kubeseal --raw --scope strict \
    --namespace "$app" --name "$app-secrets" --cert "$CERT" --from-file=/dev/stdin)"
  printf '    %s: %s\n' "$cle" "$chiffre"
  n=$((n + 1))
done < "$fichier"
echo "  → $n secret(s) scellé(s) pour $app/$app-secrets. Pensez à détruire $fichier (shred -u)." >&2
