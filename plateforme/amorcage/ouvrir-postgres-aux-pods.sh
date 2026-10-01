#!/usr/bin/env bash
# =====================================================================
# ouvrir-postgres-aux-pods.sh — rend le PostgreSQL NATIF joignable depuis
# les pods, et seulement depuis eux.
#
#   sudo plateforme/amorcage/ouvrir-postgres-aux-pods.sh [--adresse IP] [--redemarrer]
#
# La base RESTE sur l'hôte (décision des trois dépôts, gardée ici) : pas de
# PostgreSQL dans Kubernetes, pas de volume de base à perdre avec un
# cluster. Les pods y vont par un Service sans sélecteur (`postgres`,
# posé par Terraform dans chaque espace de noms d'application) qui pointe
# sur l'adresse de l'hôte.
#
# Ce qui change :
#   1. conf.d/90-k8s.conf : listen_addresses = 'localhost,<IP de l'hôte>'
#   2. pg_hba.conf : « host all all 10.42.0.0/16 scram-sha-256 » — un pod
#      doit TOUJOURS donner un mot de passe (jamais trust, jamais peer).
#   3. Le garde nftables (installer-k3s.sh --pare-feu) bloque 5432 depuis
#      l'extérieur. SANS LUI, NE PAS LANCER CE SCRIPT.
#
# listen_addresses ne se recharge pas à chaud : il faut REDÉMARRER
# PostgreSQL, donc couper quelques secondes les applications en place.
# Sans --redemarrer, le script prépare tout et vous dit quand le faire.
# =====================================================================
set -euo pipefail
ADRESSE="$(hostname -I | awk '{print $1}')"
REDEMARRER=0
CIDR_PODS="10.42.0.0/16"
while [ $# -gt 0 ]; do
  case "$1" in
    --adresse) ADRESSE="${2:?}"; shift 2 ;;
    --redemarrer) REDEMARRER=1; shift ;;
    *) echo "option inconnue : $1" >&2; exit 1 ;;
  esac
done
[ "$(id -u)" = 0 ] || { echo "à lancer en root" >&2; exit 1; }
[[ "$ADRESSE" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] || { echo "adresse IPv4 attendue : $ADRESSE" >&2; exit 1; }

if ! nft list table inet k3s_garde >/dev/null 2>&1; then
  echo "  ✗ le garde nftables n'est pas en place : 5432 serait ouvert à Internet." >&2
  echo "    sudo plateforme/amorcage/installer-k3s.sh --pare-feu" >&2
  exit 1
fi

conf_dir="$(runuser -u postgres -- psql -XtAc 'show config_file' | xargs dirname)"
hba="$(runuser -u postgres -- psql -XtAc 'show hba_file')"
[ -d "$conf_dir/conf.d" ] || { echo "conf.d introuvable dans $conf_dir (include_dir attendu, défaut Debian)" >&2; exit 1; }

cat > "$conf_dir/conf.d/90-k8s.conf" <<CONF
# Posé par plateforme/amorcage/ouvrir-postgres-aux-pods.sh
# Les pods joignent la base par l'adresse de l'hôte ; 5432 est fermé vers
# l'extérieur par le garde nftables (table inet k3s_garde).
listen_addresses = 'localhost,$ADRESSE'
CONF
chown postgres:postgres "$conf_dir/conf.d/90-k8s.conf"
echo "  ✓ $conf_dir/conf.d/90-k8s.conf"

marque="# plateforme-k8s : les pods, avec mot de passe"
if ! grep -qF "$marque" "$hba"; then
  cp -a "$hba" "$hba.avant-k8s"
  printf '\n%s\nhost    all    all    %s    scram-sha-256\n' "$marque" "$CIDR_PODS" >> "$hba"
  echo "  ✓ $hba (copie : $hba.avant-k8s)"
else
  echo "  ~ $hba : déjà en place"
fi

runuser -u postgres -- psql -XtAc "select pg_reload_conf()" >/dev/null
# Une ligne pg_hba fautive est ignorée au rechargement, mais SIGNALÉE ici :
erreurs="$(runuser -u postgres -- psql -XtAc "select count(*) from pg_hba_file_rules where error is not null")"
[ "$erreurs" = 0 ] || { echo "  ✗ pg_hba.conf contient $erreurs erreur(s) :  select * from pg_hba_file_rules where error is not null" >&2; exit 1; }

if [ "$REDEMARRER" = 1 ]; then
  systemctl restart postgresql
  sleep 2
  ss -Hltn "( sport = :5432 )" | grep -q "$ADRESSE:5432" \
    && echo "  ✓ PostgreSQL écoute sur $ADRESSE:5432" \
    || { echo "  ✗ PostgreSQL n'écoute pas sur $ADRESSE:5432 :  journalctl -u postgresql -n 50" >&2; exit 1; }
else
  echo "  ~ reste à redémarrer PostgreSQL (coupure de quelques secondes) :"
  echo "      sudo systemctl restart postgresql"
fi
echo "  → dans terraform.tfvars :  adresse_postgres = \"$ADRESSE\""
