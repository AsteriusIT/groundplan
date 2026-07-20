{{/*
Shared helpers. Naming: every resource is "<fullname>-<component>", labels
follow the app.kubernetes.io convention, and cross-cutting derivations
(image refs, public URL, DATABASE_URL env) live here so the api Deployment
and the migration Job can never disagree.
*/}}

{{- define "groundplan.fullname" -}}
{{- if contains .Chart.Name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name .Chart.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end }}

{{- define "groundplan.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version }}
app.kubernetes.io/name: {{ .Chart.Name }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/* Selector labels for one component. Call: include "groundplan.selectorLabels" (dict "root" . "component" "api") */}}
{{- define "groundplan.selectorLabels" -}}
app.kubernetes.io/name: {{ .root.Chart.Name }}
app.kubernetes.io/instance: {{ .root.Release.Name }}
app.kubernetes.io/component: {{ .component }}
{{- end }}

{{/* Image reference. Call: include "groundplan.image" (dict "root" . "name" "groundplan-backend") */}}
{{- define "groundplan.image" -}}
{{- printf "%s/%s:%s" .root.Values.image.registry .name (.root.Values.image.tag | default .root.Chart.AppVersion) -}}
{{- end }}

{{/* Public origin the deployment is reachable on (CORS, PR-comment links). */}}
{{- define "groundplan.publicUrl" -}}
{{- if .Values.publicUrl -}}
{{- .Values.publicUrl -}}
{{- else if .Values.ingress.host -}}
{{- printf "%s://%s" (ternary "https" "http" .Values.ingress.tls.enabled) .Values.ingress.host -}}
{{- end -}}
{{- end }}

{{/* Name of the Secret holding ENCRYPTION_KEY (user-brought or chart-managed). */}}
{{- define "groundplan.apiSecretName" -}}
{{- .Values.api.existingSecret | default (printf "%s-api" (include "groundplan.fullname" .)) -}}
{{- end }}

{{/* Name of the Secret holding the database password. */}}
{{- define "groundplan.dbSecretName" -}}
{{- .Values.externalDatabase.existingSecret | default (printf "%s-db" (include "groundplan.fullname" .)) -}}
{{- end }}

{{/*
The one templated DATABASE_URL (GP-170): env entries shared verbatim by the
api Deployment and the migration Job. The password never appears in the
rendered URL — it is pulled from the Secret into DB_PASSWORD and substituted
by Kubernetes' $(VAR) expansion at container start.
*/}}
{{- define "groundplan.databaseEnv" -}}
- name: DB_PASSWORD
  valueFrom:
    secretKeyRef:
      name: {{ include "groundplan.dbSecretName" . }}
      key: {{ .Values.externalDatabase.passwordKey }}
- name: DATABASE_URL
  value: {{ printf "postgres://%s:$(DB_PASSWORD)@%s:%d/%s%s" .Values.externalDatabase.username .Values.externalDatabase.host (.Values.externalDatabase.port | int) .Values.externalDatabase.database (ternary (printf "?sslmode=%s" .Values.externalDatabase.sslMode) "" (ne .Values.externalDatabase.sslMode "")) | quote }}
{{- end }}

{{/* The OIDC issuer URL the api validates against and the SPA logs in with. */}}
{{- define "groundplan.issuerUrl" -}}
{{- .Values.oidc.issuerUrl -}}
{{- end }}

{{/*
Cross-value validation — included from the api Deployment (always rendered),
so an impossible combination fails `helm template`/`install` with a sentence,
never a half-deployed release.
*/}}
{{- define "groundplan.validate" -}}
{{- if and .Values.ingress.enabled (not .Values.ingress.host) -}}
{{- fail "ingress.enabled requires ingress.host (the public hostname the app is served on)" -}}
{{- end -}}
{{- if not .Values.externalDatabase.host -}}
{{- fail "no database configured: set externalDatabase.host (and its credentials)" -}}
{{- end -}}
{{- if and .Values.externalDatabase.existingSecret .Values.externalDatabase.password -}}
{{- fail "set only one of externalDatabase.existingSecret and externalDatabase.password" -}}
{{- end -}}
{{- if and (not .Values.externalDatabase.existingSecret) (not .Values.externalDatabase.password) -}}
{{- fail "the database password is required: set externalDatabase.existingSecret (recommended) or externalDatabase.password" -}}
{{- end -}}
{{- if and .Values.api.existingSecret .Values.api.encryptionKey -}}
{{- fail "set only one of api.existingSecret and api.encryptionKey" -}}
{{- end -}}
{{- if and (not .Values.api.existingSecret) (not .Values.api.encryptionKey) -}}
{{- fail "ENCRYPTION_KEY is required: set api.existingSecret (recommended) or api.encryptionKey (generate one with: openssl rand -base64 32)" -}}
{{- end -}}
{{- if not (include "groundplan.issuerUrl" .) -}}
{{- fail "no identity provider configured: set oidc.issuerUrl" -}}
{{- end -}}
{{- end }}
