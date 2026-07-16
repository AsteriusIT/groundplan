/**
 * Namespace read + snapshot API (GP-97). The reader is injected, so these tests
 * exercise the whole path — list, read, map, store, history — without ever
 * opening a socket to a cluster.
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";

import type { FastifyInstance } from "fastify";

import { loadEnv } from "../config/env.js";
import { runMigrations } from "../db/migrate.js";
import type { K8sResourceSet } from "../graph/k8s-mapper.js";
import {
  K8sUnreachableError,
  type K8sReader,
  type K8sReadResult,
} from "../services/k8s-reader.js";
import type { K8sVerify } from "../services/k8s-verify.js";
import { authHeader, buildTestApp, seedOrgForDefaultUser } from "../test-support.js";

const env = loadEnv();

before(async () => {
  await runMigrations(env.databaseUrl);
});

const KUBECONFIG = `
apiVersion: v1
kind: Config
current-context: prod
clusters:
  - name: prod-cluster
    cluster:
      server: https://k8s.example.com:6443
contexts:
  - name: prod
    context:
      cluster: prod-cluster
      user: prod-user
users:
  - name: prod-user
    user:
      token: super-secret-token
`;

/** A small but real namespace: one deployment, its config, and the service. */
function resourceSet(namespace = "payments"): K8sResourceSet {
  return {
    namespace,
    deployments: [
      {
        metadata: { name: "api", namespace, labels: { app: "api" } },
        spec: {
          selector: { matchLabels: { app: "api" } },
          template: {
            metadata: { labels: { app: "api" } },
            spec: {
              containers: [
                {
                  name: "api",
                  image: "acme/api:1",
                  envFrom: [{ configMapRef: { name: "api-config" } }],
                },
              ],
            },
          },
        },
      },
    ],
    statefulSets: [],
    daemonSets: [],
    cronJobs: [],
    jobs: [],
    services: [
      {
        metadata: { name: "api-svc", namespace },
        spec: { selector: { app: "api" }, ports: [{ port: 80 }] },
      },
    ],
    ingresses: [],
    configMaps: [{ metadata: { name: "api-config", namespace } }],
    secrets: [],
    persistentVolumeClaims: [],
    serviceAccounts: [],
    horizontalPodAutoscalers: [],
    networkPolicies: [],
  };
}

const okVerify: K8sVerify = async () => ({ ok: true, version: "v1.31.0" });

function stubReader(overrides: Partial<K8sReader> = {}): K8sReader {
  return {
    listNamespaces: async () => ["default", "payments"],
    readNamespace: async (_kubeconfig, namespace): Promise<K8sReadResult> => ({
      resources: resourceSet(namespace),
      warnings: [],
    }),
    ...overrides,
  };
}

/** A cluster stands on its own — attaching one needs no project to hang it from. */
async function attachCluster(
  app: FastifyInstance,
  orgId: string,
  auth: { authorization: string },
) {
  const cluster = await app.inject({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/clusters`,
    headers: auth,
    payload: { name: "prod", kubeconfig: KUBECONFIG },
  });
  assert.equal(cluster.statusCode, 201);
  return { clusterId: cluster.json().id as string };
}

test("list a cluster's namespaces", async () => {
  const app = await buildTestApp({ k8sVerify: okVerify, k8s: stubReader() });
  const auth = await authHeader();
  const orgId = await seedOrgForDefaultUser(app);
  try {
    const { clusterId } = await attachCluster(app, orgId, auth);
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/orgs/${orgId}/clusters/${clusterId}/namespaces`,
      headers: auth,
    });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { namespaces: ["default", "payments"] });
  } finally {
    await app.close();
  }
});

test("an unreachable cluster is a 502, and the kubeconfig is never in it", async () => {
  const app = await buildTestApp({
    k8sVerify: okVerify,
    k8s: stubReader({
      listNamespaces: async () => {
        throw new K8sUnreachableError("auth_failed");
      },
    }),
  });
  const auth = await authHeader();
  const orgId = await seedOrgForDefaultUser(app);
  try {
    const { clusterId } = await attachCluster(app, orgId, auth);
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/orgs/${orgId}/clusters/${clusterId}/namespaces`,
      headers: auth,
    });
    assert.equal(res.statusCode, 502);
    assert.equal(res.json().kind, "auth_failed");
    assert.ok(!res.body.includes("super-secret-token"));
    assert.ok(!res.body.includes("k8s.example.com"));
  } finally {
    await app.close();
  }
});

test("generate: read → map → store a k8s_namespace snapshot the rest of the API can read", async () => {
  const app = await buildTestApp({ k8sVerify: okVerify, k8s: stubReader() });
  const auth = await authHeader();
  const orgId = await seedOrgForDefaultUser(app);
  try {
    const { clusterId } = await attachCluster(app, orgId, auth);

    const created = await app.inject({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/clusters/${clusterId}/namespaces/payments/snapshots`,
      headers: auth,
      payload: {},
    });
    assert.equal(created.statusCode, 201);
    const snapshot = created.json();
    assert.equal(snapshot.source, "k8s_namespace");
    assert.equal(snapshot.clusterId, clusterId);
    assert.equal(snapshot.namespace, "payments");
    assert.equal(snapshot.repositoryId, null, "a cluster snapshot has no repository");

    // The graph is the GP-96 mapping — the namespace container and what is in it.
    // Ids carry the namespace since GP-102, because the same mapper now also maps
    // repositories that hold several namespaces at once, where `Kind/name` alone
    // would collide.
    assert.deepEqual(
      snapshot.graph.nodes.map((n: { id: string }) => n.id).sort(),
      [
        "Namespace/payments",
        "payments/ConfigMap/api-config",
        "payments/Deployment/api",
        "payments/Service/api-svc",
      ],
    );
    assert.equal(snapshot.stats.nodes, 4);
    assert.deepEqual(snapshot.stats.warnings, []);

    // The ordinary snapshot routes take the new kind without modification.
    const read = await app.inject({
      method: "GET",
      url: `/api/v1/orgs/${orgId}/snapshots/${snapshot.id}`,
      headers: auth,
    });
    assert.equal(read.statusCode, 200);
    assert.equal(read.json().graph.version, 7);
    assert.equal(read.json().stats.edges, 5);

    const svg = await app.inject({
      method: "GET",
      url: `/api/v1/orgs/${orgId}/snapshots/${snapshot.id}/export.svg`,
      headers: auth,
    });
    assert.equal(svg.statusCode, 200);
    assert.ok(svg.body.startsWith("<svg"));
  } finally {
    await app.close();
  }
});

test("one generation in flight per namespace — the second is a 409", async () => {
  // A handshake, not a sleep: `reading` resolves the moment the reader is inside
  // the cluster, and `gate` keeps it there until the test says otherwise. So the
  // second request provably arrives while the first is still running.
  let readerIsIn: () => void = () => {};
  const reading = new Promise<void>((resolve) => {
    readerIsIn = resolve;
  });
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  const app = await buildTestApp({
    k8sVerify: okVerify,
    k8s: stubReader({
      readNamespace: async (_kubeconfig, namespace) => {
        readerIsIn();
        await gate;
        return { resources: resourceSet(namespace), warnings: [] };
      },
    }),
  });
  const auth = await authHeader();
  const orgId = await seedOrgForDefaultUser(app);
  try {
    const { clusterId } = await attachCluster(app, orgId, auth);
    const url = `/api/v1/orgs/${orgId}/clusters/${clusterId}/namespaces/payments/snapshots`;

    // `.then()` is what dispatches an injected request — holding the thenable
    // without consuming it would leave it sitting on the doorstep, unsent.
    const first = app
      .inject({ method: "POST", url, headers: auth, payload: {} })
      .then((res) => res);
    await reading;

    const second = await app.inject({ method: "POST", url, headers: auth, payload: {} });
    assert.equal(second.statusCode, 409);

    release();
    assert.equal((await first).statusCode, 201);

    // The lock is released with the run, not held by it: a later run works.
    const third = await app.inject({ method: "POST", url, headers: auth, payload: {} });
    assert.equal(third.statusCode, 201);
  } finally {
    await app.close();
  }
});

test("history lists a namespace's snapshots, newest first", async () => {
  const app = await buildTestApp({ k8sVerify: okVerify, k8s: stubReader() });
  const auth = await authHeader();
  const orgId = await seedOrgForDefaultUser(app);
  try {
    const { clusterId } = await attachCluster(app, orgId, auth);
    const url = `/api/v1/orgs/${orgId}/clusters/${clusterId}/namespaces/payments/snapshots`;

    const first = await app.inject({ method: "POST", url, headers: auth, payload: {} });
    const second = await app.inject({ method: "POST", url, headers: auth, payload: {} });

    // A different namespace is a different history.
    await app.inject({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/clusters/${clusterId}/namespaces/default/snapshots`,
      headers: auth,
      payload: {},
    });

    const history = await app.inject({ method: "GET", url, headers: auth });
    assert.equal(history.statusCode, 200);
    const rows = history.json();
    assert.equal(rows.length, 2);
    assert.equal(rows[0].id, second.json().id);
    assert.equal(rows[1].id, first.json().id);
    // The list carries stats, never the graph body.
    assert.ok(rows[0].stats);
    assert.equal(rows[0].graph, undefined);
  } finally {
    await app.close();
  }
});

test("RBAC-denied kinds are skipped and named — a partial diagram says it is partial", async () => {
  const app = await buildTestApp({
    k8sVerify: okVerify,
    k8s: stubReader({
      readNamespace: async (_kubeconfig, namespace) => ({
        resources: { ...resourceSet(namespace), secrets: [] },
        warnings: ["not allowed to list Secret in this namespace — skipped"],
      }),
    }),
  });
  const auth = await authHeader();
  const orgId = await seedOrgForDefaultUser(app);
  try {
    const { clusterId } = await attachCluster(app, orgId, auth);
    const created = await app.inject({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/clusters/${clusterId}/namespaces/payments/snapshots`,
      headers: auth,
      payload: {},
    });

    // Still a snapshot — partial truth, labelled, beats a hard failure.
    assert.equal(created.statusCode, 201);
    const snapshot = created.json();
    assert.deepEqual(snapshot.stats.warnings, [
      "not allowed to list Secret in this namespace — skipped",
    ]);
    assert.ok(!snapshot.graph.nodes.some((n: { type: string }) => n.type === "Secret"));
  } finally {
    await app.close();
  }
});

test("a namespace with nothing mappable stores a valid, near-empty snapshot", async () => {
  const empty: K8sResourceSet = {
    namespace: "quiet",
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
  };
  const app = await buildTestApp({
    k8sVerify: okVerify,
    k8s: stubReader({
      readNamespace: async () => ({ resources: empty, warnings: [] }),
    }),
  });
  const auth = await authHeader();
  const orgId = await seedOrgForDefaultUser(app);
  try {
    const { clusterId } = await attachCluster(app, orgId, auth);
    const created = await app.inject({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/clusters/${clusterId}/namespaces/quiet/snapshots`,
      headers: auth,
      payload: {},
    });
    assert.equal(created.statusCode, 201);
    assert.equal(created.json().stats.nodes, 1); // the namespace itself
    assert.deepEqual(created.json().graph.edges, []);
  } finally {
    await app.close();
  }
});

test("a read that fails mid-generation is a 502 and stores nothing", async () => {
  const app = await buildTestApp({
    k8sVerify: okVerify,
    k8s: stubReader({
      readNamespace: async () => {
        throw new K8sUnreachableError("network");
      },
    }),
  });
  const auth = await authHeader();
  const orgId = await seedOrgForDefaultUser(app);
  try {
    const { clusterId } = await attachCluster(app, orgId, auth);
    const url = `/api/v1/orgs/${orgId}/clusters/${clusterId}/namespaces/payments/snapshots`;
    const res = await app.inject({ method: "POST", url, headers: auth, payload: {} });
    assert.equal(res.statusCode, 502);

    const history = await app.inject({ method: "GET", url, headers: auth });
    assert.deepEqual(history.json(), []);
  } finally {
    await app.close();
  }
});

test("deleting a cluster takes its snapshots with it", async () => {
  const app = await buildTestApp({ k8sVerify: okVerify, k8s: stubReader() });
  const auth = await authHeader();
  const orgId = await seedOrgForDefaultUser(app);
  try {
    const { clusterId } = await attachCluster(app, orgId, auth);
    const created = await app.inject({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/clusters/${clusterId}/namespaces/payments/snapshots`,
      headers: auth,
      payload: {},
    });
    const snapshotId = created.json().id as string;

    await app.inject({
      method: "DELETE",
      url: `/api/v1/orgs/${orgId}/clusters/${clusterId}`,
      headers: auth,
    });

    const gone = await app.inject({
      method: "GET",
      url: `/api/v1/orgs/${orgId}/snapshots/${snapshotId}`,
      headers: auth,
    });
    assert.equal(gone.statusCode, 404);
  } finally {
    await app.close();
  }
});
