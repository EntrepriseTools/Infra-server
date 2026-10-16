#!/usr/bin/env bash
# =====================================================================
# paas/sauvegarde.sh — une archive de tout ce qui ne se reconstruit pas :
#
#   .env (les clés), le volume « rail_rail-data » (catalogue SQLite et
#   journaux de déploiement) et le volume de chaque base de données.
#
#   sudo ./sauvegarde.sh                  → /var/backups/rail/rail-<date>.tar.gz
#   sudo ./sauvegarde.sh /mnt/sauvegardes
#   RETENTION_J=30 sudo ./sauvegarde.sh   → garde 30 jours (défaut : 14)
#   A_CHAUD=1 sudo ./sauvegarde.sh        → ne met pas le plan de contrôle en pause
#
# Le plan de contrôle est arrêté pendant la copie (quelques secondes) pour que la
# base SQLite soit cohérente : VOS services, eux, ne bougent pas. Pour une base de
# données, préférez un export logique (« rail backup projet/base ») à la copie du
# volume : il se restaure dans n'importe quelle version du moteur.
#
# Une sauvegarde qui reste sur le serveur ne sauve de rien : copiez l'archive
# ailleurs (rsync, S3, disque externe) une fois le script passé.
# =====================================================================
set -euo pipefail
cd "$(dirname "$0")"

dest="${1:-/var/backups/rail}"
retention="${RETENTION_J:-14}"
die() { printf 'sauvegarde : %s\n' "$*" >&2; exit 1; }

command -v docker >/dev/null || die "Docker n'est pas installé"
mkdir -p "$dest"
chmod 700 "$dest"

# Une image qui contient tar : celle du plan de contrôle est déjà là.
outil="rail-control:local"
docker image inspect "$outil" >/dev/null 2>&1 || outil="busybox"

tmp="$(mktemp -d)"
chmod 700 "$tmp"
trap 'rm -rf "$tmp"' EXIT

copier_volume() {
  local volume="$1"
  docker volume inspect "$volume" >/dev/null 2>&1 || return 0
  printf '  volume %s\n' "$volume"
  docker run --rm -v "$volume":/src:ro -v "$tmp":/out "$outil" \
    tar czf "/out/$volume.tgz" -C /src .
}

# Le plan de contrôle écrit dans SQLite : on le met en pause le temps de la copie.
pause=0
reprendre() {
  if [ "$pause" = 1 ]; then pause=0; docker start rail-control >/dev/null 2>&1 || true; fi
}

printf 'Sauvegarde de Rail\n'
if [ "${A_CHAUD:-0}" != 1 ] && [ "$(docker inspect -f '{{.State.Running}}' rail-control 2>/dev/null)" = true ]; then
  pause=1
  trap 'reprendre; rm -rf "$tmp"' EXIT
  printf '  pause du plan de contrôle\n'
  docker stop -t 20 rail-control >/dev/null
fi
if [ -f .env ]; then cp .env "$tmp/env"; printf '  .env\n'; fi
copier_volume rail_rail-data
# Les volumes des bases de données managées : rail-vol-<id du service>
while read -r v; do
  if [ -n "$v" ]; then copier_volume "$v"; fi
done < <(docker volume ls --format '{{.Name}}' | grep '^rail-vol-' || true)
reprendre   # le tableau de bord revient pendant que l'archive se compresse

archive="$dest/rail-$(date +%Y%m%d-%H%M%S).tar.gz"
tar czf "$archive" -C "$tmp" .
chmod 600 "$archive"
printf 'Archive : %s (%s)\n' "$archive" "$(du -h "$archive" | cut -f1)"

# Rotation : on ne garde que les N derniers jours, et seulement nos archives.
find "$dest" -maxdepth 1 -name 'rail-*.tar.gz' -mtime "+$retention" -print -delete

cat <<'FIN'

Pour restaurer sur un serveur neuf :
  1. tar xzf rail-<date>.tar.gz -C /tmp/restore
  2. cp /tmp/restore/env paas/.env    (la clé RAIL_SECRET_KEY doit être la même, sinon les variables sont illisibles)
  3. sudo ./install.sh                (crée les volumes)
  4. docker compose stop control
     docker run --rm -v rail_rail-data:/dst -v /tmp/restore:/src rail-control:local \
       sh -c 'tar xzf /src/rail_rail-data.tgz -C /dst'
     (et de même pour chaque rail-vol-*.tgz vers son volume)
  5. docker compose start control
FIN
