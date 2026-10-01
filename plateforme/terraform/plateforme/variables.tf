# ─────────────────────────────────────────────────────────────── accès
variable "kubeconfig" {
  description = "Chemin du kubeconfig. Dans la CI : le fichier écrit depuis le secret PLATEFORME_KUBECONFIG_*."
  type        = string
  default     = "~/.kube/config"
}

variable "contexte_kube" {
  description = "Contexte du kubeconfig à utiliser (null = le contexte courant)."
  type        = string
  default     = null
}

# ─────────────────────────────────────────────────────────────── entrée
variable "mode_ingress" {
  description = <<-EOT
    Comment le trafic arrive à Traefik :
      coexistence  le nginx de l'hôte garde 80/443 et passe la main à Traefik
                   (adresse fixe traefik_ip_service) — tant que des applications
                   sont encore livrées par `infra` ;
      direct       Traefik prend 80/443 (hostPort), cert-manager les certificats ;
      labo         cluster local de travaux pratiques (k3d), sans hostPort.
  EOT
  type        = string
  default     = "coexistence"

  validation {
    condition     = contains(["coexistence", "direct", "labo"], var.mode_ingress)
    error_message = "mode_ingress : coexistence, direct ou labo."
  }
}

variable "traefik_ip_service" {
  description = "Adresse FIXE du Service Traefik (dans 10.43.0.0/16, le CIDR des Services de k3s). Le pont nginx y envoie."
  type        = string
  default     = "10.43.0.80"

  validation {
    condition     = can(cidrhost("${var.traefik_ip_service}/32", 0)) && startswith(var.traefik_ip_service, "10.43.")
    error_message = "traefik_ip_service doit être une adresse de 10.43.0.0/16."
  }
}

variable "courriel_acme" {
  description = "Courriel donné à Let's Encrypt (avis d'expiration). Utilisé en mode direct."
  type        = string
}

# ─────────────────────────────────────────────────────────────── base
variable "adresse_postgres" {
  description = "Adresse IPv4 de l'hôte où écoute le PostgreSQL natif."
  type        = string
}

# ─────────────────────────────────────────────────────────────── GitOps
variable "depot_gitops" {
  description = "Dépôt que suit Argo CD (adresse SSH)."
  type        = string
  default     = "git@github.com:EntrepriseTools/Infra-server.git"
}

variable "revision_gitops" {
  description = "Branche suivie par Argo CD."
  type        = string
  default     = "main"
}

variable "argocd_cle_depot" {
  description = "Clé privée SSH d'une « deploy key » EN LECTURE SEULE sur le dépôt GitOps. Vient d'un secret GitHub (TF_VAR_argocd_cle_depot)."
  type        = string
  sensitive   = true
}

variable "argocd_admin_bcrypt" {
  description = "Empreinte bcrypt du mot de passe admin d'Argo CD. Seule l'empreinte entre dans le state. htpasswd -nbBC 12 '' 'motdepasse' | tr -d ':\\n'"
  type        = string
  sensitive   = true

  validation {
    condition     = can(regex("^\\$2[aby]\\$[0-9]{2}\\$.{53}$", var.argocd_admin_bcrypt))
    error_message = "argocd_admin_bcrypt doit être une empreinte bcrypt ($2y$12$…), pas un mot de passe en clair."
  }
}

# ─────────────────────────────────────────────────────────── applications
variable "applications" {
  description = "Les applications hébergées. Une entrée ici = un espace de noms prêt (quotas, réseau, base). Le déploiement lui-même est fait par Argo CD depuis gitops/applications/<nom>/."
  type = map(object({
    quota = optional(object({
      cpu_demandes    = optional(string)
      memoire_limites = optional(string)
      stockage        = optional(string)
      pods            = optional(number)
    }), {})
  }))
  default = {}
}

# ─────────────────────────────────────────────────────────── sécurité
variable "kyverno_action" {
  description = "Audit : une image non conforme est SIGNALÉE (rapport). Enforce : elle est REFUSÉE. On commence en Audit, on lit les rapports, puis on passe en Enforce."
  type        = string
  default     = "Audit"

  validation {
    condition     = contains(["Audit", "Enforce"], var.kyverno_action)
    error_message = "kyverno_action : Audit ou Enforce."
  }
}

variable "registres_autorises" {
  description = "Motifs d'images permis dans les espaces des applications."
  type        = list(string)
  default = [
    "ghcr.io/entreprisetools/*",
    # L'image de la sauvegarde avant déploiement (hook PreSync du chart).
    "docker.io/library/postgres:*",
  ]
}

variable "identite_signature" {
  description = <<-EOT
    Expression régulière de l'identité qui doit avoir signé les images (cosign
    sans clé, OIDC). Pour un workflow RÉUTILISABLE, GitHub met dans le
    certificat le chemin du workflow réutilisable lui-même : seul
    k8s-publier.yml de CE dépôt, à une version publiée, peut donc produire une
    signature valable — pas un workflow écrit dans un dépôt d'application.
  EOT
  type        = string
  default     = "^https://github\\.com/EntrepriseTools/Infra-server/\\.github/workflows/k8s-publier\\.yml@refs/(heads/main|tags/v[0-9]+(\\.[0-9]+)*)$"
}

# ─────────────────────────────────────────────────────────── supervision
variable "observabilite" {
  description = "Installer Prometheus, Alertmanager et Grafana (kube-prometheus-stack). ~1 Gio de mémoire."
  type        = bool
  default     = true
}

variable "retention_metriques" {
  description = "Durée de conservation des métriques Prometheus."
  type        = string
  default     = "15d"
}
