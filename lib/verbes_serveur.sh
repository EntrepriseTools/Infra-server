# shellcheck shell=bash
# =====================================================================
# lib/verbes_serveur.sh — preparer, etat, liste, journaux, historique,
# docteur.
# =====================================================================

# ---------------------------------------------------------------- preparer
# Une fois par serveur (et sans danger à rejouer) : outils, répertoires,
# unités systemd, et un diagnostic de ce qui manque.
cmd_preparer() {
  exiger_root preparer "$@"
  local hote="" paquets=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --hote) hote="$2"; shift 2 ;;
      --installer-paquets) paquets=1; shift ;;
      *) mort "option inconnue : $1  (--hote <IP publique> --installer-paquets)" ;;
    esac
  done
  [ -z "$hote" ] || valide_hote "$hote" || mort "--hote illisible : $hote"

  titre "1 — Les outils"
  local manque="" c
  for c in nginx pg_dump pg_restore psql runuser flock curl openssl ss visudo systemctl ssh-keygen gunzip tar; do
    command -v "$c" >/dev/null 2>&1 || manque="$manque $c"
  done
  if [ -n "$manque" ] && [ "$paquets" = 1 ] && command -v apt-get >/dev/null; then
    info "installation :$manque"
    DEBIAN_FRONTEND=noninteractive apt-get install -y -q nginx postgresql-client curl openssl iproute2 sudo util-linux openssh-client gzip tar >/dev/null \
      || mort "apt-get install a échoué."
    manque=""
    for c in nginx pg_dump pg_restore psql runuser flock curl openssl ss visudo systemctl ssh-keygen; do
      command -v "$c" >/dev/null 2>&1 || manque="$manque $c"
    done
  fi
  [ -z "$manque" ] || mort "outils absents :$manque   (relancer avec --installer-paquets, ou apt-get install)"
  vert "nginx, client PostgreSQL, curl, openssl, ss, visudo, systemd, ssh-keygen"
  if ! docker compose version >/dev/null 2>&1; then
    rouge "Docker Engine + le greffon compose v2 sont absents."
    info "Debian : https://docs.docker.com/engine/install/debian/  (paquets docker-ce, docker-compose-plugin)"
    mort "installer Docker, puis relancer « infra preparer »."
  fi
  vert "docker $(docker version --format '{{.Server.Version}}' 2>/dev/null) — compose $(docker compose version --short 2>/dev/null)"
  command -v gpg >/dev/null || jaune "gpg absent : les sauvegardes ne pourront pas être chiffrées (apt-get install gnupg)."

  titre "2 — PostgreSQL natif"
  if runuser -u postgres -- psql -X -tAqc 'select version()' >/dev/null 2>&1; then
    vert "$(runuser -u postgres -- psql -X -tAqc 'show server_version' 2>/dev/null) — joignable par le compte postgres (socket, peer)"
  else
    mort "le compte postgres n'atteint pas PostgreSQL par le socket local. Est-il installé et démarré ?  systemctl status postgresql"
  fi

  titre "3 — Les répertoires"
  install -d -m 0755 "$ETC_INFRA" "$ETC_INFRA/apps" "$VAR_INFRA" "$JOURNAL_DIR"
  install -d -m 0700 "$SECRETS_DIR" "$SAUVEGARDES"
  [ -e "$(serveur_conf)" ] || printf '# Réglages du serveur — infra preparer.\nHOTE_PUBLIC=\n' > "$(serveur_conf)"
  [ -z "$hote" ] || ecrire_cle "$(serveur_conf)" HOTE_PUBLIC "$hote"
  vert "$ETC_INFRA (fiches, secrets 0700) · $VAR_INFRA (état) · $SAUVEGARDES (prises 0700) · $JOURNAL_DIR"

  titre "4 — Les unités de sauvegarde"
  install -d -m 0755 "$SYSTEMD_DIR"
  install -m 0644 "$INFRA_HOME/modeles/systemd/infra-sauvegarde@.service" "$SYSTEMD_DIR/"
  install -m 0644 "$INFRA_HOME/modeles/systemd/infra-sauvegarde@.timer" "$SYSTEMD_DIR/"
  systemctl daemon-reload
  vert "infra-sauvegarde@.service / .timer (une instance par application)"

  titre "5 — nginx"
  if grep -rqsE '^[[:space:]]*include[[:space:]]+/etc/nginx/conf\.d/\*\.conf' "$NGINX_CONF"; then
    vert "nginx.conf inclut conf.d/*.conf"
  else
    jaune "nginx.conf ne semble pas inclure /etc/nginx/conf.d/*.conf : les portes n'y seraient pas lues."
  fi
  nginx -t >/dev/null 2>&1 && vert "nginx -t : la configuration actuelle est valide" \
    || jaune "nginx -t échoue DÉJÀ : à corriger avant tout déploiement (sudo nginx -t)."

  vert "serveur prêt — prochaine étape :  sudo infra creer <app> --manifeste … --url …"
}

# ---------------------------------------------------------------- etat
cmd_etat() {
  local app="${1:-}"
  if [ -z "$app" ]; then etat_tous; return 0; fi
  exiger_root etat "$@"
  charger_fiche "$app"
  local mf; mf="$(manifeste_de "$app")"
  titre "« $app » — $A_URL"
  info "compte $A_COMPTE · port 127.0.0.1:$A_PORT · base $A_BASE_NOM · projet compose $A_PROJET"
  if [ ! -f "$mf" ]; then info "jamais déployée (aucun manifeste accepté)."; return 0; fi
  charger_manifeste "$mf" "$app"
  info "image $M_IMAGE · service $M_SERVICE · mode $M_MODE_WEB · sondes $M_SONDES"
  titre "En service"
  info "version   $(version_en_service || true)"
  compose ps 2>/dev/null | sed 's/^/    /' || info "(compose illisible)"
  titre "Sondes"
  local p; for p in $M_SONDES; do info "$(printf '%-24s' "$p") $(sonder "http://127.0.0.1:$A_PORT$p" 10)"; done
  titre "Sauvegardes"
  info "dernière  $(ls -t "$A_PRISES"/quotidien_* 2>/dev/null | head -1 || true)"
  info "minuteur  $(systemctl list-timers "infra-sauvegarde@$app.timer" --no-pager 2>/dev/null | sed -n '2p' || true)"
  if [ "$A_SCHEMA" = https ] && [ -r "$A_TLS_CERT" ]; then
    titre "Certificat"; info "$A_TLS_CERT — expire dans $(jours_certificat "$A_TLS_CERT") jour(s)"
  fi
  titre "Versions relançables"
  docker images "$M_IMAGE" --format '    {{.Tag}}  ({{.CreatedSince}})' 2>/dev/null | grep -v en-service || true
}

etat_tous() {
  exiger_root etat
  printf '\n%-14s %-10s %-9s %-7s %-17s %s\n' APPLICATION VERSION CONTENEUR SONDE "DERNIÈRE PRISE" URL
  local app mf sha cont sonde prise p
  for app in $(applications); do
    ( charger_fiche "$app" >/dev/null 2>&1 ) || { printf '%-14s (fiche illisible — infra docteur)\n' "$app"; continue; }
    charger_fiche "$app"
    mf="$(manifeste_de "$app")"; sha="$(version_en_service)"; cont="—"; sonde="—"
    if [ -f "$mf" ]; then
      charger_manifeste "$mf" "$app"
      en_marche && cont="en marche" || cont="ARRÊTÉ"
      sonde=200; for p in $M_SONDES; do s="$(sonder "http://127.0.0.1:$A_PORT$p" 5)"; [ "$s" = 200 ] || { sonde="$s"; break; }; done
    fi
    prise="$(ls -t "$A_PRISES"/quotidien_* 2>/dev/null | head -1 || true)"
    prise="${prise:+$(date -r "$prise" '+%d/%m %H:%M')}"
    printf '%-14s %-10s %-9s %-7s %-17s %s\n' "$app" "${sha:0:8}" "$cont" "$sonde" "${prise:-aucune}" "$A_URL"
  done
  echo
}

cmd_liste() { applications; }

cmd_journaux() {
  local app="${1:-}" n="${2:-200}"
  exiger_root journaux "$@"
  charger_fiche "$app"; charger_manifeste "$(manifeste_de "$app")" "$app"
  if [ "$n" = -f ]; then compose logs -f --tail=100 "$M_SERVICE"; else compose logs --tail="$n" "$M_SERVICE"; fi
}

cmd_historique() {
  local app="${1:-}"
  local f="$JOURNAL_DIR/deploiements.log"
  [ -r "$f" ] || { info "(aucun historique)"; return 0; }
  printf '\n%-19s  %-12s  %-8s  %-12s  %-10s  %s\n' DATE APPLICATION VERSION RÉSULTAT PAR DÉTAIL
  if [ -n "$app" ]; then
    valide_app "$app" || mort "nom illisible"
    awk -F'\t' -v a="$app" '$2 == a' "$f"
  else cat "$f"; fi | tail -n 30 | awk -F'\t' '{ printf "%-19s  %-12s  %-8s  %-12s  %-10s  %s\n", $1, $2, substr($3,1,8), $4, $5, $6 }'
  echo
}

# ---------------------------------------------------------------- docteur
# Tout ce qui se vérifie sans rien toucher. Rend 1 s'il y a une erreur.
cmd_docteur() {
  exiger_root docteur
  local erreurs=0
  e() { rouge "$*"; erreurs=$((erreurs + 1)); }
  titre "Serveur"
  [ -d "$ETC_INFRA/apps" ] && vert "préparé ($ETC_INFRA)" || e "non préparé :  sudo infra preparer"
  [ "$(stat -c '%a' "$SECRETS_DIR" 2>/dev/null)" = 700 ] && vert "secrets 0700" || e "$SECRETS_DIR n'est pas en 0700"
  nginx -t >/dev/null 2>&1 && vert "nginx -t valide" || e "nginx -t échoue"
  docker info >/dev/null 2>&1 && vert "docker répond" || e "docker ne répond pas"
  runuser -u postgres -- psql -X -tAqc 'select 1' >/dev/null 2>&1 && vert "PostgreSQL répond (postgres, socket)" || e "PostgreSQL ne répond pas au compte postgres"
  local d u
  for d in / "$SAUVEGARDES"; do
    u="$(df -P "$d" 2>/dev/null | awk 'NR==2 {gsub("%","",$5); print $5}')"
    [ -z "$u" ] || { [ "$u" -lt 85 ] && vert "disque $d : ${u} %" || e "disque $d plein à ${u} % — la base et les prises partagent ce disque"; }
  done
  # Les restes des trois pipelines d'origine : à retirer APRÈS la bascule.
  local vieux
  local t; vieux=""
  for t in hr board procurement; do [ -e "$SYSTEMD_DIR/$t-sauvegarde.timer" ] && vieux="$vieux $t-sauvegarde.timer"; done
  [ -z "$vieux" ] || jaune "minuteur(s) de l'ancien outillage encore posés : $(echo $vieux) — voir migration/LISEZMOI.md"

  local app ports="" p
  for app in $(applications); do
    titre "« $app »"
    if ! ( charger_fiche "$app" ) >/dev/null 2>&1; then e "fiche illisible : $( (charger_fiche "$app") 2>&1 | tail -1)"; continue; fi
    charger_fiche "$app"
    p="$A_PORT"
    printf '%s\n' "$ports" | grep -xF "$p" >/dev/null && e "port $p en double dans le registre"
    ports="$ports"$'\n'"$p"
    local s; s="$(secrets_de "$app")"
    [ -f "$s" ] && [ "$(stat -c '%U %a' "$s")" = "root 600" ] && vert "secrets root 0600" || e "secrets absents ou mal protégés : $s"
    [ -f "$SUDOERS_D/infra-$app" ] && vert "droit sudo posé" || e "droit sudo absent ($SUDOERS_D/infra-$app) : sudo infra creer … ou recréer"
    grep -qs " infra:$app\$" "$(home_de "$A_COMPTE")/.ssh/authorized_keys" && vert "clé du pipeline posée" || e "clé du pipeline absente :  sudo infra cle $app"
    id -nG "$A_COMPTE" 2>/dev/null | tr ' ' '\n' | grep -x docker >/dev/null && jaune "« $A_COMPTE » est encore dans le groupe docker (inutile, équivalent root)"
    systemctl is-enabled "infra-sauvegarde@$app.timer" >/dev/null 2>&1 && vert "minuteur armé ($A_SAUV_HEURE)" || e "minuteur de sauvegarde non armé"
    local der; der="$(ls -t "$A_PRISES"/quotidien_* 2>/dev/null | head -1 || true)"
    if [ -z "$der" ]; then jaune "aucune prise quotidienne encore"
    elif [ $(( $(date +%s) - $(stat -c %Y "$der") )) -gt 129600 ]; then e "dernière prise de plus de 36 h : $der"
    else vert "dernière prise : $(date -r "$der" '+%d/%m %H:%M')"; fi
    [ -z "$A_SAUV_GPG" ] && jaune "prises en clair (SAUVEGARDE_CLE_GPG vide)"
    if [ -f "$(manifeste_de "$app")" ]; then
      charger_manifeste "$(manifeste_de "$app")" "$app"
      if en_marche; then
        local ok=1 q; for q in $M_SONDES; do [ "$(sonder "http://127.0.0.1:$A_PORT$q" 10)" = 200 ] || ok=0; done
        [ "$ok" = 1 ] && vert "en marche, sondes vertes ($(version_en_service | cut -c1-8))" || e "en marche, mais une sonde n'est pas verte"
      else e "conteneur ARRÊTÉ"; fi
      [ -f "$A_POSE" ] && vert "porte $A_POSE" || e "porte nginx absente :  sudo infra porte $app"
    else
      jaune "jamais déployée"
    fi
    if [ "$A_SCHEMA" = https ]; then
      if [ -r "$A_TLS_CERT" ]; then
        local j; j="$(jours_certificat "$A_TLS_CERT")"
        if [ -n "$j" ] && [ "$j" -lt 21 ]; then e "certificat : $j jour(s) restant(s) — certbot renew ?"; else vert "certificat : ${j:-?} jour(s)"; fi
      else e "certificat absent : $A_TLS_CERT"; fi
    else
      [ -n "$A_ACCES_LIMITE" ] || jaune "http:// sans ACCES_LIMITE : ouvert et en clair"
    fi
  done
  echo
  [ "$erreurs" = 0 ] && { vert "aucune erreur"; return 0; }
  rouge "$erreurs erreur(s)"; return 1
}
