# =====================================================================
# Un espace de noms PRÊT par application : quotas, réseau fermé, base.
# Ajouter une application = une entrée dans terraform.tfvars, puis un
# dossier gitops/applications/<nom>/ (voir docs/plateforme/04-helm.md).
# =====================================================================
module "application" {
  source   = "../modules/espace-application"
  for_each = var.applications

  nom              = each.key
  adresse_postgres = var.adresse_postgres
  quota            = each.value.quota

  espace_ingress      = "traefik"
  espaces_supervision = var.observabilite ? ["observabilite"] : []
}
