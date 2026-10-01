# =====================================================================
# Supervision — kube-prometheus-stack : Prometheus (métriques), Alertmanager
# (alertes), Grafana (tableaux), node-exporter (l'hôte), kube-state-metrics
# (les objets Kubernetes).
#
# Taillé pour UN serveur : une réplique, rétention courte, pas de
# composants que k3s embarque dans son propre processus (etcd, scheduler,
# controller-manager, proxy : leurs points de métriques ne sont pas
# exposés séparément).
#
# Grafana : pas d'Ingress public, accès par tunnel SSH. Le mot de passe
# admin est tiré au sort ici :  terraform output -raw grafana_admin
# =====================================================================
resource "random_password" "grafana_admin" {
  count   = var.observabilite ? 1 : 0
  length  = 32
  special = false
}

resource "helm_release" "observabilite" {
  count = var.observabilite ? 1 : 0

  name       = "supervision"
  namespace  = kubernetes_namespace_v1.socle["observabilite"].metadata[0].name
  repository = "https://prometheus-community.github.io/helm-charts"
  chart      = "kube-prometheus-stack"
  version    = "91.8.2"

  wait            = true
  timeout         = 900
  cleanup_on_fail = true

  values = [yamlencode({
    kubeEtcd              = { enabled = false }
    kubeScheduler         = { enabled = false }
    kubeControllerManager = { enabled = false }
    kubeProxy             = { enabled = false }

    prometheus = {
      prometheusSpec = {
        retention = var.retention_metriques
        # Lire les ServiceMonitor/PodMonitor/règles de TOUS les espaces,
        # pas seulement ceux étiquetés pour cette release.
        serviceMonitorSelectorNilUsesHelmValues = false
        podMonitorSelectorNilUsesHelmValues     = false
        ruleSelectorNilUsesHelmValues           = false
        resources = {
          requests = { cpu = "100m", memory = "512Mi" }
          limits   = { memory = "1536Mi" }
        }
        storageSpec = {
          volumeClaimTemplate = {
            spec = {
              accessModes = ["ReadWriteOnce"]
              resources   = { requests = { storage = "10Gi" } }
            }
          }
        }
      }
    }

    alertmanager = {
      alertmanagerSpec = {
        resources = {
          requests = { cpu = "10m", memory = "32Mi" }
          limits   = { memory = "128Mi" }
        }
      }
    }

    grafana = {
      adminPassword = random_password.grafana_admin[0].result
      persistence   = { enabled = true, size = "2Gi" }
      resources = {
        requests = { cpu = "20m", memory = "128Mi" }
        limits   = { memory = "512Mi" }
      }
    }
  })]
}
