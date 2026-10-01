# =====================================================================
# Module « espace-application » — tout ce qu'une application reçoit de la
# PLATEFORME avant même son premier déploiement :
#
#   l'espace de noms   avec son niveau Pod Security (restricted)
#   un plafond         ResourceQuota + LimitRange
#   un réseau fermé    NetworkPolicy : tout refusé, puis on ouvre DNS,
#                      PostgreSQL, l'entrée depuis Traefik
#   la base            un Service `postgres` qui pointe sur l'hôte
#
# Ce que l'application apporte ELLE-MÊME (chart Helm + valeurs, via Argo
# CD) : Deployment, Service, Ingress, secrets scellés. Elle ne peut PAS
# toucher à ce qui est ici (AppProject Argo CD : ResourceQuota et
# LimitRange sont sur liste noire).
# =====================================================================

locals {
  etiquettes_communes = {
    "app.kubernetes.io/managed-by" = "terraform"
    "app.kubernetes.io/part-of"    = "plateforme"
  }
}

resource "kubernetes_namespace_v1" "this" {
  metadata {
    name = var.nom
    labels = merge(var.etiquettes, local.etiquettes_communes, {
      "plateforme.entreprisetools/type" = "application"

      # Pod Security Admission : le niveau IMPOSÉ, et la même exigence
      # signalée (warn/audit) pour que kubectl prévienne avant de refuser.
      "pod-security.kubernetes.io/enforce"         = var.niveau_securite_pods
      "pod-security.kubernetes.io/enforce-version" = "latest"
      "pod-security.kubernetes.io/warn"            = "restricted"
      "pod-security.kubernetes.io/audit"           = "restricted"
    })
  }
}

# ───────────────────────────────────────────────────────────── plafonds
resource "kubernetes_resource_quota_v1" "plafond" {
  metadata {
    name      = "plafond"
    namespace = kubernetes_namespace_v1.this.metadata[0].name
  }
  spec {
    hard = {
      "requests.cpu"           = var.quota.cpu_demandes
      "limits.memory"          = var.quota.memoire_limites
      "requests.storage"       = var.quota.stockage
      "pods"                   = var.quota.pods
      "services.loadbalancers" = 0
      "services.nodeports"     = 0
    }
  }
}

resource "kubernetes_limit_range_v1" "defauts" {
  metadata {
    name      = "defauts"
    namespace = kubernetes_namespace_v1.this.metadata[0].name
  }
  spec {
    limit {
      type = "Container"
      default_request = {
        cpu    = var.defauts_conteneur.cpu_demande
        memory = var.defauts_conteneur.memoire_demande
      }
      default = {
        memory = var.defauts_conteneur.memoire_limite
      }
    }
  }
}

# ──────────────────────────────────────────────────────────────── réseau
# Une NetworkPolicy qui sélectionne un pod lui RETIRE tout ce qu'elle ne
# permet pas. Celle-ci sélectionne TOUS les pods ({}) et ne permet rien :
# c'est le « refus par défaut ». Les suivantes ouvrent, une par une.
resource "kubernetes_network_policy_v1" "refuser_tout" {
  metadata {
    name      = "refuser-tout"
    namespace = kubernetes_namespace_v1.this.metadata[0].name
  }
  spec {
    pod_selector {}
    policy_types = ["Ingress", "Egress"]
  }
}

resource "kubernetes_network_policy_v1" "sortie_dns" {
  metadata {
    name      = "sortie-dns"
    namespace = kubernetes_namespace_v1.this.metadata[0].name
  }
  spec {
    pod_selector {}
    policy_types = ["Egress"]
    egress {
      to {
        namespace_selector {
          match_labels = { "kubernetes.io/metadata.name" = "kube-system" }
        }
        pod_selector {
          match_labels = { "k8s-app" = "kube-dns" }
        }
      }
      ports {
        protocol = "UDP"
        port     = "53"
      }
      ports {
        protocol = "TCP"
        port     = "53"
      }
    }
  }
}

resource "kubernetes_network_policy_v1" "sortie_postgres" {
  metadata {
    name      = "sortie-postgres"
    namespace = kubernetes_namespace_v1.this.metadata[0].name
  }
  spec {
    pod_selector {}
    policy_types = ["Egress"]
    egress {
      to {
        ip_block {
          cidr = "${var.adresse_postgres}/32"
        }
      }
      ports {
        protocol = "TCP"
        port     = tostring(var.port_postgres)
      }
    }
  }
}

resource "kubernetes_network_policy_v1" "entree" {
  metadata {
    name      = "entree"
    namespace = kubernetes_namespace_v1.this.metadata[0].name
  }
  spec {
    pod_selector {}
    policy_types = ["Ingress"]

    # Depuis le même espace (le pod de `helm test`, le frontend vers l'API…).
    ingress {
      from {
        pod_selector {}
      }
    }

    # Depuis le contrôleur d'entrée (Traefik) et la supervision.
    dynamic "ingress" {
      for_each = toset(concat([var.espace_ingress], var.espaces_supervision))
      content {
        from {
          namespace_selector {
            match_labels = { "kubernetes.io/metadata.name" = ingress.value }
          }
        }
      }
    }
  }
}

# ──────────────────────────────────────────────────────────────── base
# Un Service SANS sélecteur : Kubernetes ne lui cherche pas de pods, c'est
# NOUS qui disons où il pointe (EndpointSlice ci-dessous). Les pods écrivent
# simplement  jdbc:postgresql://postgres:5432/<base>  — et le jour où la base
# déménage, on change UNE adresse ici, pas les applications.
resource "kubernetes_service_v1" "postgres" {
  metadata {
    name      = "postgres"
    namespace = kubernetes_namespace_v1.this.metadata[0].name
    labels    = local.etiquettes_communes
  }
  spec {
    port {
      name        = "postgres"
      port        = var.port_postgres
      target_port = var.port_postgres
      protocol    = "TCP"
    }
  }
}

resource "kubernetes_endpoint_slice_v1" "postgres" {
  metadata {
    name      = "postgres-hote"
    namespace = kubernetes_namespace_v1.this.metadata[0].name
    labels = merge(local.etiquettes_communes, {
      "kubernetes.io/service-name"             = kubernetes_service_v1.postgres.metadata[0].name
      "endpointslice.kubernetes.io/managed-by" = "terraform"
    })
  }
  address_type = "IPv4"
  endpoint {
    addresses = [var.adresse_postgres]
  }
  port {
    name         = "postgres"
    port         = tostring(var.port_postgres)
    protocol     = "TCP"
    app_protocol = "postgresql"
  }
}
