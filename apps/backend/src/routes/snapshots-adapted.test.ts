/**
 * GP-72: `GET /snapshots/:id/adapted` — the annotation layer folded into the
 * snapshot, end to end and through the real API, on a graph that carries every
 * one of the five annotation types at once.
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";

import { buildApp } from "../app.js";
import { loadEnv } from "../config/env.js";
import { annotations } from "../db/schema.js";
import { runMigrations } from "../db/migrate.js";
import { insertGraphSnapshot } from "../services/graph-snapshots.js";
import { validateGraph, type Graph } from "../graph/graph.js";

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
    payload: { name: "A", slug: `adapted-${Date.now()}-${counter}` },
  });
  const projectId = p.json().id;
  const r = await app.inject({
    method: "POST",
    url: `/api/v1/projects/${projectId}/repositories`,
    payload: { provider: "github", url: "https://github.com/acme/repo" },
  });
  return { projectId, repoId: r.json().id };
}

/** web → db, plus a cache nobody wants to see and a legacy box to rename. */
const GRAPH: Graph = {
  version: 1,
  nodes: ["web", "db", "cache", "legacy"].map((name) => ({
    id: `azurerm_x.${name}`,
    name,
    type: "azurerm_x",
    provider: "azurerm",
    module_path: [],
    change: null,
  })),
  edges: [
    { from: "azurerm_x.web", to: "azurerm_x.db", kind: "depends_on" },
    { from: "azurerm_x.web", to: "azurerm_x.cache", kind: "depends_on" },
  ],
};

const annotate = (app: FastifyInstance, repoId: string, payload: unknown) =>
  app.inject({
    method: "POST",
    url: `/api/v1/repositories/${repoId}/annotations`,
    payload: payload as Record<string, unknown>,
  });

test("the adapted snapshot folds in all five annotation types", async () => {
  const app = await buildApp(env);
  try {
    const { projectId, repoId } = await createRepo(app);
    const snapshot = await insertGraphSnapshot(app.db, {
      repositoryId: repoId,
      source: "hcl",
      ref: "refs/heads/main",
      commitSha: "sha-1",
      graph: GRAPH,
    });

    const front = await annotate(app, repoId, {
      type: "group",
      label: "Storefront",
      anchors: ["azurerm_x.web"],
    });
    const data = await annotate(app, repoId, {
      type: "group",
      label: "Data",
      anchors: ["azurerm_x.db"],
    });
    await annotate(app, repoId, { type: "hide", anchors: ["azurerm_x.cache"] });
    await annotate(app, repoId, {
      type: "rename",
      label: "Order ledger",
      anchors: ["azurerm_x.legacy"],
    });
    await annotate(app, repoId, {
      type: "note",
      body: "Owned by payments.",
      anchors: ["azurerm_x.db"],
    });
    await annotate(app, repoId, {
      type: "link",
      label: "replicates to",
      anchors: [front.json().id, data.json().id],
    });

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/snapshots/${snapshot.id}/adapted`,
    });
    assert.equal(res.statusCode, 200);
    const graph = res.json().graph as Graph;

    // It is a GraphSnapshot like any other — that is the contract renderers rely on.
    assert.equal(validateGraph(graph).valid, true);

    const ids = graph.nodes.map((n) => n.id);
    assert.equal(ids.includes(`group:${front.json().id}`), true);
    assert.equal(ids.includes(`group:${data.json().id}`), true);
    assert.equal(ids.includes("azurerm_x.cache"), false); // hidden

    const legacy = graph.nodes.find((n) => n.id === "azurerm_x.legacy");
    assert.equal(legacy?.display_label, "Order ledger");
    assert.equal(legacy?.name, "legacy");

    const db = graph.nodes.find((n) => n.id === "azurerm_x.db");
    assert.deepEqual(db?.notes, ["Owned by payments."]);

    const logical = graph.edges.filter((e) => e.kind === "logical");
    assert.equal(logical.length, 1);
    assert.equal(logical[0]?.from, `group:${front.json().id}`);
    assert.equal(logical[0]?.label, "replicates to");

    // No edge survives into a hidden node.
    assert.equal(
      graph.edges.some((e) => e.from === "azurerm_x.cache" || e.to === "azurerm_x.cache"),
      false,
    );

    // The stats describe the picture we are handing back, not the one we started from.
    assert.equal(res.json().stats.nodes, graph.nodes.length);

    await app.inject({ method: "DELETE", url: `/api/v1/projects/${projectId}` });
  } finally {
    await app.close();
  }
});

test("a proposal changes nothing until a human accepts it", async () => {
  const app = await buildApp(env);
  try {
    const { projectId, repoId } = await createRepo(app);
    const snapshot = await insertGraphSnapshot(app.db, {
      repositoryId: repoId,
      source: "hcl",
      ref: "refs/heads/main",
      commitSha: "sha-2",
      graph: GRAPH,
    });

    const hide = await annotate(app, repoId, {
      type: "hide",
      anchors: ["azurerm_x.cache"],
    });
    // Put it in the state the AI proposer (GP-75) would have stored it in. The
    // API has no way to *create* a proposal — that is the point.
    await app.db
      .update(annotations)
      .set({ status: "proposed", provenance: "ai" })
      .where(eq(annotations.id, hide.json().id));

    const before = await app.inject({
      method: "GET",
      url: `/api/v1/snapshots/${snapshot.id}/adapted`,
    });
    assert.equal(
      (before.json().graph as Graph).nodes.some((n) => n.id === "azurerm_x.cache"),
      true,
    );

    // Accepting is a status PATCH — and only then does the picture change.
    await app.inject({
      method: "PATCH",
      url: `/api/v1/annotations/${hide.json().id}`,
      payload: { status: "resolved" },
    });

    const after = await app.inject({
      method: "GET",
      url: `/api/v1/snapshots/${snapshot.id}/adapted`,
    });
    assert.equal(
      (after.json().graph as Graph).nodes.some((n) => n.id === "azurerm_x.cache"),
      false,
    );

    await app.inject({ method: "DELETE", url: `/api/v1/projects/${projectId}` });
  } finally {
    await app.close();
  }
});

test("404s for an unknown snapshot", async () => {
  const app = await buildApp(env);
  try {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/snapshots/00000000-0000-4000-8000-000000000000/adapted",
    });
    assert.equal(res.statusCode, 404);
  } finally {
    await app.close();
  }
});
