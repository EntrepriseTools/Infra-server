# shellcheck shell=bash
# =====================================================================
# lib/registre.sh — les DEUX fichiers qui décrivent une application.
#
#   /etc/infra/apps/<app>.conf     la FICHE SERVEUR   (root, écrite par
#                                  `infra creer`, réglée par `infra regler`)
#       ce qui dépend de CE serveur : le compte, le port, l'adresse publique,
#       la base, l'heure de la sauvegarde. Rien de tout cela n'est dans git.
#
#   deploiement/app.conf           le MANIFESTE        (versionné dans le
#                                  dépôt de l'application, livré à chaque
#                                  déploiement)
#       ce qui dépend du CODE : l'image, le nom du service, les chemins à
#       sonder, les volumes, les variables que l'application lit.
#
# Le manifeste arrive par le pipeline, donc d'un compte non root : il est
# VALIDÉ clé par clé, puis sa copie acceptée est rangée en
# /var/lib/infra/<app>/app.conf (root). Les verbes qui tournent hors
# déploiement (etat, porte, revenir…) ne lisent que cette copie-là.
# =====================================================================

fiche_de()     { printf '%s/apps/%s.conf' "$ETC_INFRA" "$1"; }
secrets_de()   { printf '%s/%s.env' "$SECRETS_DIR" "$1"; }
manifeste_de() { printf '%s/%s/app.conf' "$VAR_INFRA" "$1"; }
compose_de()   { printf '%s/%s/docker-compose.yml' "$VAR_INFRA" "$1"; }

applications() {
  local f
  for f in "$ETC_INFRA"/apps/*.conf; do
    [ -e "$f" ] || continue
    basename "$f" .conf
  done
}

# ------------------------------------------------------------------ fiche
# Remplit A_* depuis la fiche serveur, et refuse ce qui ne se valide pas.
charger_fiche() {
  local app="$1" f
  valide_app "$app" || mort "nom d'application illisible : « $app » (a-z, 0-9, tiret)."
  f="$(fiche_de "$app")"
  [ -r "$f" ] || mort "« $app » n'est pas enregistrée sur ce serveur ($f absent).
    Les applications connues : $(applications | tr '\n' ' ')
    En créer une :  sudo infra creer $app --manifeste deploiement/app.conf --url https://…"
  A_APP="$app"
  A_COMPTE="$(lire "$f" COMPTE)"
  A_PROJET="$(lire "$f" PROJET)";               A_PROJET="${A_PROJET:-$app}"
  A_PORT="$(lire "$f" PORT)"
  A_URL="$(lire "$f" URL)"
  A_TLS_CERT="$(lire "$f" TLS_CERT)"
  A_TLS_CLE="$(lire "$f" TLS_CLE)"
  A_ACCES_LIMITE="$(lire "$f" ACCES_LIMITE)"
  A_BASE_NOM="$(lire "$f" BASE_NOM)"
  A_BASE_ROLE="$(lire "$f" BASE_ROLE)"
  A_BASE_PORT="$(lire "$f" BASE_PORT)";         A_BASE_PORT="${A_BASE_PORT:-5432}"
  A_FICHIER_NGINX="$(lire "$f" FICHIER_NGINX)"; A_FICHIER_NGINX="${A_FICHIER_NGINX:-$app}"
  A_SAUV_HEURE="$(lire "$f" SAUVEGARDE_HEURE)"; A_SAUV_HEURE="${A_SAUV_HEURE:-21:00}"
  A_SAUV_GARDER="$(lire "$f" SAUVEGARDE_GARDER)"; A_SAUV_GARDER="${A_SAUV_GARDER:-30}"
  A_SAUV_GPG="$(lire "$f" SAUVEGARDE_CLE_GPG)"
  A_GARDER_VERSIONS="$(lire "$f" GARDER_VERSIONS)"; A_GARDER_VERSIONS="${A_GARDER_VERSIONS:-5}"

  valide_compte "$A_COMPTE"  || mort "$f : COMPTE illisible « $A_COMPTE »."
  valide_app "$A_PROJET"     || mort "$f : PROJET illisible « $A_PROJET »."
  valide_port "$A_PORT"      || mort "$f : PORT illisible « $A_PORT »."
  valide_base "$A_BASE_NOM"  || mort "$f : BASE_NOM illisible « $A_BASE_NOM »."
  valide_base "$A_BASE_ROLE" || mort "$f : BASE_ROLE illisible « $A_BASE_ROLE »."
  [[ "$A_BASE_PORT" =~ ^[0-9]{2,5}$ ]] || mort "$f : BASE_PORT illisible « $A_BASE_PORT »."
  valide_app "$A_FICHIER_NGINX" || mort "$f : FICHIER_NGINX illisible « $A_FICHIER_NGINX »."
  valide_heure "$A_SAUV_HEURE"  || mort "$f : SAUVEGARDE_HEURE doit être HH:MM — lu « $A_SAUV_HEURE »."
  [[ "$A_SAUV_GARDER" =~ ^[0-9]+$ ]]     || mort "$f : SAUVEGARDE_GARDER doit être un nombre."
  [[ "$A_GARDER_VERSIONS" =~ ^[0-9]+$ ]] || mort "$f : GARDER_VERSIONS doit être un nombre."
  [ -z "$A_SAUV_GPG" ] || [[ "$A_SAUV_GPG" =~ ^[A-Za-z0-9@._+-]+$ ]] || mort "$f : SAUVEGARDE_CLE_GPG illisible."
  local a; for a in $A_ACCES_LIMITE; do valide_adresse "$a" || mort "$f : ACCES_LIMITE « $a » n'est ni une adresse ni un réseau."; done
  decouper_url
  A_TLS_CERT="${A_TLS_CERT:-/etc/letsencrypt/live/$A_NOM/fullchain.pem}"
  A_TLS_CLE="${A_TLS_CLE:-/etc/letsencrypt/live/$A_NOM/privkey.pem}"
  valide_chemin "$A_TLS_CERT" && valide_chemin "$A_TLS_CLE" || mort "$f : TLS_CERT / TLS_CLE illisibles."
  A_ETAT="$VAR_INFRA/$app"
  A_PRISES="$SAUVEGARDES/$app"
  A_POSE="$NGINX_CONF_D/$A_FICHIER_NGINX.conf"
}

# SCHEMA et NOM depuis l'URL. Les deux découpes se font sur « :// » : sans ce
# séparateur, « http » deviendrait le schéma ET le nom, et nginx accepterait
# « server_name http; » sans broncher — la paie a servi ainsi du 21 au
# 22 septembre 2026, déploiement vert.
decouper_url() {
  case "$A_URL" in
    http://?*|https://?*) : ;;
    *) mort "URL de « $A_APP » : elle doit commencer par http:// ou https:// — lu « $A_URL ».
    La régler :  sudo infra regler $A_APP URL=https://nom.exemple.ma" ;;
  esac
  A_SCHEMA="${A_URL%%://*}"
  A_NOM="${A_URL#*://}"; A_NOM="${A_NOM%%/*}"; A_NOM="${A_NOM%%:*}"
  valide_hote "$A_NOM" || mort "le nom tiré de l'URL n'est pas un nom d'hôte : « $A_NOM »."
}

# -------------------------------------------------------------- manifeste
# Clés connues ; toute autre clé est refusée (une faute de frappe qui
# passerait en silence est pire qu'un refus).
CLES_MANIFESTE="APP IMAGE SERVICE MODE_WEB SONDES SONDE_PUBLIQUE VARIABLE_PORT VARIABLE_ADRESSE
VOLUMES MEMOIRE CORPS_MAX DELAI_PROXY API_PREFIXE BASE_VARIABLES SECRETS VARIABLES_FIXES
VARIABLES_OBLIGATOIRES"

# charger_manifeste FICHIER [APP_ATTENDUE] — remplit M_*.
charger_manifeste() {
  local f="$1" attendue="${2:-}" cle
  fichier_sur "$f" || mort "manifeste absent : $f"
  # Les clés présentes doivent toutes être connues.
  while IFS= read -r cle; do
    [ -n "$cle" ] || continue
    printf '%s\n' $CLES_MANIFESTE | grep -xF "$cle" >/dev/null \
      || mort "manifeste $f : clé inconnue « $cle ». Connues : $(echo $CLES_MANIFESTE)"
  done < <(sed -n 's/^[[:space:]]*\([A-Za-z_][A-Za-z0-9_]*\)[[:space:]]*=.*/\1/p' "$f")

  M_APP="$(lire "$f" APP)"
  M_IMAGE="$(lire "$f" IMAGE)"
  M_SERVICE="$(lire "$f" SERVICE)";           M_SERVICE="${M_SERVICE:-app}"
  M_MODE_WEB="$(lire "$f" MODE_WEB)";         M_MODE_WEB="${M_MODE_WEB:-proxy}"
  M_SONDES="$(lire "$f" SONDES)";             M_SONDES="${M_SONDES:-/}"
  M_SONDE_PUBLIQUE="$(lire "$f" SONDE_PUBLIQUE)"; M_SONDE_PUBLIQUE="${M_SONDE_PUBLIQUE:-/}"
  M_VARIABLE_PORT="$(lire "$f" VARIABLE_PORT)";       M_VARIABLE_PORT="${M_VARIABLE_PORT:-SERVER_PORT}"
  M_VARIABLE_ADRESSE="$(lire "$f" VARIABLE_ADRESSE)"; M_VARIABLE_ADRESSE="${M_VARIABLE_ADRESSE:-SERVER_ADDRESS}"
  M_VOLUMES="$(lire "$f" VOLUMES)"
  M_MEMOIRE="$(lire "$f" MEMOIRE)";           M_MEMOIRE="${M_MEMOIRE:-1g}"
  M_CORPS_MAX="$(lire "$f" CORPS_MAX)";       M_CORPS_MAX="${M_CORPS_MAX:-16m}"
  M_DELAI_PROXY="$(lire "$f" DELAI_PROXY)";   M_DELAI_PROXY="${M_DELAI_PROXY:-120}"
  M_API_PREFIXE="$(lire "$f" API_PREFIXE)";   M_API_PREFIXE="${M_API_PREFIXE:-/api/}"
  M_BASE_VARIABLES="$(lire "$f" BASE_VARIABLES)"
  M_SECRETS="$(lire "$f" SECRETS)"
  M_VARIABLES_FIXES="$(lire "$f" VARIABLES_FIXES)"
  M_VARIABLES_OBLIGATOIRES="$(lire "$f" VARIABLES_OBLIGATOIRES)"

  valide_app "$M_APP" || mort "manifeste : APP illisible « $M_APP »."
  [ -z "$attendue" ] || [ "$M_APP" = "$attendue" ] \
    || mort "manifeste : APP vaut « $M_APP », on attendait « $attendue ». Mauvais dépôt, ou mauvaise clé SSH ?"
  valide_image "$M_IMAGE"    || mort "manifeste : IMAGE illisible « $M_IMAGE » (ex. equipe/app, sans étiquette)."
  valide_app "$M_SERVICE"    || mort "manifeste : SERVICE illisible « $M_SERVICE »."
  case "$M_MODE_WEB" in proxy|spa) : ;; *) mort "manifeste : MODE_WEB vaut proxy ou spa — lu « $M_MODE_WEB »." ;; esac
  local p
  for p in $M_SONDES "$M_SONDE_PUBLIQUE" "$M_API_PREFIXE"; do
    [[ "$p" =~ ^/[A-Za-z0-9._/-]*$ ]] || mort "manifeste : chemin illisible « $p » (SONDES, SONDE_PUBLIQUE, API_PREFIXE)."
  done
  [[ "$M_API_PREFIXE" == */ ]] || mort "manifeste : API_PREFIXE doit finir par « / » (ex. /api/)."
  valide_ident "$M_VARIABLE_PORT"    || mort "manifeste : VARIABLE_PORT illisible."
  valide_ident "$M_VARIABLE_ADRESSE" || mort "manifeste : VARIABLE_ADRESSE illisible."
  valide_taille "$M_MEMOIRE"   || mort "manifeste : MEMOIRE illisible « $M_MEMOIRE » (ex. 1g, 512m)."
  valide_taille "$M_CORPS_MAX" || mort "manifeste : CORPS_MAX illisible « $M_CORPS_MAX » (ex. 12m)."
  [[ "$M_DELAI_PROXY" =~ ^[0-9]{1,4}$ ]] || mort "manifeste : DELAI_PROXY en secondes (ex. 120)."

  # VOLUMES="nom:/chemin/dans/le/conteneur …" — des volumes NOMMÉS seulement.
  # Un montage d'un chemin de l'hôte (« /:/hote ») donnerait l'hôte entier au
  # conteneur : c'est précisément ce que ce contrôle interdit.
  local v nom chemin
  for v in $M_VOLUMES; do
    nom="${v%%:*}"; chemin="${v#*:}"
    [[ "$nom" =~ ^[a-z0-9][a-z0-9_-]*$ ]] && valide_chemin "$chemin" && [ "$chemin" != / ] \
      || mort "manifeste : VOLUMES « $v » — attendu nom:/chemin (volume nommé, jamais un chemin de l'hôte)."
  done
  # VARIABLES_FIXES="CLE=valeur …" — posées dans l'environnement du conteneur.
  # Jetons : @URL@ @NOM@ @HTTPS@ (true/false) @PORT@.
  local kv
  for kv in $M_VARIABLES_FIXES; do
    [[ "$kv" =~ ^[A-Za-z_][A-Za-z0-9_]*=[A-Za-z0-9_./:,@+=-]*$ ]] \
      || mort "manifeste : VARIABLES_FIXES « $kv » — attendu CLE=valeur sans espace ni guillemet."
  done
  for kv in $M_BASE_VARIABLES; do
    [[ "$kv" =~ ^[A-Za-z_][A-Za-z0-9_]*=[A-Za-z0-9_./:,@+=-]*$ ]] \
      || mort "manifeste : BASE_VARIABLES « $kv » — attendu CLE=@JETON@."
  done
  for kv in $M_SECRETS; do
    [[ "$kv" =~ ^[A-Za-z_][A-Za-z0-9_]*=(hex|base64|mdp):[0-9]{1,3}$ ]] \
      || mort "manifeste : SECRETS « $kv » — attendu CLE=hex:32, base64:64 ou mdp:20."
  done
  for kv in $M_VARIABLES_OBLIGATOIRES; do
    valide_ident "$kv" || mort "manifeste : VARIABLES_OBLIGATOIRES « $kv » illisible."
  done
}

# Remplace les jetons d'une valeur de VARIABLES_FIXES.
jetons_fixes() {
  local v="$1" https=false
  [ "$A_SCHEMA" = https ] && https=true
  v="${v//@URL@/$A_URL}"; v="${v//@NOM@/$A_NOM}"; v="${v//@HTTPS@/$https}"; v="${v//@PORT@/$A_PORT}"
  printf '%s' "$v"
}
