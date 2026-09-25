#!/usr/bin/env bash
# =====================================================================
# tests/banc.sh — le banc d'« infra ».
#
# Il lance les VRAIS verbes (bin/infra), dans un répertoire jetable
# (INFRA_BANC=1, INFRA_PREFIXE=…), avec des doubles de docker, PostgreSQL,
# nginx, curl, systemctl… (tests/doubles/) qui notent l'ORDRE des gestes dans
# ordre.log. Il ne lit pas des intentions dans le texte : il vérifie que la
# sauvegarde a PRÉCÉDÉ la relance, que le retour arrière a eu lieu, que
# l'ancien bloc nginx est revenu, etc.
#
#   sudo bash tests/banc.sh          (root : il crée un compte système jetable)
#
# Sort en 0 si tout passe. Chaque contrôle qui tombe est nommé.
# =====================================================================
set -uo pipefail
ICI="$(cd "$(dirname "$0")/.." && pwd)"
[ "$(id -u)" = 0 ] || { echo "le banc crée un compte système : sudo bash $0" >&2; exit 2; }
unset SUDO_USER SUDO_UID SUDO_GID SUDO_COMMAND

BANC="$(mktemp -d)"; export BANC
export INFRA_BANC=1 INFRA_PREFIXE="$BANC/racine" NO_COLOR=1
export INFRA_SONDE_ESSAIS=2 INFRA_SONDE_PAUSE=0 INFRA_PORTE_ESSAIS=2 INFRA_PORTE_PAUSE=0
export PATH="$ICI/tests/doubles:$PATH"
mkdir -p "$INFRA_PREFIXE"/etc/nginx/conf.d "$INFRA_PREFIXE"/etc/nginx/sites-enabled "$INFRA_PREFIXE/etc/ssh"
echo 'http { include /etc/nginx/conf.d/*.conf; }' > "$INFRA_PREFIXE/etc/nginx/nginx.conf"
echo 'ssh-ed25519 AAAAHOTE root@serveur' > "$INFRA_PREFIXE/etc/ssh/ssh_host_ed25519_key.pub"
COMPTE=infrabanc$$
COMPTE=${COMPTE:0:16}
nettoyer() { userdel "$COMPTE" >/dev/null 2>&1 || true; rm -rf "$BANC"; }
trap nettoyer EXIT

INFRA="$ICI/bin/infra"
reussis=0; echecs=0
ok()  { reussis=$((reussis + 1)); printf '  ✓ %s\n' "$1"; }
ko()  { echecs=$((echecs + 1)); printf '  ✗ %s\n' "$1"; [ -n "${2:-}" ] && printf '%s\n' "$2" | tail -15 | sed 's/^/      │ /'; return 0; }
bloc() { printf '\n%s\n' "$1"; : > "$BANC/ordre.log"; }
# avant MOTIF1 MOTIF2 — la première ligne de MOTIF1 précède celle de MOTIF2 dans ordre.log
avant() {
  local a b; a="$(grep -n -m1 -- "$1" "$BANC/ordre.log" | cut -d: -f1)"; b="$(grep -n -m1 -- "$2" "$BANC/ordre.log" | cut -d: -f1)"
  [ -n "$a" ] && [ -n "$b" ] && [ "$a" -lt "$b" ]
}
lancer() { SORTIE="$("$INFRA" "$@" 2>&1)"; STATUT=$?; }
SHA1=1111111111111111111111111111111111111111
SHA2=2222222222222222222222222222222222222222
SHA3=3333333333333333333333333333333333333333

# ---- le manifeste d'essai (mode spa, comme Procurement) ----
MANIF="$BANC/app.conf"
cat > "$MANIF" <<'EOF'
APP=essai
IMAGE=equipe/essai
SERVICE=backend
MODE_WEB=spa
SONDES="/actuator/health"
VARIABLE_PORT=PORT
VARIABLE_ADRESSE=SERVER_ADDRESS
VOLUMES="donnees:/var/lib/essai"
MEMOIRE=512m
BASE_VARIABLES="PGHOST=@HOTE@ PGPORT=@PORT_BASE@ PGDATABASE=@BASE@ PGUSER=@ROLE@ PGPASSWORD=@MOTDEPASSE@"
SECRETS="JWT_SECRET=base64:48 ADMIN_PASSWORD=mdp:20"
VARIABLES_FIXES="CORS_ALLOWED_ORIGINS=@URL@ COOKIE_SECURISE=@HTTPS@"
VARIABLES_OBLIGATOIRES="JWT_SECRET PGPASSWORD"
EOF

# livraison SHA [ko] [manifeste] — fabrique l'archive que pousse le pipeline.
livraison() {
  local sha="$1" d="$BANC/liv-$1"; rm -rf "$d"; mkdir -p "$d/ecran"
  cp "${3:-$MANIF}" "$d/app.conf"
  printf 'equipe/essai:%s\n' "$sha" | gzip > "$d/image.tar.gz"
  echo "<html>$sha</html>" > "$d/ecran/index.html"
  tar -czf "$d/frontend.tar.gz" -C "$d/ecran" .
  [ "${2:-}" = ko ] && { mkdir -p "$BANC/ko"; touch "$BANC/ko/$sha"; }
  tar -cf "$d.tar" -C "$d" app.conf image.tar.gz frontend.tar.gz
  printf '%s' "$d.tar"
}
livrer() { local t; t="$(livraison "$@")"; SORTIE="$("$INFRA" livrer essai "$1" < "$t" 2>&1)"; STATUT=$?; }
en_service() { cat "$INFRA_PREFIXE/var/lib/infra/essai/en-service" 2>/dev/null; }

# ======================================================================
bloc "1. preparer"
lancer preparer --hote 203.0.113.10
[ "$STATUT" = 0 ] && ok "preparer rend 0" || ko "preparer rend $STATUT" "$SORTIE"
[ -f "$INFRA_PREFIXE/etc/systemd/system/infra-sauvegarde@.timer" ] && ok "unités de sauvegarde posées" || ko "unités absentes"
[ "$(stat -c %a "$INFRA_PREFIXE/etc/infra/secrets")" = 700 ] && ok "secrets en 0700" || ko "secrets pas en 0700"

bloc "2. creer"
lancer creer essai --manifeste "$MANIF" --url http://essai.exemple.ma --compte "$COMPTE" --port 8150
[ "$STATUT" = 0 ] && ok "creer rend 0" || ko "creer rend $STATUT" "$SORTIE"
F="$INFRA_PREFIXE/etc/infra/apps/essai.conf"; S="$INFRA_PREFIXE/etc/infra/secrets/essai.env"
grep -q '^PORT=8150$' "$F" && ok "fiche : port" || ko "fiche sans port"
[ "$(stat -c '%U %a' "$S")" = "root 600" ] && ok "secrets root 0600" || ko "secrets mal protégés"
[ -n "$(sed -n 's/^PGPASSWORD=//p' "$S")" ] && ok "mot de passe de base tiré au sort" || ko "PGPASSWORD vide" "$(cat "$S")"
[ "$(sed -n 's/^JWT_SECRET=//p' "$S" | wc -c)" -gt 40 ] && ok "JWT_SECRET tiré au sort" || ko "JWT_SECRET absent"
grep -q '^PGDATABASE=essai$' "$S" && ok "variables de base rendues sous les noms de l'application" || ko "PGDATABASE absent"
[ -f "$BANC/pg/bases/essai" ] && [ -f "$BANC/pg/roles/essai" ] && ok "base et rôle créés" || ko "base/rôle absents"
grep -q "infra livrer essai \*" "$INFRA_PREFIXE/etc/sudoers.d/infra-essai" && ok "sudoers : livrer essai seulement" || ko "sudoers"
grep -q "^restrict,command=\"/usr/local/bin/infra-ssh essai\" ssh-ed25519" "$INFRA_PREFIXE/home/$COMPTE/.ssh/authorized_keys" \
  && ok "clé bridée (restrict + command forcée)" || ko "clé bridée absente"
grep -q 'OnCalendar=\*-\*-\* ' "$INFRA_PREFIXE/etc/systemd/system/infra-sauvegarde@essai.timer.d/heure.conf" && ok "minuteur à son heure" || ko "minuteur"
printf '%s' "$SORTIE" | grep -q 'BEGIN OPENSSH PRIVATE KEY' && ok "clé privée affichée une fois" || ko "clé privée non affichée"
printf '%s' "$SORTIE" | grep -q 'INFRA_SSH_KNOWN_HOSTS  203.0.113.10 ssh-ed25519 AAAAHOTE' && ok "known_hosts prêt à copier" || ko "known_hosts" "$SORTIE"
lancer creer essai --manifeste "$MANIF" --url http://x.ma
[ "$STATUT" != 0 ] && ok "une application ne se crée pas deux fois" || ko "re-création acceptée"
sed 's/^APP=essai/APP=autre/' "$MANIF" > "$BANC/autre.conf"
lancer creer autre --manifeste "$BANC/autre.conf" --url http://autre.ma --port 8150 --compte "$COMPTE" --adopter
[ "$STATUT" != 0 ] && printf '%s' "$SORTIE" | grep -q "8150" && ok "port déjà pris : refusé" || ko "port en double accepté" "$SORTIE"

# ---- l'adoption d'une application existante (--depuis) ----
mkdir -p "$BANC/ancien"; printf 'PGPASSWORD=ancien\nJWT_SECRET=ancienjwt\n' > "$BANC/ancien/.env"
echo "$SHA3" > "$BANC/ancien/tag-en-service"; touch "$BANC/pg/bases/vieille"
mkdir -p "$BANC/ancien/frontend/versions/v"; echo ancien > "$BANC/ancien/frontend/versions/v/index.html"; ln -s "$BANC/ancien/frontend/versions/v" "$BANC/ancien/frontend/courant"
sed 's/^APP=essai/APP=vieille/' "$MANIF" > "$BANC/vieille.conf"
lancer creer vieille --manifeste "$BANC/vieille.conf" --url http://vieille.ma --compte "$COMPTE" --port 8151 --depuis "$BANC/ancien"
[ "$STATUT" = 0 ] && ok "adoption (--depuis) rend 0" || ko "adoption" "$SORTIE"
grep -q '^PGPASSWORD=ancien$' "$INFRA_PREFIXE/etc/infra/secrets/vieille.env" && ok "adoption : secrets repris tels quels" || ko "secrets non repris"
[ "$(cat "$INFRA_PREFIXE/var/lib/infra/vieille/en-service" 2>/dev/null)" = "$SHA3" ] && ok "adoption : version en service reprise (retour arrière possible)" || ko "version non reprise"
grep -q ancien "$INFRA_PREFIXE/var/lib/infra/vieille/ecran/versions/$SHA3/index.html" 2>/dev/null && ok "adoption : écran en service repris" || ko "écran non repris"
[ -f "$BANC/pg/roles/vieille" ] && ko "adoption : un rôle a été créé sur une base existante" || ok "adoption : base existante non touchée"

# Le conteneur de l'ANCIEN outillage tourne (même projet, même service) et
# tient le port : ce n'est pas un étranger, la bascule doit passer.
echo "8151 equipe/essai:$SHA3 backend" > "$BANC/docker/run/vieille"; mkdir -p "$BANC/ecoute"; touch "$BANC/ecoute/8151"
t="$(livraison "$SHA1" "" "$BANC/vieille.conf")"
SORTIE="$("$INFRA" livrer vieille "$SHA1" < "$t" 2>&1)"; STATUT=$?
rm -f "$BANC/ecoute/8151"
[ "$STATUT" = 0 ] && ok "adoption : la bascule passe, le conteneur de l'ancien outillage n'est pas pris pour un étranger" || ko "bascule refusée" "$SORTIE"

bloc "3. livrer une première version"
livrer "$SHA1"
[ "$STATUT" = 0 ] && ok "livrer rend 0" || ko "livrer rend $STATUT" "$SORTIE"
avant "pg_dump essai" "docker compose up" && ok "la sauvegarde PRÉCÈDE la relance" || ko "ordre sauvegarde/relance" "$(cat "$BANC/ordre.log")"
[ "$(en_service)" = "$SHA1" ] && ok "version en service notée" || ko "en-service = $(en_service)"
C="$INFRA_PREFIXE/var/lib/infra/essai/docker-compose.yml"
grep -q 'network_mode: host' "$C" && grep -q 'PORT: "8150"' "$C" && grep -q 'SERVER_ADDRESS: "127.0.0.1"' "$C" \
  && ok "compose engendré : réseau de l'hôte, port et adresse" || ko "compose" "$(cat "$C")"
grep -q 'CORS_ALLOWED_ORIGINS: "http://essai.exemple.ma"' "$C" && grep -q 'COOKIE_SECURISE: "false"' "$C" \
  && ok "jetons @URL@ et @HTTPS@ rendus" || ko "jetons non rendus"
grep -qiE 'privileged|/:/' "$C" && ko "compose privilégié ou montage de l'hôte" || ok "ni privilège ni montage de l'hôte"
grep -q 'no-new-privileges:true' "$C" && ok "no-new-privileges" || ko "no-new-privileges absent"
grep -q "<html>$SHA1</html>" "$INFRA_PREFIXE/var/lib/infra/essai/ecran/courant/index.html" && ok "écran basculé" || ko "écran"
P="$INFRA_PREFIXE/etc/nginx/conf.d/essai.conf"
grep -q 'server_name essai.exemple.ma;' "$P" && grep -q 'X-Infra-App essai' "$P" && ok "porte nginx posée" || ko "porte" "$(cat "$P" 2>/dev/null)"
grep -q '#' "$P" && grep -qE '#HTTPS#|#ACCES#' "$P" && ko "marqueurs de gabarit restés dans le bloc" || ok "gabarit entièrement rendu"
ls "$INFRA_PREFIXE"/var/backups/infra/essai/avant-*.dump >/dev/null 2>&1 && ok "prise d'avant-déploiement gardée" || ko "prise absente"
grep -q "OK" "$INFRA_PREFIXE/var/log/infra/deploiements.log" && ok "historique écrit" || ko "historique"

bloc "4. une version qui ne démarre pas : retour arrière"
livrer "$SHA2" ko
[ "$STATUT" != 0 ] && ok "le passage échoue" || ko "passage vert malgré la sonde rouge" "$SORTIE"
[ "$(en_service)" = "$SHA1" ] && ok "la version en service reste $SHA1" || ko "en-service = $(en_service)"
grep -q "equipe/essai:$SHA1" "$BANC/docker/run/essai" && ok "le conteneur tourne à nouveau sur l'ancienne" || ko "conteneur" "$(cat "$BANC/docker/run/essai")"
grep -q "<html>$SHA1</html>" "$INFRA_PREFIXE/var/lib/infra/essai/ecran/courant/index.html" && ok "l'écran n'a pas bougé" || ko "écran changé malgré l'échec"
printf '%s' "$SORTIE" | grep -q 'RETOUR ARRIÈRE' && ok "le retour arrière est dit" || ko "retour arrière muet"
grep -q "ECHEC" "$INFRA_PREFIXE/var/log/infra/deploiements.log" && ok "échec historisé" || ko "échec non historisé"

bloc "5. relivrer la version en service : on reprend à la porte"
livrer "$SHA1"
[ "$STATUT" = 0 ] && ok "rend 0" || ko "rend $STATUT" "$SORTIE"
printf '%s' "$SORTIE" | grep -q 'tourne déjà' && ok "pas de relance inutile" || ko "relance inutile" "$SORTIE"
grep -q 'docker compose up' "$BANC/ordre.log" && ko "conteneur relancé pour rien" || ok "conteneur non touché"
grep -q 'systemctl reload nginx' "$BANC/ordre.log" && ok "la porte est quand même reposée" || ko "porte non reposée"

bloc "6. la sauvegarde tombe : rien n'est touché"
touch "$BANC/pg_dump_panne"
livrer "$SHA3"
rm -f "$BANC/pg_dump_panne"
[ "$STATUT" != 0 ] && ok "le passage échoue" || ko "passage vert sans sauvegarde"
grep -q 'docker compose up' "$BANC/ordre.log" && ko "RELANCÉ SANS SAUVEGARDE" || ok "aucune relance sans sauvegarde"
[ "$(en_service)" = "$SHA1" ] && ok "version inchangée" || ko "en-service = $(en_service)"

bloc "7. nginx refuse le bloc : l'ancien revient"
echo "# bloc d'avant" > "$BANC/avant.conf"; cp "$P" "$BANC/porte-valide.conf"
sed -i 's/^URL=.*/URL=http:\/\/essai2.exemple.ma/' "$F"
touch "$BANC/nginx_refuse_prochain"
# nginx refusera dès que le bloc neuf est posé : on le simule par le marqueur INVALIDE dans le gabarit rendu
cp "$ICI/modeles/nginx/spa.conf.gabarit" "$BANC/spa.sauve"
echo "# INVALIDE" >> "$ICI/modeles/nginx/spa.conf.gabarit"
lancer porte essai
cp "$BANC/spa.sauve" "$ICI/modeles/nginx/spa.conf.gabarit"
[ "$STATUT" != 0 ] && ok "porte refusée" || ko "porte acceptée malgré nginx -t"
cmp -s "$P" "$BANC/porte-valide.conf" && ok "l'ANCIEN bloc est remis (pas supprimé)" || ko "ancien bloc perdu" "$(cat "$P" 2>/dev/null)"
sed -i 's/^URL=.*/URL=http:\/\/essai.exemple.ma/' "$F"

bloc "8. revenir"
livrer "$SHA3"
[ "$STATUT" = 0 ] && [ "$(en_service)" = "$SHA3" ] && ok "$SHA3 en service" || ko "livraison 3" "$SORTIE"
lancer revenir essai
[ "$STATUT" = 0 ] && [ "$(en_service)" = "$SHA1" ] && ok "revenir remet la précédente ($SHA1)" || ko "revenir" "$SORTIE"
avant "pg_dump essai" "docker compose up" && ok "revenir sauvegarde aussi avant" || ko "revenir sans sauvegarde"

bloc "9. livraisons refusées"
d="$BANC/piege"; rm -rf "$d"; mkdir -p "$d"; cp "$MANIF" "$d/app.conf"; ln -s /etc/shadow "$d/image.tar.gz"
tar -cf "$d.tar" -C "$d" app.conf image.tar.gz
SORTIE="$("$INFRA" livrer essai "$SHA2" < "$d.tar" 2>&1)"; STATUT=$?
[ "$STATUT" != 0 ] && printf '%s' "$SORTIE" | grep -q "pas un fichier ordinaire" && ok "lien symbolique dans la livraison : refusé" || ko "lien accepté" "$SORTIE"
rm -f "$d/image.tar.gz"; echo x > "$d/autre.sh"; tar -cf "$d.tar" -C "$d" app.conf autre.sh
SORTIE="$("$INFRA" livrer essai "$SHA2" < "$d.tar" 2>&1)"; STATUT=$?
[ "$STATUT" != 0 ] && printf '%s' "$SORTIE" | grep -q "inattendu" && ok "fichier inattendu : refusé" || ko "fichier inattendu accepté" "$SORTIE"
sed 's/^APP=essai/APP=pirate/' "$MANIF" > "$BANC/m1"; livrer "$SHA2" "" "$BANC/m1"
[ "$STATUT" != 0 ] && printf '%s' "$SORTIE" | grep -q "on attendait « essai »" && ok "manifeste d'une autre application : refusé" || ko "manifeste étranger accepté" "$SORTIE"
sed 's|^VOLUMES=.*|VOLUMES="/:/hote"|' "$MANIF" > "$BANC/m2"; livrer "$SHA2" "" "$BANC/m2"
[ "$STATUT" != 0 ] && printf '%s' "$SORTIE" | grep -q "jamais un chemin de l'hôte" && ok "montage de l'hôte : refusé" || ko "montage de l'hôte accepté" "$SORTIE"
{ cat "$MANIF"; echo 'PRIVILEGIE=oui'; } > "$BANC/m3"; livrer "$SHA2" "" "$BANC/m3"
[ "$STATUT" != 0 ] && printf '%s' "$SORTIE" | grep -q "clé inconnue" && ok "clé inconnue : refusée" || ko "clé inconnue acceptée" "$SORTIE"
lancer livrer essai 'abc;rm'
[ "$STATUT" != 0 ] && ok "version illisible : refusée" || ko "version illisible acceptée"
[ "$(en_service)" = "$SHA1" ] && ok "après tous ces refus, $SHA1 sert toujours" || ko "en-service = $(en_service)"

bloc "10. regler"
lancer regler essai URL=essai.exemple.ma
[ "$STATUT" != 0 ] && grep -q '^URL=http://essai.exemple.ma$' "$F" && ok "URL sans schéma refusée, fiche intacte" || ko "URL sans schéma acceptée" "$SORTIE"
lancer regler essai 'URL=https://x.ma;include'
[ "$STATUT" != 0 ] && ok "« ; » refusé dans une valeur" || ko "« ; » accepté"
lancer regler essai SAUVEGARDE_HEURE=03:15
grep -q '03:15:00' "$INFRA_PREFIXE/etc/systemd/system/infra-sauvegarde@essai.timer.d/heure.conf" && ok "heure de sauvegarde appliquée au minuteur" || ko "minuteur non réglé"
lancer regler essai COMPTE=root
[ "$STATUT" != 0 ] && ok "COMPTE ne se règle pas" || ko "COMPTE réglable"

bloc "11. sauvegarder, verifier, restaurer"
for i in 1 2 3; do lancer sauvegarder essai --garder 2; sleep 1; done
[ "$(ls "$INFRA_PREFIXE"/var/backups/infra/essai/quotidien_* 2>/dev/null | wc -l)" -le 2 ] && ok "rotation : on en garde 2" || ko "rotation"
lancer sauvegarder --toutes
[ "$STATUT" = 0 ] && ok "sauvegarder --toutes" || ko "sauvegarder --toutes" "$SORTIE"
lancer verifier essai
[ "$STATUT" = 0 ] && printf '%s' "$SORTIE" | grep -q "coïncident" && ok "verifier : la prise rend la base" || ko "verifier" "$SORTIE"
compgen -G "$BANC/pg/bases/*_verif_*" >/dev/null && ko "base jetable laissée derrière" || ok "base jetable balayée"
prise="$(ls "$INFRA_PREFIXE"/var/backups/infra/essai/quotidien_* | head -1)"
lancer restaurer essai "$prise"
[ "$STATUT" != 0 ] && ok "restaurer sans --confirmer : refusé" || ko "restaurer sans confirmation"
: > "$BANC/ordre.log"
lancer restaurer essai "$prise" --confirmer essai
[ "$STATUT" = 0 ] && avant "pg_dump essai" "pg_restore essai" && ok "restaurer : filet pris AVANT d'écraser" || ko "restaurer" "$SORTIE"

bloc "12. infra-ssh (commande forcée)"
SORTIE="$(SSH_ORIGINAL_COMMAND='bash -i' "$ICI/bin/infra-ssh" essai 2>&1)"; [ $? = 2 ] && ok "shell refusé" || ko "shell accepté"
SORTIE="$(SSH_ORIGINAL_COMMAND='livrer $(id)' "$ICI/bin/infra-ssh" essai 2>&1)"; [ $? = 2 ] && ok "version piégée refusée" || ko "version piégée acceptée"
SORTIE="$(SSH_ORIGINAL_COMMAND='etat autre' "$ICI/bin/infra-ssh" essai 2>&1)"; [ $? = 2 ] && ok "une autre application : refusée" || ko "autre app acceptée"
: > "$BANC/ordre.log"
SSH_ORIGINAL_COMMAND="livrer $SHA1" "$ICI/bin/infra-ssh" essai </dev/null >/dev/null 2>&1
grep -q "sudo -n /usr/local/bin/infra livrer essai $SHA1" "$BANC/ordre.log" && ok "livrer <sha> → sudo infra livrer essai <sha>" || ko "livrer non transmis" "$(cat "$BANC/ordre.log")"

bloc "13. etat, docteur, historique"
lancer etat;              [ "$STATUT" = 0 ] && printf '%s' "$SORTIE" | grep -q essai && ok "etat (tous)" || ko "etat" "$SORTIE"
lancer etat essai;        [ "$STATUT" = 0 ] && ok "etat essai" || ko "etat essai" "$SORTIE"
lancer historique essai;  [ "$STATUT" = 0 ] && ok "historique" || ko "historique" "$SORTIE"
lancer docteur;           [ "$STATUT" -le 1 ] && printf '%s' "$SORTIE" | grep -q "clé du pipeline posée" && ok "docteur passe en revue" || ko "docteur" "$SORTIE"
lancer version;           printf '%s' "$SORTIE" | grep -q "infra $(cat "$ICI/VERSION")" && ok "version" || ko "version"

bloc "14. retirer"
lancer retirer essai
[ "$STATUT" != 0 ] && ok "retirer sans --confirmer : refusé" || ko "retirer sans confirmation"
lancer retirer essai --confirmer essai
[ "$STATUT" = 0 ] && [ ! -f "$P" ] && [ ! -f "$INFRA_PREFIXE/etc/sudoers.d/infra-essai" ] && ok "retirée du service" || ko "retirer" "$SORTIE"
[ -f "$BANC/pg/bases/essai" ] && [ -f "$S" ] && ok "base et secrets GARDÉS" || ko "données détruites"

printf '\n%s réussis, %s échec(s)\n' "$reussis" "$echecs"
[ "$echecs" = 0 ]
