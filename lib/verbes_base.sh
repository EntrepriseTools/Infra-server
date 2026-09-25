# shellcheck shell=bash
# =====================================================================
# lib/verbes_base.sh — sauvegarder, prises, verifier, restaurer.
#
# Deux tiroirs par application, dans /var/backups/infra/<app>/ :
#   quotidien_<date>.dump[.gpg]   le minuteur de chaque soir — chiffré si
#                                 SAUVEGARDE_CLE_GPG est posée ;
#   avant-<date>_<sha>.dump       la prise de chaque déploiement, EN CLAIR
#                                 (c'est elle qu'on restaure dans l'urgence).
#
# ⚠ Ces prises sont sur le disque qui porte la base : la copie hors machine
# reste à faire (voir README, « Ce qui n'est pas fait »).
# =====================================================================

cmd_sauvegarder() {
  exiger_root sauvegarder "$@"
  local cible="${1:-}"; shift || true
  local garder=""
  [ "${1:-}" = --garder ] && { garder="${2:?--garder attend un nombre}"; [[ "$garder" =~ ^[0-9]+$ ]] || mort "--garder attend un nombre"; }
  if [ "$cible" = --toutes ]; then
    local app echecs=0
    for app in $(applications); do ( sauvegarder_une "$app" "$garder" ) || echecs=$((echecs + 1)); done
    [ "$echecs" = 0 ] || mort "$echecs sauvegarde(s) en échec."
    return 0
  fi
  [ -n "$cible" ] || mort "usage : infra sauvegarder <app>|--toutes [--garder N]"
  sauvegarder_une "$cible" "$garder"
}

sauvegarder_une() {
  local app="$1" garder="${2:-}"
  charger_fiche "$app"
  garder="${garder:-$A_SAUV_GARDER}"
  titre "Sauvegarde de « $app » (base $A_BASE_NOM)"
  local f; f="$A_PRISES/quotidien_$(date +%F_%Hh%M).dump"
  prendre "$f"
  vert "$f ($(du -h "$f" | cut -f1)), relue — $(pg_restore --list "$f" | grep -c 'TABLE DATA' || true) tables"
  # La clé PUBLIQUE chiffre ; la privée n'est pas sur ce serveur, et c'est le
  # but : un disque volé ne rend pas la base.
  if [ -n "$A_SAUV_GPG" ]; then
    command -v gpg >/dev/null || mort "SAUVEGARDE_CLE_GPG posée mais gpg absent : apt-get install -y gnupg"
    gpg --batch --yes --trust-model always --recipient "$A_SAUV_GPG" --output "$f.gpg" --encrypt "$f" \
      || mort "chiffrement refusé : « $A_SAUV_GPG » est-elle dans le trousseau de root ?"
    chmod 0600 "$f.gpg"; rm -f "$f"
    vert "chiffrée pour « $A_SAUV_GPG » — ce serveur ne sait plus la relire"
  else
    jaune "prise EN CLAIR (SAUVEGARDE_CLE_GPG n'est pas posée)."
  fi
  local trop
  trop="$(ls -t "$A_PRISES"/quotidien_*.dump "$A_PRISES"/quotidien_*.dump.gpg 2>/dev/null | tail -n "+$((garder + 1))" || true)"
  if [ -n "$trop" ]; then printf '%s\n' "$trop" | xargs -r rm -f; vert "$(printf '%s\n' "$trop" | wc -l) ancienne(s) retirée(s), on en garde $garder"; fi
  journaliser "$app" "" SAUVEGARDE "$(basename "$f")"
}

cmd_prises() {
  local app="${1:-}"
  exiger_root prises "$@"
  charger_fiche "$app"
  titre "Prises de « $app » — $A_PRISES"
  ls -lht "$A_PRISES" 2>/dev/null | tail -n +2 | sed 's/^/    /' || true
  [ -n "$(ls -A "$A_PRISES" 2>/dev/null)" ] || info "(aucune)"
}

# Une sauvegarde qu'on n'a jamais restaurée est une intention. Sans argument :
# prise NEUVE, restaurée dans une base jetable, comparée table par table à la
# base vivante. Avec une prise : restaurée, et ce qu'elle porte est montré.
cmd_verifier() {
  local app="${1:-}" fichier="${2:-}" neuve=non
  exiger_root verifier "$@"
  charger_fiche "$app"
  trap nettoyer_verif EXIT INT TERM
  if [ -z "$fichier" ]; then
    info "prise neuve, temporaire…"
    VERIF_PRISE="$A_PRISES/.verif_$$.dump"; prendre "$VERIF_PRISE"; fichier="$VERIF_PRISE"; neuve=oui
  fi
  [ -r "$fichier" ] || mort "prise illisible : $fichier"
  case "$fichier" in *.gpg) mort "prise CHIFFRÉE : la déchiffrer là où vit la clé privée, puis passer le fichier en clair." ;; esac

  VERIF_JETABLE="${A_BASE_NOM}_verif_$(date +%H%M%S)"
  titre "Vérification — $(basename "$fichier") ($(du -h "$fichier" | cut -f1))"
  psql_pg -d postgres -c "create database $VERIF_JETABLE" >/dev/null || mort "création de la base jetable refusée."
  local souci
  if ! souci="$(runuser -u postgres -- pg_restore -p "${A_BASE_PORT:-5432}" --no-owner --no-privileges --exit-on-error -d "$VERIF_JETABLE" < "$fichier" 2>&1 >/dev/null)"; then
    mort "LA PRISE NE SE RESTAURE PAS :
    $souci"
  fi
  vert "restaurée sans erreur dans $VERIF_JETABLE (jetable)"
  local apres avant
  apres="$(compter_tables "$VERIF_JETABLE")"
  [ -n "$apres" ] || mort "la base restaurée ne porte AUCUNE table : la prise est vide."
  vert "$(printf '%s\n' "$apres" | wc -l) table(s)"
  if [ "$neuve" = oui ]; then
    avant="$(compter_tables "$A_BASE_NOM")"
    if [ "$avant" = "$apres" ]; then vert "la base et la prise coïncident, table par table"
    else
      rouge "les effectifs diffèrent (une écriture pendant la prise ?) :"
      diff <(printf '%s\n' "$avant") <(printf '%s\n' "$apres") | sed 's/^/      /' || true
      mort "la prise ne rend pas la base. NE PAS compter dessus sans relancer."
    fi
  else
    printf '%s\n' "$apres" | sed 's/^/      /'
  fi
  journaliser "$app" "" VERIFICATION "$(basename "$fichier")"
}

# Remet une prise dans la base VIVANTE. Dangereux, donc : confirmation par le
# nom, service arrêté, prise de l'état présent AVANT d'écraser.
cmd_restaurer() {
  local app="${1:-}" fichier="${2:-}"
  exiger_root restaurer "$@"
  [ "${3:-}" = --confirmer ] && [ "${4:-}" = "$app" ] \
    || mort "usage : infra restaurer <app> <prise> --confirmer <app>
    (la base VIVANTE de <app> est remplacée par la prise ; l'état présent est sauvegardé d'abord)"
  charger_fiche "$app"; verrou_app "$app"
  charger_manifeste "$(manifeste_de "$app")" "$app"
  [ -r "$fichier" ] || mort "prise illisible : $fichier"
  case "$fichier" in *.gpg) mort "prise chiffrée : la déchiffrer d'abord." ;; esac
  pg_restore --list "$fichier" >/dev/null 2>&1 || mort "ce fichier n'est pas une prise lisible : $fichier"

  titre "1 — L'état présent, sauvegardé"
  local filet; filet="$A_PRISES/avant-restauration-$(date +%F_%Hh%M%S).dump"
  prendre "$filet"; vert "$filet"
  titre "2 — Le service, arrêté"
  compose stop "$M_SERVICE" >/dev/null 2>&1 || true
  vert "arrêté"
  titre "3 — La restauration"
  # --role : les objets restaurés appartiennent au rôle de l'application,
  # pas à postgres — sinon l'application ne pourrait plus écrire ses tables.
  if ! runuser -u postgres -- pg_restore -p "${A_BASE_PORT:-5432}" --clean --if-exists --no-owner --no-privileges \
        --role="$A_BASE_ROLE" -d "$A_BASE_NOM" < "$fichier" >/dev/null 2>"$A_ETAT/restauration.log"; then
    jaune "pg_restore a signalé des erreurs (voir $A_ETAT/restauration.log)."
  fi
  vert "restaurée depuis $(basename "$fichier")"
  titre "4 — Le service, relancé"
  compose up -d "$M_SERVICE" || true
  if attendre_le_service; then vert "l'application répond"
  else dire_pourquoi_la_sonde_tombe; mort "l'application ne répond pas après restauration. Filet : $filet"; fi
  journaliser "$app" "$(version_en_service)" RESTAURATION "$(basename "$fichier")"
}
