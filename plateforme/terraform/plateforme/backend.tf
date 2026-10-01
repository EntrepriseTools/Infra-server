# =====================================================================
# Le STATE — la mémoire de Terraform : ce qu'il a créé, avec quels
# identifiants. Sans lui, Terraform ne sait plus rien et voudrait tout
# recréer.
#
# Où ?  Dans le cluster lui-même, dans un Secret de l'espace terraform-etat
# (backend « kubernetes »). Pourquoi :
#   - pas de compte cloud à ouvrir pour un bucket S3 ;
#   - chiffré au repos (k3s : secrets-encryption) ;
#   - VERROU natif (un objet Lease) : deux `apply` simultanés sont impossibles ;
#   - lisible par terraform-plan, écrit par terraform-apply (RBAC).
# La limite, dite : le state vit sur la machine qu'il décrit. Perdre le
# serveur = perdre le state ET le cluster ; on reconstruit alors depuis le
# code (c'est tout l'intérêt de l'IaC) — voir 10-exploitation.md.
#
# Le chemin du kubeconfig n'est pas écrit ici : il vient de l'environnement
# (KUBE_CONFIG_PATH), différent sur votre poste et dans GitHub Actions.
# =====================================================================
terraform {
  backend "kubernetes" {
    secret_suffix = "plateforme"
    namespace     = "terraform-etat"
  }
}
