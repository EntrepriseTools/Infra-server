# 02 — Kubernetes et k3s

## Partie A — Comprendre Kubernetes, à travers notre cluster

### A.1 L'idée fondamentale : l'état VOULU et la boucle de réconciliation

Avec `infra`, on donne des **ordres** : « charge l'image, relance, sonde ».
Avec Kubernetes, on **déclare un état** : « je veux 1 pod de
`pilotage:<sha>`, prêt, derrière ce nom ». Des **contrôleurs** comparent sans
cesse l'état voulu à l'état réel et agissent pour les rapprocher.

```
     vous ──kubectl apply / Argo CD──▶  API server ──▶ etcd (l'état VOULU)
                                           ▲    │
                                 observe   │    │ notifie
                                           │    ▼
                                 contrôleurs (Deployment, ReplicaSet, …)
                                           │
                                           ▼
                                 kubelet (sur le nœud) ──▶ containerd ──▶ conteneurs (l'état RÉEL)
```

Conséquence pratique : si vous supprimez un pod à la main, un autre est
recréé. Ce n'est pas un bug : l'état voulu dit « 1 pod ».

### A.2 Les objets, du plus petit au plus grand

| Objet | C'est… | Chez nous |
|---|---|---|
| **Pod** | un ou plusieurs conteneurs qui partagent réseau et volumes. Éphémère, jamais créé à la main. | le pod `pilotage-7c9…` |
| **ReplicaSet** | « garde N pods identiques en vie » | créé par le Deployment |
| **Deployment** | gère les ReplicaSets : mises à jour progressives, historique, retour | `deployment.yaml` du chart |
| **Service** | un nom DNS et une adresse STABLES devant des pods qui changent | `pilotage` (→ pods), `postgres` (→ l'hôte !) |
| **Ingress** | une règle HTTP : « tel nom d'hôte, tel chemin → tel Service » | `ingress.yaml` du chart, lu par Traefik |
| **ConfigMap / Secret** | configuration / données sensibles, injectées en variables ou fichiers | `pilotage-secrets` (créé par Sealed Secrets) |
| **PersistentVolumeClaim** | « je veux 5 Gio de disque qui survivent au pod » | `paie-etat`, `pilotage-prises` |
| **Job** | un pod qui doit aller AU BOUT, une fois | la sauvegarde avant déploiement |
| **Namespace** | un espace de noms : isolation des noms, des droits, des quotas | un par application + un par composant du socle |
| **ServiceAccount** | l'identité d'un pod auprès de l'API | une par application, sans aucun droit |
| **NetworkPolicy** | pare-feu entre pods | refus par défaut, puis DNS, base, Traefik |
| **ResourceQuota / LimitRange** | plafond d'un espace / défauts d'un conteneur | `plafond`, `defauts` (Terraform) |
| **CRD** | un type d'objet AJOUTÉ par un logiciel | `Application` (Argo CD), `ClusterPolicy` (Kyverno), `SealedSecret`, `Middleware` (Traefik) |

Explorer :

```bash
k api-resources              # tous les types connus (dont les CRD)
k explain deployment.spec.strategy   # la documentation d'un champ, dans le terminal
k get deploy pilotage -n pilotage -o yaml   # l'objet complet, avec son .status
```

### A.3 Le réseau, en une page

- Chaque pod a sa propre adresse dans **10.42.0.0/16** (réseau flannel).
- Chaque Service a une adresse virtuelle dans **10.43.0.0/16** ; kube-proxy
  la traduit (iptables) vers l'un des pods prêts.
- **CoreDNS** résout `pilotage` (même espace), `pilotage.pilotage`, ou
  `pilotage.pilotage.svc.cluster.local`.
- Un pod n'est mis derrière son Service que quand sa **sonde de préparation**
  (readiness) est verte. C'est ce qui rend les mises à jour sans coupure.
- **NetworkPolicy** : par défaut tout pod parle à tout pod. Dès qu'une
  politique *sélectionne* un pod, seul ce qu'elle permet passe. Chez nous,
  `refuser-tout` sélectionne tout, puis on ouvre (voir le module Terraform).
  k3s applique les NetworkPolicy grâce à son contrôleur intégré (kube-router).

Le Service `postgres` mérite qu'on s'y arrête : **il n'a pas de sélecteur**.
Kubernetes ne lui cherche donc pas de pods ; c'est un **EndpointSlice** écrit
par Terraform qui dit « l'adresse, c'est celle de l'hôte ». Un nom stable
devant quelque chose qui n'est pas dans le cluster.

### A.4 Les trois sondes

| Sonde | Si elle échoue… | Chez nous |
|---|---|---|
| **startup** (démarrage) | rien tant que `delaiMax` n'est pas dépassé ; ensuite, redémarrage | protège Spring Boot qui démarre lentement |
| **liveness** (vivacité) | le conteneur est **redémarré** | `/actuator/health/liveness` — ne dépend PAS de la base |
| **readiness** (préparation) | le pod est **retiré du Service** (plus de trafic), sans redémarrage | `/actuator/health/readiness` ou `/api/moi` — prouve la base |

Erreur classique : mettre la base dans la liveness. Une base lente et tous les
pods redémarrent en boucle — ce qui aggrave la panne.

### A.5 Requests, limits, et ce qui se passe quand ça déborde

- `requests` : ce que l'ordonnanceur **réserve**. Un pod n'est placé que si
  la somme des requests tient sur le nœud.
- `limits.memory` : au-delà, le conteneur est **tué** (OOMKilled). Lui, et
  pas PostgreSQL à côté.
- `limits.cpu` : au-delà, le conteneur est **ralenti** (throttling). On ne
  le pose PAS (choix courant et défendu : ralentir une JVM au démarrage la
  rend plus lente pour rien ; les requests suffisent au partage équitable).
- La JVM : `-XX:MaxRAMPercentage=70` → le tas prend 70 % de la limite du
  conteneur ; le reste pour la métaspace, les threads, les tampons.

### A.6 La sécurité des pods (Pod Security Standards)

Trois niveaux, imposés par espace de noms avec des étiquettes :

```yaml
pod-security.kubernetes.io/enforce: restricted   # refuser
pod-security.kubernetes.io/warn: restricted      # avertir (kubectl)
pod-security.kubernetes.io/audit: restricted     # noter (journal d'audit)
```

`restricted` exige : non-root, `allowPrivilegeEscalation: false`, toutes les
capacités retirées, profil seccomp. Notre chart le respecte : c'est le
`securityContext` de `deployment.yaml`. Essayez de le violer (TP 3).

---

## Partie B — k3s, et l'installation durcie

### B.1 Ce qu'est k3s

Kubernetes complet et certifié, empaqueté en **un binaire** : API server,
ordonnanceur, contrôleurs, kubelet, containerd, flannel, CoreDNS,
metrics-server, local-path (stockage). Il coexiste avec Docker (k3s utilise
son propre containerd).

### B.2 Ce que fait `installer-k3s.sh`, et pourquoi

```bash
sudo plateforme/amorcage/installer-k3s.sh --pare-feu
```

| Étape | Fichier | Pourquoi |
|---|---|---|
| Configuration avant démarrage | `k3s/config.yaml` | voir le tableau ci-dessous |
| Pod Security par défaut | `k3s/admission.yaml` | `baseline` imposé partout, `restricted` signalé |
| Journal d'audit | `k3s/audit.yaml` | qui a fait quoi sur l'API ; jamais le contenu des Secrets |
| Garde-barrière | `k3s/garde.nft` + `k3s-garde.service` | 6443, 10250, etcd, VXLAN, 5432 fermés vers l'extérieur |
| Version épinglée | `K3S_VERSION` | une patch d'une mineure éprouvée ; Renovate propose les suivantes |
| Comptes du pipeline | `rbac-pipeline.yaml` | terraform-plan (lecture) / terraform-apply (admin) |

Les clés de `config.yaml` :

| Clé | Effet | Pourquoi |
|---|---|---|
| `write-kubeconfig-mode: "0600"` | k3s.yaml lisible par root seul | c'est un passe-partout cluster-admin |
| `cluster-init: true` | etcd embarqué (au lieu de SQLite) | instantanés programmés ; un 2e nœud possible un jour |
| `etcd-snapshot-*` | un instantané toutes les 6 h, 7 jours gardés | restaurer l'état du cluster (10, « etcd ») |
| `disable: [traefik, servicelb]` | on retire les composants par défaut | on installe NOTRE Traefik (version, valeurs) |
| `secrets-encryption: true` | Secrets chiffrés dans etcd | un instantané volé ne livre pas les mots de passe |
| `system-reserved`, `kube-reserved` | 2,5 Gio jamais promis aux pods | PostgreSQL et le système passent d'abord |
| `eviction-hard` | évincer des pods avant que le noyau ne tue au hasard | protéger PostgreSQL de l'OOM killer |

**Écart CIS assumé** : `protect-kernel-defaults` n'est pas activé, car il
exige `vm.overcommit_memory=1`, déconseillé pour PostgreSQL. Un écart
**documenté** vaut mieux qu'un réglage subi.

### B.3 Les étapes après l'installation

```bash
sudo plateforme/amorcage/compte-tunnel-ci.sh          # SSH « tunnel seulement » pour la CI
sudo plateforme/amorcage/kubeconfig-pipeline.sh terraform-plan    # → secret GitHub
sudo plateforme/amorcage/kubeconfig-pipeline.sh terraform-apply   # → secret GitHub
sudo plateforme/amorcage/identifiants-registre.sh <robot-github>  # tirer les images de GHCR
sudo plateforme/amorcage/ouvrir-postgres-aux-pods.sh              # puis redémarrer PostgreSQL au calme
```

Vérifier :

```bash
k get nodes -o wide                         # Ready
k get pods -A                               # CoreDNS, local-path, metrics-server Running
sudo nft list table inet k3s_garde          # le garde est en place
curl -k https://<IP-publique>:6443          # depuis votre poste : doit ÉCHOUER (délai)
k auth can-i --list --as=system:serviceaccount:terraform-etat:terraform-plan | head
k auth can-i get secrets -n pilotage --as=system:serviceaccount:terraform-etat:terraform-plan   # no
```

---

## Partie C — kubectl au quotidien

```bash
# Voir
k get pods -n pilotage -o wide            # où, quelle IP, depuis quand
k describe pod <pod> -n pilotage          # LES ÉVÉNEMENTS en bas : la cause des problèmes
k get events -n pilotage --sort-by=.lastTimestamp
k top pods -A                             # consommation réelle (metrics-server)

# Journaux
k logs deploy/pilotage -n pilotage -f
k logs <pod> -n pilotage --previous       # le conteneur PRÉCÉDENT (après un plantage)
k logs job/pilotage-sauvegarde -n pilotage

# Entrer (à éviter en production : tout est tracé dans l'audit)
k exec -it deploy/pilotage -n pilotage -- sh

# Déploiements
k rollout status deploy/pilotage -n pilotage
k rollout history deploy/pilotage -n pilotage
# (pas de « rollout undo » : Argo CD le défera — on revient par Git, voir 05)

# Tester un accès réseau depuis un pod jetable
k run t -n pilotage --rm -it --restart=Never \
  --image=docker.io/library/postgres:17-alpine \
  --overrides='{"spec":{"securityContext":{"runAsNonRoot":true,"runAsUser":70,"seccompProfile":{"type":"RuntimeDefault"}},"containers":[{"name":"t","image":"docker.io/library/postgres:17-alpine","command":["sh"],"stdin":true,"tty":true,"securityContext":{"allowPrivilegeEscalation":false,"capabilities":{"drop":["ALL"]}},"resources":{"requests":{"cpu":"10m","memory":"32Mi"},"limits":{"memory":"64Mi"}}}]}}'
# dans le pod :  pg_isready -h postgres   ;   wget -T5 -qO- https://example.org   (doit échouer)
```

La commande `k run` ci-dessus est longue **parce que** l'espace est en
`restricted` : un pod sans `securityContext` est refusé. C'est voulu.

### Lire une panne : la méthode

1. `k get pods` — l'état : `Pending`, `CrashLoopBackOff`, `ImagePullBackOff`, `Running 0/1`.
2. `k describe pod` — les **événements** disent presque toujours pourquoi.
3. `k logs` (et `--previous`) — ce que l'application a dit.
4. Puis le tableau de dépannage de [10-exploitation.md](10-exploitation.md#5-dépannage).
