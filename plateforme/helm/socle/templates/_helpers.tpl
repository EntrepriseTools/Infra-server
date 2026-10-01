{{/* La cible commune des politiques Kyverno : les pods des espaces
     d'application (étiquette posée par le module Terraform). */}}
{{- define "socle.espacesApplications" -}}
match:
  any:
    - resources:
        kinds: [Pod]
        namespaceSelector:
          matchLabels:
            plateforme.entreprisetools/type: application
{{- end }}
