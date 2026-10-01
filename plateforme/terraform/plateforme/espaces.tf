# =====================================================================
# Les espaces de noms du SOCLE — un par composant, chacun avec son niveau
# Pod Security écrit et justifié ici (et nulle part ailleurs).
#
#   restricted  ce qu'on vise partout ;
#   baseline    composant tiers dont on ne garantit pas chaque pod en
#               restricted : on SIGNALE restricted (warn/audit) quand même ;
#   privileged  accès à l'hôte EXIGÉ, raison écrite à côté.
# =====================================================================

locals {
  espaces_socle = merge(
    {
      # Traefik en hostPort (mode direct) : PSS baseline interdit hostPort.
      traefik      = var.mode_ingress == "direct" ? "privileged" : "restricted"
      cert-manager = "restricted"
      argocd       = "baseline"
      kyverno      = "baseline"
    },
    # node-exporter lit /proc et /sys de l'hôte (hostPID, hostNetwork, hostPath).
    var.observabilite ? { observabilite = "privileged" } : {},
  )
}

resource "kubernetes_namespace_v1" "socle" {
  for_each = local.espaces_socle

  metadata {
    name = each.key
    labels = {
      "app.kubernetes.io/managed-by"               = "terraform"
      "app.kubernetes.io/part-of"                  = "plateforme"
      "plateforme.entreprisetools/type"            = "socle"
      "pod-security.kubernetes.io/enforce"         = each.value
      "pod-security.kubernetes.io/enforce-version" = "latest"
      "pod-security.kubernetes.io/warn"            = "restricted"
      "pod-security.kubernetes.io/audit"           = "restricted"
    }
  }
}

# terraform-plan (lecture seule) doit lire les Secrets où Helm range ses
# releases, dans les espaces que Terraform gère — et NULLE PART AILLEURS
# (pas sealed-secrets, pas les applications). Voir amorcage/rbac-pipeline.yaml.
resource "kubernetes_role_binding_v1" "plan_lit_les_releases" {
  for_each = kubernetes_namespace_v1.socle

  metadata {
    name      = "terraform-plan-secrets"
    namespace = each.value.metadata[0].name
  }
  role_ref {
    api_group = "rbac.authorization.k8s.io"
    kind      = "ClusterRole"
    name      = "terraform-plan-secrets"
  }
  subject {
    kind      = "ServiceAccount"
    name      = "terraform-plan"
    namespace = "terraform-etat"
  }
}
