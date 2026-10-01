# =====================================================================
# Le chart « socle » (plateforme/helm/socle) — ce qui DÉPEND des CRD
# installées plus haut, et qu'on ne peut donc pas écrire avec le provider
# kubernetes (kubernetes_manifest exige que la CRD existe dès le `plan`) :
#
#   ClusterIssuers        cert-manager   (letsencrypt, letsencrypt-staging, auto-signé)
#   ClusterPolicies       Kyverno        (registres, signatures, ressources)
#   AppProjects           Argo CD        (plateforme, applications)
#   ApplicationSet        Argo CD        (une Application par dossier gitops/applications/*)
#   Application           Argo CD        (Sealed Secrets, installé PAR Argo CD)
#   PrometheusRules       supervision    (si activée)
#
# C'est un chart LOCAL : pas de dépôt, Terraform le lit sur le disque.
# =====================================================================
resource "helm_release" "socle" {
  name      = "socle"
  namespace = kubernetes_namespace_v1.socle["argocd"].metadata[0].name
  chart     = "${path.module}/../../helm/socle"

  wait            = true
  timeout         = 300
  cleanup_on_fail = true

  values = [yamlencode({
    modeIngress  = var.mode_ingress
    courrielAcme = var.courriel_acme

    gitops = {
      depot    = var.depot_gitops
      revision = var.revision_gitops
    }

    applications = sort(keys(var.applications))

    kyverno = {
      action             = var.kyverno_action
      registresAutorises = var.registres_autorises
      identiteSignature  = var.identite_signature
    }

    observabilite = var.observabilite
  })]

  depends_on = [
    helm_release.cert_manager,
    helm_release.kyverno,
    helm_release.argocd,
    helm_release.observabilite,
    kubernetes_secret_v1.argocd_depot,
    module.application,
  ]
}
