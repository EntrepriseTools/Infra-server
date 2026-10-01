output "espace" {
  description = "Nom de l'espace de noms créé."
  value       = kubernetes_namespace_v1.this.metadata[0].name
}

output "hote_postgres" {
  description = "Nom DNS de la base, vu depuis les pods de l'espace."
  value       = "${kubernetes_service_v1.postgres.metadata[0].name}.${kubernetes_namespace_v1.this.metadata[0].name}.svc.cluster.local"
}
