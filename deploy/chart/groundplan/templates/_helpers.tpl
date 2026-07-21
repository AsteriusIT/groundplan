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
External Secrets Operator (ESO) sourcing predicates — each emits "true" when
that secret is materialised by ESO: the global switch is on AND the section's
remote key is set. Empty string otherwise (falsy in `if`).
*/}}
{{- define "groundplan.apiExternalSecretActive" -}}
{{- if and .Values.externalSecrets.enabled .Values.api.externalSecret.remoteRef.key -}}true{{- end -}}
{{- end }}
{{- define "groundplan.dbExternalSecretActive" -}}
{{- if and .Values.externalSecrets.enabled .Values.externalDatabase.externalSecret.remoteRef.key -}}true{{- end -}}
{{- end }}
{{- define "groundplan.aiExternalSecretActive" -}}
{{- if and .Values.externalSecrets.enabled .Values.ai.externalSecret.remoteRef.key -}}true{{- end -}}
{{- end }}

{{/* The AI layer is on when the key is supplied by any of its three modes. */}}
{{- define "groundplan.aiEnabled" -}}
{{- if or .Values.ai.apiKey .Values.ai.existingSecret (include "groundplan.aiExternalSecretActive" .) -}}true{{- end -}}
{{- end }}

{{/* Name of the Secret holding AI_API_KEY (user-brought or chart/ESO-managed). */}}
{{- define "groundplan.aiSecretName" -}}
{{- .Values.ai.existingSecret | default (printf "%s-ai" (include "groundplan.fullname" .)) -}}
{{- end }}

{{/* Key inside that Secret; a brought Secret may name it differently. */}}
{{- define "groundplan.aiSecretKey" -}}
{{- if .Values.ai.existingSecret -}}
{{- .Values.ai.existingSecretKey | default "AI_API_KEY" -}}
{{- else -}}
AI_API_KEY
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
{{- if and .Values.externalSecrets.enabled (not .Values.externalSecrets.secretStore.name) -}}
{{- fail "externalSecrets.enabled requires externalSecrets.secretStore.name (the (Cluster)SecretStore to read from)" -}}
{{- end -}}
{{- if and .Values.postgresql.enabled .Values.externalDatabase.host -}}
{{- fail "enable only one database mode: unset externalDatabase.host or set postgresql.enabled=false (the embedded Postgres is evaluation-only)" -}}
{{- end -}}
{{- if and (not .Values.postgresql.enabled) (not .Values.externalDatabase.host) -}}
{{- fail "no database configured: set externalDatabase.host (production) or postgresql.enabled=true (evaluation only)" -}}
{{- end -}}
{{- if and .Values.postgresql.enabled (include "groundplan.dbExternalSecretActive" .) -}}
{{- fail "externalDatabase.externalSecret cannot be combined with the embedded postgresql (it manages its own Secret)" -}}
{{- end -}}
{{- if not .Values.postgresql.enabled -}}
{{- $dbEso := include "groundplan.dbExternalSecretActive" . -}}
{{- $dbCount := add (ternary 1 0 (not (empty .Values.externalDatabase.existingSecret))) (ternary 1 0 (not (empty .Values.externalDatabase.password))) (ternary 1 0 (not (empty $dbEso))) -}}
{{- if gt $dbCount 1 -}}
{{- fail "set only one database password source: externalDatabase.existingSecret, externalDatabase.password, or externalDatabase.externalSecret (with externalSecrets.enabled)" -}}
{{- end -}}
{{- if eq $dbCount 0 -}}
{{- fail "the database password is required: set externalDatabase.existingSecret (recommended), externalDatabase.password, or externalDatabase.externalSecret.remoteRef.key (with externalSecrets.enabled)" -}}
{{- end -}}
{{- end -}}
{{- $apiEso := include "groundplan.apiExternalSecretActive" . -}}
{{- $apiCount := add (ternary 1 0 (not (empty .Values.api.existingSecret))) (ternary 1 0 (not (empty .Values.api.encryptionKey))) (ternary 1 0 (not (empty $apiEso))) -}}
{{- if gt $apiCount 1 -}}
{{- fail "set only one ENCRYPTION_KEY source: api.existingSecret, api.encryptionKey, or api.externalSecret (with externalSecrets.enabled)" -}}
{{- end -}}
{{- if eq $apiCount 0 -}}
{{- fail "ENCRYPTION_KEY is required: set api.existingSecret (recommended), api.encryptionKey (generate one with: openssl rand -base64 32), or api.externalSecret.remoteRef.key (with externalSecrets.enabled)" -}}
{{- end -}}
{{- $aiEso := include "groundplan.aiExternalSecretActive" . -}}
{{- $aiCount := add (ternary 1 0 (not (empty .Values.ai.apiKey))) (ternary 1 0 (not (empty .Values.ai.existingSecret))) (ternary 1 0 (not (empty $aiEso))) -}}
{{- if gt $aiCount 1 -}}
{{- fail "set only one AI_API_KEY source: ai.apiKey, ai.existingSecret, or ai.externalSecret (with externalSecrets.enabled)" -}}
{{- end -}}
{{- if and .Values.keycloak.enabled .Values.oidc.issuerUrl -}}
{{- fail "set only one identity provider: unset oidc.issuerUrl or set keycloak.enabled=false (the embedded Keycloak is evaluation-only and wires oidc.* itself)" -}}
{{- end -}}
{{- if not (include "groundplan.issuerUrl" .) -}}
{{- fail "no identity provider configured: set oidc.issuerUrl (production) or keycloak.enabled=true (evaluation only)" -}}
{{- end -}}
{{- end }}
