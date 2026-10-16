#!/usr/bin/env bash
# =====================================================================
# paas/test/integration.sh — la preuve que ça marche pour de vrai :
# le plan de contrôle, dans son image, parle au VRAI Docker de la machine,
# déploie une VRAIE base de données, la mesure, l'arrête, la relance,
# la sauvegarde, puis la supprime.
#
#   cd paas && sudo ./test/integration.sh      (CI, ou une machine jetable)
#
# N'utilise que des noms suffixés « -ci » et nettoie tout en sortant.
# =====================================================================
set -euo pipefail
cd "$(dirname "$0")/.."

RESEAU=rail-ci
CTRL=rail-control-ci
PORT=${PORT:-4055}
DATA="$PWD/.ci-data"
TOKEN="$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
CLE="$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
BASE="http://127.0.0.1:$PORT"

bleu() { printf '\n\033[1m• %s\033[0m\n' "$*"; }
die() { printf '\033[31mÉCHEC : %s\033[0m\n' "$*" >&2; docker logs --tail 60 "$CTRL" 2>&1 || true; exit 1; }
api() { curl -sS --max-time 60 -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' "$@"; }

nettoyer() {
  bleu "Ménage"
  docker rm -f "$CTRL" >/dev/null 2>&1 || true
  docker ps -aq --filter 'label=rail.managed=true' | xargs -r docker rm -f >/dev/null 2>&1 || true
  docker volume ls -q --filter 'name=^rail-vol-' | xargs -r docker volume rm -f >/dev/null 2>&1 || true
  docker network rm "$RESEAU" >/dev/null 2>&1 || true
  sudo rm -rf "$DATA" 2>/dev/null || rm -rf "$DATA" || true
}
trap nettoyer EXIT
nettoyer

bleu "Construction de l'image du plan de contrôle"
docker build -q -t rail-control:ci . >/dev/null

bleu "Démarrage : réseau, volume de données, plan de contrôle"
docker network create "$RESEAU" >/dev/null
mkdir -p "$DATA" && chmod 777 "$DATA"
gid="$(getent group docker | cut -d: -f3)"
docker run -d --name "$CTRL" --network "$RESEAU" \
  --user node --group-add "$gid" \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v "$DATA":/data \
  -p "127.0.0.1:$PORT:4000" \
  -e RAIL_DOMAIN=apps.integration.test \
  -e RAIL_ADMIN_TOKEN="$TOKEN" \
  -e RAIL_SECRET_KEY="$CLE" \
  -e RAIL_NETWORK="$RESEAU" \
  -e RAIL_METRICS_INTERVAL_S=5 \
  -e RAIL_HEALTH_TIMEOUT_S=180 \
  rail-control:ci >/dev/null

for _ in $(seq 1 40); do
  [ "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/health" || true)" = 200 ] && break
  sleep 1
done
[ "$(api "$BASE/api/health" | jq -r .status)" = ok ] || die "le plan de contrôle n'a pas démarré"
echo "  version $(api "$BASE/api/health" | jq -r .version)"

bleu "Projet et base PostgreSQL"
projet="$(api -X POST "$BASE/api/projects" -d '{"name":"integration"}' | jq -r .id)"
[ -n "$projet" ] && [ "$projet" != null ] || die "projet non créé"
base="$(api -X POST "$BASE/api/projects/$projet/databases" -d '{"engine":"postgres","name":"base"}' | jq -r .id)"
[ "$base" != null ] || die "base non créée"

bleu "Attente du déploiement (récupération de l'image, démarrage, santé TCP)"
for _ in $(seq 1 120); do
  etat="$(api "$BASE/api/services/$base" | jq -r '.latest_deployment.status // "?"')"
  [ "$etat" = success ] && break
  [ "$etat" = failed ] && { api "$BASE/api/deployments/$(api "$BASE/api/services/$base" | jq -r .latest_deployment.id)/logs"; die "déploiement en échec"; }
  sleep 2
done
[ "$etat" = success ] || die "déploiement non terminé (état : $etat)"
conteneur="$(api "$BASE/api/services/$base" | jq -r .active_deployment.container)"
[ "$(docker inspect -f '{{.State.Running}}' "$conteneur")" = true ] || die "le conteneur ne tourne pas"
docker volume inspect "rail-vol-$base" >/dev/null || die "volume absent"
echo "  conteneur $conteneur en marche, volume rail-vol-$base"

bleu "La base répond vraiment"
docker exec "$conteneur" pg_isready -U rail >/dev/null || die "pg_isready en échec"

bleu "Mesures et surveillance"
sleep 12
mesures="$(api "$BASE/api/services/$base/metrics?range=15m")"
[ "$(echo "$mesures" | jq '.points | length')" -ge 1 ] || die "aucune mesure"
[ "$(echo "$mesures" | jq -r '.current.mem // 0')" -gt 0 ] || die "mémoire non mesurée"
[ "$(api "$BASE/api/services/$base/status" | jq -r .state)" = running ] || die "le service n'est pas vu « en ligne »"
systeme="$(api "$BASE/api/system")"
[ "$(echo "$systeme" | jq -r .docker)" != null ] || die "version de Docker inconnue"
[ "$(echo "$systeme" | jq -r '.disk_total // 0')" -gt 0 ] || die "disque non mesuré"
echo "  processeur $(echo "$systeme" | jq -r '.cpu // 0')% — mémoire $(echo "$mesures" | jq -r .current.mem) octets"

bleu "Sauvegarde logique (pg_dump en flux)"
api "$BASE/api/services/$base/backup" -o /tmp/rail-ci-dump.sql
grep -q 'PostgreSQL database dump' /tmp/rail-ci-dump.sql || die "la sauvegarde n'est pas un dump PostgreSQL"
echo "  $(wc -l < /tmp/rail-ci-dump.sql) lignes"

bleu "Arrêt, redémarrage, relance"
api -X POST "$BASE/api/services/$base/stop" >/dev/null
sleep 2
[ "$(docker inspect -f '{{.State.Running}}' "$conteneur")" = false ] || die "le conteneur devait être arrêté"
api -X POST "$BASE/api/services/$base/start" >/dev/null
sleep 3
[ "$(docker inspect -f '{{.State.Running}}' "$conteneur")" = true ] || die "le conteneur devait redémarrer"
api -X POST "$BASE/api/services/$base/restart" >/dev/null
sleep 3
[ "$(docker inspect -f '{{.State.Running}}' "$conteneur")" = true ] || die "le conteneur devait survivre au redémarrage"

bleu "Fil d'activité"
api "$BASE/api/events" | jq -e 'map(.kind) | index("deployment.success")' >/dev/null || die "l'activité ne mentionne pas le déploiement"

bleu "Console SQL : lecture, écriture, refus en lecture seule"
sql() { api -X POST "$BASE/api/services/$base/query" -d "$1"; }
sql '{"sql":"CREATE TABLE preuve(x int)","read_only":false}' | jq -e '.message' >/dev/null || die "CREATE TABLE refusé"
sql '{"sql":"INSERT INTO preuve VALUES (42)","read_only":false}' | jq -e '.message' >/dev/null || die "INSERT refusé"
[ "$(sql '{"sql":"SELECT x FROM preuve"}' | jq -r '.rows[0][0]')" = 42 ] || die "la lecture ne renvoie pas la ligne"
sql '{"sql":"INSERT INTO preuve VALUES (7)"}' | jq -r '.error' | grep -qi 'read-only' || die "une écriture devrait être refusée en lecture seule"
sql '{"sql":"SELECT * FROM nexistepas"}' | jq -r '.error' | grep -qi 'does not exist' || die "l'erreur du moteur devrait remonter"
api "$BASE/api/services/$base/tables" | jq -e '.rows | map(.[1]) | index("preuve")' >/dev/null || die "la table n'est pas listée"
echo "  SELECT, INSERT, refus en lecture seule et liste des tables : tout répond"

bleu "Inventaire : tous les conteneurs de la machine"
inventaire="$(api "$BASE/api/containers")"
echo "$inventaire" | jq -e --arg n "$conteneur" 'map(.name) | index($n)' >/dev/null || die "la base n'est pas dans l'inventaire"
echo "$inventaire" | jq -e --arg n "$CTRL" 'map(select(.name==$n and .control_plane==true)) | length == 1' >/dev/null || die "le plan de contrôle devrait se reconnaître"
[ "$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "authorization: Bearer $TOKEN" "$BASE/api/containers/$CTRL/stop")" = 400 ] \
  || die "le plan de contrôle ne doit pas pouvoir s'arrêter lui-même"
[ "$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "authorization: Bearer $TOKEN" "$BASE/api/containers/$conteneur/stop")" = 400 ] \
  || die "un conteneur géré par Rail doit passer par son service"
echo "  $(echo "$inventaire" | jq 'length') conteneur(s) vus, dont ceux que Rail n'a pas déployés"

bleu "Les données survivent à un redéploiement"
api -X POST "$BASE/api/services/$base/redeploy" >/dev/null
for _ in $(seq 1 90); do
  n="$(api "$BASE/api/services/$base" | jq -r '.active_deployment.number // 0')"
  [ "$n" = 2 ] && break
  sleep 2
done
[ "$n" = 2 ] || die "le redéploiement n'a pas abouti"
[ "$(api -X POST "$BASE/api/services/$base/query" -d '{"sql":"SELECT x FROM preuve"}' | jq -r '.rows[0][0]')" = 42 ] || die "les données du volume sont perdues"
echo "  la ligne insérée avant le redéploiement est toujours là"

bleu "Suppression : conteneur et volume disparaissent"
conteneur2="$(api "$BASE/api/services/$base" | jq -r .active_deployment.container)"
api -X DELETE "$BASE/api/services/$base" >/dev/null
sleep 2
if docker inspect "$conteneur2" >/dev/null 2>&1; then die "le conteneur est resté"; fi
if docker volume inspect "rail-vol-$base" >/dev/null 2>&1; then die "le volume est resté"; fi

printf '\n\033[32mTout est passé : le plan de contrôle déploie, mesure, sauvegarde et nettoie pour de vrai.\033[0m\n'
