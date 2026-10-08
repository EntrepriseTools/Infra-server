#!/usr/bin/env bash
# =====================================================================
# paas/install.sh — installe Rail sur ce serveur (Debian/Ubuntu, root).
#
#   sudo ./install.sh                         interactif : domaine et courriel demandés
#   sudo RAIL_DOMAIN=apps.exemple.com RAIL_ACME_EMAIL=moi@exemple.com ./install.sh
#
# Idempotent : relancé, il garde le .env existant et remet à jour les conteneurs.
# =====================================================================
set -euo pipefail
cd "$(dirname "$0")"

die() { printf 'install : %s\n' "$*" >&2; exit 1; }
[ "$(id -u)" = 0 ] || die "à lancer en root (sudo $0)"
command -v docker >/dev/null || die "Docker n'est pas installé. Installez Docker Engine (https://docs.docker.com/engine/install/) puis relancez."
docker compose version >/dev/null 2>&1 || die "le plugin « docker compose » (v2) est requis"
command -v openssl >/dev/null || die "openssl est requis"

# Les ports 80 et 443 doivent être libres : Traefik les prend (certificats HTTP-01 sur le 80).
busy() { ss -ltnH "( sport = :$1 )" 2>/dev/null | grep -q . ; }
if ! docker ps --format '{{.Names}}' | grep -q '^rail-traefik'; then
  for p in 80 443; do
    busy "$p" && die "le port $p est déjà utilisé (nginx/apache de l'hôte ?). Rail veut le 80 et le 443 : libérez-les, ou donnez-lui une IP à lui (RAIL_BIND dans .env)."
  done
fi

if [ ! -f .env ]; then
  domain="${RAIL_DOMAIN:-}"; email="${RAIL_ACME_EMAIL:-}"
  [ -n "$domain" ] || read -r -p "Domaine de base (ex. apps.exemple.com) : " domain
  [ -n "$email" ]  || read -r -p "Courriel pour Let's Encrypt : " email
  [[ "$domain" =~ ^([a-z0-9-]+\.)+[a-z]{2,}$ ]] || die "domaine invalide : $domain"
  [[ "$email" == *@*.* ]] || die "courriel invalide : $email"
  umask 077
  sed -e "s|^RAIL_DOMAIN=.*|RAIL_DOMAIN=$domain|" \
      -e "s|^RAIL_ACME_EMAIL=.*|RAIL_ACME_EMAIL=$email|" \
      -e "s|^RAIL_ADMIN_TOKEN=.*|RAIL_ADMIN_TOKEN=$(openssl rand -base64 36 | tr -d '\n=+/' )|" \
      -e "s|^RAIL_SECRET_KEY=.*|RAIL_SECRET_KEY=$(openssl rand -hex 32)|" \
      .env.example > .env
  created=1
fi
chmod 600 .env

gid="$(getent group docker | cut -d: -f3 || true)"
[ -n "$gid" ] || die "le groupe « docker » n'existe pas sur cet hôte"
if grep -q '^DOCKER_GID=' .env; then sed -i "s|^DOCKER_GID=.*|DOCKER_GID=$gid|" .env; else echo "DOCKER_GID=$gid" >> .env; fi

docker compose up -d --build --remove-orphans

printf 'Démarrage'
for _ in $(seq 1 60); do
  if [ "$(docker inspect -f '{{.State.Health.Status}}' rail-control 2>/dev/null)" = healthy ]; then ready=1; break; fi
  printf '.'; sleep 2
done
echo
[ "${ready:-0}" = 1 ] || { docker compose logs --tail 40 control; die "le plan de contrôle n'est pas devenu sain"; }

domain="$(sed -n 's/^RAIL_DOMAIN=//p' .env)"
dash="$(sed -n 's/^RAIL_DASHBOARD_HOST=//p' .env)"; dash="${dash:-rail.$domain}"
echo
echo "Rail est installé."
echo "  Tableau de bord : https://$dash   (le certificat arrive en quelques secondes si le DNS est en place)"
echo "  Jeton           : $(sed -n 's/^RAIL_ADMIN_TOKEN=//p' .env)"
echo "  DNS requis      : *.${domain}  et  ${dash}  →  l'adresse IP de ce serveur"
[ "${created:-0}" = 1 ] && echo "  Sauvegardez .env (surtout RAIL_SECRET_KEY) : sans elle, les variables chiffrées sont perdues."
exit 0
