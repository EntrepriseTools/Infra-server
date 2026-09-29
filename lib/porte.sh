# shellcheck shell=bash
# =====================================================================
# lib/porte.sh — le bloc nginx d'une application (« la porte »).
#
# Le nginx de l'hôte est PARTAGÉ par toutes les applications : un bloc refusé
# laissé dans conf.d/ ferait tomber TOUS les sites au prochain rechargement
# (celui de certbot par exemple). D'où l'ordre, tenu sous un verrou global :
#
#   1. rendre le bloc depuis le gabarit (root) et la fiche serveur (root) ;
#   2. refuser un nom déjà servi ailleurs — nginx ne dit rien sur deux
#      `server_name` identiques, il ignore le second en silence ;
#   3. garder le bloc en place de côté, poser le neuf, `nginx -t` ;
#   4. refusé → remettre l'ANCIEN (les trois scripts d'origine le
#      supprimaient : l'application perdait sa porte au lieu de garder
#      l'ancienne) ;
#   5. recharger, puis SONDER par le nom, plusieurs fois : `reload` rend la
#      main avant que les nouveaux processus de nginx aient pris le relais
#      (mesuré sur Pilotage le 25 septembre 2026) ;
#   6. l'en-tête `X-Infra-App: <app>` prouve que c'est bien CE bloc qui a
#      répondu, et pas le serveur par défaut.
# =====================================================================

gabarit_de() { printf '%s/modeles/nginx/%s.conf.gabarit' "$INFRA_HOME" "$1"; }

rendre_porte() {
  local gabarit rendu="$A_ETAT/nginx.conf" ecran="$A_ETAT/ecran/courant" regles="" a
  gabarit="$(gabarit_de "$M_MODE_WEB")"
  [ -r "$gabarit" ] || mort "gabarit absent : $gabarit"
  install -d -m 0755 "$A_ETAT"
  sed -e "s|@APP@|$A_APP|g" -e "s|@NOM@|$A_NOM|g" -e "s|@PORT@|$A_PORT|g" \
      -e "s|@CERT@|$A_TLS_CERT|g" -e "s|@CLE@|$A_TLS_CLE|g" \
      -e "s|@CORPS_MAX@|$M_CORPS_MAX|g" -e "s|@DELAI@|${M_DELAI_PROXY}s|g" \
      -e "s|@ECRAN@|$ecran|g" -e "s|@API_PREFIXE@|$M_API_PREFIXE|g" \
      "$gabarit" > "$rendu.tmp"
  if [ "$A_SCHEMA" = https ]; then grep -v '^#HTTP#' "$rendu.tmp" | sed 's/^#HTTPS#//' > "$rendu.tmp2"
  else                             grep -v '^#HTTPS#' "$rendu.tmp" | sed 's/^#HTTP#//'  > "$rendu.tmp2"; fi
  # ---- UNE PORTE D'ESSAI NE S'OUVRE PAS À TOUT INTERNET ----
  # ACCES_LIMITE : les adresses admises ; tout le reste reçoit 403. La boucle
  # locale D'ABORD : la sonde de fin part du serveur lui-même.
  if [ -n "$A_ACCES_LIMITE" ]; then
    regles="    allow 127.0.0.1;\n    allow ::1;\n"
    for a in $A_ACCES_LIMITE; do regles="$regles    allow $a;\n"; done
    regles="$regles    deny all;"
  fi
  awk -v r="$regles" '/^[[:space:]]*#ACCES#/ { if (r != "") { gsub(/\\n/, "\n", r); print r }; next } { print }' \
    "$rendu.tmp2" > "$rendu"
  rm -f "$rendu.tmp" "$rendu.tmp2"
  chmod 0644 "$rendu"
}

poser_porte() {
  titre "La porte — $A_SCHEMA://$A_NOM/"
  verrou_nginx

  if [ "$A_SCHEMA" = https ]; then
    local manque="" f
    for f in "$A_TLS_CERT" "$A_TLS_CLE"; do [ -e "$f" ] || manque="$manque $f"; done
    if [ -n "$manque" ]; then
      rouge "HTTPS annoncé pour « $A_NOM » mais il manque :$manque"
      local deja
      deja="$(grep -rhoE '^[[:space:]]*ssl_certificate[[:space:]]+[^;]+;' "$NGINX_CONF_D" "$NGINX_SITES" "$NGINX_CONF" 2>/dev/null \
              | sed 's/^[[:space:]]*//' | sort -u || true)"
      [ -z "$deja" ] || { info "Ce que nginx sert DÉJÀ ici :"; printf '%s\n' "$deja" | sed 's/^/      /'; }
      info "Obtenir le certificat :  sudo certbot certonly --nginx -d $A_NOM"
      info "ou désigner un existant : sudo infra regler $A_APP TLS_CERT=… TLS_CLE=…"
      mort "porte NON posée. L'application tourne : http://127.0.0.1:$A_PORT/"
    fi
  fi

  local conflits
  conflits="$(grep -rlE "^[[:space:]]*server_name[[:space:]]+([^;]*[[:space:]])?${A_NOM//./\\.}[[:space:];]" \
              "$NGINX_CONF_D" "$NGINX_SITES" "$NGINX_CONF" 2>/dev/null | grep -vxF "$A_POSE" || true)"
  if [ -n "$conflits" ]; then
    rouge "« $A_NOM » est déjà servi par un autre bloc nginx :"; printf '%s\n' "$conflits" | sed 's/^/      /'
    mort "choisir un autre nom (sudo infra regler $A_APP URL=…) ou retirer ce bloc. L'application tourne : http://127.0.0.1:$A_PORT/"
  fi

  rendre_porte
  local precedent="$A_ETAT/nginx.precedent"
  rm -f "$precedent"
  [ -f "$A_POSE" ] && cp -p "$A_POSE" "$precedent"
  install -m 0644 "$A_ETAT/nginx.conf" "$A_POSE"
  if ! nginx -t >/dev/null 2>"$A_ETAT/nginx-t.log"; then
    rouge "nginx REFUSE ce bloc :"; sed 's/^/      /' "$A_ETAT/nginx-t.log" >&2
    if [ -f "$precedent" ]; then install -m 0644 "$precedent" "$A_POSE"; info "l'ancien bloc est remis — la porte d'avant reste ouverte."
    else rm -f "$A_POSE"; info "le bloc est retiré — les autres sites sont épargnés."; fi
    nginx -t >/dev/null 2>&1 || rouge "⚠ nginx -t échoue ENCORE après le retrait : ce n'est pas ce bloc. NE PAS recharger avant d'avoir regardé."
    mort "porte NON posée."
  fi
  systemctl reload nginx || mort "nginx n'a pas rechargé (systemctl status nginx)."
  vert "bloc $A_POSE posé, éprouvé (nginx -t), rechargé"

  sonder_porte
}

sonder_porte() {
  local pp=443 res=() ent="" i
  [ "$A_SCHEMA" = http ] && pp=80
  [[ "$A_NOM" =~ ^[0-9.]+$ ]] || res=(--resolve "$A_NOM:$pp:127.0.0.1")
  for i in $(seq 1 "$PORTE_ESSAIS"); do
    ent="$(curl -sk --noproxy '*' -o /dev/null -D - --max-time 15 ${res[@]+"${res[@]}"} "$A_SCHEMA://$A_NOM$M_SONDE_PUBLIQUE" 2>/dev/null || true)"
    printf '%s' "$ent" | grep -iE "^x-infra-app:[[:space:]]*${A_APP}[[:space:]]*$" >/dev/null && break
    [ "$i" -lt "$PORTE_ESSAIS" ] && sleep "$PORTE_PAUSE"
  done
  if printf '%s' "$ent" | grep -iE "^x-infra-app:[[:space:]]*${A_APP}[[:space:]]*$" >/dev/null; then
    vert "$A_SCHEMA://$A_NOM$M_SONDE_PUBLIQUE répond, et c'est bien « $A_APP » (X-Infra-App)"
  else
    rouge "$A_SCHEMA://$A_NOM/ ne répond pas par « $A_APP » — un autre bloc répond, ou le nom ne résout pas ici."
    if [ -n "$ent" ]; then
      info "Ce qui a répondu au dernier essai :"
      printf '%s\n' "$ent" | tr -d '\r' | grep -iE '^(HTTP/|server:|location:|x-infra-app:)' | sed 's/^/      /' || true
    fi
    mort "L'application tourne (http://127.0.0.1:$A_PORT/) — relancer « infra porte $A_APP » après correction."
  fi
  # La sonde accepte n'importe quel certificat : elle éprouve le chemin, pas
  # le chiffrement. Un certificat qui ne couvre pas le nom se DIT.
  if [ "$A_SCHEMA" = https ] \
     && ! curl -s --noproxy '*' -o /dev/null --max-time 15 ${res[@]+"${res[@]}"} "https://$A_NOM$M_SONDE_PUBLIQUE" 2>/dev/null; then
    jaune "le certificat servi pour « $A_NOM » ne se vérifie pas : les navigateurs afficheront une alerte."
  fi
}

# Jours avant l'expiration du certificat (vide si illisible).
jours_certificat() {
  local fin
  fin="$(openssl x509 -enddate -noout -in "$1" 2>/dev/null | cut -d= -f2)" || return 0
  [ -n "$fin" ] || return 0
  echo $(( ( $(date -d "$fin" +%s) - $(date +%s) ) / 86400 ))
}
