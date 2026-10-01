# =====================================================================
# cert-manager — émet et RENOUVELLE les certificats TLS (Let's Encrypt).
#
# En mode coexistence, c'est encore certbot sur l'hôte qui tient les
# certificats publics : cert-manager est installé pour qu'on puisse
# l'apprendre (émetteur « staging » et auto-signé) et pour le jour du
# mode direct. Les ClusterIssuers sont dans le chart « socle » (socle.tf) :
# ils ont besoin des CRD, qui n'existent qu'APRÈS cette release.
# =====================================================================
resource "helm_release" "cert_manager" {
  name       = "cert-manager"
  namespace  = kubernetes_namespace_v1.socle["cert-manager"].metadata[0].name
  repository = "https://charts.jetstack.io"
  chart      = "cert-manager"
  version    = "v1.21.2"

  wait            = true
  timeout         = 600
  cleanup_on_fail = true

  values = [yamlencode({
    # Les CRD sont installées ET mises à jour avec le chart.
    crds = { enabled = true, keep = true }

    global = {
      leaderElection = { namespace = "cert-manager" }
    }

    prometheus = {
      enabled        = true
      servicemonitor = { enabled = var.observabilite }
    }

    resources = {
      requests = { cpu = "10m", memory = "64Mi" }
      limits   = { memory = "256Mi" }
    }
    webhook = {
      resources = {
        requests = { cpu = "10m", memory = "32Mi" }
        limits   = { memory = "128Mi" }
      }
    }
    cainjector = {
      resources = {
        requests = { cpu = "10m", memory = "64Mi" }
        limits   = { memory = "256Mi" }
      }
    }
  })]

  # Le ServiceMonitor demande la CRD de Prometheus Operator.
  depends_on = [helm_release.observabilite]
}
