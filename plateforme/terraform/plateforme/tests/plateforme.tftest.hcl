# =====================================================================
# Tests du module racine — le socle, avec des providers SIMULÉS.
# On vérifie les DÉCISIONS (modes d'entrée, niveaux Pod Security,
# supervision facultative), pas le fonctionnement de Helm.
# =====================================================================

mock_provider "kubernetes" {}
mock_provider "helm" {}
mock_provider "random" {}

variables {
  courriel_acme    = "infra@example.org"
  adresse_postgres = "10.0.0.5"
  argocd_cle_depot = "cle-de-test"
  # Une empreinte bcrypt de test (format seulement : 53 caractères après le coût).
  argocd_admin_bcrypt = "$2y$12$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ01234"
  applications = {
    pilotage = {}
    paie     = { quota = { memoire_limites = "3Gi" } }
  }
}

run "coexistence_adresse_fixe_sans_port_hote" {
  command = plan

  assert {
    condition     = yamldecode(helm_release.traefik.values[0]).service.spec.clusterIP == "10.43.0.80"
    error_message = "En coexistence, Traefik doit avoir l'adresse fixe vers laquelle pointe le pont nginx."
  }

  assert {
    condition     = !can(yamldecode(helm_release.traefik.values[0]).ports.web.hostPort)
    error_message = "En coexistence, Traefik ne doit pas prendre le port 80 de l'hôte (nginx l'a)."
  }

  assert {
    condition     = kubernetes_namespace_v1.socle["traefik"].metadata[0].labels["pod-security.kubernetes.io/enforce"] == "restricted"
    error_message = "Sans hostPort, Traefik tient en restricted."
  }
}

run "direct_prend_80_et_443" {
  command = plan

  variables {
    mode_ingress = "direct"
  }

  assert {
    condition     = yamldecode(helm_release.traefik.values[0]).ports.websecure.hostPort == 443
    error_message = "En direct, Traefik doit écouter sur 443."
  }

  assert {
    condition     = kubernetes_namespace_v1.socle["traefik"].metadata[0].labels["pod-security.kubernetes.io/enforce"] == "privileged"
    error_message = "hostPort est interdit par baseline : l'exception doit être explicite."
  }

  assert {
    condition     = contains(yamldecode(helm_release.traefik.values[0]).additionalArguments, "--entryPoints.web.http.redirections.entryPoint.to=websecure")
    error_message = "En direct, HTTP doit être renvoyé vers HTTPS."
  }
}

run "un_espace_par_application" {
  command = plan

  assert {
    condition     = length(module.application) == 2
    error_message = "Chaque application déclarée doit recevoir son espace."
  }

  assert {
    condition     = yamldecode(helm_release.socle.values[0]).applications == ["paie", "pilotage"]
    error_message = "Le socle (AppProject Argo CD) doit connaître la liste triée des applications."
  }
}

run "supervision_facultative" {
  command = plan

  variables {
    observabilite = false
  }

  assert {
    condition     = length(helm_release.observabilite) == 0
    error_message = "observabilite = false ne doit rien installer."
  }

  assert {
    condition     = !contains(keys(kubernetes_namespace_v1.socle), "observabilite")
    error_message = "observabilite = false ne doit pas créer l'espace privileged."
  }
}

run "refuse_un_mot_de_passe_en_clair" {
  command = plan

  variables {
    argocd_admin_bcrypt = "motdepasse"
  }

  expect_failures = [var.argocd_admin_bcrypt]
}

run "refuse_un_mode_inconnu" {
  command = plan

  variables {
    mode_ingress = "nodeport"
  }

  expect_failures = [var.mode_ingress]
}
