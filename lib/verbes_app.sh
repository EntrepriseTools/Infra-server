# shellcheck shell=bash
# =====================================================================
# lib/verbes_app.sh — creer, regler, editer, cle, retirer.
#
# `infra creer` fait, en UNE commande, tout ce que les trois LISEZMOI
# décrivaient en dix à douze étapes manuelles :
#
#   le compte de déploiement  (sans shell interactif utile : sa clé SSH est
#                             bridée sur `infra-ssh <app>`, et son seul droit
#                             root est `infra livrer <app> …`) ;
#   la base et son rôle       (PostgreSQL natif, mot de passe tiré au sort) ;
#   les secrets               (/etc/infra/secrets/<app>.env, root 0600 :
#                             base + secrets tirés au sort + ce qui reste à
#                             remplir, d'après le manifeste) ;
#   la fiche serveur          (/etc/infra/apps/<app>.conf) ;
#   le droit sudo             (/etc/sudoers.d/infra-<app>, éprouvé par visudo) ;
#   le minuteur de sauvegarde (infra-sauvegarde@<app>.timer, heure décalée) ;
#   la clé SSH du pipeline    (affichée UNE fois, pour le secret GitHub).
# =====================================================================

home_de() { getent passwd "$1" | cut -d: -f6; }
serveur_conf() { printf '%s/serveur.conf' "$ETC_INFRA"; }

port_libre() {
  local p=8100 pris
  pris="$(for a in $(applications); do lire "$(fiche_de "$a")" PORT; echo; done)"
  while [ "$p" -lt 8200 ]; do
    if ! printf '%s\n' "$pris" | grep -qxF "$p" && [ -z "$(ecoute_sur_le_port "$p")" ]; then echo "$p"; return 0; fi
    p=$((p + 1))
  done
  mort "aucun port libre entre 8100 et 8199 : --port N"
}

heure_decalee() {   # 21:00, 21:20, 21:40, 22:00… une par application
  local n m; n="$(applications | wc -l)"; m=$(( (21 * 60 + 20 * n) % (24 * 60) ))
  printf '%02d:%02d' $((m / 60)) $((m % 60))
}

poser_minuteur() {  # poser_minuteur APP HEURE
  local d="$SYSTEMD_DIR/infra-sauvegarde@$1.timer.d"
  install -d -m 0755 "$d"
  printf '# Posé par « infra » — SAUVEGARDE_HEURE de la fiche de %s.\n[Timer]\nOnCalendar=\nOnCalendar=*-*-* %s:00\n' "$1" "$2" > "$d/heure.conf"
  systemctl daemon-reload
  systemctl enable --now "infra-sauvegarde@$1.timer" >/dev/null 2>&1 \
    || jaune "minuteur infra-sauvegarde@$1.timer non armé (systemctl) — « infra preparer » a-t-il posé les unités ?"
}

poser_sudoers() {   # poser_sudoers APP COMPTE
  local f="$SUDOERS_D/infra-$1" tmp
  tmp="$(mktemp)"
  {
    printf '# Posé par « infra creer %s » — le SEUL droit root du compte %s.\n' "$1" "$2"
    printf '# Il ne peut que livrer SA version de SON application, et en lire l’état.\n'
    printf '%s ALL=(root) NOPASSWD: %s livrer %s *, %s etat %s, %s historique %s\n' \
      "$2" "$INFRA_BIN" "$1" "$INFRA_BIN" "$1" "$INFRA_BIN" "$1"
  } > "$tmp"
  # Éprouvé AVANT la pose : un sudoers faux verrouille sudo pour tout le monde.
  visudo -cf "$tmp" >/dev/null || { rm -f "$tmp"; mort "le droit sudo engendré ne passe pas visudo — rien n'a été posé."; }
  install -d -m 0750 "$SUDOERS_D"
  install -m 0440 "$tmp" "$f"; rm -f "$tmp"
}

# poser_cle APP COMPTE — (re)tire une paire ed25519, pose la publique bridée,
# affiche la privée UNE fois. Elle n'est gardée nulle part sur ce serveur.
poser_cle() {
  local app="$1" compte="$2" home ak tmpd
  home="$(home_de "$compte")"; [ -n "$home" ] || mort "le compte « $compte » n'a pas de répertoire personnel."
  ak="$home/.ssh/authorized_keys"
  install -d -m 0700 -o "$compte" -g "$(id -gn "$compte")" "$home/.ssh"
  touch "$ak"; chown "$compte:$(id -gn "$compte")" "$ak"; chmod 0600 "$ak"
  tmpd="$(mktemp -d)"
  ssh-keygen -q -t ed25519 -N '' -C "infra:$app" -f "$tmpd/cle" >/dev/null
  grep -v " infra:$app\$" "$ak" > "$ak.tmp" || true
  printf 'restrict,command="%s-ssh %s" %s\n' "$INFRA_BIN" "$app" "$(cat "$tmpd/cle.pub")" >> "$ak.tmp"
  mv -f "$ak.tmp" "$ak"; chown "$compte:$(id -gn "$compte")" "$ak"; chmod 0600 "$ak"
  CLE_PRIVEE="$(cat "$tmpd/cle")"
  rm -rf "$tmpd"
}

afficher_secrets_github() {  # afficher_secrets_github APP COMPTE
  local hote cle_hote
  hote="$(lire "$(serveur_conf)" HOTE_PUBLIC)"; hote="${hote:-<IP_DU_SERVEUR>}"
  cle_hote="$(cut -d' ' -f1,2 "$_P/etc/ssh/ssh_host_ed25519_key.pub" 2>/dev/null || true)"
  titre "À poser dans GitHub — dépôt de « $1 » → Settings → Secrets and variables → Actions"
  info "Secret  INFRA_SSH_HOST         $hote"
  info "Secret  INFRA_SSH_USER         $2"
  info "Secret  INFRA_SSH_KNOWN_HOSTS  $hote ${cle_hote:-<ssh-keyscan -t ed25519 $hote>}"
  info "Secret  INFRA_SSH_KEY          la clé PRIVÉE ci-dessous, en entier (BEGIN … END incluses)"
  printf '\n%s\n\n' "$CLE_PRIVEE"
  jaune "Cette clé n'est gardée NULLE PART sur ce serveur. Perdue : sudo infra cle $1"
}

# ------------------------------------------------------------------ creer
cmd_creer() {
  local app="${1:-}"; shift || true
  exiger_root creer "$app" "$@"
  valide_app "$app" || mort "usage : infra creer <app> --manifeste <app.conf> --url <https://nom> [options] (voir « infra aide »)"
  local manifeste="" url="" port="" compte="" base="" role="" heure="" projet="" fnginx="" secrets_src="" adopter=0 depuis=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --manifeste) manifeste="$2"; shift 2 ;;
      --url) url="$2"; shift 2 ;;
      --port) port="$2"; shift 2 ;;
      --compte) compte="$2"; shift 2 ;;
      --base) base="$2"; shift 2 ;;
      --role) role="$2"; shift 2 ;;
      --heure) heure="$2"; shift 2 ;;
      --projet) projet="$2"; shift 2 ;;
      --fichier-nginx) fnginx="$2"; shift 2 ;;
      --secrets) secrets_src="$2"; shift 2 ;;
      --adopter) adopter=1; shift ;;
      # --depuis <ancien répertoire> : reprend son .env (secrets) et son
      # tag-en-service (la version qui tourne) — sans lui, le premier
      # déploiement sous infra n'aurait AUCUNE version où revenir.
      --depuis) depuis="$2"; adopter=1; shift 2 ;;
      *) mort "option inconnue : $1" ;;
    esac
  done
  [ -n "$manifeste" ] && [ -n "$url" ] || mort "--manifeste et --url sont obligatoires."
  if [ -n "$depuis" ]; then
    [ -d "$depuis" ] || mort "--depuis : $depuis n'est pas un répertoire."
    [ -n "$secrets_src" ] || { [ -f "$depuis/.env" ] && secrets_src="$depuis/.env"; }
  fi
  [ -e "$(fiche_de "$app")" ] && mort "« $app » est déjà enregistrée ($(fiche_de "$app")). La régler : infra regler $app CLE=valeur"
  [ -d "$ETC_INFRA/apps" ] || mort "serveur non préparé :  sudo infra preparer"
  charger_manifeste "$manifeste" "$app"

  compte="${compte:-$app}"; base="${base:-${app//-/_}}"; role="${role:-$base}"
  projet="${projet:-$app}"; fnginx="${fnginx:-$app}"
  port="${port:-$(port_libre)}"; heure="${heure:-$(heure_decalee)}"
  valide_compte "$compte" && valide_base "$base" && valide_base "$role" && valide_app "$projet" && valide_app "$fnginx" \
    || mort "compte, base, rôle, projet ou fichier nginx illisible."
  valide_port "$port" || mort "port illisible : $port"
  valide_heure "$heure" || mort "heure illisible : $heure (HH:MM)"
  A_APP="$app"; A_URL="$url"; decouper_url
  local autre
  for autre in $(applications); do
    [ "$(lire "$(fiche_de "$autre")" PORT)" = "$port" ] && mort "le port $port est déjà celui de « $autre »."
  done

  titre "1 — Le compte de déploiement « $compte »"
  if id "$compte" >/dev/null 2>&1; then
    [ "$adopter" = 1 ] || mort "le compte « $compte » existe déjà. Pour reprendre une application existante : --adopter"
    vert "compte existant repris"
  else
    useradd --system --create-home --home-dir "/home/$compte" --shell /bin/bash "$compte"
    vert "compte système créé (sans mot de passe : il n'entre que par sa clé)"
  fi
  if id -nG "$compte" 2>/dev/null | tr ' ' '\n' | grep -qx docker; then
    jaune "« $compte » est dans le groupe docker : ce n'est plus nécessaire, et c'est un équivalent root."
    info "Le retirer quand l'ancien pipeline est arrêté :  sudo gpasswd -d $compte docker"
  fi

  titre "2 — La base « $base » (rôle « $role »)"
  local mdp="" ROLE_CREE=0
  A_BASE_PORT=5432
  if [ "$adopter" = 1 ] && base_existe "$base"; then
    vert "base existante reprise — rien n'est créé ni modifié"
  else
    mdp="$(tirer_secret mdp:32)"
    creer_role_et_base "$role" "$base" "$mdp"
  fi

  titre "3 — Les secrets"
  install -d -m 0700 "$SECRETS_DIR"
  local s; s="$(secrets_de "$app")"
  if [ -n "$secrets_src" ]; then
    fichier_sur "$secrets_src" || mort "--secrets : $secrets_src absent."
    install -m 0600 -o root -g root "$secrets_src" "$s"
    vert "repris depuis $secrets_src → $s"
  else
    ecrire_secrets "$s" "$role" "$base" "$mdp" "$ROLE_CREE"
  fi

  titre "4 — La fiche serveur"
  install -d -m 0755 "$ETC_INFRA/apps"
  cat > "$(fiche_de "$app")" <<FICHE
# Fiche serveur de « $app » — écrite par « infra creer » le $(horodatage).
# Régler :  sudo infra regler $app CLE=valeur   (validé, puis appliqué)
APP=$app
COMPTE=$compte
PROJET=$projet
PORT=$port
URL=$url
TLS_CERT=
TLS_CLE=
ACCES_LIMITE=
BASE_NOM=$base
BASE_ROLE=$role
BASE_PORT=5432
FICHIER_NGINX=$fnginx
SAUVEGARDE_HEURE=$heure
SAUVEGARDE_GARDER=30
SAUVEGARDE_CLE_GPG=
GARDER_VERSIONS=5
FICHE
  chmod 0644 "$(fiche_de "$app")"
  charger_fiche "$app"
  install -d -m 0755 "$A_ETAT"; install -d -m 0700 "$A_PRISES"
  install -m 0644 "$manifeste" "$(manifeste_de "$app")"
  vert "$(fiche_de "$app") — port $port, $url"
  if [ -n "$depuis" ] && [ -f "$depuis/tag-en-service" ]; then
    local ancien; ancien="$(tr -d '[:space:]' < "$depuis/tag-en-service")"
    if valide_sha "$ancien"; then
      noter_version "$ancien"
      vert "version en service reprise de l'ancien outillage : ${ancien:0:8} (le premier déploiement pourra y revenir)"
      # L'écran servi (mode spa) : sans lui, revenir à cette version n'aurait
      # rien à montrer.
      if [ "$M_MODE_WEB" = spa ] && [ -f "$depuis/frontend/courant/index.html" ]; then
        install -d -m 0755 "$A_ETAT/ecran/versions"
        cp -rL "$depuis/frontend/courant" "$A_ETAT/ecran/versions/$ancien"
        chown -R root:root "$A_ETAT/ecran/versions/$ancien"
        vert "écran en service repris ($depuis/frontend/courant)"
      fi
    fi
  fi

  titre "5 — Le droit sudo, la clé SSH, le minuteur"
  poser_sudoers "$app" "$compte"
  vert "$SUDOERS_D/infra-$app : « infra livrer/etat/historique $app », rien d'autre"
  poser_cle "$app" "$compte"
  vert "clé bridée posée dans ~$compte/.ssh/authorized_keys (command=\"infra-ssh $app\", restrict)"
  poser_minuteur "$app" "$heure"
  vert "infra-sauvegarde@$app.timer — chaque jour à $heure"

  journaliser "$app" "" CREATION "port $port, $url"
  afficher_secrets_github "$app" "$compte"
  titre "Et ensuite"
  info "1. Compléter les secrets si besoin :      sudo infra editer $app"
  [ "$A_SCHEMA" = https ] && info "2. Le certificat (DNS posé AVANT) :      sudo certbot certonly --nginx -d $A_NOM"
  info "3. Pousser sur main : le pipeline livre, « infra » déploie."
  info "4. Vérifier :                            sudo infra etat $app   ·   sudo infra docteur"
}

ecrire_secrets() {  # ecrire_secrets FICHIER ROLE BASE MDP ROLE_CREE
  local s="$1" role="$2" base="$3" mdp="$4" cree="$5" kv cle val a_remplir="" v
  (
    umask 077
    printf '# Secrets de « %s » — %s (root, 0600).\n' "$A_APP" "$s"
    printf '# Passés TELS QUELS au conteneur (env_file). Jamais dans git.\n'
    printf '# Éditer : sudo infra editer %s   puis : sudo infra relancer %s\n' "$A_APP" "$A_APP"
    printf '# Pas d’espace autour du « = », ni « $ » ni guillemets dans les valeurs.\n'
    if [ -n "$M_BASE_VARIABLES" ]; then
      printf '\n# ---- La base (PostgreSQL natif, engendré par infra creer) ----\n'
      [ "$cree" = 1 ] || printf '# ⚠ le rôle existait déjà : son mot de passe est à poser à la main.\n'
      for kv in $M_BASE_VARIABLES; do
        cle="${kv%%=*}"; val="${kv#*=}"
        val="${val//@JDBC@/jdbc:postgresql://127.0.0.1:5432/$base}"
        val="${val//@HOTE@/127.0.0.1}"; val="${val//@PORT_BASE@/5432}"
        val="${val//@BASE@/$base}"; val="${val//@ROLE@/$role}"; val="${val//@MOTDEPASSE@/$mdp}"
        printf '%s=%s\n' "$cle" "$val"
      done
    fi
    if [ -n "$M_SECRETS" ]; then
      printf '\n# ---- Secrets tirés au sort par infra creer ----\n'
      for kv in $M_SECRETS; do printf '%s=%s\n' "${kv%%=*}" "$(tirer_secret "${kv#*=}")"; done
    fi
    printf '\n# ---- À remplir (VARIABLES_OBLIGATOIRES du manifeste) ----\n'
    for v in $M_VARIABLES_OBLIGATOIRES; do
      printf '%s\n' $M_BASE_VARIABLES $M_SECRETS | cut -d= -f1 | grep -qxF "$v" || printf '%s=\n' "$v"
    done
  ) > "$s"
  chown root:root "$s"; chmod 0600 "$s"
  for v in $M_VARIABLES_OBLIGATOIRES; do [ -n "$(lire "$s" "$v")" ] || a_remplir="$a_remplir $v"; done
  vert "$s écrit"
  [ -z "$a_remplir" ] || jaune "à remplir avant le premier déploiement :$a_remplir   (sudo infra editer $A_APP)"
  if printf '%s\n' $M_SECRETS | grep -q '^ADMIN_PASSWORD='; then
    info "Mot de passe administrateur initial : $(lire "$s" ADMIN_PASSWORD)  — le changer à la première connexion."
  fi
}

# ------------------------------------------------------------------ regler
CLES_REGLABLES="URL PORT TLS_CERT TLS_CLE ACCES_LIMITE SAUVEGARDE_HEURE SAUVEGARDE_GARDER SAUVEGARDE_CLE_GPG GARDER_VERSIONS"
cmd_regler() {
  local app="${1:-}"; shift || true
  exiger_root regler "$app" "$@"
  charger_fiche "$app"
  [ $# -gt 0 ] || { titre "Fiche de « $app »"; grep -v '^#' "$(fiche_de "$app")" | sed 's/^/    /'; return 0; }
  local f; f="$(fiche_de "$app")"
  cp -p "$f" "$f.avant"
  local kv cle val
  for kv in "$@"; do
    cle="${kv%%=*}"; val="${kv#*=}"
    [[ "$kv" == *=* ]] || { mv -f "$f.avant" "$f"; mort "attendu CLE=valeur — lu « $kv »"; }
    printf '%s\n' $CLES_REGLABLES | grep -qxF "$cle" || { mv -f "$f.avant" "$f"; mort "« $cle » ne se règle pas. Réglables : $CLES_REGLABLES"; }
    [[ "$val" =~ ^[A-Za-z0-9@._:/\ +-]*$ ]] || { mv -f "$f.avant" "$f"; mort "valeur illisible pour $cle."; }
    ecrire_cle "$f" "$cle" "$val"
  done
  if ! ( charger_fiche "$app" ) >/dev/null 2>"$f.erreur"; then
    cat "$f.erreur" >&2; mv -f "$f.avant" "$f"; rm -f "$f.erreur"; mort "réglage refusé — la fiche est inchangée."
  fi
  rm -f "$f.avant" "$f.erreur"
  charger_fiche "$app"
  vert "fiche de « $app » réglée : $*"
  case " $* " in *" SAUVEGARDE_HEURE="*) poser_minuteur "$app" "$A_SAUV_HEURE"; vert "minuteur à $A_SAUV_HEURE" ;; esac
  case " $* " in *" URL="*|*" PORT="*|*" TLS_"*|*" ACCES_LIMITE="*)
    info "À appliquer :  sudo infra relancer $app   (compose, sondes et porte réengendrés)" ;; esac
  journaliser "$app" "" REGLAGE "$*"
}

cmd_editer() {
  local app="${1:-}"
  exiger_root editer "$@"
  charger_fiche "$app"
  local s; s="$(secrets_de "$app")"
  install -d -m 0700 "$SECRETS_DIR"; [ -e "$s" ] || install -m 0600 /dev/null "$s"
  "${EDITOR:-nano}" "$s"
  chown root:root "$s"; chmod 0600 "$s"
  vert "$s enregistré.  Appliquer :  sudo infra relancer $app"
}

cmd_cle() {
  local app="${1:-}"
  exiger_root cle "$@"
  charger_fiche "$app"
  poser_cle "$app" "$A_COMPTE"
  vert "nouvelle clé posée ; l'ancienne ne passe plus."
  afficher_secrets_github "$app" "$A_COMPTE"
}

# ----------------------------------------------------------------- retirer
# Retire l'application du SERVICE — conteneur, porte, minuteur, droit sudo,
# clé — sans JAMAIS détruire une donnée : base, prises, volumes et secrets
# restent, et on dit comment les retirer si c'est vraiment voulu.
cmd_retirer() {
  local app="${1:-}"
  exiger_root retirer "$@"
  [ "${2:-}" = --confirmer ] && [ "${3:-}" = "$app" ] || mort "usage : infra retirer <app> --confirmer <app>"
  charger_fiche "$app"; verrou_app "$app"
  [ -f "$(manifeste_de "$app")" ] && charger_manifeste "$(manifeste_de "$app")" "$app" && [ -f "$(compose_de "$app")" ] \
    && { compose down >/dev/null 2>&1 || true; vert "conteneur arrêté et retiré (volumes GARDÉS)"; }
  if [ -f "$A_POSE" ]; then
    verrou_nginx; rm -f "$A_POSE"
    nginx -t >/dev/null 2>&1 && systemctl reload nginx && vert "porte nginx retirée"
  fi
  systemctl disable --now "infra-sauvegarde@$app.timer" >/dev/null 2>&1 || true
  rm -rf "$SYSTEMD_DIR/infra-sauvegarde@$app.timer.d"; systemctl daemon-reload || true
  rm -f "$SUDOERS_D/infra-$app"
  local ak; ak="$(home_de "$A_COMPTE")/.ssh/authorized_keys"
  [ -f "$ak" ] && { grep -v " infra:$app\$" "$ak" > "$ak.tmp" || true; mv -f "$ak.tmp" "$ak"; chown "$A_COMPTE" "$ak"; chmod 0600 "$ak"; }
  mv -f "$(fiche_de "$app")" "$ETC_INFRA/apps/.$app.conf.retiree-$(date +%F)"
  vert "« $app » retirée du service"
  journaliser "$app" "" RETRAIT ""
  titre "Ce qui RESTE, volontairement"
  info "base      $A_BASE_NOM   (sudo -u postgres dropdb $A_BASE_NOM   — irréversible)"
  info "prises    $A_PRISES"
  info "secrets   $(secrets_de "$app")"
  info "état      $A_ETAT"
  info "compte    $A_COMPTE   (sudo userdel -r $A_COMPTE)"
}
