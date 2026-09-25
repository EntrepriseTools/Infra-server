# shellcheck shell=bash
# =====================================================================
# lib/verbes_deploiement.sh — livrer, deployer, revenir, relancer, porte.
#
#   livrer <app> <sha>     reçoit la livraison sur l'entrée standard (le
#                          pipeline la pousse par SSH), puis déploie
#   deployer <app> <sha>   déploie une version déjà reçue ou déjà chargée
#   revenir <app> [sha]    remet la version précédente (ou celle-ci)
#   relancer <app>         réapplique fiche + secrets sans changer d'image
#   porte <app>            repose seulement le bloc nginx
#
# ---- L'ORDRE D'UN DÉPLOIEMENT (identique pour toutes les applications) ----
#
#   0. contrôles SANS RIEN TOUCHER : secrets, variables obligatoires, base,
#      port, certificat, nom — un réglage faux doit arrêter le passage
#      pendant que l'ancienne version sert encore ;
#   1. l'image : `docker load`, et elle doit porter <image>:<sha> ;
#   2. la SAUVEGARDE, relue — toujours : le retour arrière remet une IMAGE,
#      jamais un SCHÉMA (les migrations Flyway tournent au démarrage) ;
#   3. compose engendré, étiquette `en-service`, `up -d` ;
#   4. les sondes ; rouge → RETOUR ARRIÈRE sur la version précédente,
#      re-sondée, et le passage échoue en le disant ;
#   5. l'écran (mode spa) — seulement APRÈS un serveur vert : on ne sert
#      jamais un écran neuf devant une API ancienne ;
#   6. la porte nginx, posée, éprouvée, sondée par le nom ;
#   7. le ménage : les N dernières versions restent relançables.
#
# Relancer le même <sha> reprend à l'étape 5 : jamais « rien à faire » en
# vert, porte fermée (défaut de la paie, corrigé le 15 septembre 2026).
# =====================================================================

# Refuse un appel par sudo venu d'un autre compte que celui de l'application.
exiger_appelant() {
  if [ -n "${SUDO_USER:-}" ] && [ "$SUDO_USER" != root ] && [ "$SUDO_USER" != "$A_COMPTE" ]; then
    mort "« $SUDO_USER » n'est pas le compte de « $A_APP » ($A_COMPTE) : refusé."
  fi
}

# --------------------------------------------------------------- livrer
cmd_livrer() {
  local app="${1:-}" sha="${2:-}"
  [ $# -eq 2 ] || mort "usage : infra livrer <app> <sha>   (la livraison arrive sur l'entrée standard)"
  exiger_root livrer "$@"
  valide_sha "$sha" || mort "version illisible : « $sha » (SHA git attendu)."
  charger_fiche "$app"; exiger_appelant
  verrou_app "$app"
  [ -t 0 ] && mort "rien sur l'entrée standard : « infra livrer » attend l'archive que pousse le pipeline."

  titre "Réception de la livraison ${sha:0:8}"
  local dir="$A_ETAT/livraisons/$sha"
  rm -rf "$A_ETAT/livraisons"; install -d -m 0700 "$dir"
  head -c "$((LIVRAISON_MAX + 1))" > "$dir/livraison.tar"
  local taille; taille="$(stat -c %s "$dir/livraison.tar")"
  [ "$taille" -le "$LIVRAISON_MAX" ] || { rm -rf "$dir"; mort "livraison trop grosse (> $LIVRAISON_MAX octets) : refusée."; }
  [ "$taille" -gt 0 ] || { rm -rf "$dir"; mort "livraison vide."; }

  # On regarde AVANT d'extraire : que des fichiers ordinaires, et seulement
  # ceux qu'on attend. Un lien symbolique dans une archive extraite par root
  # est la voie classique pour écrire hors du répertoire.
  local ligne type nom
  while IFS= read -r ligne; do
    type="${ligne:0:1}"; nom="${ligne##* }"; nom="${nom#./}"
    [ -z "$nom" ] && continue
    case "$type" in -|d) : ;; *) rm -rf "$dir"; mort "livraison : « $nom » n'est pas un fichier ordinaire — refusée." ;; esac
    case "$nom" in ""|app.conf|image.tar.gz|frontend.tar.gz|VERSION) : ;;
      *) rm -rf "$dir"; mort "livraison : fichier inattendu « $nom » — refusée." ;; esac
  done < <(tar -tvf "$dir/livraison.tar" 2>/dev/null || { rm -rf "$dir"; mort "livraison illisible (tar)."; })
  tar -xf "$dir/livraison.tar" --no-same-owner --no-same-permissions -C "$dir"
  rm -f "$dir/livraison.tar"
  [ -f "$dir/app.conf" ] || mort "livraison sans manifeste (app.conf)."
  [ -f "$dir/image.tar.gz" ] || mort "livraison sans image (image.tar.gz)."
  vert "reçue : $(du -sh "$dir" | cut -f1) — $(ls "$dir" | tr '\n' ' ')"

  deployer_interne "$sha" "$dir"
}

# --------------------------------------------------------------- deployer
cmd_deployer() {
  local app="${1:-}" sha="${2:-}"
  [ $# -eq 2 ] || mort "usage : infra deployer <app> <sha>"
  exiger_root deployer "$@"
  valide_sha "$sha" || mort "version illisible : « $sha »."
  charger_fiche "$app"; exiger_appelant
  verrou_app "$app"
  local dir="$A_ETAT/livraisons/$sha"
  [ -d "$dir" ] || dir=""
  deployer_interne "$sha" "$dir"
}

# Le cœur, commun à livrer / deployer. $2 = répertoire de livraison ou vide.
deployer_interne() {
  local sha="$1" dir="$2" debut; debut="$(date +%s)"
  local avant; avant="$(version_en_service)"
  local manifeste_accepte; manifeste_accepte="$(manifeste_de "$A_APP")"

  # Le manifeste : celui de la livraison (candidat), sinon le dernier accepté.
  if [ -n "$dir" ] && [ -f "$dir/app.conf" ]; then
    charger_manifeste "$dir/app.conf" "$A_APP"
  elif [ -f "$manifeste_accepte" ]; then
    charger_manifeste "$manifeste_accepte" "$A_APP"
  else
    mort "aucun manifeste pour « $A_APP » : il arrive avec la première livraison (infra livrer)."
  fi

  titre "0 — Les contrôles, avant de toucher à quoi que ce soit"
  controler_avant_deploiement

  local deja=0
  [ "$avant" = "$sha" ] && en_marche && deja=1

  if [ "$deja" = 1 ]; then
    vert "$M_IMAGE:${sha:0:8} tourne déjà — on reprend à l'écran et à la porte."
    [ -n "$dir" ] && [ -f "$dir/app.conf" ] && install -m 0644 "$dir/app.conf" "$manifeste_accepte"
  else
    titre "1 — L'image"
    if [ -n "$dir" ] && [ -f "$dir/image.tar.gz" ]; then
      gunzip -c "$dir/image.tar.gz" | docker load >/dev/null || mort "docker load a échoué."
    fi
    docker image inspect "$M_IMAGE:$sha" >/dev/null 2>&1 \
      || mort "$M_IMAGE:$sha n'est pas chargée. L'IMAGE du manifeste est-elle celle que le pipeline a bâtie ?"
    vert "${avant:0:8}${avant:+ → }${sha:0:8}   ($M_IMAGE)"

    titre "2 — La sauvegarde, avant de toucher à quoi que ce soit"
    local prise; prise="$A_PRISES/avant-$(date +%F_%Hh%M%S)_${sha:0:8}.dump"
    prendre "$prise"
    vert "$prise ($(du -h "$prise" | cut -f1)), relue"
    ls -t "$A_PRISES"/avant-*.dump 2>/dev/null | tail -n +11 | xargs -r rm -f

    titre "3 — La mise en service"
    local ancien_service=""
    if [ -f "$manifeste_accepte" ]; then ancien_service="$(lire "$manifeste_accepte" SERVICE)"; ancien_service="${ancien_service:-app}"; fi
    engendrer_compose
    docker tag "$M_IMAGE:$sha" "$M_IMAGE:en-service"
    compose up -d "$M_SERVICE" || true
    vert "conteneur relancé sur $M_IMAGE:${sha:0:8}"

    titre "4 — Les sondes : $M_SONDES"
    if ! attendre_le_service; then
      titre "RETOUR ARRIÈRE"
      dire_pourquoi_la_sonde_tombe
      retour_arriere "$avant" "$ancien_service"
      info "⚠ le SCHÉMA n'est pas revenu. La prise d'avant est là : $prise"
      info "   la remettre :  sudo infra restaurer $A_APP $prise --confirmer $A_APP"
      journaliser "$A_APP" "$sha" ECHEC "sonde $SONDE_ECHEC — retour à ${avant:-rien}"
      mort "déploiement de ${sha:0:8} ABANDONNÉ."
    fi
    vert "toutes les sondes rendent 200"
    [ -n "$dir" ] && [ -f "$dir/app.conf" ] && install -m 0644 "$dir/app.conf" "$manifeste_accepte"
    noter_version "$sha"
  fi

  poser_ecran "$sha" "$dir"
  poser_porte

  titre "7 — Le ménage"
  menage_images "$sha"
  ls -1dt "$A_ETAT"/ecran/versions/*/ 2>/dev/null | tail -n "+$((A_GARDER_VERSIONS + 1))" | xargs -r rm -rf
  rm -rf "$A_ETAT/livraisons"
  vert "en service : $sha  ($(( $(date +%s) - debut )) s)"
  journaliser "$A_APP" "$sha" OK "$(( $(date +%s) - debut )) s"
}

controler_avant_deploiement() {
  docker info >/dev/null 2>&1 || mort "docker ne répond pas."
  docker compose version >/dev/null 2>&1 || mort "« docker compose » (v2) absent : paquet docker-compose-plugin."

  local s; s="$(secrets_de "$A_APP")"
  fichier_sur "$s" || mort "$s absent : les secrets de « $A_APP ».  sudo infra editer $A_APP"
  [ "$(stat -c '%U %a' "$s")" = "root 600" ] || { chown root:root "$s"; chmod 0600 "$s"; jaune "$s remis en root 0600."; }
  local v manque=""
  for v in $M_VARIABLES_OBLIGATOIRES; do [ -n "$(lire "$s" "$v")" ] || manque="$manque $v"; done
  [ -z "$manque" ] || mort "variables obligatoires vides dans $s :$manque
    Les poser :  sudo infra editer $A_APP"

  base_existe "$A_BASE_NOM" || mort "la base « $A_BASE_NOM » n'existe pas (ou postgres ne répond pas par le socket local)."

  # Le port : un conteneur ÉTRANGER qui le publie, ou un processus qui
  # l'écoute alors que notre service ne tourne pas.
  local squat; squat="$(etrangers_sur_le_port "$A_PORT")"
  if [ -n "$squat" ]; then
    rouge "le port $A_PORT est publié par un conteneur étranger à « $A_APP » :"; printf '%s\n' "$squat" | sed 's/^/      /'
    mort "ABANDONNÉ — rien n'a été touché.  (changer : sudo infra regler $A_APP PORT=…)"
  fi
  if ! en_marche && [ -n "$(ecoute_sur_le_port "$A_PORT")" ]; then
    rouge "quelque chose écoute déjà 127.0.0.1:$A_PORT, et ce n'est pas « $A_APP » :"
    ecoute_sur_le_port "$A_PORT" | sed 's/^/      /'
    mort "ABANDONNÉ — rien n'a été touché."
  fi
  local autre
  for autre in $(applications); do
    [ "$autre" = "$A_APP" ] && continue
    [ "$(lire "$(fiche_de "$autre")" PORT)" = "$A_PORT" ] && mort "le port $A_PORT est aussi celui de « $autre » dans le registre."
  done

  # Le certificat, vérifié ICI et non à l'étape de la porte : découvrir qu'il
  # manque APRÈS la relance laissait un serveur neuf sans porte.
  if [ "$A_SCHEMA" = https ] && { [ ! -e "$A_TLS_CERT" ] || [ ! -e "$A_TLS_CLE" ]; }; then
    mort "HTTPS annoncé pour « $A_NOM », mais $A_TLS_CERT ou $A_TLS_CLE manque.
    sudo certbot certonly --nginx -d $A_NOM   — ou  sudo infra regler $A_APP TLS_CERT=… TLS_CLE=…"
  fi
  [ "$A_SCHEMA" = http ] && [ -z "$A_ACCES_LIMITE" ] \
    && jaune "porte OUVERTE et EN CLAIR sur « $A_NOM » (http://, sans ACCES_LIMITE) : c'est une décision, pas un défaut."
  vert "contrôles verts — base $A_BASE_NOM, port $A_PORT, $A_URL"
}

# retour_arriere VERSION_PRECEDENTE ANCIEN_SERVICE
retour_arriere() {
  local avant="$1" ancien_service="$2" manifeste_accepte; manifeste_accepte="$(manifeste_de "$A_APP")"
  if [ -n "$avant" ] && docker image inspect "$(lire "$manifeste_accepte" IMAGE):$avant" >/dev/null 2>&1; then
    # Le candidat a pu changer de nom de service : on l'arrête avant de
    # remettre l'ancien, sinon les deux se disputeraient le port.
    if [ -n "$ancien_service" ] && [ "$ancien_service" != "$M_SERVICE" ]; then
      compose rm -sf "$M_SERVICE" >/dev/null 2>&1 || true
    fi
    charger_manifeste "$manifeste_accepte" "$A_APP"
    engendrer_compose
    docker tag "$M_IMAGE:$avant" "$M_IMAGE:en-service"
    compose up -d "$M_SERVICE" || true
    if attendre_le_service; then vert "version précédente remise (${avant:0:8}), et elle répond"
    else rouge "version précédente remise (${avant:0:8}), mais elle ne répond pas non plus ($SONDE_ECHEC)"; fi
  else
    compose stop "$M_SERVICE" >/dev/null 2>&1 || true
    info "aucune version précédente à remettre : le conteneur est arrêté (il bouclerait sur un démarrage raté)."
  fi
}

# --------------------------------------------------------------- l'écran
poser_ecran() {
  local sha="$1" dir="$2"
  [ "$M_MODE_WEB" = spa ] || return 0
  titre "5 — L'écran"
  local versions="$A_ETAT/ecran/versions" dest
  dest="$versions/$sha"
  install -d -m 0755 "$A_ETAT/ecran" "$versions"
  if [ -n "$dir" ] && [ -f "$dir/frontend.tar.gz" ]; then
    local ligne
    while IFS= read -r ligne; do
      case "${ligne:0:1}" in -|d) : ;; *) mort "frontend.tar.gz porte autre chose que des fichiers et des répertoires — écran NON changé." ;; esac
      case "${ligne##* }" in /*|*..*) mort "frontend.tar.gz porte un chemin hors de l'archive — écran NON changé." ;; esac
    done < <(tar -tvzf "$dir/frontend.tar.gz")
    rm -rf "$dest.tmp"; install -d -m 0755 "$dest.tmp"
    tar -xzf "$dir/frontend.tar.gz" --no-same-owner --no-same-permissions -C "$dest.tmp"
    [ -f "$dest.tmp/index.html" ] || mort "frontend.tar.gz ne porte pas d'index.html — écran NON changé."
    find "$dest.tmp" -type d -exec chmod 0755 {} + ; find "$dest.tmp" -type f -exec chmod 0644 {} +
    rm -rf "$dest"; mv "$dest.tmp" "$dest"
  fi
  [ -f "$dest/index.html" ] || mort "aucun écran pour ${sha:0:8} ($dest) : la livraison devait porter frontend.tar.gz."
  ln -sfn "$dest" "$A_ETAT/ecran/courant.tmp" && mv -Tf "$A_ETAT/ecran/courant.tmp" "$A_ETAT/ecran/courant"
  vert "écran ${sha:0:8} servi depuis $A_ETAT/ecran/courant"
}

# --------------------------------------------------------------- revenir
cmd_revenir() {
  local app="${1:-}" cible="${2:-}"
  exiger_root revenir "$@"
  charger_fiche "$app"; exiger_appelant; verrou_app "$app"
  charger_manifeste "$(manifeste_de "$app")" "$app"
  local courant; courant="$(version_en_service)"
  if [ -z "$cible" ]; then
    cible="$(cut -f1 "$A_ETAT/versions" 2>/dev/null | grep -vxF "$courant" | tail -1 || true)"
    [ -n "$cible" ] || mort "aucune version précédente connue pour « $app »."
  fi
  valide_sha "$cible" || mort "version illisible : « $cible »."
  docker image inspect "$M_IMAGE:$cible" >/dev/null 2>&1 \
    || mort "$M_IMAGE:$cible n'est plus sur ce serveur. Versions présentes :
$(docker images "$M_IMAGE" --format '      {{.Tag}}  ({{.CreatedSince}})' | grep -v en-service)"
  titre "Revenir de ${courant:0:8} à ${cible:0:8}"
  # Le même chemin qu'un déploiement : contrôles, prise, sondes, écran, porte.
  deployer_interne "$cible" ""
}

# --------------------------------------------------------------- relancer
# Après `infra editer` (secrets) ou `infra regler` (port, adresse) : même
# image, compose réengendré, sondes, porte.
cmd_relancer() {
  local app="${1:-}"
  exiger_root relancer "$@"
  charger_fiche "$app"; verrou_app "$app"
  charger_manifeste "$(manifeste_de "$app")" "$app"
  local sha; sha="$(version_en_service)"
  [ -n "$sha" ] || mort "« $app » n'a encore jamais été déployée."
  titre "0 — Les contrôles"
  controler_avant_deploiement
  titre "Relance de ${sha:0:8}"
  engendrer_compose
  compose up -d --force-recreate "$M_SERVICE" || true
  if ! attendre_le_service; then
    dire_pourquoi_la_sonde_tombe
    journaliser "$A_APP" "$sha" ECHEC "relance : sonde $SONDE_ECHEC"
    mort "la relance ne répond pas. Les réglages viennent-ils de changer ?  sudo infra editer $app"
  fi
  vert "toutes les sondes rendent 200"
  poser_ecran "$sha" ""
  poser_porte
  journaliser "$A_APP" "$sha" RELANCE ""
}

cmd_porte() {
  local app="${1:-}"
  exiger_root porte "$@"
  charger_fiche "$app"; verrou_app "$app"
  charger_manifeste "$(manifeste_de "$app")" "$app"
  poser_porte
}
