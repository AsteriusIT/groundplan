import { test, before } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";

import { buildApp } from "../app.js";
import { seedOrg } from "../test-support.js";
import { loadEnv } from "../config/env.js";
import { runMigrations } from "../db/migrate.js";
import { insertGraphSnapshot } from "../services/graph-snapshots.js";
import type { Graph } from "../graph/graph.js";

const env = loadEnv();

before(async () => {
  await runMigrations(env.databaseUrl);
});

let counter = 0;
async function createRepo(app: FastifyInstance, orgId: string) {
  counter += 1;
  const p = await app.inject({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/projects`,
    payload: { name: "A", slug: `annroute-${Date.now()}-${counter}` },
  });
  const projectId = p.json().id;
  const r = await app.inject({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/projects/${projectId}/repositories`,
    payload: { provider: "github", url: "https://github.com/acme/repo" },
  });
  return { projectId, repoId: r.json().id };
}

function create(app: FastifyInstance, orgId: string, repoId: string, payload: unknown) {
  return app.inject({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/repositories/${repoId}/annotations`,
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
    const orgId = await seedOrg(app);
    const { projectId, repoId } = await createRepo(app, orgId);

    const note = await create(app, orgId, repoId, {
      type: "note",
      anchors: ["aws_s3_bucket.a"],
      body: "**owned by** payments",
    });
    assert.equal(note.statusCode, 201);
    assert.equal(note.json().type, "note");
    assert.equal(note.json().status, "resolved");
    assert.equal(note.json().body, "**owned by** payments");

    const link = await create(app, orgId, repoId, {
      type: "link",
      anchors: ["aws_s3_bucket.a", "aws_s3_bucket.b"],
      label: "replicates to",
    });
    assert.equal(link.statusCode, 201);
    assert.equal(link.json().label, "replicates to");

    const group = await create(app, orgId, repoId, {
      type: "group",
      anchors: ["aws_s3_bucket.a", "aws_s3_bucket.b", "aws_s3_bucket.c"],
      label: "data lake",
    });
    assert.equal(group.statusCode, 201);

    const list = await app.inject({
      method: "GET",
      url: `/api/v1/orgs/${orgId}/repositories/${repoId}/annotations`,
    });
    assert.equal(list.statusCode, 200);
    assert.equal(list.json().length, 3);

    await app.inject({ method: "DELETE", url: `/api/v1/orgs/${orgId}/projects/${projectId}` });
  } finally {
    await app.close();
  }
});

test("enforces per-type anchor counts", async () => {
  const app = await buildApp(env);
  try {
    const orgId = await seedOrg(app);
    const { projectId, repoId } = await createRepo(app, orgId);

    const noteTwo = await create(app, orgId, repoId, {
      type: "note",
      anchors: ["aws_s3_bucket.a", "aws_s3_bucket.b"],
      body: "x",
    });
    assert.equal(noteTwo.statusCode, 422);

    const linkOne = await create(app, orgId, repoId, {
      type: "link",
      anchors: ["aws_s3_bucket.a"],
      label: "x",
    });
    assert.equal(linkOne.statusCode, 422);

    // A group of one is legitimate (GP-71): one resource can be a system on its
    // own, and a group whose siblings are hidden must not become invalid.
    const groupOne = await create(app, orgId, repoId, {
      type: "group",
      anchors: ["aws_s3_bucket.a"],
      label: "x",
    });
    assert.equal(groupOne.statusCode, 201);

    const hideTwo = await create(app, orgId, repoId, {
      type: "hide",
      anchors: ["aws_s3_bucket.a", "aws_s3_bucket.b"],
    });
    assert.equal(hideTwo.statusCode, 422);

    await app.inject({ method: "DELETE", url: `/api/v1/orgs/${orgId}/projects/${projectId}` });
  } finally {
    await app.close();
  }
});

test("rejects invalid Terraform address format with a clear message", async () => {
  const app = await buildApp(env);
  try {
    const orgId = await seedOrg(app);
    const { projectId, repoId } = await createRepo(app, orgId);

    const bad = await create(app, orgId, repoId, {
      type: "note",
      anchors: ["not a valid address"],
      body: "x",
    });
    assert.equal(bad.statusCode, 422);
    assert.match(bad.json().message, /address/i);

    await app.inject({ method: "DELETE", url: `/api/v1/orgs/${orgId}/projects/${projectId}` });
  } finally {
    await app.close();
  }
});

test("requires a label for group/rename and rejects a body on non-notes", async () => {
  const app = await buildApp(env);
  try {
    const orgId = await seedOrg(app);
    const { projectId, repoId } = await createRepo(app, orgId);

    // A logical edge's label is optional (GP-71) — saying *that* two things are
    // joined is worth drawing even when you have no name for the relationship.
    const noLabel = await create(app, orgId, repoId, {
      type: "link",
      anchors: ["aws_s3_bucket.a", "aws_s3_bucket.b"],
    });
    assert.equal(noLabel.statusCode, 201);
    assert.equal(noLabel.json().label, null);

    const renameNoLabel = await create(app, orgId, repoId, {
      type: "rename",
      anchors: ["aws_s3_bucket.a"],
    });
    assert.equal(renameNoLabel.statusCode, 422);

    const bodyOnGroup = await create(app, orgId, repoId, {
      type: "group",
      anchors: ["aws_s3_bucket.a", "aws_s3_bucket.b"],
      label: "x",
      body: "not allowed",
    });
    assert.equal(bodyOnGroup.statusCode, 422);

    await app.inject({ method: "DELETE", url: `/api/v1/orgs/${orgId}/projects/${projectId}` });
  } finally {
    await app.close();
  }
});

test("creates hide and rename annotations, human-provenanced by default", async () => {
  const app = await buildApp(env);
  try {
    const orgId = await seedOrg(app);
    const { projectId, repoId } = await createRepo(app, orgId);

    const hide = await create(app, orgId, repoId, {
      type: "hide",
      anchors: ["aws_s3_bucket.a"],
      createdFromSha: "abc1234",
    });
    assert.equal(hide.statusCode, 201);
    assert.equal(hide.json().provenance, "human");
    assert.equal(hide.json().status, "resolved");
    assert.equal(hide.json().createdFromSha, "abc1234");

    const rename = await create(app, orgId, repoId, {
      type: "rename",
      anchors: ["aws_s3_bucket.a"],
      label: "Customer uploads",
    });
    assert.equal(rename.statusCode, 201);
    assert.equal(rename.json().label, "Customer uploads");

    await app.inject({ method: "DELETE", url: `/api/v1/orgs/${orgId}/projects/${projectId}` });
  } finally {
    await app.close();
  }
});

test("a logical edge may anchor to a group id", async () => {
  const app = await buildApp(env);
  try {
    const orgId = await seedOrg(app);
    const { projectId, repoId } = await createRepo(app, orgId);

    const group = await create(app, orgId, repoId, {
      type: "group",
      anchors: ["aws_s3_bucket.a"],
      label: "Payments",
    });
    const edge = await create(app, orgId, repoId, {
      type: "link",
      anchors: [group.json().id, "aws_s3_bucket.b"],
      label: "publishes to",
    });
    assert.equal(edge.statusCode, 201);

    // ...but only a link may. A note anchored to a uuid is not a Terraform address.
    const note = await create(app, orgId, repoId, {
      type: "note",
      anchors: [group.json().id],
      body: "x",
    });
    assert.equal(note.statusCode, 422);

    await app.inject({ method: "DELETE", url: `/api/v1/orgs/${orgId}/projects/${projectId}` });
  } finally {
    await app.close();
  }
});

test("groups nest one level — a grandchild group is rejected", async () => {
  const app = await buildApp(env);
  try {
    const orgId = await seedOrg(app);
    const { projectId, repoId } = await createRepo(app, orgId);

    const parent = await create(app, orgId, repoId, {
      type: "group",
      anchors: ["aws_s3_bucket.a"],
      label: "Platform",
    });
    const child = await create(app, orgId, repoId, {
      type: "group",
      anchors: ["aws_s3_bucket.b"],
      label: "Payments",
      parentGroupId: parent.json().id,
    });
    assert.equal(child.statusCode, 201);
    assert.equal(child.json().parentGroupId, parent.json().id);

    const grandchild = await create(app, orgId, repoId, {
      type: "group",
      anchors: ["aws_s3_bucket.c"],
      label: "Ledger",
      parentGroupId: child.json().id,
    });
    assert.equal(grandchild.statusCode, 422);
    assert.match(grandchild.json().message, /one level/i);

    // Only groups nest.
    const nestedNote = await create(app, orgId, repoId, {
      type: "note",
      anchors: ["aws_s3_bucket.a"],
      body: "x",
      parentGroupId: parent.json().id,
    });
    assert.equal(nestedNote.statusCode, 422);

    await app.inject({ method: "DELETE", url: `/api/v1/orgs/${orgId}/projects/${projectId}` });
  } finally {
    await app.close();
  }
});

test("?snapshotId= re-resolves anchors on demand without persisting", async () => {
  const app = await buildApp(env);
  try {
    const orgId = await seedOrg(app);
    const { projectId, repoId } = await createRepo(app, orgId);
    const created = await create(app, orgId, repoId, {
      type: "note",
      anchors: ["aws_s3_bucket.a"],
      body: "x",
    });
    assert.equal(created.json().status, "resolved");

    // A snapshot in which the anchored address does not exist.
    const snapshot = await insertGraphSnapshot(app.db, {
      repositoryId: repoId,
      source: "hcl",
      ref: "refs/heads/main",
      commitSha: "sha-empty",
      graph: graph(["aws_s3_bucket.other"]),
    });

    const against = await app.inject({
      method: "GET",
      url: `/api/v1/orgs/${orgId}/repositories/${repoId}/annotations?snapshotId=${snapshot.id}`,
    });
    assert.equal(against.statusCode, 200);
    assert.equal(against.json()[0].status, "orphaned");
    assert.deepEqual(against.json()[0].missingAnchors, ["aws_s3_bucket.a"]);

    // The stored row is untouched — a GET decides nothing.
    const stored = await app.inject({
      method: "GET",
      url: `/api/v1/orgs/${orgId}/annotations/${created.json().id}`,
    });
    assert.equal(stored.json().status, "resolved");

    await app.inject({ method: "DELETE", url: `/api/v1/orgs/${orgId}/projects/${projectId}` });
  } finally {
    await app.close();
  }
});

test("updates and deletes an annotation", async () => {
  const app = await buildApp(env);
  try {
    const orgId = await seedOrg(app);
    const { projectId, repoId } = await createRepo(app, orgId);
    const created = await create(app, orgId, repoId, {
      type: "note",
      anchors: ["aws_s3_bucket.a"],
      body: "before",
    });
    const id = created.json().id;

    const patched = await app.inject({
      method: "PATCH",
      url: `/api/v1/orgs/${orgId}/annotations/${id}`,
      payload: { body: "after", anchors: ["aws_s3_bucket.z"] },
    });
    assert.equal(patched.statusCode, 200);
    assert.equal(patched.json().body, "after");
    assert.deepEqual(patched.json().anchors, ["aws_s3_bucket.z"]);

    const del = await app.inject({
      method: "DELETE",
      url: `/api/v1/orgs/${orgId}/annotations/${id}`,
    });
    assert.equal(del.statusCode, 204);

    const get = await app.inject({
      method: "GET",
      url: `/api/v1/orgs/${orgId}/annotations/${id}`,
    });
    assert.equal(get.statusCode, 404);

    await app.inject({ method: "DELETE", url: `/api/v1/orgs/${orgId}/projects/${projectId}` });
  } finally {
    await app.close();
  }
});

test("a note survives snapshot regeneration untouched (layer separation)", async () => {
  const app = await buildApp(env);
  try {
    const orgId = await seedOrg(app);
    const { projectId, repoId } = await createRepo(app, orgId);
    const created = await create(app, orgId, repoId, {
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
      url: `/api/v1/orgs/${orgId}/annotations/${id}`,
    });
    assert.equal(get.statusCode, 200);
    assert.equal(get.json().body, "keep me");

    await app.inject({ method: "DELETE", url: `/api/v1/orgs/${orgId}/projects/${projectId}` });
  } finally {
    await app.close();
  }
});

test("404s for unknown repository and unknown annotation", async () => {
  const app = await buildApp(env);
  try {
    const orgId = await seedOrg(app);
    const missing = "00000000-0000-4000-8000-000000000000";
    const list = await app.inject({
      method: "GET",
      url: `/api/v1/orgs/${orgId}/repositories/${missing}/annotations`,
    });
    assert.equal(list.statusCode, 404);

    const createMissing = await create(app, orgId, missing, {
      type: "note",
      anchors: ["aws_s3_bucket.a"],
      body: "x",
    });
    assert.equal(createMissing.statusCode, 404);

    const getMissing = await app.inject({
      method: "GET",
      url: `/api/v1/orgs/${orgId}/annotations/${missing}`,
    });
    assert.equal(getMissing.statusCode, 404);
  } finally {
    await app.close();
  }
});
