#!/usr/bin/env bash
# =====================================================================
# compte-tunnel-ci.sh — le compte SSH qui sert UNIQUEMENT de tunnel vers
# l'API Kubernetes, pour GitHub Actions.
#
#   sudo plateforme/amorcage/compte-tunnel-ci.sh [--hote 197.153.58.171]
#
# La clé est posée BRIDÉE :
#   restrict                      plus rien : ni shell, ni pty, ni agent, ni X11…
#   port-forwarding               … sauf la redirection de port,
#   permitopen="127.0.0.1:6443"   … et vers cette seule destination ;
#   command="/bin/false"          si quelqu'un demande un shell : non.
# Le pipeline fait :  ssh -N -L 6443:127.0.0.1:6443 tunnel-ci@serveur
#
# Comme pour `infra creer`, la clé privée est AFFICHÉE UNE FOIS et n'est
# gardée nulle part sur le serveur. La rejouer = une nouvelle clé (rotation).
# =====================================================================
set -euo pipefail
COMPTE=tunnel-ci
HOTE="$(hostname -I | awk '{print $1}')"
while [ $# -gt 0 ]; do
  case "$1" in
    --hote) HOTE="${2:?}"; shift 2 ;;
    *) echo "option inconnue : $1" >&2; exit 1 ;;
  esac
done
[ "$(id -u)" = 0 ] || { echo "à lancer en root" >&2; exit 1; }

if ! id "$COMPTE" >/dev/null 2>&1; then
  useradd --system --create-home --home-dir /var/lib/$COMPTE --shell /usr/sbin/nologin "$COMPTE"
fi
passwd -l "$COMPTE" >/dev/null 2>&1 || true

tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
ssh-keygen -q -t ed25519 -N "" -C "github-actions-tunnel@$(hostname)" -f "$tmp/cle"
install -d -m 0700 -o "$COMPTE" -g "$COMPTE" /var/lib/$COMPTE/.ssh
printf 'restrict,port-forwarding,permitopen="127.0.0.1:6443",command="/bin/false" %s\n' "$(cat "$tmp/cle.pub")" \
  > /var/lib/$COMPTE/.ssh/authorized_keys
chown "$COMPTE:$COMPTE" /var/lib/$COMPTE/.ssh/authorized_keys
chmod 0600 /var/lib/$COMPTE/.ssh/authorized_keys

# sshd doit permettre la redirection pour ce compte (AllowTcpForwarding).
if sshd -T 2>/dev/null | grep -qi '^allowtcpforwarding no'; then
  cat > /etc/ssh/sshd_config.d/50-tunnel-ci.conf <<CONF
Match User $COMPTE
    AllowTcpForwarding local
    PermitOpen 127.0.0.1:6443
    X11Forwarding no
    PermitTTY no
# Referme le bloc Match : ce qui suit l'Include reste global.
Match all
CONF
  sshd -t && systemctl reload ssh
fi

cat <<TXT

  Secrets GitHub (dépôt Infra-server → Settings → Secrets and variables → Actions) :

  PLATEFORME_SSH_HOST          $HOTE
  PLATEFORME_SSH_USER          $COMPTE
  PLATEFORME_SSH_KNOWN_HOSTS   $HOTE $(awk '{print $1" "$2}' /etc/ssh/ssh_host_ed25519_key.pub)
  PLATEFORME_SSH_KEY           (ci-dessous, en entier, lignes BEGIN/END comprises)

TXT
cat "$tmp/cle"
echo
echo "  Cette clé n'est gardée nulle part sur le serveur."
