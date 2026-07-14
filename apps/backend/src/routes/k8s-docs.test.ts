import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { FastifyInstance } from "fastify";

import { buildApp } from "../app.js";
import { loadEnv } from "../config/env.js";
import { runMigrations } from "../db/migrate.js";

/**
 * The Kubernetes half of the living-docs flow (GP-102): a manifests repository is
 * documented from its default branch, and re-documented when main moves — the same
 * story GP-15/GP-23 tell for Terraform, told by the other producer.
 *
 * Integration: real HTTP, real Postgres, and a real (local) git repository. No
 * network: the remote is a `file://` fixture, as in GP-11's verifier tests.
 */
const env = loadEnv();
const exec = promisify(execFile);

let fixtureDir: string;
let fixtureUrl: string;
/** The commit that adds the worker — main moving under a repository we document. */
let secondSha: string;

const API_V1 = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: api
  namespace: prod
  labels:
    app: api
spec:
  replicas: 2
  template:
    metadata:
      labels:
        app: api
    spec:
      containers:
        - name: api
          image: acme/api:1.4.0
          envFrom:
            - configMapRef:
                name: settings
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
`;

/**
 * A manifests repository as they come: two namespaces, a multi-document file, a
 * values file that is not a manifest, and a Helm template that is not YAML.
 */
async function makeManifestFixture(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gp-k8s-fixture-"));
  const git = (args: string[]) => exec("git", args, { cwd: dir });
  await git(["init", "-b", "main"]);
  await git(["config", "user.email", "test@example.com"]);
  await git(["config", "user.name", "Fixture"]);

  await fs.mkdir(path.join(dir, "deploy", "prod"), { recursive: true });
  await fs.mkdir(path.join(dir, "deploy", "staging"), { recursive: true });
  await fs.mkdir(path.join(dir, "chart", "templates"), { recursive: true });

  await fs.writeFile(path.join(dir, "deploy", "prod", "api.yaml"), API_V1);
  await fs.writeFile(
    path.join(dir, "deploy", "prod", "settings.yaml"),
    "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: settings\n  namespace: prod\ndata:\n  LOG_LEVEL: info\n",
  );
  await fs.writeFile(
    path.join(dir, "deploy", "staging", "api.yaml"),
    "apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: api\n  namespace: staging\nspec:\n  replicas: 1\n",
  );
  // Not a manifest: no kind. Skipped by the rule, not by its filename.
  await fs.writeFile(path.join(dir, "deploy", "values.yaml"), "replicaCount: 2\n");
  // Go source that ends in .yaml. It cannot parse, and that is not an error.
  await fs.writeFile(
    path.join(dir, "chart", "templates", "deployment.yaml"),
    "spec:\n  {{- if .Values.expose }}\n  type: LoadBalancer\n  {{- end }}\n",
  );
  // A Terraform file in a manifests repository is simply not ours to read.
  await fs.writeFile(path.join(dir, "main.tf"), 'resource "aws_s3_bucket" "b" {}\n');

  await git(["add", "."]);
  await git(["commit", "-m", "init"]);

  // Main moves: a second workload lands in prod.
  await fs.writeFile(
    path.join(dir, "deploy", "prod", "worker.yaml"),
    "apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: worker\n  namespace: prod\nspec:\n  replicas: 1\n",
  );
  await git(["add", "."]);
  await git(["commit", "-m", "add worker"]);
  const { stdout } = await exec("git", ["rev-parse", "HEAD"], { cwd: dir });
  secondSha = stdout.trim();

  return dir;
}

let counter = 0;
async function createK8sRepo(
  app: FastifyInstance,
): Promise<{ projectId: string; repoId: string; webhookToken: string }> {
  counter += 1;
  const p = await app.inject({
    method: "POST",
    url: "/api/v1/projects",
    payload: { name: "K", slug: `k8sdocs-${Date.now()}-${counter}` },
  });
  const projectId = p.json().id;
  const r = await app.inject({
    method: "POST",
    url: `/api/v1/projects/${projectId}/repositories`,
    payload: {
      provider: "github",
      url: fixtureUrl,
      defaultBranch: "main",
      iacType: "kubernetes",
      terraformPath: "deploy",
    },
  });
  const repo = r.json();
  return { projectId, repoId: repo.id, webhookToken: repo.webhookToken };
}

before(async () => {
  await runMigrations(env.databaseUrl);
  fixtureDir = await makeManifestFixture();
  fixtureUrl = `file://${fixtureDir}`;
});

after(async () => {
  await fs.rm(fixtureDir, { recursive: true, force: true });
});

test("a manifests repository documents its default branch, and says what it skipped", async () => {
  const app = await buildApp(env);
  try {
    const { projectId, repoId } = await createK8sRepo(app);

    const generated = await app.inject({
      method: "POST",
      url: `/api/v1/repositories/${repoId}/docs/generate`,
    });
    assert.equal(generated.statusCode, 201);

    const latest = (
      await app.inject({ method: "GET", url: `/api/v1/repositories/${repoId}/docs/latest` })
    ).json();

    // An ordinary docs snapshot, produced by the other producer.
    assert.equal(latest.source, "k8s_manifest");
    assert.equal(latest.ref, "main");
    assert.equal(latest.prNumber, null);

    // Two namespaces, because a manifests repository routinely holds several —
    // unlike a live read, which is of exactly one.
    const ids = latest.graph.nodes.map((n: { id: string }) => n.id).sort();
    assert.deepEqual(ids, [
      "Namespace/prod",
      "Namespace/staging",
      "prod/ConfigMap/settings",
      "prod/Deployment/api",
      "prod/Deployment/worker",
      "prod/Service/api",
      "staging/Deployment/api",
    ]);

    // The relationships the manifests actually declare, and no others.
    const depends = latest.graph.edges
      .filter((e: { kind: string }) => e.kind === "depends_on")
      .map((e: { from: string; to: string }) => `${e.from} -> ${e.to}`)
      .sort();
    assert.deepEqual(depends, [
      "prod/Deployment/api -> prod/ConfigMap/settings",
      "prod/Service/api -> prod/Deployment/api",
    ]);

    // Loud by count: the values file and the Helm template were dropped, and the
    // snapshot says so rather than quietly presenting a partial picture.
    assert.equal(latest.stats.skippedDocuments, 1, "values.yaml");
    assert.equal(latest.stats.skippedFiles, 0, "the chart is outside the manifests root");
    assert.ok(latest.stats.warnings.some((w: string) => w.includes("not Kubernetes objects")));

    // The .tf file in the repository is not ours to read: this is a manifests repo.
    assert.ok(!ids.some((id: string) => id.includes("aws_s3_bucket")));

    await app.inject({ method: "DELETE", url: `/api/v1/projects/${projectId}` });
  } finally {
    await app.close();
  }
});

test("a merge to main re-documents a manifests repository (GP-23, the other producer)", async () => {
  const app = await buildApp(env);
  try {
    const { projectId, repoId, webhookToken } = await createK8sRepo(app);

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/webhooks/ci/${repoId}`,
      headers: { "x-groundplan-token": webhookToken },
      payload: {
        event: "push",
        ref: "refs/heads/main",
        commit_sha: secondSha,
        payload: {},
      },
    });
    assert.equal(res.statusCode, 202);
    await app.flushBackgroundTasks();

    const latest = (
      await app.inject({ method: "GET", url: `/api/v1/repositories/${repoId}/docs/latest` })
    ).json();
    assert.equal(latest.source, "k8s_manifest");
    assert.equal(latest.commitSha, secondSha);
    assert.equal(latest.stats.trigger, "auto");
    assert.ok(
      latest.graph.nodes.some((n: { id: string }) => n.id === "prod/Deployment/worker"),
    );

    await app.inject({ method: "DELETE", url: `/api/v1/projects/${projectId}` });
  } finally {
    await app.close();
  }
});

test("two manifest snapshots diff like any other documentation (GP-40, unchanged)", async () => {
  const app = await buildApp(env);
  try {
    const { projectId, repoId } = await createK8sRepo(app);

    const first = await app.inject({
      method: "POST",
      url: `/api/v1/repositories/${repoId}/docs/generate`,
    });
    const second = await app.inject({
      method: "POST",
      url: `/api/v1/repositories/${repoId}/docs/generate`,
    });
    assert.equal(second.statusCode, 201);

    const diff = await app.inject({
      method: "GET",
      url: `/api/v1/snapshots/${first.json().id}/diff/${second.json().id}`,
    });
    assert.equal(diff.statusCode, 200);
    // The same tree twice: nothing appeared, nothing left. The point is that the
    // GP-40 machinery answers at all for a Kubernetes pair — it needed no changes.
    assert.deepEqual(diff.json().added, []);
    assert.deepEqual(diff.json().removed, []);
    assert.equal(diff.json().unchangedCount, 7);

    await app.inject({ method: "DELETE", url: `/api/v1/projects/${projectId}` });
  } finally {
    await app.close();
  }
});
