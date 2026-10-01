output "espaces_applications" {
  description = "Les espaces de noms prêts, par application."
  value       = { for nom, m in module.application : nom => m.espace }
}

output "hotes_postgres" {
  description = "Le nom DNS de la base, vu depuis chaque application."
  value       = { for nom, m in module.application : nom => m.hote_postgres }
}

output "traefik" {
  description = "Où envoyer le trafic vers Traefik."
  value = var.mode_ingress == "coexistence" ? "http://${var.traefik_ip_service} (depuis l'hôte : brancher-nginx.sh)" : (
    var.mode_ingress == "direct" ? "ports 80/443 de l'hôte" : "ports publiés par k3d"
  )
}

output "grafana_admin" {
  description = "Mot de passe admin de Grafana (utilisateur admin)."
  value       = var.observabilite ? random_password.grafana_admin[0].result : null
  sensitive   = true
}
