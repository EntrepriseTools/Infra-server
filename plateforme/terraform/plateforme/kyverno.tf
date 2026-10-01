# =====================================================================
# Kyverno — le moteur de POLITIQUES d'admission.
#
# Chaque objet envoyé à l'API passe par lui avant d'être accepté. Les
# politiques (chart « socle ») vérifient, dans les espaces des
# applications :
#   - que l'image vient d'un registre permis, avec une étiquette ≠ latest ;
#   - qu'elle est SIGNÉE par un workflow GitHub de l'organisation (cosign,
#     sans clé, OIDC) — la fin de la chaîne d'approvisionnement ;
#   - que chaque conteneur déclare ses ressources.
# Pod Security Admission (intégré) couvre déjà root/privilèges/hôte.
# =====================================================================
resource "helm_release" "kyverno" {
  name       = "kyverno"
  namespace  = kubernetes_namespace_v1.socle["kyverno"].metadata[0].name
  repository = "https://kyverno.github.io/kyverno"
  chart      = "kyverno"
  version    = "3.9.1"

  wait            = true
  timeout         = 600
  cleanup_on_fail = true

  values = [yamlencode({
    # Un seul nœud : une réplique par contrôleur.
    admissionController = {
      replicas = 1
      container = {
        resources = {
          requests = { cpu = "100m", memory = "128Mi" }
          limits   = { memory = "512Mi" }
        }
      }
      # kyverno_policy_results_total : lu par les alertes du socle.
      serviceMonitor = { enabled = var.observabilite }
    }
    backgroundController = { enabled = true }
    cleanupController    = { enabled = true }
    reportsController    = { enabled = true }
  })]

  depends_on = [helm_release.observabilite]
}
