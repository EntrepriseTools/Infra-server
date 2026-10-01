# 12 — Glossaire

| Terme (FR) | Anglais | Définition courte |
|---|---|---|
| Admission (contrôleur d') | admission controller | ce qui accepte, modifie ou refuse un objet envoyé à l'API, avant qu'il soit enregistré (PSA, Kyverno) |
| ApplicationSet | ApplicationSet | objet Argo CD qui ENGENDRE des Applications (ici : une par dossier `gitops/applications/*`) |
| Attestation | attestation | une affirmation signée sur un artefact (« cette image a été construite par ce workflow », « elle contient ceci ») |
| Audit (journal d') | audit log | qui a fait quoi sur l'API Kubernetes, quand |
| Backend (Terraform) | backend | où vit le state (ici : un Secret du cluster) |
| Chart | chart | paquet Helm : gabarits + valeurs par défaut |
| ClusterIP | ClusterIP | adresse virtuelle d'un Service, joignable dans le cluster (et depuis le nœud) |
| CRD | CustomResourceDefinition | un type d'objet ajouté à l'API (Application, ClusterPolicy, SealedSecret…) |
| Dérive | drift | écart entre l'état voulu (code) et l'état réel |
| Empreinte | digest | identifiant cryptographique (sha256) et immuable d'une image |
| Environnement (GitHub) | environment | cible de déploiement avec ses secrets et ses règles (relecteurs, branches) |
| Espace de noms | namespace | cloison de noms, de droits et de quotas dans le cluster |
| État voulu | desired state | ce qui est déclaré (Git) ; les contrôleurs y ramènent la réalité |
| Étiquette (d'image) | tag | nom mobile d'une image (`:abc1234`) — à la différence de l'empreinte |
| GitOps | GitOps | Git comme source de vérité, appliquée par un agent qui tire et réconcilie |
| Hook | hook | objet exécuté à un moment précis d'un déploiement (PreSync : avant) |
| IaC | Infrastructure as Code | l'infrastructure décrite dans des fichiers versionnés |
| Ingress | Ingress | règle d'entrée HTTP (nom d'hôte, chemin → Service) |
| Keyless (signature) | keyless signing | signature avec un certificat éphémère lié à une identité OIDC, sans clé longue durée |
| kubelet | kubelet | l'agent de chaque nœud, qui fait tourner les pods |
| Moindre privilège | least privilege | n'accorder que les droits strictement nécessaires |
| NetworkPolicy | NetworkPolicy | pare-feu entre pods (et vers l'extérieur) |
| OIDC | OpenID Connect | protocole d'identité ; GitHub Actions émet des jetons OIDC par exécution |
| Plan | plan | les changements que Terraform appliquerait |
| Pod | pod | un ou plusieurs conteneurs partageant réseau et volumes ; l'unité d'exécution |
| Provider | provider | le « pilote » de Terraform pour une API (kubernetes, helm…) |
| PSA / PSS | Pod Security Admission / Standards | les trois niveaux privileged / baseline / restricted, imposés par espace |
| PVC | PersistentVolumeClaim | une demande de stockage persistant |
| Réconciliation | reconciliation | la boucle qui compare voulu et réel et agit |
| Release | release | une installation d'un chart (Helm), avec son historique |
| Rekor | Rekor | journal de transparence public de Sigstore (signatures, append-only) |
| SBOM | Software Bill of Materials | l'inventaire de tout ce que contient un logiciel |
| Sceller (un secret) | seal | le chiffrer avec la clé publique du contrôleur Sealed Secrets |
| Selfheal | self-heal | Argo CD remet automatiquement ce qui a été modifié hors Git |
| Service | Service | nom et adresse stables devant des pods (ou, sans sélecteur, devant autre chose) |
| ServiceMonitor | ServiceMonitor | « Prometheus, lis les métriques de ce Service » |
| SLSA | Supply-chain Levels for Software Artifacts | cadre de niveaux de confiance pour la chaîne de construction |
| Sonde | probe | test de santé : startup, liveness (vivacité), readiness (préparation) |
| State | state | la mémoire de Terraform : ressource du code ↔ objet réel |
| Supply chain | software supply chain | tout ce qui mène du code à ce qui s'exécute (dépendances, CI, registre…) |
| Workflow réutilisable | reusable workflow | workflow GitHub appelé par d'autres (`workflow_call`) |
