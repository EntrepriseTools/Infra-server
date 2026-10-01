#!/usr/bin/env bash
# =====================================================================
# creer-base.sh — le rôle et la base d'une NOUVELLE application, dans le
# PostgreSQL natif. (Les trois applications existantes ont déjà les leurs,
# créées par `infra creer` : ne pas relancer pour elles.)
#
#   sudo plateforme/amorcage/creer-base.sh <app>
#
# Le mot de passe est tiré au sort, posé dans PostgreSQL, puis écrit dans
# un fichier root 0600 que vous SCELLEZ aussitôt (plateforme/outils/sceller.sh)
# et que vous SUPPRIMEZ. Il ne reste alors en clair nulle part.
# =====================================================================
set -euo pipefail
app="${1:-}"
[[ "$app" =~ ^[a-z][a-z0-9-]{1,30}$ ]] || { echo "usage : $0 <app>  (minuscules, chiffres, tirets)" >&2; exit 1; }
[ "$(id -u)" = 0 ] || { echo "à lancer en root" >&2; exit 1; }
role="${app//-/_}"
psql_pg() { runuser -u postgres -- psql -X -q -v ON_ERROR_STOP=1 "$@"; }
valeur()  { runuser -u postgres -- psql -X -tAq -c "$1"; }

if [ "$(valeur "select 1 from pg_roles where rolname='$role'")" = 1 ]; then
  echo "  ~ le rôle « $role » existe déjà : rien n'est touché." >&2
  exit 1
fi
mdp="$(openssl rand -base64 36 | tr -d '/+=' | cut -c1-32)"
# log_statement coupé le temps de la commande : le mot de passe ne doit pas
# atterrir dans le journal de PostgreSQL.
printf "set log_statement = 'none';\ncreate role %s login password :'mdp';\n" "$role" \
  | psql_pg -d postgres -v mdp="$mdp" -f - >/dev/null
runuser -u postgres -- createdb --owner="$role" --encoding=UTF8 --template=template0 "$role"

f="/root/$app-base.env"
( umask 077; printf 'DB_UTILISATEUR=%s\nDB_MOTDEPASSE=%s\n' "$role" "$mdp" > "$f" )
cat <<TXT
  ✓ rôle et base « $role »
  ✓ $f (root 0600)

  Ensuite, SUR VOTRE POSTE (le certificat public de Sealed Secrets suffit) :
    scp admin@serveur:$f /tmp/ && plateforme/outils/sceller.sh $app /tmp/$app-base.env
    shred -u /tmp/$app-base.env
  Et SUR LE SERVEUR :
    shred -u $f
TXT
