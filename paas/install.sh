#!/usr/bin/env bash
# =====================================================================
# paas/install.sh — installe Rail sur ce serveur (Debian/Ubuntu, root).
#
#   sudo ./install.sh                         interactif : domaine et courriel demandés
#   sudo RAIL_DOMAIN=apps.exemple.com RAIL_ACME_EMAIL=moi@exemple.com ./install.sh
#
# Les ports 80 et 443 sont déjà pris (nginx…) ? Rail s'installe à côté :
#   sudo RAIL_TLS=proxy RAIL_HTTP_PORT=8080 ./install.sh      nginx garde le HTTPS, Rail est derrière
#   sudo RAIL_TLS=dns RAIL_HTTP_PORT=8080 RAIL_HTTPS_PORT=8443 ./install.sh   certificat par DNS-01
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

# ── Mode TLS et ports : ce que Rail va publier sur la machine ────────────
lire_env() { [ -f .env ] && sed -n "s/^$1=//p" .env | tail -1; }
mode="${RAIL_TLS:-$(lire_env RAIL_TLS)}"; mode="${mode:-acme}"
http_port="${RAIL_HTTP_PORT:-$(lire_env RAIL_HTTP_PORT)}"; http_port="${http_port:-80}"
https_port="${RAIL_HTTPS_PORT:-$(lire_env RAIL_HTTPS_PORT)}"; https_port="${https_port:-443}"
dns_provider="${RAIL_ACME_DNS_PROVIDER:-$(lire_env RAIL_ACME_DNS_PROVIDER)}"
case "$mode" in
  acme|dns|proxy) ;;
  *) die "RAIL_TLS doit valoir acme, dns ou proxy (reçu : $mode)" ;;
esac
# En mode proxy, le 443 ne sort pas de la machine : c'est le serveur de devant qui l'a.
if [ "$mode" = proxy ]; then
  [ "$https_port" = 443 ] && https_port=8443
  bind_tls=127.0.0.1
else
  bind_tls="${RAIL_BIND_TLS:-$(lire_env RAIL_BIND_TLS)}"
fi
[ "$mode" = dns ] && [ -z "$dns_provider" ] && die "RAIL_TLS=dns demande RAIL_ACME_DNS_PROVIDER (cloudflare, ovh…) et ses identifiants dans .env.dns"

# Les ports que Rail va prendre doivent être libres.
busy() { ss -ltnH "( sport = :$1 )" 2>/dev/null | grep -q . ; }
if ! docker ps --format '{{.Names}}' | grep -q '^rail-traefik'; then
  a_tester="$http_port"
  [ "$mode" != proxy ] && a_tester="$http_port $https_port"
  for p in $a_tester; do
    if busy "$p"; then
      printf 'install : le port %s est déjà utilisé sur cette machine.\n\n' "$p" >&2
      if [ "$mode" = acme ]; then
        cat >&2 <<'AIDE'
Trois façons de s'en sortir :

  1. Libérer le 80 et le 443 (si nginx ne sert plus) :
       systemctl disable --now nginx

  2. Laisser le serveur de devant faire le HTTPS, et mettre Rail derrière :
       sudo RAIL_TLS=proxy RAIL_HTTP_PORT=8080 ./install.sh
     (ce script affichera le bloc nginx à copier)

  3. Donner à Rail des ports à lui, avec un certificat par DNS-01 :
       sudo RAIL_TLS=dns RAIL_HTTP_PORT=8080 RAIL_HTTPS_PORT=8443 \
            RAIL_ACME_DNS_PROVIDER=cloudflare ./install.sh

Ou lui donner une IP à lui : RAIL_BIND=<ip> dans .env.
AIDE
      fi
      exit 1
    fi
  done
fi

if [ ! -f .env ]; then
  domain="${RAIL_DOMAIN:-}"; email="${RAIL_ACME_EMAIL:-}"
  [ -n "$domain" ] || read -r -p "Domaine de base (ex. apps.exemple.com) : " domain
  [ -n "$email" ]  || read -r -p "Courriel pour Let's Encrypt : " email
  [[ "$domain" =~ ^([a-z0-9-]+\.)+[a-z]{2,}$ ]] || die "domaine invalide : $domain"
  [[ "$email" == *@*.* ]] || die "courriel invalide : $email"
  # Le compte avec lequel on se connectera au tableau de bord : identifiant et
  # mot de passe. Le mot de passe se tire tout seul si on n'en propose pas.
  admin_login="${RAIL_ADMIN_LOGIN:-}"
  [ -n "$admin_login" ] || read -r -p "Identifiant du compte administrateur [admin] : " admin_login
  admin_login="${admin_login:-admin}"
  [[ "$admin_login" =~ ^[a-z0-9][a-z0-9._-]{1,30}$ ]] || die "identifiant invalide : $admin_login (minuscules, chiffres, point, tiret)"
  admin_password="${RAIL_ADMIN_PASSWORD:-}"
  if [ -z "$admin_password" ]; then
    read -r -s -p "Mot de passe (vide = un mot de passe sera tiré au sort) : " admin_password; echo
  fi
  if [ -z "$admin_password" ]; then
    admin_password="$(openssl rand -base64 18 | tr -d '\n=+/')"
    mdp_tire=1
  fi
  [ "${#admin_password}" -ge 10 ] || die "le mot de passe doit faire au moins 10 caractères"
  umask 077
  sed -e "s|^RAIL_DOMAIN=.*|RAIL_DOMAIN=$domain|" \
      -e "s|^RAIL_ACME_EMAIL=.*|RAIL_ACME_EMAIL=$email|" \
      -e "s|^RAIL_ADMIN_TOKEN=.*|RAIL_ADMIN_TOKEN=$(openssl rand -base64 36 | tr -d '\n=+/' )|" \
      -e "s|^RAIL_SECRET_KEY=.*|RAIL_SECRET_KEY=$(openssl rand -hex 32)|" \
      .env.example > .env
  printf 'RAIL_ADMIN_LOGIN=%s\nRAIL_ADMIN_PASSWORD=%s\n' "$admin_login" "$admin_password" >> .env
  created=1
fi
chmod 600 .env

# Les réglages de ports et de TLS sont réécrits à chaque passage : ce sont eux qui
# décident de la configuration de Traefik juste en dessous.
poser() {
  if grep -q "^$1=" .env; then sed -i "s|^$1=.*|$1=$2|" .env; else printf '%s=%s\n' "$1" "$2" >> .env; fi
}
poser RAIL_TLS "$mode"
poser RAIL_HTTP_PORT "$http_port"
poser RAIL_HTTPS_PORT "$https_port"
[ -n "${bind_tls:-}" ] && poser RAIL_BIND_TLS "$bind_tls"
[ -n "${dns_provider:-}" ] && poser RAIL_ACME_DNS_PROVIDER "$dns_provider"
if [ "$mode" = proxy ]; then poser RAIL_SITE_SCHEME "${RAIL_SITE_SCHEME:-https}"; poser RAIL_SITE_PORT "${RAIL_SITE_PORT:-443}"; fi

# Identifiants du fournisseur DNS (mode dns) : un fichier à part, jamais le .env de Rail.
if [ ! -f .env.dns ]; then
  umask 077
  printf '# Identifiants du fournisseur DNS pour RAIL_TLS=dns. Exemple Cloudflare :\n# CF_DNS_API_TOKEN=...\n' > .env.dns
fi
chmod 600 .env.dns

# ── Configuration statique de Traefik, engendrée d'après le mode ─────────
email_acme="$(sed -n 's/^RAIL_ACME_EMAIL=//p' .env | tail -1)"
{
  printf '# Engendré par install.sh — mode TLS : %s. Ne pas éditer : il sera réécrit.\n' "$mode"
  cat <<'TETE'
global:
  checkNewVersion: false
  sendAnonymousUsage: false
accessLog: {}
log:
  level: INFO
entryPoints:
TETE
  if [ "$mode" = proxy ]; then
    printf '  web:\n    address: ":80"\n'
  else
    printf '  web:\n    address: ":80"\n    http:\n      redirections:\n        entryPoint:\n          to: websecure\n          scheme: https\n'
    [ "$https_port" != 443 ] && printf '          port: "%s"\n' "$https_port"
    printf '  websecure:\n    address: ":443"\n'
  fi
  cat <<'PROV'
providers:
  file:
    # Les routes sont des fichiers que le plan de contrôle écrit : Traefik n'a PAS le socket docker.
    directory: /data/traefik/dynamic
    watch: true
PROV
  if [ "$mode" != proxy ]; then
    printf 'certificatesResolvers:\n  le:\n    acme:\n      email: %s\n      storage: /letsencrypt/acme.json\n' "$email_acme"
    if [ "$mode" = dns ]; then
      printf '      dnsChallenge:\n        provider: %s\n' "$dns_provider"
    else
      printf '      httpChallenge:\n        entryPoint: web\n'
    fi
  fi
} > traefik.local.yml
chmod 644 traefik.local.yml

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
# L'adresse publique dépend du mode : port sous-entendu quand c'est celui du schéma.
suffixe=""
case "$mode" in
  proxy) url="https://$dash" ;;
  *) [ "$https_port" != 443 ] && suffixe=":$https_port"; url="https://$dash$suffixe" ;;
esac
echo
echo "Rail est installé."
case "$mode" in
  acme) echo "  Mode TLS        : Let's Encrypt (HTTP-01), Rail tient les ports $http_port et $https_port" ;;
  dns)  echo "  Mode TLS        : Let's Encrypt (DNS-01, $dns_provider) — identifiants à mettre dans .env.dns puis « docker compose up -d »" ;;
  proxy) echo "  Mode TLS        : aucun ici — Rail écoute en clair sur le port $http_port, le HTTPS est à votre serveur de devant" ;;
esac
echo "  Tableau de bord : $url   (le certificat arrive en quelques secondes si le DNS est en place)"
compte="$(sed -n 's/^RAIL_ADMIN_LOGIN=//p' .env | tail -1)"
if [ -n "$compte" ]; then
  echo "  Connexion       : $compte / $(sed -n 's/^RAIL_ADMIN_PASSWORD=//p' .env | tail -1)"
fi
echo "  Jeton de secours: $(sed -n 's/^RAIL_ADMIN_TOKEN=//p' .env | tail -1)   (API, CLI, et création du premier compte)"
echo "  DNS requis      : *.${domain}  et  ${dash}  →  l'adresse IP de ce serveur"
if [ "$mode" = proxy ]; then
  cat <<NGINX

  À copier dans votre nginx (un bloc pour le tableau de bord, un pour les services) :

    server {
      listen 443 ssl;
      server_name ${dash} *.${domain};
      # ssl_certificate … (vos certificats, par exemple ceux de certbot)
      location / {
        proxy_pass http://127.0.0.1:${http_port};
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 1h;   # les journaux en direct sont des réponses longues
      }
    }

  (un certificat joker « *.${domain} » évite d'en demander un par service)
NGINX
fi
echo
echo "  Se connecter     : tableau de bord → identifiant et mot de passe ci-dessus (à changer dans « Mon compte »)"
echo "  Déployer         : Nouveau projet → + Service → choisir un dépôt GitHub dans la liste (reliez votre compte GitHub), ou une image Docker"
echo "  En un clic       : page Catalogue → n8n, Ghost, WordPress, Metabase, Umami, Uptime Kuma, Gitea, MinIO, Grafana…"
echo "  Base de données  : + Base de données (PostgreSQL, MySQL, MariaDB, Redis, Valkey, MongoDB, ClickHouse, Meilisearch, RabbitMQ)"
echo "                     branchée dans un service par \${{nom.DATABASE_URL}}"
echo "  Environnements   : un projet a « production » ; dupliquez-le en « preprod » depuis sa page"
echo "  Tâches planifiées: + Tâche planifiée (cron), avec historique des exécutions"
echo "  Sauvegardes      : onglet Sauvegardes d'une base (manuelles, planifiées, restauration)"
echo "  Requêter         : onglet Requêtes d'une base (SQL, lecture seule par défaut) ou « rail sql projet/base \"SELECT 1\" »"
echo "  Surveiller       : onglet Aperçu d'un service, page Conteneurs (tout ce que Docker fait tourner ici) et page Système"
echo "  Comptes          : page Comptes — lecteur (regarde), membre (déploie), administrateur (tout)"
echo "  Alertes          : renseignez RAIL_NOTIFY_URL dans .env (Slack, Discord ou votre webhook), puis relancez ce script"
echo "  Sauvegarde       : sudo ./sauvegarde.sh    (à mettre en cron : 15 3 * * *  cd $PWD && ./sauvegarde.sh)"
if [ "${created:-0}" = 1 ]; then
  echo "  Gardez .env ailleurs (surtout RAIL_SECRET_KEY) : sans elle, les variables chiffrées sont perdues."
  [ "${mdp_tire:-0}" = 1 ] && echo "  Le mot de passe ci-dessus a été tiré au sort : notez-le, puis changez-le depuis « Mon compte »."
  echo "  Le compte est créé : vous pouvez retirer RAIL_ADMIN_PASSWORD de .env (il ne sert plus qu'au premier démarrage)."
fi
exit 0
