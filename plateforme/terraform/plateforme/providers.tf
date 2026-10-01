# Les deux providers parlent au MÊME cluster, par le même kubeconfig.
# Dans GitHub Actions : un compte de service (terraform-plan ou
# terraform-apply), joint par le tunnel SSH sur https://127.0.0.1:6443.

provider "kubernetes" {
  config_path    = var.kubeconfig
  config_context = var.contexte_kube
}

provider "helm" {
  kubernetes = {
    config_path    = var.kubeconfig
    config_context = var.contexte_kube
  }
}
