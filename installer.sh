#!/usr/bin/env bash
# =====================================================================
# installer.sh — pose « infra » sur le serveur, puis le prépare.
#
#   sudo ./installer.sh [--hote <IP publique>] [--installer-paquets]
#
# À lancer depuis une copie de ce dépôt SUR LE SERVEUR (le serveur ne connaît
# pas GitHub : on la lui apporte —  outils/pousser-sur-serveur.sh admin@IP).
#
#   /opt/infra/                 bin/ lib/ modeles/ VERSION  — root, 0755
#   /usr/local/bin/infra        → /opt/infra/bin/infra
#   /usr/local/bin/infra-ssh    la commande forcée des clés de pipeline
#
# Rejouable : une version plus récente remplace l'ancienne en bloc (copie
# dans un répertoire neuf, puis bascule). Les fiches, secrets, états et
# prises (/etc/infra, /var/lib/infra, /var/backups/infra) ne sont jamais
# touchés par une réinstallation.
# =====================================================================
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "à lancer en root : sudo $0 $*" >&2; exit 1; }
ici="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
cible=/opt/infra
version="$(cat "$ici/VERSION")"

for f in bin/infra bin/infra-ssh lib/commun.sh modeles/nginx/proxy.conf.gabarit VERSION; do
  [ -f "$ici/$f" ] || { echo "copie incomplète : $f manque dans $ici" >&2; exit 1; }
done
for f in "$ici"/bin/* "$ici"/lib/*.sh "$ici/installer.sh"; do
  bash -n "$f" || { echo "$f ne se lit pas (bash -n) : rien n'est posé." >&2; exit 1; }
done

neuf="$cible.neuf.$$"
rm -rf "$neuf"; install -d -m 0755 "$neuf"
cp -r "$ici/bin" "$ici/lib" "$ici/modeles" "$ici/VERSION" "$neuf/"
chown -R root:root "$neuf"; chmod -R go-w "$neuf"; chmod 0755 "$neuf"/bin/*
if [ -d "$cible" ]; then rm -rf "$cible.ancien"; mv "$cible" "$cible.ancien"; fi
mv "$neuf" "$cible"
rm -rf "$cible.ancien"
ln -sfn "$cible/bin/infra" /usr/local/bin/infra
install -m 0755 -o root -g root "$cible/bin/infra-ssh" /usr/local/bin/infra-ssh
echo "  ✓ infra $version posé dans $cible (/usr/local/bin/infra, /usr/local/bin/infra-ssh)"

exec /usr/local/bin/infra preparer "$@"
