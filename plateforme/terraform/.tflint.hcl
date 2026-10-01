# tflint — le linter de Terraform : variables inutilisées, types manquants,
# conventions de nommage, versions de providers non contraintes…
config {
  call_module_type = "local"
}

plugin "terraform" {
  enabled = true
  version = "0.15.0"
  source  = "github.com/terraform-linters/tflint-ruleset-terraform"
  preset  = "recommended"
}
