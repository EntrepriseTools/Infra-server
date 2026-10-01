{{/* =====================================================================
     Les petites fonctions du chart. Une fonction = un `define`, appelée par
     `include "application.xxx" .` (include, pas template : son résultat
     peut être passé à nindent).
     ===================================================================== */}}

{{/* Le nom de tous les objets : nomComplet, sinon la release. */}}
{{- define "application.nom" -}}
{{- default .Release.Name .Values.nomComplet | trunc 40 | trimSuffix "-" -}}
{{- end -}}

{{/* Les étiquettes recommandées par Kubernetes (app.kubernetes.io/*). */}}
{{- define "application.etiquettes" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version }}
app.kubernetes.io/name: {{ include "application.nom" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ include "application.version" . | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/part-of: {{ include "application.nom" . }}
{{- end -}}

{{/* Le sélecteur : IMMUABLE une fois le Deployment créé — on n'y met donc
     jamais la version. `composant` distingue backend et frontend. */}}
{{- define "application.selecteur" -}}
app.kubernetes.io/name: {{ include "application.nom" .racine }}
app.kubernetes.io/instance: {{ .racine.Release.Name }}
app.kubernetes.io/component: {{ .composant }}
{{- end -}}

{{/* La version affichée : le tag (SHA), sinon le début de l'empreinte. */}}
{{- define "application.version" -}}
{{- if .Values.image.tag -}}
{{- .Values.image.tag | trunc 63 -}}
{{- else if .Values.image.empreinte -}}
{{- .Values.image.empreinte | trimPrefix "sha256:" | trunc 12 -}}
{{- else -}}
inconnue
{{- end -}}
{{- end -}}

{{/* La référence d'image. L'empreinte, si elle est donnée, est
     prioritaire (dépôt@sha256:…). Sans tag NI empreinte : on REFUSE de
     rendre, avec un message qui dit quoi faire — jamais de `latest`. */}}
{{- define "application.image" -}}
{{- $i := .image -}}
{{- if $i.empreinte -}}
{{- printf "%s@%s" $i.depot $i.empreinte -}}
{{- else if $i.tag -}}
{{- printf "%s:%s" $i.depot $i.tag -}}
{{- else -}}
{{- fail (printf "%s : ni image.tag ni image.empreinte. Aucune image n'a encore été publiée : lancez le pipeline de l'application (il pose ces valeurs dans gitops/applications/<app>/values.yaml)." .quoi) -}}
{{- end -}}
{{- end -}}

{{/* Le Secret dont l'application lit ses variables (ou rien). */}}
{{- define "application.secret" -}}
{{- if .Values.secrets.existant -}}
{{- .Values.secrets.existant -}}
{{- else if .Values.secrets.scelles -}}
{{- printf "%s-secrets" (include "application.nom" .) -}}
{{- end -}}
{{- end -}}

{{/* Le contexte de sécurité d'un conteneur — le même partout. */}}
{{- define "application.securiteConteneur" -}}
allowPrivilegeEscalation: false
readOnlyRootFilesystem: {{ .racineEnLectureSeule }}
capabilities:
  drop: ["ALL"]
{{- end -}}

{{/* Nom du middleware Traefik, tel que l'annotation l'attend :
     <espace>-<nom>@kubernetescrd */}}
{{- define "application.middleware" -}}
{{- printf "%s-%s-%s@kubernetescrd" .racine.Release.Namespace (include "application.nom" .racine) .nom -}}
{{- end -}}
