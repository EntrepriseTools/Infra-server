#!/usr/bin/env bash
# =====================================================================
# tests/mutations.sh — la preuve négative du banc.
#
# Chaque mutation réintroduit un défaut PRÉCIS (souvent un défaut vécu par
# l'un des trois dépôts) dans une COPIE de ce dépôt, et y rejoue le banc.
# Le banc DOIT tomber. Une mutation qui survit dit qu'un contrôle manque.
# Les sources ne sont jamais touchées : tout se passe dans un répertoire
# jetable.
#
#   sudo bash tests/mutations.sh
# =====================================================================
set -uo pipefail
ICI="$(cd "$(dirname "$0")/.." && pwd)"
[ "$(id -u)" = 0 ] || { echo "sudo bash $0" >&2; exit 2; }

# nom | fichier | motif sed (s|…|…|) — chaque motif DOIT mordre
MUTATIONS=(
  "sans-sauvegarde|lib/verbes_deploiement.sh|s|^    prendre \"\$prise\"\$|    : prendre|"
  "sans-retour-arriere|lib/verbes_deploiement.sh|s|^      retour_arriere \"\$avant\" \"\$ancien_service\"|      :|"
  "porte-supprimee-au-lieu-de-remise|lib/porte.sh|s|if \[ -f \"\$precedent\" \]; then install|if false; then install|"
  "lien-dans-la-livraison|lib/verbes_deploiement.sh|s|case \"\$type\" in -\|d) : ;;|case \"\$type\" in *) : ;;|"
  "montage-de-l-hote|lib/registre.sh|s|\[\[ \"\$nom\" =~ ^\[a-z0-9\]\[a-z0-9_-\]\*\$ \]\]|true|"
  "url-sans-schema|lib/registre.sh|s|http://?\*\|https://?\*) : ;;|*) : ;;|"
  "privileges-du-conteneur|lib/conteneur.sh|s|no-new-privileges:true|no-new-privileges:false|"
  "ssh-sans-garde|bin/infra-ssh|s|\[\[ \"\$2\" =~ \^\[0-9a-f\]{7,40}\$ \]\]|true|"
  "relance-pour-rien|lib/verbes_deploiement.sh|s|\&\& en_marche \&\& deja=1|\&\& false \&\& deja=1|"
  "sigpipe-du-secret|lib/commun.sh|s|^    mdp)    local s=\"\";.*|    mdp) LC_ALL=C tr -dc A-Za-z0-9 < /dev/urandom \| head -c \"\$n\" ;;|"
  "restaurer-sans-filet|lib/verbes_base.sh|s|^  prendre \"\$filet\"; vert|  : ; vert|"
  "adoption-bloquee|lib/conteneur.sh|s|label=com.docker.compose.service=\$M_SERVICE|label=com.docker.compose.service=autre|"
  "manifeste-etranger|lib/registre.sh|s|\|\| mort \"manifeste : APP vaut|\|\| true \"|"
)

survivantes=0
for m in "${MUTATIONS[@]}"; do
  IFS='|' read -r nom fichier _ <<< "$m"
  motif="${m#"$nom|$fichier|"}"
  copie="$(mktemp -d)"; cp -r "$ICI"/. "$copie/"
  avant="$(md5sum < "$copie/$fichier")"
  sed -i "$motif" "$copie/$fichier"
  if [ "$(md5sum < "$copie/$fichier")" = "$avant" ]; then
    printf '  ?  %-36s le motif ne mord plus sur %s — à reprendre\n' "$nom" "$fichier"; survivantes=$((survivantes + 1))
  elif bash "$copie/tests/banc.sh" >/dev/null 2>&1; then
    printf '  ✗  %-36s SURVIT — un contrôle manque\n' "$nom"; survivantes=$((survivantes + 1))
  else
    printf '  ✓  %-36s attrapée\n' "$nom"
  fi
  rm -rf "$copie"
done
printf '\n%s mutation(s), %s survivante(s)\n' "${#MUTATIONS[@]}" "$survivantes"
[ "$survivantes" = 0 ]
