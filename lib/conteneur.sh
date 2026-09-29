# shellcheck shell=bash
# =====================================================================
# lib/conteneur.sh — le compose ENGENDRÉ, l'image, les sondes.
#
# ---- LE COMPOSE N'ARRIVE PLUS PAR LE PIPELINE ----
#
# Les trois dépôts déposaient leur `docker-compose.yml` par SCP, avec le compte
# de déploiement. Or un compose peut monter `/` dans un conteneur privilégié :
# qui écrit le compose tient root. Ici, root l'ENGENDRE depuis le manifeste
# validé — volumes nommés seulement, pas de `privileged`, pas de montage de
# l'hôte — et le range dans /var/lib/infra/<app>/, que personne d'autre n'écrit.
#
# Ce qui reste commun aux trois, et qui est gardé tel quel :
#   - `network_mode: host` et l'application sur 127.0.0.1 : elle atteint le
#     PostgreSQL natif sans toucher à pg_hba.conf, et seul nginx l'atteint ;
#   - l'étiquette mobile `en-service`, jamais `latest` : `docker load` avance
#     `latest`, un retour arrière ne la recule pas, et un `up -d` tapé à la
#     main réinstallerait la version refusée ;
#   - un plafond mémoire (sans lui, la JVM voit la machine entière) ;
#   - un journal qui tourne (3 × 10 Mo) : sinon il remplit le disque de la base.
# =====================================================================

compose() {   # docker compose de CETTE application, et d'elle seule
  docker compose -p "$A_PROJET" -f "$(compose_de "$A_APP")" "$@"
}

engendrer_compose() {
  local sortie; sortie="$(compose_de "$A_APP")"
  install -d -m 0755 "$(dirname "$sortie")"
  {
    printf '# ENGENDRÉ par « infra » le %s — ne pas modifier à la main :\n' "$(horodatage)"
    printf '# il est réécrit à chaque déploiement depuis le manifeste et la fiche serveur.\n'
    printf 'name: %s\n\nservices:\n  %s:\n' "$A_PROJET" "$M_SERVICE"
    printf '    image: %s:${TAG:-en-service}\n' "$M_IMAGE"
    printf '    restart: unless-stopped\n    network_mode: host\n'
    printf '    env_file: %s\n' "$(secrets_de "$A_APP")"
    printf '    environment:\n'
    printf '      %s: "127.0.0.1"\n' "$M_VARIABLE_ADRESSE"
    printf '      %s: "%s"\n' "$M_VARIABLE_PORT" "$A_PORT"
    local kv
    for kv in $M_VARIABLES_FIXES; do
      printf '      %s: "%s"\n' "${kv%%=*}" "$(jetons_fixes "${kv#*=}")"
    done
    printf '    mem_limit: %s\n' "$M_MEMOIRE"
    printf '    security_opt:\n      - no-new-privileges:true\n'
    printf '    labels:\n      infra.app: "%s"\n' "$A_APP"
    if [ -n "$M_VOLUMES" ]; then
      printf '    volumes:\n'
      local v; for v in $M_VOLUMES; do printf '      - %s\n' "$v"; done
    fi
    printf '    logging:\n      driver: json-file\n      options:\n        max-size: "10m"\n        max-file: "3"\n'
    printf '    stop_grace_period: 30s\n'
    if [ -n "$M_VOLUMES" ]; then
      printf '\nvolumes:\n'
      local v; for v in $M_VOLUMES; do printf '  %s:\n' "${v%%:*}"; done
    fi
  } > "$sortie.tmp"
  chmod 0644 "$sortie.tmp"; mv -f "$sortie.tmp" "$sortie"
}

# Les conteneurs qui publient ce port SANS être de ce projet. Le jar ne
# pourrait pas s'y lier, et la sonde interrogerait quelqu'un d'autre — qui
# répondrait, souvent 502 (paie, 15 septembre 2026). Comparaison EXACTE.
etrangers_sur_le_port() {
  local nous
  nous="$(compose ps -a --format '{{.Name}}' 2>/dev/null || true)"
  docker ps --filter "publish=$1" --format '{{.Names}}\t{{.Image}}' 2>/dev/null \
  | while IFS=$'\t' read -r nom image; do
      [ -n "$nom" ] || continue
      printf '%s\n' "$nous" | grep -xF "$nom" >/dev/null && continue
      printf '%s  %s\n' "$nom" "$image"
    done
}

# Et, en réseau de l'hôte, ce qui ÉCOUTE déjà ce port hors de Docker.
ecoute_sur_le_port() {
  command -v ss >/dev/null 2>&1 || return 0
  ss -Hltnp "sport = :$1" 2>/dev/null || true
}

# Par les ÉTIQUETTES de compose (projet + service), pas par notre fichier : au
# premier déploiement d'une application adoptée, le conteneur qui tourne a été
# lancé par l'ancien outillage — même projet, même service, autre fichier. Le
# prendre pour un étranger bloquerait toute migration.
en_marche() {
  [ -n "$(docker ps -q --filter "label=com.docker.compose.project=$A_PROJET" \
                      --filter "label=com.docker.compose.service=$M_SERVICE" 2>/dev/null)" ]
}

# Sonde chaque chemin de SONDES sur la boucle locale, dans l'ordre. Le premier
# dit « le processus répond » ; les suivants disent « et la base aussi »
# (`/api/moi` pour la paie, `/actuator/health` pour Spring). Remplit
# SONDE_ECHEC (« chemin=code ») quand ça tombe.
attendre_le_service() {
  local i p code ok
  SONDE_ECHEC=""
  for i in $(seq 1 "$SONDE_ESSAIS"); do
    ok=1
    for p in $M_SONDES; do
      code="$(sonder "http://127.0.0.1:$A_PORT$p" 20)"
      if [ "$code" != 200 ]; then ok=0; SONDE_ECHEC="$p=$code"; break; fi
    done
    [ "$ok" = 1 ] && return 0
    [ "$i" -lt "$SONDE_ESSAIS" ] && sleep "$SONDE_PAUSE"
  done
  return 1
}

dire_pourquoi_la_sonde_tombe() {
  local code="${SONDE_ECHEC#*=}"
  rouge "sonde ${SONDE_ECHEC%%=*} → $code"
  if [ "$code" = 000 ]; then
    info "personne n'écoute sur 127.0.0.1:$A_PORT — l'application n'a pas démarré (base, migration, secret ?)."
  else
    info "quelqu'un RÉPOND sur 127.0.0.1:$A_PORT et rend $code."
    docker ps --filter "publish=$A_PORT" --format '      {{.Names}}  {{.Image}}' 2>/dev/null || true
    ecoute_sur_le_port "$A_PORT" | sed 's/^/      /'
  fi
  compose logs --tail=40 "$M_SERVICE" 2>/dev/null | sed 's/^/      /' || true
}

# Nos images seulement — jamais `docker image prune` à l'aveugle : sur un
# serveur partagé, il balaierait ce qui appartient aux autres applications.
menage_images() {
  local garder="$A_GARDER_VERSIONS" sha_courant="$1" vieilles
  vieilles="$(docker images "$M_IMAGE" --format '{{.Tag}}' 2>/dev/null \
              | grep -vx 'en-service' | grep -vx "$sha_courant" | grep -vx '<none>' \
              | tail -n "+$garder" || true)"
  [ -n "$vieilles" ] || return 0
  printf '%s\n' "$vieilles" | while read -r t; do docker rmi "$M_IMAGE:$t" >/dev/null 2>&1 || true; done
}

# L'historique des versions ACCEPTÉES (une par ligne, la plus récente en bas).
# C'est lui que `infra revenir` lit pour savoir où revenir.
noter_version() {
  local h="$A_ETAT/versions"
  printf '%s\t%s\n' "$1" "$(horodatage)" >> "$h"
  tail -n 50 "$h" > "$h.tmp" && mv -f "$h.tmp" "$h"
  printf '%s\n' "$1" > "$A_ETAT/en-service"
}
version_en_service() { cat "$A_ETAT/en-service" 2>/dev/null || true; }
