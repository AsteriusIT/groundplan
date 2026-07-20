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
{{- if .Values.postgresql.enabled -}}
{{- printf "%s-db" (include "groundplan.fullname" .) -}}
{{- else -}}
{{- .Values.externalDatabase.existingSecret | default (printf "%s-db" (include "groundplan.fullname" .)) -}}
{{- end -}}
{{- end }}

{{/* Key inside that Secret holding the password. */}}
{{- define "groundplan.dbPasswordKey" -}}
{{- ternary "password" .Values.externalDatabase.passwordKey .Values.postgresql.enabled -}}
{{- end }}

{{/*
The one templated DATABASE_URL (GP-170): env entries shared verbatim by the
api Deployment and the migration Job, pointing at either the embedded eval
Postgres or the external one. The password never appears in the rendered
URL — it is pulled from the Secret into DB_PASSWORD and substituted by
Kubernetes' $(VAR) expansion at container start.
*/}}
{{- define "groundplan.databaseEnv" -}}
- name: DB_PASSWORD
  valueFrom:
    secretKeyRef:
      name: {{ include "groundplan.dbSecretName" . }}
      key: {{ include "groundplan.dbPasswordKey" . }}
- name: DATABASE_URL
{{- if .Values.postgresql.enabled }}
  value: {{ printf "postgres://groundplan:$(DB_PASSWORD)@%s-postgresql:5432/groundplan" (include "groundplan.fullname" .) | quote }}
{{- else }}
  value: {{ printf "postgres://%s:$(DB_PASSWORD)@%s:%d/%s%s" .Values.externalDatabase.username .Values.externalDatabase.host (.Values.externalDatabase.port | int) .Values.externalDatabase.database (ternary (printf "?sslmode=%s" .Values.externalDatabase.sslMode) "" (ne .Values.externalDatabase.sslMode "")) | quote }}
{{- end }}
{{- end }}

{{/* Public origin of the embedded Keycloak; in-cluster service URL without a host. */}}
{{- define "groundplan.keycloakUrl" -}}
{{- if .Values.keycloak.host -}}
{{- printf "%s://%s" (ternary "https" "http" .Values.keycloak.tls.enabled) .Values.keycloak.host -}}
{{- else -}}
{{- printf "http://%s-keycloak:8080" (include "groundplan.fullname" .) -}}
{{- end -}}
{{- end }}

{{/* Image the embedded Keycloak runs (themed groundplan build by default). */}}
{{- define "groundplan.keycloakImage" -}}
{{- .Values.keycloak.image | default (include "groundplan.image" (dict "root" . "name" "groundplan-keycloak")) -}}
{{- end }}

{{/*
The OIDC issuer URL the api validates against and the SPA logs in with —
auto-wired to the embedded Keycloak's groundplan realm when it is enabled
(GP-171), oidc.issuerUrl otherwise.
*/}}
{{- define "groundplan.issuerUrl" -}}
{{- if .Values.keycloak.enabled -}}
{{- printf "%s/realms/groundplan" (include "groundplan.keycloakUrl" .) -}}
{{- else -}}
{{- .Values.oidc.issuerUrl -}}
{{- end -}}
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
{{- if and .Values.postgresql.enabled .Values.externalDatabase.host -}}
{{- fail "enable only one database mode: unset externalDatabase.host or set postgresql.enabled=false (the embedded Postgres is evaluation-only)" -}}
{{- end -}}
{{- if and (not .Values.postgresql.enabled) (not .Values.externalDatabase.host) -}}
{{- fail "no database configured: set externalDatabase.host (production) or postgresql.enabled=true (evaluation only)" -}}
{{- end -}}
{{- if not .Values.postgresql.enabled -}}
{{- if and .Values.externalDatabase.existingSecret .Values.externalDatabase.password -}}
{{- fail "set only one of externalDatabase.existingSecret and externalDatabase.password" -}}
{{- end -}}
{{- if and (not .Values.externalDatabase.existingSecret) (not .Values.externalDatabase.password) -}}
{{- fail "the database password is required: set externalDatabase.existingSecret (recommended) or externalDatabase.password" -}}
{{- end -}}
{{- end -}}
{{- if and .Values.api.existingSecret .Values.api.encryptionKey -}}
{{- fail "set only one of api.existingSecret and api.encryptionKey" -}}
{{- end -}}
{{- if and (not .Values.api.existingSecret) (not .Values.api.encryptionKey) -}}
{{- fail "ENCRYPTION_KEY is required: set api.existingSecret (recommended) or api.encryptionKey (generate one with: openssl rand -base64 32)" -}}
{{- end -}}
{{- if and .Values.keycloak.enabled .Values.oidc.issuerUrl -}}
{{- fail "set only one identity provider: unset oidc.issuerUrl or set keycloak.enabled=false (the embedded Keycloak is evaluation-only and wires oidc.* itself)" -}}
{{- end -}}
{{- if not (include "groundplan.issuerUrl" .) -}}
{{- fail "no identity provider configured: set oidc.issuerUrl (production) or keycloak.enabled=true (evaluation only)" -}}
{{- end -}}
{{- end }}
