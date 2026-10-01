#!/usr/bin/env bash
# =====================================================================
# brancher-nginx.sh — fait passer un nom public du nginx de l'hôte vers
# Traefik (mode coexistence).
#
#   sudo plateforme/amorcage/brancher-nginx.sh pilotage.sbp.ma
#   sudo plateforme/amorcage/brancher-nginx.sh --retirer pilotage.sbp.ma
#
# Mêmes règles que `infra porte` : verrou nginx partagé avec infra,
# `nginx -t` AVANT le reload, et l'ANCIEN bloc remis si le nouveau est
# refusé. Le nginx est partagé : un bloc faux ferait tomber tous les sites.
#
# ⚠ Si le nom est encore servi par `infra` (bloc /etc/nginx/conf.d/<app>.conf),
#   nginx refusera deux server_name identiques : retirer d'abord l'ancienne
#   porte (docs/plateforme/09-migration.md, étape « bascule »).
# =====================================================================
set -euo pipefail
ICI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TRAEFIK="${TRAEFIK:-10.43.0.80:80}"     # = traefik_ip_service dans terraform.tfvars
RETIRER=0
[ "${1:-}" = --retirer ] && { RETIRER=1; shift; }
nom="${1:-}"
[[ "$nom" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$ ]] \
  || { echo "usage : $0 [--retirer] <nom.public.tld>" >&2; exit 1; }
[ "$(id -u)" = 0 ] || { echo "à lancer en root" >&2; exit 1; }

cible="/etc/nginx/conf.d/k8s-$nom.conf"
install -d -m 0755 /var/lib/infra
exec 7>/var/lib/infra/.nginx.verrou
flock -w 120 7 || { echo "nginx est tenu par un autre passage" >&2; exit 1; }

ancien=""
if [ -f "$cible" ]; then ancien="$(mktemp)"; cp -a "$cible" "$ancien"; fi
remettre() {
  if [ -n "$ancien" ]; then mv "$ancien" "$cible"; else rm -f "$cible"; fi
  nginx -t >/dev/null 2>&1 && systemctl reload nginx
}

if [ "$RETIRER" = 1 ]; then
  rm -f "$cible"
else
  [ -f "/etc/letsencrypt/live/$nom/fullchain.pem" ] \
    || { echo "  ✗ pas de certificat pour $nom :  sudo certbot certonly --nginx -d $nom" >&2; exit 1; }
  sed -e "s|__NOM__|$nom|g" -e "s|__TRAEFIK__|$TRAEFIK|g" "$ICI/nginx/pont-k8s.conf.gabarit" > "$cible.nouveau"
  mv "$cible.nouveau" "$cible"
fi

sortie="$(mktemp)"
if ! nginx -t 2>"$sortie"; then
  cat "$sortie" >&2; rm -f "$sortie"
  remettre
  echo "  ✗ nginx -t refuse le bloc : l'ancien est remis." >&2
  exit 1
fi
rm -f "$sortie" "$ancien"
systemctl reload nginx

if [ "$RETIRER" = 1 ]; then
  echo "  ✓ $nom ne passe plus par Traefik"
  exit 0
fi
# nginx recharge en différé : on réessaie (leçon apprise, cf. AUDIT.md).
for _ in $(seq 1 15); do
  if curl -sS -o /dev/null --resolve "$nom:443:127.0.0.1" -D - "https://$nom/" 2>/dev/null | grep -qi '^x-infra-voie: k8s'; then
    echo "  ✓ https://$nom/ → Traefik"
    exit 0
  fi
  sleep 1
done
echo "  ~ bloc posé, mais https://$nom/ ne répond pas encore par Traefik :" >&2
echo "    kubectl -n traefik logs deploy/traefik ; kubectl get ingress -A" >&2
exit 1
