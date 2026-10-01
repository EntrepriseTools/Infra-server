# Les valeurs du LABO (k3d sur votre poste). Même code, autres valeurs :
# c'est tout l'intérêt de séparer le code (*.tf) des valeurs (*.tfvars).
contexte_kube    = "k3d-plateforme-labo"
mode_ingress     = "labo"
courriel_acme    = "labo@example.org"
adresse_postgres = "172.30.0.10"

# Argo CD suit VOTRE fork (la deploy key de TF_VAR_argocd_cle_depot doit y avoir accès).
# depot_gitops = "git@github.com:<vous>/Infra-server.git"
# revision_gitops = "labo"

# Plus léger : pas de Prometheus/Grafana (activez-le pour le TP supervision).
observabilite = false

kyverno_action = "Audit"

applications = {
  pilotage = {}
}
