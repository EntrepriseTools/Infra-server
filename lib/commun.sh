# shellcheck shell=bash
# =====================================================================
# lib/commun.sh — ce que tous les verbes partagent : affichage, erreurs,
# chemins du système, lecture des fichiers de réglages, validations.
#
# Règle n° 1 de tout ce dossier : un fichier de réglages est LU, jamais
# SOURCÉ. `source .env` exécuterait ce qu'il contient, et une valeur comme
# `X=$(rm -rf /)` deviendrait une commande lancée en root.
# =====================================================================

# ---------------------------------------------------------------- affichage
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  _V=$'\033[32m'; _J=$'\033[33m'; _R=$'\033[31m'; _G=$'\033[1m'; _Z=$'\033[0m'
else
  _V=""; _J=""; _R=""; _G=""; _Z=""
fi
vert()  { printf '%s  ✓%s %s\n' "$_V" "$_Z" "$*"; }
jaune() { printf '%s  ~%s %s\n' "$_J" "$_Z" "$*"; }
rouge() { printf '%s  ✗%s %s\n' "$_R" "$_Z" "$*" >&2; }
info()  { printf '    %s\n' "$*"; }
titre() { printf '\n%s%s%s\n' "$_G" "$*" "$_Z"; }
mort()  { rouge "$*"; exit 1; }

# ---------------------------------------------------------- chemins système
# Tous surchargeables par le BANC seulement (INFRA_BANC=1) : il rejoue les
# verbes dans un répertoire jetable. Appelé par `sudo`, l'environnement est
# remis à zéro (env_reset) — un compte d'application ne peut donc pas
# détourner ces chemins. On le vérifie quand même : ceinture et bretelles.
if [ "${INFRA_BANC:-0}" = 1 ] && [ -n "${SUDO_USER:-}" ] && [ "${SUDO_USER}" != root ]; then
  echo "INFRA_BANC refusé sous sudo." >&2; exit 1
fi
if [ "${INFRA_BANC:-0}" = 1 ]; then
  _P="${INFRA_PREFIXE:?INFRA_PREFIXE obligatoire avec INFRA_BANC=1}"
else
  _P=""
fi
ETC_INFRA="$_P/etc/infra"                  # le registre : une ligne de conduite par application
SECRETS_DIR="$ETC_INFRA/secrets"           # les .env des applications, 0600 root
VAR_INFRA="$_P/var/lib/infra"              # l'état : compose engendré, manifeste accepté, écran…
SAUVEGARDES="$_P/var/backups/infra"        # les prises de base
JOURNAL_DIR="$_P/var/log/infra"            # l'historique des déploiements
NGINX_CONF_D="$_P/etc/nginx/conf.d"
NGINX_SITES="$_P/etc/nginx/sites-enabled"
NGINX_CONF="$_P/etc/nginx/nginx.conf"
SUDOERS_D="$_P/etc/sudoers.d"
SYSTEMD_DIR="$_P/etc/systemd/system"
INFRA_BIN="${INFRA_BIN:-/usr/local/bin/infra}"

# Réglables par le banc (sondes rapides), avec les défauts de production.
SONDE_ESSAIS="${INFRA_SONDE_ESSAIS:-40}"   # 40 × 3 s = deux minutes pour démarrer
SONDE_PAUSE="${INFRA_SONDE_PAUSE:-3}"
PORTE_ESSAIS="${INFRA_PORTE_ESSAIS:-15}"   # nginx recharge en différé : on réessaie
PORTE_PAUSE="${INFRA_PORTE_PAUSE:-1}"
LIVRAISON_MAX="${INFRA_LIVRAISON_MAX:-6442450944}"   # 6 Gio : au-delà, on refuse

est_root() { [ "$(id -u)" = 0 ] || [ "${INFRA_BANC:-0}" = 1 ]; }
exiger_root() { est_root || mort "« infra $1 » se lance en root :  sudo infra $*"; }

# ------------------------------------------------------------- validations
# Chaque valeur qui finit dans un fichier de nginx, de systemd, de sudoers ou
# de compose passe par l'une de ces gardes. Un « ; » dans un nom d'hôte n'y
# serait pas une erreur de syntaxe : ce serait une directive de plus.
valide_app()    { [[ "$1" =~ ^[a-z][a-z0-9-]{1,30}$ ]]; }
valide_sha()    { [[ "$1" =~ ^[0-9a-f]{7,40}$ ]]; }
valide_port()   { [[ "$1" =~ ^[0-9]{2,5}$ ]] && [ "$1" -ge 1024 ] && [ "$1" -le 65535 ]; }
valide_hote()   { [[ "$1" =~ ^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)*$ ]]; }
valide_chemin() { [[ "$1" =~ ^/[A-Za-z0-9._/-]*$ ]] && [[ "$1" != *..* ]]; }
valide_ident()  { [[ "$1" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; }
valide_image()  { [[ "$1" =~ ^[a-z0-9]+([._/-][a-z0-9]+)*$ ]]; }
valide_taille() { [[ "$1" =~ ^[0-9]+[kmgKMG]?$ ]]; }
valide_heure()  { [[ "$1" =~ ^([01][0-9]|2[0-3]):[0-5][0-9]$ ]]; }
valide_compte() { [[ "$1" =~ ^[a-z_][a-z0-9_-]{0,31}$ ]]; }
valide_base()   { [[ "$1" =~ ^[a-z_][a-z0-9_]{0,62}$ ]]; }
valide_adresse(){ [[ "$1" =~ ^[0-9A-Fa-f:./]+$ ]]; }

# ------------------------------------------------------ lecture de réglages
# lire FICHIER CLE — la PREMIÈRE ligne « CLE=… », sans les espaces de fin, le
# CR d'un fichier écrit sous Windows, ni une paire de guillemets encadrants.
# Rien d'autre n'est retiré : un mot de passe à espaces reste entier.
lire() {
  local f="$1" k="$2" v
  v="$(sed -n "s/^[[:space:]]*${k}[[:space:]]*=//p" "$f" 2>/dev/null | head -1)"
  v="${v%$'\r'}"; v="${v%"${v##*[![:space:]]}"}"; v="${v#"${v%%[![:space:]]*}"}"
  case "$v" in \"*\") v="${v#\"}"; v="${v%\"}" ;; \'*\') v="${v#\'}"; v="${v%\'}" ;; esac
  printf '%s' "$v"
}

# ecrire_cle FICHIER CLE VALEUR — remplace la ligne, ou l'ajoute.
ecrire_cle() {
  local f="$1" k="$2" v="$3" tmp
  tmp="$(mktemp "$f.XXXXXX")"
  if grep -qE "^[[:space:]]*${k}[[:space:]]*=" "$f" 2>/dev/null; then
    awk -v k="$k" -v v="$v" 'BEGIN{d=0} $0 ~ "^[[:space:]]*"k"[[:space:]]*=" { if(!d){print k"="v; d=1}; next } {print}' "$f" > "$tmp"
  else
    { cat "$f" 2>/dev/null; printf '%s=%s\n' "$k" "$v"; } > "$tmp"
  fi
  chmod --reference="$f" "$tmp" 2>/dev/null || chmod 0600 "$tmp"
  mv -f "$tmp" "$f"
}

# Un fichier que root va lire ne doit pas être un lien : un compte qui le
# remplacerait par un lien vers /etc/shadow ferait lire à root ce qu'il veut.
fichier_sur() {
  local f="$1"
  [ -e "$f" ] || return 1
  [ ! -L "$f" ] && [ -f "$f" ] || mort "$f n'est pas un fichier ordinaire (lien ?) : refusé."
  [ "$(stat -c '%h' "$f")" = 1 ] || mort "$f a plusieurs liens physiques : refusé."
}

# ---------------------------------------------------------------- réseau
# curl rend déjà 000 quand la connexion échoue : pas de `|| echo 000`.
# `--noproxy '*'` : on sonde CE serveur, jamais un mandataire d'environnement.
sonder() {
  local c; c="$(curl -sk --noproxy '*' -o /dev/null -w '%{http_code}' --max-time "${2:-5}" "$1" 2>/dev/null)" || true
  printf '%s' "${c:-000}"
}

# ---------------------------------------------------------------- verrous
# Le verrou vit dans /var/lib/infra (root, 0755), jamais dans /tmp : sous
# Debian 12, `fs.protected_regular=1` interdit — même à root — d'ouvrir dans
# /tmp un fichier appartenant à un autre compte. Mesuré par la paie le
# 15 septembre 2026.
verrou_app() {
  local f="$VAR_INFRA/$1/.verrou"
  install -d -m 0755 "$VAR_INFRA/$1"
  exec 8>"$f"
  flock -n 8 || mort "un autre passage est en cours pour « $1 » ($f)."
}
# nginx est PARTAGÉ : deux applications qui rechargent en même temps se
# marcheraient dessus (le bloc de l'une éprouvé pendant que l'autre le pose).
verrou_nginx() {
  install -d -m 0755 "$VAR_INFRA"
  exec 7>"$VAR_INFRA/.nginx.verrou"
  flock -w 120 7 || mort "nginx est tenu par un autre passage depuis deux minutes."
}

horodatage() { date '+%Y-%m-%d %H:%M:%S'; }
journaliser() {   # journaliser APP SHA RESULTAT MESSAGE
  install -d -m 0755 "$JOURNAL_DIR"
  printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$(horodatage)" "$1" "${2:-—}" "$3" "${SUDO_USER:-$(id -un)}" "${4:-}" \
    >> "$JOURNAL_DIR/deploiements.log"
}

# Un secret aléatoire, dans une forme qui ne casse ni compose ni un .env.
# Formes : hex:N (N octets en hexadécimal), base64:N, mdp:N (N caractères).
tirer_secret() {
  local forme="${1%%:*}" n="${1#*:}"
  [[ "$n" =~ ^[0-9]+$ ]] || n=32
  case "$forme" in
    hex)    openssl rand -hex "$n" ;;
    base64) openssl rand -base64 "$n" | tr -d '\n' ;;
    # Pas de « tr < /dev/urandom | head » : sous `pipefail`, tr meurt sur
    # SIGPIPE (141) et `set -e` emporte le script. On tire assez, puis on coupe.
    mdp)    local s=""; while [ "${#s}" -lt "$n" ]; do s="$s$(openssl rand -base64 64 | tr -dc 'A-Za-z0-9')"; done
            printf '%s' "${s:0:$n}" ;;
    *)      openssl rand -hex "$n" ;;
  esac
}
