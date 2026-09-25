#!/usr/bin/env bash
# =====================================================================
# outils/nouveau-depot.sh — un dépôt d'application prêt à déployer.
#
#   outils/nouveau-depot.sh <app> <dossier> [options]
#
#     --mode proxy|spa      l'application sert tout / nginx sert l'écran (défaut proxy)
#     --backend <rép>       répertoire Gradle (défaut backend)
#     --frontend <rép>      répertoire de l'écran npm, « » pour aucun (défaut frontend)
#     --equipe <nom>        préfixe de l'image (défaut entreprisetools)
#     --github <org/nom>    crée aussi le dépôt GitHub (privé) avec gh, et pousse
#
# Dans <dossier> (neuf, ou un dépôt existant auquel on AJOUTE l'outillage) :
#   .github/workflows/pipeline.yml   vos contrôles + l'appel au déploiement commun
#   deploiement/app.conf             le manifeste
#   deploiement/LISEZMOI.md          la marche à suivre
#   Dockerfile.exemple, .dockerignore
# Un fichier déjà présent n'est JAMAIS écrasé : il est dit, et laissé.
# =====================================================================
set -euo pipefail
ICI="$(cd "$(dirname "$0")/.." && pwd)"
MODELE="$ICI/modeles/depot"
app="${1:-}"; dossier="${2:-}"; shift 2 2>/dev/null || true
[[ "$app" =~ ^[a-z][a-z0-9-]{1,30}$ ]] && [ -n "$dossier" ] || { sed -n '4,13p' "$0" | cut -c3-; exit 1; }
mode=proxy; backend=backend; frontend=frontend; equipe=entreprisetools; github=""
while [ $# -gt 0 ]; do
  case "$1" in
    --mode) mode="$2"; shift 2 ;;
    --backend) backend="$2"; shift 2 ;;
    --frontend) frontend="$2"; shift 2 ;;
    --equipe) equipe="$2"; shift 2 ;;
    --github) github="$2"; shift 2 ;;
    *) echo "option inconnue : $1" >&2; exit 1 ;;
  esac
done
case "$mode" in proxy|spa) : ;; *) echo "--mode proxy|spa" >&2; exit 1 ;; esac
[ "$mode" = spa ] && [ -z "$frontend" ] && { echo "--mode spa demande un --frontend" >&2; exit 1; }

# En mode spa, l'image est celle du backend seul ; en proxy, le contexte est
# la racine (le Dockerfile bâtit l'écran et le jar ensemble).
contexte=.; frontend_spa=""; needs=serveur
[ "$mode" = spa ] && { contexte="./$backend"; frontend_spa="$frontend"; }
[ -n "$frontend" ] && needs="serveur, ecran"

mkdir -p "$dossier"
( cd "$MODELE" && find . -type f ) | while read -r f; do
  cible="$dossier/${f#./}"
  if [ -e "$cible" ]; then echo "  ~ $cible existe déjà — laissé tel quel"; continue; fi
  mkdir -p "$(dirname "$cible")"
  sed -e "s|__APP__|$app|g" -e "s|__EQUIPE__|$equipe|g" -e "s|__MODE__|$mode|g" \
      -e "s|__BACKEND__|$backend|g" -e "s|__FRONTEND__|$frontend|g" -e "s|__FRONTEND_SPA__|$frontend_spa|g" \
      -e "s|__CONTEXTE__|$contexte|g" -e "s|__NEEDS__|$needs|g" "$MODELE/$f" > "$cible"
  if [ -z "$frontend" ]; then sed -i '/# >>> ecran/,/# <<< ecran/d' "$cible"; else sed -i '/# >>> ecran/d;/# <<< ecran/d' "$cible"; fi
  echo "  ✓ $cible"
done

if [ -n "$github" ]; then
  command -v gh >/dev/null || { echo "gh absent : créer le dépôt à la main, puis git push." >&2; exit 1; }
  cd "$dossier"
  [ -d .git ] || { git init -q -b main; git add -A; git commit -qm "Dépôt $app — outillage Infra-server"; }
  gh repo create "$github" --private --source . --push
fi
echo
echo "Suite : compléter $dossier/deploiement/app.conf, puis sur le serveur :"
echo "  sudo infra creer $app --manifeste app.conf --url https://$app.exemple.ma"
