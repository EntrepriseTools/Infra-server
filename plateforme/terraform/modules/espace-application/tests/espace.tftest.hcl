# =====================================================================
# Tests du module espace-application — `terraform test` (ou `tofu test`).
#
# mock_provider : aucun cluster n'est contacté. Terraform calcule le plan
# avec un provider SIMULÉ ; on vérifie ce que le module DEMANDERAIT.
# C'est rapide (quelques secondes), donc joué sur chaque PR.
# =====================================================================

mock_provider "kubernetes" {}

variables {
  nom              = "pilotage"
  adresse_postgres = "10.0.0.5"
}

run "restricted_par_defaut" {
  command = plan

  assert {
    condition     = kubernetes_namespace_v1.this.metadata[0].labels["pod-security.kubernetes.io/enforce"] == "restricted"
    error_message = "Un espace d'application doit imposer Pod Security « restricted » par défaut."
  }

  assert {
    condition     = kubernetes_namespace_v1.this.metadata[0].labels["plateforme.entreprisetools/type"] == "application"
    error_message = "L'étiquette de type est lue par les politiques Kyverno : elle doit être posée."
  }
}

run "aucun_port_sur_l_hote" {
  command = plan

  assert {
    condition     = kubernetes_resource_quota_v1.plafond.spec[0].hard["services.nodeports"] == "0"
    error_message = "Une application ne doit pas pouvoir ouvrir de NodePort."
  }

  assert {
    condition     = kubernetes_resource_quota_v1.plafond.spec[0].hard["services.loadbalancers"] == "0"
    error_message = "Une application ne doit pas pouvoir demander de LoadBalancer."
  }
}

run "refus_par_defaut_puis_ouvertures" {
  command = plan

  assert {
    condition     = length(kubernetes_network_policy_v1.refuser_tout.spec[0].policy_types) == 2
    error_message = "La politique de refus doit couvrir l'entrée ET la sortie."
  }

  assert {
    condition     = kubernetes_network_policy_v1.sortie_postgres.spec[0].egress[0].to[0].ip_block[0].cidr == "10.0.0.5/32"
    error_message = "La sortie vers PostgreSQL doit viser l'hôte, et lui seul (/32)."
  }

  # Même espace + Traefik ; pas de supervision demandée.
  assert {
    condition     = length(kubernetes_network_policy_v1.entree.spec[0].ingress) == 2
    error_message = "Sans supervision, l'entrée n'est ouverte qu'au même espace et à Traefik."
  }
}

run "supervision_ouvre_une_entree" {
  command = plan

  variables {
    espaces_supervision = ["observabilite"]
  }

  assert {
    condition     = length(kubernetes_network_policy_v1.entree.spec[0].ingress) == 3
    error_message = "La supervision doit recevoir sa propre règle d'entrée."
  }
}

run "la_base_pointe_sur_l_hote" {
  command = plan

  assert {
    condition     = one(kubernetes_endpoint_slice_v1.postgres.endpoint[0].addresses) == "10.0.0.5"
    error_message = "Le Service postgres doit pointer sur l'adresse de l'hôte."
  }
}

run "quota_partiel_garde_les_defauts" {
  command = plan

  variables {
    quota = { memoire_limites = "3Gi" }
  }

  assert {
    condition     = kubernetes_resource_quota_v1.plafond.spec[0].hard["limits.memory"] == "3Gi"
    error_message = "La valeur donnée doit être reprise."
  }

  assert {
    condition     = kubernetes_resource_quota_v1.plafond.spec[0].hard["requests.cpu"] == "2"
    error_message = "Les valeurs non données doivent garder leur défaut."
  }
}

# ── Les refus : une mauvaise valeur doit ARRÊTER le plan. ──────────────

run "refuse_un_nom_invalide" {
  command = plan

  variables {
    nom = "Paie_RH"
  }

  expect_failures = [var.nom]
}

run "refuse_privileged" {
  command = plan

  variables {
    niveau_securite_pods = "privileged"
  }

  expect_failures = [var.niveau_securite_pods]
}

run "refuse_une_adresse_invalide" {
  command = plan

  variables {
    adresse_postgres = "postgres.local"
  }

  expect_failures = [var.adresse_postgres]
}
