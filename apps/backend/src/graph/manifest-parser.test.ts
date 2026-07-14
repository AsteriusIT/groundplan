import { test } from "node:test";
import assert from "node:assert/strict";

import { assertValidGraph } from "./graph.js";
import { mapK8sObjects } from "./k8s-mapper.js";
import {
  InvalidManifestError,
  parseManifestStream,
  parseManifests,
  type ManifestFile,
} from "./manifest-parser.js";

/**
 * A manifests repository as they actually come: two namespaces, a multi-document
 * file, the Helm chart nobody deleted (whose templates are Go source, not YAML),
 * a values file, and a kustomization — of which exactly four documents are
 * Kubernetes objects.
 */
function repo(): ManifestFile[] {
  return [
    {
      path: "deploy/prod/api.yaml",
      content: `apiVersion: apps/v1
kind: Deployment
metadata:
  name: api
  namespace: prod
  labels:
    app: api
spec:
  replicas: 3
  template:
    metadata:
      labels:
        app: api
    spec:
      containers:
        - name: api
          image: acme/api:1.4.0
---
apiVersion: v1
kind: Service
metadata:
  name: api
  namespace: prod
spec:
  selector:
    app: api
  ports:
    - port: 80
---
`,
    },
    {
      path: "deploy/prod/ingress.yml",
      content: `apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: public
  namespace: prod
spec:
  rules:
    - host: acme.example.com
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: api
                port:
                  number: 80
`,
    },
    {
      path: "deploy/staging/api.yaml",
      content: `apiVersion: apps/v1
kind: Deployment
metadata:
  name: api
  namespace: staging
spec:
  template:
    spec:
      containers:
        - name: api
          image: acme/api:1.5.0-rc1
`,
    },
    // Not a Kubernetes object: no kind. Skipped by the rule, not by its filename.
    {
      path: "deploy/prod/values.yaml",
      content: "replicaCount: 3\nimage:\n  tag: 1.4.0\n",
    },
    // A kustomization builds manifests; it is not one of them.
    {
      path: "deploy/prod/kustomization.yaml",
      content: `apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
metadata:
  name: prod
resources:
  - api.yaml
`,
    },
    // A Helm template: Go source that happens to end in .yaml. It cannot parse,
    // and that is not an error — it is the reason the CI-rendered path exists.
    {
      path: "chart/templates/deployment.yaml",
      content: `apiVersion: apps/v1
kind: Deployment
metadata:
  name: {{ .Release.Name }}
spec:
  replicas: {{ .Values.replicaCount }}
  {{- if .Values.extra }}
  extra: true
  {{- end }}
`,
    },
    // Not YAML at all, and never looked at.
    { path: "README.md", content: "# manifests\n" },
  ];
}

test("golden: a manifests repository parses to the objects it declares, and says what it dropped", () => {
  const result = parseManifests(repo());

  assert.deepEqual(
    result.objects.map((o) => `${o.metadata?.namespace}/${o.kind}/${o.metadata?.name}`),
    [
      "prod/Deployment/api",
      "prod/Service/api",
      "prod/Ingress/public",
      "staging/Deployment/api",
    ],
  );

  // Loud by count: "four things" and "four things, and we threw away three" are
  // different sentences, and the reader is owed the second one.
  assert.equal(result.skippedDocuments, 2, "values.yaml and the kustomization");
  assert.equal(result.skippedFiles, 1, "the Helm template");
  assert.ok(result.warnings.some((w) => w.includes("chart/templates/deployment.yaml")));
  assert.ok(result.warnings.some((w) => w.includes("2 YAML document(s)")));

  // And it maps: two namespaces, the ingress wired to the service it names.
  const graph = mapK8sObjects(result.objects);
  assertValidGraph(graph);
  assert.deepEqual(
    graph.nodes.map((n) => n.id),
    [
      "Namespace/prod",
      "Namespace/staging",
      "prod/Deployment/api",
      "prod/Ingress/public",
      "prod/Service/api",
      "staging/Deployment/api",
    ],
  );
  assert.deepEqual(
    graph.edges.filter((e) => e.kind === "depends_on").map((e) => `${e.from} -> ${e.to}`),
    ["prod/Ingress/public -> prod/Service/api", "prod/Service/api -> prod/Deployment/api"],
  );
  assert.equal(
    graph.nodes.find((n) => n.id === "prod/Deployment/api")?.attributes?.[
      "spec.template.spec.containers[0].image"
    ],
    "acme/api:1.4.0",
  );
});

test("the manifests root moves the parse, and nothing outside it is read", () => {
  const result = parseManifests(repo(), { rootDir: "deploy/staging" });
  assert.deepEqual(
    result.objects.map((o) => o.metadata?.name),
    ["api"],
  );
  assert.equal(result.objects[0]?.metadata?.namespace, "staging");
  // The Helm chart is outside the root, so it is not even a skip — it is not ours.
  assert.equal(result.skippedFiles, 0);
});

test("a root holding no YAML at all warns rather than pretending", () => {
  const result = parseManifests(repo(), { rootDir: "docs" });
  assert.deepEqual(result.objects, []);
  assert.ok(result.warnings.some((w) => w.includes("no .yaml/.yml files found in 'docs'")));
});

test("a chart of nothing but templates parses to nothing — loudly, whichever way it fails", () => {
  // A Helm template fails us in one of two ways, and neither is fatal:
  //   - control flow (`{{- if }}`) is not YAML at all → an unreadable file;
  //   - a bare `{{ .Values.x }}` *is* valid YAML (a flow map), so the document
  //     parses and is simply not a Kubernetes object — its name is not a string.
  // Both are counted. Neither is allowed to look like an empty repository.
  const result = parseManifests([
    {
      path: "templates/deployment.yaml",
      content: "apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: {{ .Release.Name }}\n",
    },
    {
      path: "templates/service.yaml",
      content: "spec:\n  {{- if .Values.expose }}\n  type: LoadBalancer\n  {{- end }}\n",
    },
  ]);
  assert.deepEqual(result.objects, []);
  assert.equal(result.skippedDocuments, 1, "the one that parsed, and meant nothing");
  assert.equal(result.skippedFiles, 1, "the one that would not parse at all");
  assert.ok(result.warnings.some((w) => w.includes("rendered by your CI")));
});

// --- The rendered stream (GP-103 posts one; the rules are the parser's) ---

test("a rendered stream is the payload, so YAML we cannot read is fatal — not a skip", () => {
  assert.throws(
    () => parseManifestStream("kind: Deployment\n  bad: [indent\n"),
    InvalidManifestError,
  );
});

test("a rendered stream keeps its objects and drops the noise between them", () => {
  const objects = parseManifestStream(`---
# Source: chart/templates/deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api
  namespace: prod
spec:
  replicas: 2
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: settings
  namespace: prod
---
`);
  assert.deepEqual(
    objects.map((o) => `${o.kind}/${o.metadata?.name}`),
    ["Deployment/api", "ConfigMap/settings"],
  );
});
