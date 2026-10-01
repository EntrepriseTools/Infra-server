# =====================================================================
# Les valeurs NON SECRÈTES de la plateforme de production.
#
# Les secrets ne sont JAMAIS ici. Ils arrivent par l'environnement, depuis
# les secrets GitHub de l'environnement « production » :
#   TF_VAR_argocd_cle_depot      deploy key (lecture) du dépôt GitOps
#   TF_VAR_argocd_admin_bcrypt   empreinte bcrypt du mot de passe admin Argo CD
# =====================================================================

mode_ingress       = "coexistence"
traefik_ip_service = "10.43.0.80"
courriel_acme      = "infra@sbp.ma" # À REMPLACER : la boîte qui recevra les avis Let's Encrypt

adresse_postgres = "197.153.58.171"

depot_gitops    = "git@github.com:EntrepriseTools/Infra-server.git"
revision_gitops = "main"

# Commencer en Audit. Passer en Enforce quand `kubectl get policyreport -A`
# ne montre plus d'échec (07-devsecops.md, « passer en Enforce »).
kyverno_action = "Audit"

observabilite = true

# Les plafonds partent des MEMOIRE= des manifestes d'infra (migration/*/app.conf).
# Le quota compte les limites de TOUS les pods vivants : pendant une mise à
# jour (RollingUpdate, maxSurge 1), l'ancienne ET la nouvelle version
# tournent ensemble → prévoir ~2 × la limite. (paie est en Recreate : volumes.)
applications = {
  pilotage = {
    quota = { memoire_limites = "3Gi", cpu_demandes = "1" }
  }
  procurement = {
    quota = { memoire_limites = "3Gi", cpu_demandes = "1" }
  }
  paie = {
    quota = { memoire_limites = "3Gi", cpu_demandes = "1", stockage = "30Gi" }
  }
}
