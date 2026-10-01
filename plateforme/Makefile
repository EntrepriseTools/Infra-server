# =====================================================================
# Les contrôles de la plateforme, en local — les MÊMES que la CI
# (.github/workflows/plateforme-qualite.yml). `make tout` avant chaque PR.
# =====================================================================
SHELL := /bin/bash
TF    ?= $(shell command -v terraform || command -v tofu)
K8S   ?= 1.36.0
KC     = kubeconform -strict -summary -kubernetes-version $(K8S) \
           -schema-location default \
           -schema-location 'https://raw.githubusercontent.com/datreeio/CRDs-catalog/main/{{.Group}}/{{.ResourceKind}}_{{.ResourceAPIVersion}}.json'

.PHONY: tout fmt terraform helm kubeconform securite scripts

tout: fmt terraform helm kubeconform securite scripts ## tout ce que fait la CI

fmt: ## formater Terraform (écrit les fichiers)
	$(TF) fmt -recursive terraform

terraform: ## validate + test des deux modules
	cd terraform/modules/espace-application && $(TF) init -backend=false -input=false >/dev/null && $(TF) validate && $(TF) test
	cd terraform/plateforme && $(TF) init -backend=false -input=false >/dev/null && $(TF) validate && $(TF) test
	tflint --chdir terraform --init --config "$$PWD/terraform/.tflint.hcl" && tflint --chdir terraform --recursive --config "$$PWD/terraform/.tflint.hcl"

helm: ## lint + tests unitaires
	helm lint helm/socle --strict
	for f in helm/application/ci/*.yaml; do helm lint helm/application --strict -f $$f || exit 1; done
	helm unittest helm/application

kubeconform: ## rendre et valider contre les schémas Kubernetes et CRD
	helm template socle helm/socle -n argocd --set courrielAcme=ci@example.org --set 'applications={paie,pilotage,procurement}' | $(KC) -
	for f in helm/application/ci/*.yaml; do helm template ci helm/application -n ci -f $$f | $(KC) - || exit 1; done
	for d in ../gitops/applications/*/; do a=$$(basename $$d); \
	  helm template $$a helm/application -n $$a -f $$d/values.yaml --set image.tag=ci --set frontend.image.tag=ci --set secrets.existant=ci | $(KC) - || exit 1; done

securite: ## trivy : mauvaises configurations et secrets
	trivy config --severity HIGH,CRITICAL --exit-code 1 --helm-values helm/application/ci/proxy-values.yaml --ignorefile .trivyignore.yaml .
	trivy fs --scanners secret --exit-code 1 ..

scripts: ## shellcheck
	shellcheck -x amorcage/*.sh outils/*.sh labo/*.sh

aide: ## cette aide
	@grep -E '^[a-z-]+:.*## ' $(MAKEFILE_LIST) | awk -F':.*## ' '{printf "  %-12s %s\n", $$1, $$2}'
