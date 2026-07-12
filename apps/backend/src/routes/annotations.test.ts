import { test, before } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";

import { buildApp } from "../app.js";
import { loadEnv } from "../config/env.js";
import { runMigrations } from "../db/migrate.js";
import { insertGraphSnapshot } from "../services/graph-snapshots.js";
import type { Graph } from "../graph/graph.js";

const env = loadEnv();

before(async () => {
  await runMigrations(env.databaseUrl);
});

let counter = 0;
async function createRepo(app: FastifyInstance) {
  counter += 1;
  const p = await app.inject({
    method: "POST",
    url: "/api/v1/projects",
    payload: { name: "A", slug: `annroute-${Date.now()}-${counter}` },
  });
  const projectId = p.json().id;
  const r = await app.inject({
    method: "POST",
    url: `/api/v1/projects/${projectId}/repositories`,
    payload: { provider: "github", url: "https://github.com/acme/repo" },
  });
  return { projectId, repoId: r.json().id };
}

function create(app: FastifyInstance, repoId: string, payload: unknown) {
  return app.inject({
    method: "POST",
    url: `/api/v1/repositories/${repoId}/annotations`,
    payload: payload as Record<string, unknown>,
  });
}

function graph(nodeIds: string[]): Graph {
  return {
    version: 1,
    nodes: nodeIds.map((id) => ({
      id,
      name: id.split(".").pop() ?? id,
      type: "aws_s3_bucket",
      provider: "aws",
      module_path: [],
      change: null,
    })),
    edges: [],
  };
}

test("creates and lists the three annotation types with anchor-count rules", async () => {
  const app = await buildApp(env);
  try {
    const { projectId, repoId } = await createRepo(app);

    const note = await create(app, repoId, {
      type: "note",
      anchors: ["aws_s3_bucket.a"],
      body: "**owned by** payments",
    });
    assert.equal(note.statusCode, 201);
    assert.equal(note.json().type, "note");
    assert.equal(note.json().status, "resolved");
    assert.equal(note.json().body, "**owned by** payments");

    const link = await create(app, repoId, {
      type: "link",
      anchors: ["aws_s3_bucket.a", "aws_s3_bucket.b"],
      label: "replicates to",
    });
    assert.equal(link.statusCode, 201);
    assert.equal(link.json().label, "replicates to");

    const group = await create(app, repoId, {
      type: "group",
      anchors: ["aws_s3_bucket.a", "aws_s3_bucket.b", "aws_s3_bucket.c"],
      label: "data lake",
    });
    assert.equal(group.statusCode, 201);

    const list = await app.inject({
      method: "GET",
      url: `/api/v1/repositories/${repoId}/annotations`,
    });
    assert.equal(list.statusCode, 200);
    assert.equal(list.json().length, 3);

    await app.inject({ method: "DELETE", url: `/api/v1/projects/${projectId}` });
  } finally {
    await app.close();
  }
});

test("enforces per-type anchor counts", async () => {
  const app = await buildApp(env);
  try {
    const { projectId, repoId } = await createRepo(app);

    const noteTwo = await create(app, repoId, {
      type: "note",
      anchors: ["aws_s3_bucket.a", "aws_s3_bucket.b"],
      body: "x",
    });
    assert.equal(noteTwo.statusCode, 422);

    const linkOne = await create(app, repoId, {
      type: "link",
      anchors: ["aws_s3_bucket.a"],
      label: "x",
    });
    assert.equal(linkOne.statusCode, 422);

    const groupOne = await create(app, repoId, {
      type: "group",
      anchors: ["aws_s3_bucket.a"],
      label: "x",
    });
    assert.equal(groupOne.statusCode, 422);

    await app.inject({ method: "DELETE", url: `/api/v1/projects/${projectId}` });
  } finally {
    await app.close();
  }
});

test("rejects invalid Terraform address format with a clear message", async () => {
  const app = await buildApp(env);
  try {
    const { projectId, repoId } = await createRepo(app);

    const bad = await create(app, repoId, {
      type: "note",
      anchors: ["not a valid address"],
      body: "x",
    });
    assert.equal(bad.statusCode, 422);
    assert.match(bad.json().message, /address/i);

    await app.inject({ method: "DELETE", url: `/api/v1/projects/${projectId}` });
  } finally {
    await app.close();
  }
});

test("requires a label for link/group and rejects a body on non-notes", async () => {
  const app = await buildApp(env);
  try {
    const { projectId, repoId } = await createRepo(app);

    const noLabel = await create(app, repoId, {
      type: "link",
      anchors: ["aws_s3_bucket.a", "aws_s3_bucket.b"],
    });
    assert.equal(noLabel.statusCode, 422);

    const bodyOnGroup = await create(app, repoId, {
      type: "group",
      anchors: ["aws_s3_bucket.a", "aws_s3_bucket.b"],
      label: "x",
      body: "not allowed",
    });
    assert.equal(bodyOnGroup.statusCode, 422);

    await app.inject({ method: "DELETE", url: `/api/v1/projects/${projectId}` });
  } finally {
    await app.close();
  }
});

test("updates and deletes an annotation", async () => {
  const app = await buildApp(env);
  try {
    const { projectId, repoId } = await createRepo(app);
    const created = await create(app, repoId, {
      type: "note",
      anchors: ["aws_s3_bucket.a"],
      body: "before",
    });
    const id = created.json().id;

    const patched = await app.inject({
      method: "PATCH",
      url: `/api/v1/annotations/${id}`,
      payload: { body: "after", anchors: ["aws_s3_bucket.z"] },
    });
    assert.equal(patched.statusCode, 200);
    assert.equal(patched.json().body, "after");
    assert.deepEqual(patched.json().anchors, ["aws_s3_bucket.z"]);

    const del = await app.inject({
      method: "DELETE",
      url: `/api/v1/annotations/${id}`,
    });
    assert.equal(del.statusCode, 204);

    const get = await app.inject({
      method: "GET",
      url: `/api/v1/annotations/${id}`,
    });
    assert.equal(get.statusCode, 404);

    await app.inject({ method: "DELETE", url: `/api/v1/projects/${projectId}` });
  } finally {
    await app.close();
  }
});

test("a note survives snapshot regeneration untouched (layer separation)", async () => {
  const app = await buildApp(env);
  try {
    const { projectId, repoId } = await createRepo(app);
    const created = await create(app, repoId, {
      type: "note",
      anchors: ["aws_s3_bucket.a"],
      body: "keep me",
    });
    const id = created.json().id;

    // Regenerating the graph snapshot must never touch the annotation layer.
    await insertGraphSnapshot(app.db, {
      repositoryId: repoId,
      source: "hcl",
      ref: "refs/heads/main",
      commitSha: "sha-1",
      graph: graph(["aws_s3_bucket.a"]),
    });

    const get = await app.inject({
      method: "GET",
      url: `/api/v1/annotations/${id}`,
    });
    assert.equal(get.statusCode, 200);
    assert.equal(get.json().body, "keep me");

    await app.inject({ method: "DELETE", url: `/api/v1/projects/${projectId}` });
  } finally {
    await app.close();
  }
});

test("404s for unknown repository and unknown annotation", async () => {
  const app = await buildApp(env);
  try {
    const missing = "00000000-0000-4000-8000-000000000000";
    const list = await app.inject({
      method: "GET",
      url: `/api/v1/repositories/${missing}/annotations`,
    });
    assert.equal(list.statusCode, 404);

    const createMissing = await create(app, missing, {
      type: "note",
      anchors: ["aws_s3_bucket.a"],
      body: "x",
    });
    assert.equal(createMissing.statusCode, 404);

    const getMissing = await app.inject({
      method: "GET",
      url: `/api/v1/annotations/${missing}`,
    });
    assert.equal(getMissing.statusCode, 404);
  } finally {
    await app.close();
  }
});
