import { test } from "node:test";
import assert from "node:assert/strict";

import { assertValidGraph, computeGraphStats, type GraphEdge } from "./graph.js";
import { mapK8sObjects, mapNamespace, type K8sResourceSet } from "./k8s-mapper.js";

/**
 * A realistic namespace: an API deployment wired to its config, secrets, volume
 * and service account, fronted by a service and an ingress, scaled by an HPA,
 * beside a worker, a database, a log agent, a cron job (with the job it spawned),
 * a one-off migration job, a network policy, and a service whose selector matches
 * nothing at all.
 */
function fixture(): K8sResourceSet {
  return {
    namespace: "payments",
    deployments: [
      {
        metadata: { name: "api", namespace: "payments", labels: { app: "api" } },
        spec: {
          selector: { matchLabels: { app: "api" } },
          template: {
            metadata: { labels: { app: "api", tier: "web" } },
            spec: {
              serviceAccountName: "api-sa",
              volumes: [
                { name: "config", configMap: { name: "api-config" } },
                { name: "creds", secret: { secretName: "api-secret" } },
                { name: "data", persistentVolumeClaim: { claimName: "api-data" } },
              ],
              containers: [
                {
                  name: "api",
                  image: "acme/api:1",
                  // The same ConfigMap the volume mounts — one edge, not two.
                  envFrom: [{ configMapRef: { name: "api-config" } }],
                  env: [
                    {
                      name: "DB_PASSWORD",
                      valueFrom: { secretKeyRef: { name: "db-password", key: "password" } },
                    },
                  ],
                },
              ],
            },
          },
        },
      },
      {
        metadata: { name: "worker", namespace: "payments" },
        spec: {
          selector: { matchLabels: { app: "worker" } },
          template: {
            metadata: { labels: { app: "worker" } },
            spec: { containers: [{ name: "worker", image: "acme/worker:1" }] },
          },
        },
      },
    ],
    statefulSets: [
      {
        metadata: { name: "db", namespace: "payments" },
        spec: {
          selector: { matchLabels: { app: "db" } },
          serviceName: "db",
          template: {
            metadata: { labels: { app: "db" } },
            spec: { containers: [{ name: "db", image: "postgres:17" }] },
          },
        },
      },
    ],
    daemonSets: [
      {
        metadata: { name: "log-agent", namespace: "payments" },
        spec: {
          selector: { matchLabels: { app: "log-agent" } },
          template: {
            metadata: { labels: { app: "log-agent" } },
            spec: { containers: [{ name: "agent", image: "acme/logs:1" }] },
          },
        },
      },
    ],
    cronJobs: [
      {
        metadata: { name: "nightly-report", namespace: "payments" },
        spec: {
          schedule: "0 2 * * *",
          jobTemplate: {
            spec: {
              template: {
                metadata: { labels: { app: "nightly-report" } },
                spec: {
                  containers: [{ name: "report", image: "acme/report:1" }],
                  restartPolicy: "OnFailure",
                },
              },
            },
          },
        },
      },
    ],
    jobs: [
      // Spawned by the CronJob above: the same work, said twice. Dropped.
      {
        metadata: {
          name: "nightly-report-28900",
          namespace: "payments",
          ownerReferences: [
            {
              apiVersion: "batch/v1",
              kind: "CronJob",
              name: "nightly-report",
              uid: "uid-1",
            },
          ],
        },
        spec: {
          template: {
            spec: {
              containers: [{ name: "report", image: "acme/report:1" }],
              restartPolicy: "OnFailure",
            },
          },
        },
      },
      // A one-off somebody ran by hand: nobody owns it, so it is its own thing.
      {
        metadata: { name: "migrate", namespace: "payments" },
        spec: {
          template: {
            spec: {
              containers: [{ name: "migrate", image: "acme/api:1" }],
              restartPolicy: "Never",
            },
          },
        },
      },
    ],
    services: [
      {
        metadata: { name: "api-svc", namespace: "payments" },
        spec: { selector: { app: "api" }, ports: [{ port: 80 }] },
      },
      {
        metadata: { name: "orphan-svc", namespace: "payments" },
        spec: { selector: { app: "nothing-here" }, ports: [{ port: 80 }] },
      },
    ],
    ingresses: [
      {
        metadata: { name: "public", namespace: "payments" },
        spec: {
          rules: [
            {
              host: "pay.example.com",
              http: {
                paths: [
                  {
                    path: "/",
                    pathType: "Prefix",
                    backend: { service: { name: "api-svc", port: { number: 80 } } },
                  },
                ],
              },
            },
          ],
        },
      },
    ],
    configMaps: [{ metadata: { name: "api-config", namespace: "payments" } }],
    secrets: [
      { metadata: { name: "api-secret", namespace: "payments" } },
      { metadata: { name: "db-password", namespace: "payments" } },
    ],
    persistentVolumeClaims: [{ metadata: { name: "api-data", namespace: "payments" } }],
    serviceAccounts: [{ metadata: { name: "api-sa", namespace: "payments" } }],
    horizontalPodAutoscalers: [
      {
        metadata: { name: "api-hpa", namespace: "payments" },
        spec: {
          scaleTargetRef: { kind: "Deployment", name: "api" },
          maxReplicas: 10,
        },
      },
    ],
    networkPolicies: [
      { metadata: { name: "deny-all", namespace: "payments" }, spec: { podSelector: {} } },
    ],
  };
}

const edgeKey = (e: GraphEdge) => `${e.kind} ${e.from} -> ${e.to}`;

test("golden: a namespace maps to the full graph the renderer draws", () => {
  const graph = mapNamespace(fixture());
  assertValidGraph(graph);

  // Every resource is a node, keyed `namespace/Kind/name` (GP-102). The namespace
  // is part of the id because two namespaces may hold the same `Kind/name` and
  // they are not the same thing — a manifests repository routinely holds both.
  assert.deepEqual(
    graph.nodes.map((n) => n.id),
    [
      "Namespace/payments",
      "payments/ConfigMap/api-config",
      "payments/CronJob/nightly-report",
      "payments/DaemonSet/log-agent",
      "payments/Deployment/api",
      "payments/Deployment/worker",
      "payments/HorizontalPodAutoscaler/api-hpa",
      "payments/Ingress/public",
      "payments/Job/migrate",
      "payments/NetworkPolicy/deny-all",
      "payments/PersistentVolumeClaim/api-data",
      "payments/Secret/api-secret",
      "payments/Secret/db-password",
      "payments/Service/api-svc",
      "payments/Service/orphan-svc",
      "payments/ServiceAccount/api-sa",
      "payments/StatefulSet/db",
    ],
  );

  // The job the CronJob spawned is not a second thing to look at.
  assert.ok(!graph.nodes.some((n) => n.id === "payments/Job/nightly-report-28900"));

  assert.deepEqual(graph.edges.map(edgeKey), [
    // The namespace contains everything in it — the containment a VNET has.
    "contains Namespace/payments -> payments/ConfigMap/api-config",
    "contains Namespace/payments -> payments/CronJob/nightly-report",
    "contains Namespace/payments -> payments/DaemonSet/log-agent",
    "contains Namespace/payments -> payments/Deployment/api",
    "contains Namespace/payments -> payments/Deployment/worker",
    "contains Namespace/payments -> payments/HorizontalPodAutoscaler/api-hpa",
    "contains Namespace/payments -> payments/Ingress/public",
    "contains Namespace/payments -> payments/Job/migrate",
    "contains Namespace/payments -> payments/NetworkPolicy/deny-all",
    "contains Namespace/payments -> payments/PersistentVolumeClaim/api-data",
    "contains Namespace/payments -> payments/Secret/api-secret",
    "contains Namespace/payments -> payments/Secret/db-password",
    "contains Namespace/payments -> payments/Service/api-svc",
    "contains Namespace/payments -> payments/Service/orphan-svc",
    "contains Namespace/payments -> payments/ServiceAccount/api-sa",
    "contains Namespace/payments -> payments/StatefulSet/db",
    // What the workload needs: config, secrets (by volume and by env), its
    // volume, and the identity it runs as.
    "depends_on payments/Deployment/api -> payments/ConfigMap/api-config",
    "depends_on payments/Deployment/api -> payments/PersistentVolumeClaim/api-data",
    "depends_on payments/Deployment/api -> payments/Secret/api-secret",
    "depends_on payments/Deployment/api -> payments/Secret/db-password",
    "depends_on payments/Deployment/api -> payments/ServiceAccount/api-sa",
    // What scales it, what fronts it, what routes to that.
    "depends_on payments/HorizontalPodAutoscaler/api-hpa -> payments/Deployment/api",
    "depends_on payments/Ingress/public -> payments/Service/api-svc",
    "depends_on payments/Service/api-svc -> payments/Deployment/api",
  ]);

  // Everything derived is marked derived; containment is structure, not inference.
  for (const edge of graph.edges) {
    if (edge.kind === "depends_on") assert.equal(edge.inferred, true);
    else assert.equal(edge.inferred, undefined);
  }

  const ns = graph.nodes.find((n) => n.id === "Namespace/payments");
  assert.equal(ns?.type, "Namespace");
  assert.equal(ns?.parent_id, undefined, "the namespace is the root; it has no parent");

  const api = graph.nodes.find((n) => n.id === "payments/Deployment/api");
  assert.equal(api?.type, "Deployment");
  assert.equal(api?.name, "api");
  assert.equal(api?.provider, "kubernetes");
  assert.equal(api?.change, null, "a live read is not a plan; nothing is changing");
  assert.equal(api?.parent_id, "Namespace/payments");
  assert.deepEqual(api?.labels, { app: "api" });
});

test("a Secret node carries its name and nothing else — never its data", () => {
  const resources = fixture();
  // Even handed a Secret with data (the reader never fetches it — GP-97 lists
  // Secrets, it does not get them), the mapper cannot put it on the graph.
  resources.secrets = [
    {
      metadata: { name: "api-secret", namespace: "payments" },
      data: { password: Buffer.from("hunter2").toString("base64") },
      stringData: { other: "plaintext" },
    },
  ];
  const graph = mapNamespace(resources);

  const secret = graph.nodes.find((n) => n.id === "payments/Secret/api-secret");
  assert.ok(secret);
  assert.equal(secret.type, "Secret");
  const serialized = JSON.stringify(graph);
  assert.ok(!serialized.includes("hunter2"));
  assert.ok(!serialized.includes(Buffer.from("hunter2").toString("base64")));
  assert.ok(!serialized.includes("plaintext"));
});

test("a selector that matches nothing draws no edge — we never guess", () => {
  const graph = mapNamespace(fixture());
  const fromOrphan = graph.edges.filter((e) => e.from === "payments/Service/orphan-svc");
  assert.deepEqual(fromOrphan, []);
  assert.ok(graph.nodes.some((n) => n.id === "payments/Service/orphan-svc"));
});

test("two workloads behind one selector are two edges — that is real, not ambiguity", () => {
  const resources = fixture();
  // A canary sharing the service's selector: the traffic really does go to both.
  resources.deployments.push({
    metadata: { name: "api-canary", namespace: "payments" },
    spec: {
      selector: { matchLabels: { app: "api" } },
      template: {
        metadata: { labels: { app: "api", track: "canary" } },
        spec: { containers: [{ name: "api", image: "acme/api:2" }] },
      },
    },
  });

  const graph = mapNamespace(resources);
  assert.deepEqual(
    graph.edges.filter((e) => e.from === "payments/Service/api-svc").map((e) => e.to),
    ["payments/Deployment/api", "payments/Deployment/api-canary"],
  );
});

test("an ingress pointing at a service that does not exist draws no edge", () => {
  const resources = fixture();
  resources.services = []; // the services were deleted; the ingress lingers
  const graph = mapNamespace(resources);
  assert.deepEqual(
    graph.edges.filter((e) => e.from === "payments/Ingress/public" && e.kind === "depends_on"),
    [],
  );
  assert.ok(graph.nodes.some((n) => n.id === "payments/Ingress/public"));
});

test("an empty namespace is a valid graph with one node — not a failure", () => {
  const graph = mapNamespace({
    namespace: "empty",
    deployments: [],
    statefulSets: [],
    daemonSets: [],
    cronJobs: [],
    jobs: [],
    services: [],
    ingresses: [],
    configMaps: [],
    secrets: [],
    persistentVolumeClaims: [],
    serviceAccounts: [],
    horizontalPodAutoscalers: [],
    networkPolicies: [],
  });
  assertValidGraph(graph);
  assert.deepEqual(graph.nodes.map((n) => n.id), ["Namespace/empty"]);
  assert.deepEqual(graph.edges, []);
});

test("stats work on it like any other snapshot", () => {
  const graph = mapNamespace(fixture());
  const stats = computeGraphStats(graph);
  assert.equal(stats.nodes, 17);
  assert.equal(stats.edges, 24);
  assert.equal(stats.inferredEdges, 8);
  // A live read has no plan: nothing is being created, updated or destroyed.
  assert.equal(stats.changes.unchanged, 17);
  assert.equal(stats.changes.create + stats.changes.update + stats.changes.delete, 0);
});

test("pure: the same namespace maps to a deep-equal graph every time", () => {
  assert.deepEqual(mapNamespace(fixture()), mapNamespace(fixture()));
});

// --- GP-102: the same mapper, fed the objects a repository declares ---

test("many namespaces are many containers, and references never cross them", () => {
  const graph = mapK8sObjects([
    { apiVersion: "v1", kind: "Namespace", metadata: { name: "staging" } },
    {
      apiVersion: "apps/v1",
      kind: "Deployment",
      metadata: { name: "api", namespace: "staging" },
      spec: {
        template: {
          metadata: { labels: { app: "api" } },
          spec: {
            containers: [
              { name: "api", image: "acme/api:1", envFrom: [{ configMapRef: { name: "settings" } }] },
            ],
          },
        },
      },
    },
    { apiVersion: "v1", kind: "ConfigMap", metadata: { name: "settings", namespace: "staging" } },
    // The same names again, in another namespace. A different system entirely.
    {
      apiVersion: "apps/v1",
      kind: "Deployment",
      metadata: { name: "api", namespace: "prod" },
      spec: {
        template: {
          metadata: { labels: { app: "api" } },
          spec: { containers: [{ name: "api", image: "acme/api:2" }] },
        },
      },
    },
    { apiVersion: "v1", kind: "ConfigMap", metadata: { name: "settings", namespace: "prod" } },
  ]);
  assertValidGraph(graph);

  // Two namespaces, and the same `Kind/name` in both is two nodes, not one.
  assert.deepEqual(
    graph.nodes.map((n) => n.id),
    [
      "Namespace/prod",
      "Namespace/staging",
      "prod/ConfigMap/settings",
      "prod/Deployment/api",
      "staging/ConfigMap/settings",
      "staging/Deployment/api",
    ],
  );

  // The staging deployment reads the staging ConfigMap. Kubernetes resolves the
  // reference inside the namespace, so a line to the production one would be a lie.
  assert.deepEqual(
    graph.edges.filter((e) => e.kind === "depends_on").map(edgeKey),
    ["depends_on staging/Deployment/api -> staging/ConfigMap/settings"],
  );
});

test("a namespace the manifests declare keeps what it declares", () => {
  const graph = mapK8sObjects([
    {
      apiVersion: "v1",
      kind: "Namespace",
      metadata: { name: "prod", labels: { tier: "critical" } },
    },
    { apiVersion: "v1", kind: "Service", metadata: { name: "api", namespace: "prod" } },
  ]);
  const ns = graph.nodes.find((n) => n.id === "Namespace/prod");
  assert.deepEqual(ns?.labels, { tier: "critical" });
  assert.equal(ns?.parent_id, undefined);
  // Declared or merely implied by the things inside it, the container is the same
  // node — a namespace nobody wrote down still contains its workloads.
  const implied = mapK8sObjects([
    { apiVersion: "v1", kind: "Service", metadata: { name: "api", namespace: "prod" } },
  ]);
  assert.deepEqual(implied.nodes.map((n) => n.id), ["Namespace/prod", "prod/Service/api"]);
});

test("cluster-scoped objects gather under (no namespace), and are not invented into one", () => {
  const graph = mapK8sObjects([
    { apiVersion: "rbac.authorization.k8s.io/v1", kind: "ClusterRole", metadata: { name: "admin" } },
    // A namespaced object whose manifest simply does not say (kubectl -n decides).
    { apiVersion: "v1", kind: "Service", metadata: { name: "api" } },
  ]);
  assertValidGraph(graph);
  assert.deepEqual(
    graph.nodes.map((n) => n.id),
    ["ClusterRole/admin", "Namespace/(no namespace)", "Service/api"],
  );
  const bucket = graph.nodes.find((n) => n.id === "Namespace/(no namespace)");
  assert.equal(bucket?.name, "(no namespace)");
  assert.deepEqual(
    graph.edges.map(edgeKey),
    [
      "contains Namespace/(no namespace) -> ClusterRole/admin",
      "contains Namespace/(no namespace) -> Service/api",
    ],
  );
});

test("a kind we have never heard of is still drawn — silence is worse than ignorance", () => {
  const graph = mapK8sObjects([
    {
      apiVersion: "cert-manager.io/v1",
      kind: "Certificate",
      metadata: { name: "api-tls", namespace: "prod" },
      spec: { secretName: "api-tls", dnsNames: ["api.example.com"] },
    },
  ]);
  assertValidGraph(graph);
  const crd = graph.nodes.find((n) => n.id === "prod/Certificate/api-tls");
  assert.equal(crd?.type, "Certificate");
  assert.equal(crd?.parent_id, "Namespace/prod");
  // We draw it. We do not pretend to understand what it points at.
  assert.deepEqual(graph.edges.filter((e) => e.kind === "depends_on"), []);
});

test("nodes carry their content flattened, which is what makes two graphs comparable", () => {
  const graph = mapK8sObjects([
    {
      apiVersion: "apps/v1",
      kind: "Deployment",
      metadata: { name: "api", namespace: "prod" },
      spec: {
        replicas: 3,
        template: { spec: { containers: [{ name: "api", image: "acme/api:1.4.0" }] } },
      },
    },
  ]);

  const api = graph.nodes.find((n) => n.id === "prod/Deployment/api");
  assert.equal(api?.attributes?.["spec.template.spec.containers[0].image"], "acme/api:1.4.0");
  assert.equal(api?.attributes?.["spec.replicas"], "3");
  assert.equal(api?.attributes?.["apiVersion"], "apps/v1");
  // Identity is the id, not an attribute — it cannot change without becoming
  // another node, so carrying it here would only ever be noise.
  assert.equal(api?.attributes?.["metadata.name"], undefined);
  assert.equal(api?.attributes?.["kind"], undefined);
});

test("a Secret read from a manifest — where the value IS in the file — still never reaches the graph", () => {
  const graph = mapK8sObjects([
    {
      apiVersion: "v1",
      kind: "Secret",
      metadata: { name: "db", namespace: "prod" },
      data: { password: Buffer.from("hunter2").toString("base64") },
      stringData: { token: "plaintext-token" },
    },
  ]);

  const secret = graph.nodes.find((n) => n.id === "prod/Secret/db");
  // The keys are shown — that a Secret grew a key is worth reviewing. The values
  // are not, and there is no path through this function that would let them out.
  assert.equal(secret?.attributes?.["data.password"], "(sensitive)");
  assert.equal(secret?.attributes?.["stringData.token"], "(sensitive)");
  const serialized = JSON.stringify(graph);
  assert.ok(!serialized.includes("hunter2"));
  assert.ok(!serialized.includes("plaintext-token"));
  assert.ok(!serialized.includes(Buffer.from("hunter2").toString("base64")));
});

test("the same object declared twice is one node — the last one wins, as kubectl would", () => {
  const graph = mapK8sObjects([
    {
      apiVersion: "apps/v1",
      kind: "Deployment",
      metadata: { name: "api", namespace: "prod" },
      spec: { replicas: 1 },
    },
    {
      apiVersion: "apps/v1",
      kind: "Deployment",
      metadata: { name: "api", namespace: "prod" },
      spec: { replicas: 5 },
    },
  ]);
  assert.deepEqual(graph.nodes.map((n) => n.id), ["Namespace/prod", "prod/Deployment/api"]);
  assert.equal(
    graph.nodes.find((n) => n.id === "prod/Deployment/api")?.attributes?.["spec.replicas"],
    "5",
  );
});

test("nothing to map is an empty graph, not a crash", () => {
  const graph = mapK8sObjects([]);
  assertValidGraph(graph);
  assert.deepEqual(graph.nodes, []);
  assert.deepEqual(graph.edges, []);
});
