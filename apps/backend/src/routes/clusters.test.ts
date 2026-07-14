/**
 * Cluster CRUD (GP-95). Integration tests over the real HTTP + Postgres path
 * (`docker compose up -d`), with the cluster verifier injected — nothing here
 * touches a network, and no test ever needs a Kubernetes cluster.
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";

import type { FastifyInstance } from "fastify";

import { loadEnv } from "../config/env.js";
import { runMigrations } from "../db/migrate.js";
import type { K8sVerify, K8sVerifyResult } from "../services/k8s-verify.js";
import { authHeader, buildTestApp } from "../test-support.js";

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

/** A verifier that never leaves the process, and records what it was handed. */
function stubVerify(result: K8sVerifyResult = { ok: true, version: "v1.31.0" }) {
  const seen: string[] = [];
  const verify: K8sVerify = async (kubeconfig) => {
    seen.push(kubeconfig);
    return result;
  };
  return { verify, seen };
}

async function createProject(app: FastifyInstance, auth: { authorization: string }) {
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/projects",
    headers: auth,
    payload: { name: "K8s Project", slug: `k8s-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` },
  });
  assert.equal(res.statusCode, 201);
  return res.json().id as string;
}

test("attach a cluster: created verified, kubeconfig masked everywhere", async () => {
  const { verify, seen } = stubVerify();
  const app = await buildTestApp({ k8sVerify: verify });
  const auth = await authHeader();
  try {
    const projectId = await createProject(app, auth);

    const created = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/clusters`,
      headers: auth,
      payload: { name: "prod", kubeconfig: KUBECONFIG },
    });
    assert.equal(created.statusCode, 201);
    const cluster = created.json();
    assert.equal(cluster.name, "prod");
    assert.equal(cluster.projectId, projectId);
    // Write-only: masked in the create response…
    assert.equal(cluster.kubeconfig, "***");
    // …and auto-verified on create, like a repository with a PAT (GP-11).
    assert.equal(cluster.connectionStatus, "ok");
    assert.ok(cluster.verifiedAt);
    // The verifier saw the plaintext — so what is stored is decryptable, and the
    // masking above is masking, not an empty column.
    assert.deepEqual(seen, [KUBECONFIG]);

    // …and in every subsequent read.
    const got = await app.inject({
      method: "GET",
      url: `/api/v1/clusters/${cluster.id}`,
      headers: auth,
    });
    assert.equal(got.statusCode, 200);
    assert.equal(got.json().kubeconfig, "***");

    const list = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/clusters`,
      headers: auth,
    });
    assert.equal(list.statusCode, 200);
    assert.equal(list.json().length, 1);
    assert.equal(list.json()[0].kubeconfig, "***");

    // The row holds ciphertext, not the YAML anybody pasted.
    const { rows } = await app.pool.query<{ kubeconfig: string }>(
      "select kubeconfig from clusters where id = $1",
      [cluster.id],
    );
    assert.ok(rows[0]);
    assert.ok(!rows[0].kubeconfig.includes("super-secret-token"));
    assert.ok(!rows[0].kubeconfig.includes("apiVersion"));
    assert.equal(app.encryptor.decrypt(rows[0].kubeconfig), KUBECONFIG);
  } finally {
    await app.close();
  }
});

test("an unreachable cluster is stored as failed, not an HTTP error", async () => {
  const { verify } = stubVerify({ ok: false, error: "auth_failed" });
  const app = await buildTestApp({ k8sVerify: verify });
  const auth = await authHeader();
  try {
    const projectId = await createProject(app, auth);
    const created = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/clusters`,
      headers: auth,
      payload: { name: "prod", kubeconfig: KUBECONFIG },
    });
    assert.equal(created.statusCode, 201);
    assert.equal(created.json().connectionStatus, "failed");

    // Re-verifying reports the structured reason, and never the kubeconfig.
    const verified = await app.inject({
      method: "POST",
      url: `/api/v1/clusters/${created.json().id}/verify`,
      headers: auth,
    });
    assert.equal(verified.statusCode, 200);
    assert.deepEqual(verified.json(), { ok: false, error: "auth_failed" });
  } finally {
    await app.close();
  }
});

test("a malformed kubeconfig is a 422 and stores nothing", async () => {
  const { verify, seen } = stubVerify();
  const app = await buildTestApp({ k8sVerify: verify });
  const auth = await authHeader();
  try {
    const projectId = await createProject(app, auth);
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/clusters`,
      headers: auth,
      payload: { name: "broken", kubeconfig: "not: [a: kubeconfig" },
    });
    assert.equal(res.statusCode, 422);
    assert.equal(res.json().error, "Unprocessable Entity");
    assert.deepEqual(seen, []); // never verified — it never got that far

    const list = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/clusters`,
      headers: auth,
    });
    assert.deepEqual(list.json(), []);
  } finally {
    await app.close();
  }
});

test("replacing the kubeconfig re-verifies; renaming does not", async () => {
  const { verify, seen } = stubVerify();
  const app = await buildTestApp({ k8sVerify: verify });
  const auth = await authHeader();
  try {
    const projectId = await createProject(app, auth);
    const created = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/clusters`,
      headers: auth,
      payload: { name: "prod", kubeconfig: KUBECONFIG },
    });
    const id = created.json().id as string;
    assert.equal(seen.length, 1);

    const renamed = await app.inject({
      method: "PATCH",
      url: `/api/v1/clusters/${id}`,
      headers: auth,
      payload: { name: "production" },
    });
    assert.equal(renamed.statusCode, 200);
    assert.equal(renamed.json().name, "production");
    assert.equal(seen.length, 1, "a rename says nothing about reachability");

    const replaced = await app.inject({
      method: "PATCH",
      url: `/api/v1/clusters/${id}`,
      headers: auth,
      payload: { kubeconfig: KUBECONFIG.replace("prod-user", "other-user") },
    });
    assert.equal(replaced.statusCode, 200);
    assert.equal(replaced.json().kubeconfig, "***");
    assert.equal(seen.length, 2, "a new credential is a new connection");

    // A bad replacement is refused, and the good one survives.
    const bad = await app.inject({
      method: "PATCH",
      url: `/api/v1/clusters/${id}`,
      headers: auth,
      payload: { kubeconfig: "garbage" },
    });
    assert.equal(bad.statusCode, 422);
    assert.equal(seen.length, 2);
    const { rows } = await app.pool.query<{ kubeconfig: string }>(
      "select kubeconfig from clusters where id = $1",
      [id],
    );
    assert.ok(app.encryptor.decrypt(rows[0]!.kubeconfig).includes("other-user"));
  } finally {
    await app.close();
  }
});

test("deleting a project cascades to its clusters", async () => {
  const { verify } = stubVerify();
  const app = await buildTestApp({ k8sVerify: verify });
  const auth = await authHeader();
  try {
    const projectId = await createProject(app, auth);
    const created = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/clusters`,
      headers: auth,
      payload: { name: "prod", kubeconfig: KUBECONFIG },
    });
    const id = created.json().id as string;

    const deleted = await app.inject({
      method: "DELETE",
      url: `/api/v1/projects/${projectId}`,
      headers: auth,
    });
    assert.equal(deleted.statusCode, 204);

    const gone = await app.inject({
      method: "GET",
      url: `/api/v1/clusters/${id}`,
      headers: auth,
    });
    assert.equal(gone.statusCode, 404);
  } finally {
    await app.close();
  }
});

test("deleting a cluster removes it; unknown ids are 404", async () => {
  const { verify } = stubVerify();
  const app = await buildTestApp({ k8sVerify: verify });
  const auth = await authHeader();
  try {
    const projectId = await createProject(app, auth);
    const created = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/clusters`,
      headers: auth,
      payload: { name: "prod", kubeconfig: KUBECONFIG },
    });
    const id = created.json().id as string;

    const del = await app.inject({
      method: "DELETE",
      url: `/api/v1/clusters/${id}`,
      headers: auth,
    });
    assert.equal(del.statusCode, 204);

    const again = await app.inject({
      method: "DELETE",
      url: `/api/v1/clusters/${id}`,
      headers: auth,
    });
    assert.equal(again.statusCode, 404);
  } finally {
    await app.close();
  }
});

test("clusters are behind auth like every other protected route", async () => {
  const { verify } = stubVerify();
  const app = await buildTestApp({ k8sVerify: verify });
  try {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/clusters/00000000-0000-0000-0000-000000000000",
    });
    assert.equal(res.statusCode, 401);
  } finally {
    await app.close();
  }
});
