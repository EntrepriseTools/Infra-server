# =====================================================================
# Argo CD — le déploiement CONTINU par GitOps.
#
# Le principe : le dépôt Git EST la vérité. Argo CD tourne DANS le cluster,
# lit gitops/applications/*/values.yaml et fait converger le cluster vers
# ce qui est écrit. Personne ne « pousse » vers le serveur :
#   - aucune porte entrante à ouvrir pour la CI ;
#   - tout changement est un commit (relu, daté, signé, réversible : git revert) ;
#   - une modification à la main dans le cluster est DÉFAITE (selfHeal).
#
# Terraform installe Argo CD et lui donne l'accès au dépôt ; le chart
# « socle » lui donne ses projets et l'ApplicationSet (socle.tf).
#
# Accès à l'interface : PAS d'Ingress public. Par tunnel SSH :
#   ssh -L 8080:10.43.x.y:80 admin@serveur   (voir 05-gitops-argocd.md)
# =====================================================================
resource "helm_release" "argocd" {
  name       = "argocd"
  namespace  = kubernetes_namespace_v1.socle["argocd"].metadata[0].name
  repository = "https://argoproj.github.io/argo-helm"
  chart      = "argo-cd"
  version    = "10.9.6"

  wait            = true
  timeout         = 600
  cleanup_on_fail = true

  values = [yamlencode({
    global = {
      domain = "argocd.local"
    }

    configs = {
      params = {
        # TLS est terminé par le tunnel SSH ; pas de certificat auto-signé à accepter.
        "server.insecure" = true
      }
      cm = {
        "admin.enabled"          = true
        "exec.enabled"           = false # pas de terminal dans les pods depuis l'UI
        "timeout.reconciliation" = "120s"
        # NB : on ne surcharge PAS resource.exclusions — les défauts du chart
        # excluent déjà Endpoints, Leases, les rapports Kyverno, etc.
      }
      secret = {
        # Seule l'empreinte bcrypt est dans le state et dans le cluster.
        argocdServerAdminPassword = var.argocd_admin_bcrypt
      }
    }

    # Pas de SSO pour un seul administrateur : Dex n'est pas installé.
    dex           = { enabled = false }
    notifications = { enabled = false }

    controller = {
      resources = {
        requests = { cpu = "100m", memory = "256Mi" }
        limits   = { memory = "1Gi" }
      }
      # argocd_app_info : lu par les alertes du socle (alertes.yaml).
      metrics = {
        enabled        = var.observabilite
        serviceMonitor = { enabled = var.observabilite }
      }
    }
    repoServer = {
      resources = {
        requests = { cpu = "50m", memory = "128Mi" }
        limits   = { memory = "512Mi" }
      }
    }
    server = {
      resources = {
        requests = { cpu = "20m", memory = "64Mi" }
        limits   = { memory = "256Mi" }
      }
    }
    applicationSet = {
      resources = {
        requests = { cpu = "10m", memory = "64Mi" }
        limits   = { memory = "256Mi" }
      }
    }
    redis = {
      resources = {
        requests = { cpu = "10m", memory = "32Mi" }
        limits   = { memory = "128Mi" }
      }
    }
  })]

  # Le ServiceMonitor demande la CRD de Prometheus Operator.
  depends_on = [helm_release.observabilite]
}

# L'accès d'Argo CD au dépôt GitOps : une deploy key EN LECTURE SEULE.
# Argo CD reconnaît ce Secret à son étiquette secret-type=repository.
resource "kubernetes_secret_v1" "argocd_depot" {
  metadata {
    name      = "depot-gitops"
    namespace = kubernetes_namespace_v1.socle["argocd"].metadata[0].name
    labels = {
      "argocd.argoproj.io/secret-type" = "repository"
      "app.kubernetes.io/managed-by"   = "terraform"
    }
  }
  data = {
    type          = "git"
    url           = var.depot_gitops
    sshPrivateKey = var.argocd_cle_depot
  }

  depends_on = [helm_release.argocd]
}
