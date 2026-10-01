variable "nom" {
  description = "Nom de l'application : il devient l'espace de noms, le nom de la release Helm et celui de l'Application Argo CD."
  type        = string

  validation {
    # Un nom d'espace de noms est un label DNS (RFC 1123) : 63 caractères,
    # minuscules, chiffres, tirets. On reste plus strict (31) pour laisser
    # de la place aux suffixes (paie-secrets, paie-frontend…).
    condition     = can(regex("^[a-z][a-z0-9-]{1,30}$", var.nom))
    error_message = "nom : minuscules, chiffres et tirets, 2 à 31 caractères, commençant par une lettre."
  }
}

variable "quota" {
  description = "Plafond de l'espace de noms (ResourceQuota). Une application ne peut pas affamer les autres ni la base."
  type = object({
    cpu_demandes    = optional(string, "2")
    memoire_limites = optional(string, "4Gi")
    stockage        = optional(string, "20Gi")
    pods            = optional(number, 20)
  })
  default = {}
}

variable "defauts_conteneur" {
  description = "Ressources posées par défaut (LimitRange) sur un conteneur qui n'en déclare pas."
  type = object({
    cpu_demande     = optional(string, "100m")
    memoire_demande = optional(string, "256Mi")
    memoire_limite  = optional(string, "512Mi")
  })
  default = {}
}

variable "adresse_postgres" {
  description = "Adresse IPv4 de l'hôte, sur laquelle écoute le PostgreSQL natif (ouvrir-postgres-aux-pods.sh)."
  type        = string

  validation {
    condition     = can(cidrhost("${var.adresse_postgres}/32", 0))
    error_message = "adresse_postgres : une adresse IPv4 (ex. 197.153.58.171)."
  }
}

variable "port_postgres" {
  type    = number
  default = 5432
}

variable "espace_ingress" {
  description = "Espace de noms du contrôleur d'entrée, seul autorisé à joindre les pods depuis l'extérieur de l'espace."
  type        = string
  default     = "traefik"
}

variable "espaces_supervision" {
  description = "Espaces de noms autorisés à joindre les pods pour lire leurs métriques (Prometheus)."
  type        = list(string)
  default     = []
}

variable "niveau_securite_pods" {
  description = "Niveau Pod Security Standards IMPOSÉ à l'espace : restricted (défaut) ou baseline (à justifier)."
  type        = string
  default     = "restricted"

  validation {
    condition     = contains(["restricted", "baseline"], var.niveau_securite_pods)
    error_message = "niveau_securite_pods : restricted ou baseline. « privileged » n'est jamais permis pour une application."
  }
}

variable "etiquettes" {
  description = "Étiquettes supplémentaires posées sur l'espace de noms."
  type        = map(string)
  default     = {}
}
