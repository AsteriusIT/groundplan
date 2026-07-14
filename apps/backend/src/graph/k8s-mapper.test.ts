import { test } from "node:test";
import assert from "node:assert/strict";

import { assertValidGraph, computeGraphStats, type GraphEdge } from "./graph.js";
import { mapNamespace, type K8sResourceSet } from "./k8s-mapper.js";

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

  // Every resource is a node, keyed `Kind/name` — the icon key space of GP-93.
  assert.deepEqual(
    graph.nodes.map((n) => n.id),
    [
      "ConfigMap/api-config",
      "CronJob/nightly-report",
      "DaemonSet/log-agent",
      "Deployment/api",
      "Deployment/worker",
      "HorizontalPodAutoscaler/api-hpa",
      "Ingress/public",
      "Job/migrate",
      "Namespace/payments",
      "NetworkPolicy/deny-all",
      "PersistentVolumeClaim/api-data",
      "Secret/api-secret",
      "Secret/db-password",
      "Service/api-svc",
      "Service/orphan-svc",
      "ServiceAccount/api-sa",
      "StatefulSet/db",
    ],
  );

  // The job the CronJob spawned is not a second thing to look at.
  assert.ok(!graph.nodes.some((n) => n.id === "Job/nightly-report-28900"));

  assert.deepEqual(graph.edges.map(edgeKey), [
    // The namespace contains everything in it — the containment a VNET has.
    "contains Namespace/payments -> ConfigMap/api-config",
    "contains Namespace/payments -> CronJob/nightly-report",
    "contains Namespace/payments -> DaemonSet/log-agent",
    "contains Namespace/payments -> Deployment/api",
    "contains Namespace/payments -> Deployment/worker",
    "contains Namespace/payments -> HorizontalPodAutoscaler/api-hpa",
    "contains Namespace/payments -> Ingress/public",
    "contains Namespace/payments -> Job/migrate",
    "contains Namespace/payments -> NetworkPolicy/deny-all",
    "contains Namespace/payments -> PersistentVolumeClaim/api-data",
    "contains Namespace/payments -> Secret/api-secret",
    "contains Namespace/payments -> Secret/db-password",
    "contains Namespace/payments -> Service/api-svc",
    "contains Namespace/payments -> Service/orphan-svc",
    "contains Namespace/payments -> ServiceAccount/api-sa",
    "contains Namespace/payments -> StatefulSet/db",
    // What the workload needs: config, secrets (by volume and by env), its
    // volume, and the identity it runs as.
    "depends_on Deployment/api -> ConfigMap/api-config",
    "depends_on Deployment/api -> PersistentVolumeClaim/api-data",
    "depends_on Deployment/api -> Secret/api-secret",
    "depends_on Deployment/api -> Secret/db-password",
    "depends_on Deployment/api -> ServiceAccount/api-sa",
    // What scales it, what fronts it, what routes to that.
    "depends_on HorizontalPodAutoscaler/api-hpa -> Deployment/api",
    "depends_on Ingress/public -> Service/api-svc",
    "depends_on Service/api-svc -> Deployment/api",
  ]);

  // Everything derived is marked derived; containment is structure, not inference.
  for (const edge of graph.edges) {
    if (edge.kind === "depends_on") assert.equal(edge.inferred, true);
    else assert.equal(edge.inferred, undefined);
  }

  const ns = graph.nodes.find((n) => n.id === "Namespace/payments");
  assert.equal(ns?.type, "Namespace");
  assert.equal(ns?.parent_id, undefined, "the namespace is the root; it has no parent");

  const api = graph.nodes.find((n) => n.id === "Deployment/api");
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

  const secret = graph.nodes.find((n) => n.id === "Secret/api-secret");
  assert.ok(secret);
  assert.equal(secret.type, "Secret");
  const serialized = JSON.stringify(graph);
  assert.ok(!serialized.includes("hunter2"));
  assert.ok(!serialized.includes(Buffer.from("hunter2").toString("base64")));
  assert.ok(!serialized.includes("plaintext"));
});

test("a selector that matches nothing draws no edge — we never guess", () => {
  const graph = mapNamespace(fixture());
  const fromOrphan = graph.edges.filter((e) => e.from === "Service/orphan-svc");
  assert.deepEqual(fromOrphan, []);
  assert.ok(graph.nodes.some((n) => n.id === "Service/orphan-svc"));
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
    graph.edges.filter((e) => e.from === "Service/api-svc").map((e) => e.to),
    ["Deployment/api", "Deployment/api-canary"],
  );
});

test("an ingress pointing at a service that does not exist draws no edge", () => {
  const resources = fixture();
  resources.services = []; // the services were deleted; the ingress lingers
  const graph = mapNamespace(resources);
  assert.deepEqual(
    graph.edges.filter((e) => e.from === "Ingress/public" && e.kind === "depends_on"),
    [],
  );
  assert.ok(graph.nodes.some((n) => n.id === "Ingress/public"));
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
