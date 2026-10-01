# 08 — Observabilité

## 1. Ce qui est installé (`observabilite = true`)

| Composant | Rôle |
|---|---|
| **Prometheus** | collecte des métriques toutes les 30 s, garde `retention_metriques` (15 j) sur un volume de 10 Gio |
| **node-exporter** | les métriques de l'HÔTE : CPU, mémoire, disque, réseau |
| **kube-state-metrics** | l'état des OBJETS : pods prêts, redémarrages, Jobs en échec… |
| **Alertmanager** | reçoit les alertes de Prometheus, les regroupe et les envoie |
| **Grafana** | les tableaux de bord (déjà fournis : nœud, pods, espaces, etcd…) |
| **ServiceMonitors** | « va lire les métriques de tel Service » — posés par cert-manager, Argo CD, Kyverno, Sealed Secrets, et par le chart si `metriques.serviceMonitor: true` |

## 2. Y accéder (tunnel SSH, rien n'est public)

```bash
# Grafana
ssh -L 3000:$(ssh admin@SERVEUR "sudo k3s kubectl -n observabilite get svc supervision-grafana -o jsonpath='{.spec.clusterIP}'"):80 admin@SERVEUR
# http://localhost:3000 — admin / mot de passe :
ssh admin@SERVEUR "sudo k3s kubectl -n observabilite get secret supervision-grafana -o jsonpath='{.data.admin-password}' | base64 -d"

# Prometheus (le nom du Service : k -n observabilite get svc | grep prometheus)
sudo k3s kubectl -n observabilite port-forward svc/<service-prometheus> 9090:9090   # sur le serveur, puis ssh -L 9090:localhost:9090
```

## 3. Les alertes

kube-prometheus-stack fournit les alertes classiques (pod en boucle de
redémarrage, nœud qui manque de mémoire ou de disque, cible de collecte
injoignable…). Le socle ajoute celles d'`infra docteur`
(`helm/socle/templates/alertes.yaml`) :

| Alerte | Quand |
|---|---|
| `CertificatBientotExpire` | un certificat cert-manager expire dans < 21 jours |
| `SauvegardeAvantDeploiementEchouee` | le hook pg_dump a échoué : la version n'est PAS déployée |
| `ApplicationArgoCDDegradee` | une application n'est ni Healthy ni Progressing depuis 15 min |
| `ApplicationArgoCDHorsSynchro` | OutOfSync depuis 30 min |
| `PolitiqueKyvernoViolee` | une politique a été violée dans l'heure |

**À faire (volontairement laissé à vous, TP 15)** : brancher Alertmanager sur
un vrai canal. Par défaut il reçoit les alertes mais ne les envoie nulle part.
Exemple de valeurs à ajouter dans `observabilite.tf`, bloc `alertmanager` :

```hcl
config = {
  route = { receiver = "courriel", group_by = ["alertname", "namespace"] }
  receivers = [{
    name = "courriel"
    email_configs = [{
      to            = "infra@sbp.ma"
      from          = "alertes@sbp.ma"
      smarthost     = "smtp.exemple.ma:587"
      auth_username = "alertes@sbp.ma"
      auth_password = var.smtp_mot_de_passe   # sensitive, TF_VAR_ depuis un secret GitHub
    }]
  }]
}
```

## 4. Les requêtes PromQL utiles

```promql
# Mémoire utilisée par conteneur, en Mio, par espace d'application
sum by (namespace, pod) (container_memory_working_set_bytes{namespace=~"paie|pilotage|procurement", container!=""}) / 2^20

# Part de la limite mémoire utilisée (proche de 1 = OOMKilled bientôt)
max by (namespace, pod) (container_memory_working_set_bytes{container!=""} / on (namespace, pod, container) kube_pod_container_resource_limits{resource="memory"})

# Redémarrages sur la dernière heure
increase(kube_pod_container_status_restarts_total[1h]) > 0

# Mémoire disponible sur l'hôte (PostgreSQL compris)
node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes

# Disque restant sur /var/lib (images, etcd, volumes)
node_filesystem_avail_bytes{mountpoint="/"} / node_filesystem_size_bytes{mountpoint="/"}

# Requêtes HTTP par application, vues par Traefik (si la collecte Traefik est activée — TP 15)
sum by (service) (rate(traefik_service_requests_total[5m]))
```

Pour Spring Boot : ajouter `micrometer-registry-prometheus`, exposer
`/actuator/prometheus`, puis `metriques.serviceMonitor: true` dans les valeurs.

## 5. Les journaux

Pas de Loki installé (une base de journaux de plus à maintenir sur un seul
serveur). Les journaux se lisent avec kubectl :

```bash
k -n pilotage logs deploy/pilotage --since=1h
k -n pilotage logs deploy/pilotage --previous          # avant le dernier redémarrage
k -n traefik logs deploy/traefik | grep pilotage       # journal d'accès (logs.access.enabled)
sudo journalctl -u k3s --since "1 hour ago"            # k3s lui-même
sudo jq -c 'select(.verb=="delete")' /var/log/k3s/audit.log | tail   # qui a supprimé quoi
```

Les journaux des conteneurs sont tournés par le kubelet (10 Mio × 5 fichiers
par conteneur par défaut) : pour un historique long, il faut une collecte
(Loki + Promtail/Alloy, ou Vector vers un stockage externe) — un bon exercice
quand les besoins se précisent.
