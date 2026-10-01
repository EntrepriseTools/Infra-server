# =====================================================================
# Traefik — le contrôleur d'entrée (Ingress controller).
#
# Pourquoi pas ingress-nginx ?  Le projet ingress-nginx de Kubernetes est
# RETIRÉ (fin de maintenance : mars 2026). Traefik est celui que k3s livre,
# il comprend les objets Ingress standard ET la Gateway API.
#
# On désactive le Traefik livré par k3s (config.yaml : disable: [traefik])
# pour installer le nôtre : version ÉPINGLÉE, valeurs RELUES ici.
#
# Trois modes (var.mode_ingress) :
#   coexistence  Service à adresse fixe (10.43.0.80), aucun port sur l'hôte.
#                Le nginx de l'hôte termine TLS et y envoie (brancher-nginx.sh).
#   direct       hostPort 80/443 : Traefik est la porte d'entrée.
#   labo         ni l'un ni l'autre (k3d publie lui-même les ports).
# =====================================================================

locals {
  # Les adresses dont Traefik croit les en-têtes X-Forwarded-* : le nginx de
  # l'hôte, vu depuis le pod par l'interface cni0 (10.42.0.1).
  traefik_proxies_de_confiance = var.mode_ingress == "coexistence" ? "10.42.0.1/32,127.0.0.1/32" : ""

  traefik_arguments = concat(
    [
      "--global.checknewversion=false",
      "--global.sendanonymoususage=false",
    ],
    local.traefik_proxies_de_confiance == "" ? [] : [
      "--entryPoints.web.forwardedHeaders.trustedIPs=${local.traefik_proxies_de_confiance}",
    ],
    # En direct : tout HTTP est renvoyé vers HTTPS, au niveau de l'entrée.
    var.mode_ingress == "direct" ? [
      "--entryPoints.web.http.redirections.entryPoint.to=websecure",
      "--entryPoints.web.http.redirections.entryPoint.scheme=https",
      "--entryPoints.web.http.redirections.entryPoint.permanent=true",
    ] : [],
  )
}

resource "helm_release" "traefik" {
  name       = "traefik"
  namespace  = kubernetes_namespace_v1.socle["traefik"].metadata[0].name
  repository = "https://traefik.github.io/charts"
  chart      = "traefik"
  version    = "41.6.1"

  wait            = true
  timeout         = 300
  cleanup_on_fail = true

  values = [yamlencode({
    deployment = { replicas = 1 }

    ingressClass = {
      enabled        = true
      isDefaultClass = true
      name           = "traefik"
    }

    providers = {
      kubernetesCRD     = { enabled = true, allowCrossNamespace = false }
      kubernetesIngress = { enabled = true }
    }

    ports = {
      web = merge(
        { port = 8000, exposedPort = 80 },
        var.mode_ingress == "direct" ? { hostPort = 80 } : {},
      )
      websecure = merge(
        { port = 8443, exposedPort = 443 },
        var.mode_ingress == "direct" ? { hostPort = 443 } : {},
      )
    }

    service = {
      type = "ClusterIP"
      spec = var.mode_ingress == "coexistence" ? { clusterIP = var.traefik_ip_service } : {}
    }

    additionalArguments = local.traefik_arguments

    logs = {
      access = { enabled = true }
    }

    resources = {
      requests = { cpu = "50m", memory = "64Mi" }
      limits   = { memory = "256Mi" }
    }
  })]
}
