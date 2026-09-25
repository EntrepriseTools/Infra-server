# shellcheck shell=bash
# =====================================================================
# lib/base.sh — la base PostgreSQL NATIVE du serveur.
#
# ---- UNE SEULE FAÇON D'ENTRER : LE COMPTE `postgres`, PAR LE SOCKET ----
#
# Toutes les opérations (création, prise, vérification, restauration) passent
# par `runuser -u postgres` sur le socket local, en authentification « peer » —
# le défaut de Debian (`local all postgres peer` dans pg_hba.conf). Aucun mot de
# passe n'est lu par l'outil : il ne dépend pas du .env de l'application, et
# un .env faux ne peut pas empêcher la sauvegarde de partir.
#
# Les trois scripts d'origine lisaient chacun les identifiants de l'application
# sous trois noms différents (PAIE_BASE, DATABASE_URL, PGHOST…) : c'est la
# première divergence que ce fichier supprime.
#
# ---- LA BASE N'EST JAMAIS DANS DOCKER ----
# Les trois applications l'ont appris séparément ; c'est ici une règle
# structurelle : le compose engendré ne déclare aucune base.
# =====================================================================

psql_pg() {        # psql en tant que postgres, sur le socket local
  runuser -u postgres -- psql -X -q -v ON_ERROR_STOP=1 -p "${A_BASE_PORT:-5432}" "$@"
}
psql_valeur() {    # psql_valeur BASE REQUETE — une seule valeur, sans décor
  runuser -u postgres -- psql -X -tAq -p "${A_BASE_PORT:-5432}" -d "$1" -c "$2" 2>/dev/null
}

exiger_pg_outils() {
  command -v pg_dump >/dev/null && command -v pg_restore >/dev/null \
    || mort "pg_dump / pg_restore absents :  sudo apt-get install -y postgresql-client"
}

base_existe() { [ "$(psql_valeur postgres "select 1 from pg_database where datname='$1'")" = 1 ]; }
role_existe() { [ "$(psql_valeur postgres "select 1 from pg_roles where rolname='$1'")" = 1 ]; }

# creer_role_et_base ROLE BASE MOTDEPASSE
# Idempotent : un rôle ou une base qui existent déjà ne sont PAS touchés
# (on ne change jamais le mot de passe d'une base vivante sans le dire).
creer_role_et_base() {
  local role="$1" base="$2" mdp="$3"
  if role_existe "$role"; then
    jaune "le rôle « $role » existe déjà : son mot de passe n'est PAS changé."
    ROLE_CREE=0
  else
    # `log_statement = none` le temps de la commande : le mot de passe ne doit
    # pas finir dans le journal de PostgreSQL (que la supervision de la paie lit).
    printf "set log_statement = 'none';\ncreate role %s login password :'mdp';\n" "$role" \
      | psql_pg -d postgres -v mdp="$mdp" -f - >/dev/null \
      || mort "création du rôle « $role » refusée."
    vert "rôle « $role » créé"
    ROLE_CREE=1
  fi
  if base_existe "$base"; then
    jaune "la base « $base » existe déjà : elle est gardée telle quelle."
  else
    runuser -u postgres -- createdb -p "${A_BASE_PORT:-5432}" --owner="$role" --encoding=UTF8 --template=template0 "$base" \
      || mort "création de la base « $base » refusée."
    vert "base « $base » créée (propriétaire « $role », UTF8)"
  fi
}

# prendre FICHIER — une prise de la base de l'application, RELUE.
# Un pg_dump qui rend 0 n'a pas prouvé qu'il a écrit quelque chose de
# lisible : disque plein, quota, flux tronqué. `pg_restore --list` lit
# l'archive entière ; une prise tronquée ne passe pas.
prendre() {
  local f="$1"
  exiger_pg_outils
  install -d -m 0700 "$(dirname "$f")"
  ( umask 077; runuser -u postgres -- pg_dump -p "${A_BASE_PORT:-5432}" -Fc -Z6 --no-owner --no-privileges "$A_BASE_NOM" > "$f" ) \
    || { rm -f "$f"; mort "la prise de « $A_BASE_NOM » a échoué. La base existe-t-elle ?  sudo -u postgres psql -l"; }
  chmod 0600 "$f"
  pg_restore --list "$f" >/dev/null 2>&1 || { rm -f "$f"; mort "la prise ne se relit pas (disque plein ?) : $f"; }
}

compter_tables() {  # compter_tables BASE — « schema.table=effectif » par ligne
  local b="$1" t n
  while IFS= read -r t; do
    [ -n "$t" ] || continue
    n="$(psql_valeur "$b" "select count(*) from $t")"
    printf '%s=%s\n' "$t" "${n:-?}"
  done < <(psql_valeur "$b" "select quote_ident(table_schema)||'.'||quote_ident(table_name) from information_schema.tables
            where table_type='BASE TABLE' and table_schema not in ('pg_catalog','information_schema') order by 1")
}

# Au niveau du script, pas `local` : le piège EXIT se déclenche APRÈS le retour
# de la fonction, quand ses locales n'existent plus. Sous `set -u`, le
# nettoyage de la paie mourait ainsi sans rien balayer — une prise en clair et
# une base jetable restaient sur le disque (15 septembre 2026).
VERIF_PRISE=""
VERIF_JETABLE=""
nettoyer_verif() {
  [ -n "${VERIF_PRISE:-}" ] && rm -f "$VERIF_PRISE"
  case "${VERIF_JETABLE:-}" in      # le nom porte _verif_ : impossible de supprimer la mauvaise base
    *_verif_*) psql_pg -d postgres -c "drop database if exists $VERIF_JETABLE" >/dev/null 2>&1 || true ;;
  esac
  return 0
}
