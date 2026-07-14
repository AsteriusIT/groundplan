/**
 * GP-78, end to end through the route — against a stub model, always.
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";

import { buildApp } from "../app.js";
import { loadEnv } from "../config/env.js";
import { runMigrations } from "../db/migrate.js";
import { insertGraphSnapshot } from "../services/graph-snapshots.js";
import type { AiProvider, AiStream } from "../services/ai.js";
import type { Graph } from "../graph/graph.js";

const env = loadEnv();

before(async () => {
  await runMigrations(env.databaseUrl);
});

/** A plan graph: one thing added, one deleted, one impacted by the addition. */
const PLAN_GRAPH: Graph = {
  version: 2,
  nodes: [
    {
      id: "azurerm_servicebus_queue.ingest",
      name: "ingest",
      type: "azurerm_servicebus_queue",
      provider: "azurerm",
      module_path: [],
      change: "create",
    },
    {
      id: "azurerm_storage_account.legacy",
      name: "legacy",
      type: "azurerm_storage_account",
      provider: "azurerm",
      module_path: [],
      change: "delete",
    },
    {
      id: "azurerm_function_app.worker",
      name: "worker",
      type: "azurerm_function_app",
      provider: "azurerm",
      module_path: [],
      change: "noop",
      impacted: true,
    },
  ],
  edges: [
    {
      from: "azurerm_function_app.worker",
      to: "azurerm_servicebus_queue.ingest",
      kind: "depends_on",
    },
  ],
};

const DOCS_GRAPH: Graph = {
  version: 1,
  nodes: ["web", "db"].map((name) => ({
    id: `azurerm_x.${name}`,
    name,
    type: "azurerm_x",
    provider: "azurerm",
    module_path: [],
    change: null,
  })),
  edges: [{ from: "azurerm_x.web", to: "azurerm_x.db", kind: "depends_on" }],
};

function stubProvider(answer: string): AiProvider & { calls: number; prompts: string[] } {
  const stub = {
    calls: 0,
    prompts: [] as string[],
    model: "test-model",
    stream({ prompt }: { system: string; prompt: string }): AiStream {
      stub.calls += 1;
      stub.prompts.push(prompt);
      return {
        // eslint-disable-next-line @typescript-eslint/require-await
        textStream: (async function* () {
          yield answer;
        })(),
        usage: Promise.resolve({ inputTokens: 100, outputTokens: 20 }),
      };
    },
  };
  return stub;
}

const CHANGE_TOUR = JSON.stringify({
  title: "Adds an ingestion queue, retires the old blob store",
  steps: [
    { anchors: [], title: "What this change does", body: "Two resources move." },
    {
      anchors: ["azurerm_servicebus_queue.ingest"],
      title: "The new queue",
      body: "Everything added hangs off `ingest`.",
    },
    {
      anchors: ["azurerm_storage_account.legacy"],
      title: "The old blob store goes",
      body: "Check its data is retained.",
    },
  ],
});

const SYSTEM_TOUR = JSON.stringify({
  title: "A web tier and its database",
  steps: [
    { anchors: [], title: "What this is", body: "A small estate." },
    { anchors: ["azurerm_x.web"], title: "The web tier", body: "Serves traffic." },
  ],
});

let counter = 0;
async function seed(app: FastifyInstance) {
  counter += 1;
  const p = await app.inject({
    method: "POST",
    url: "/api/v1/projects",
    payload: { name: "P", slug: `tours-${Date.now()}-${counter}` },
  });
  const projectId = p.json().id;
  const r = await app.inject({
    method: "POST",
    url: `/api/v1/projects/${projectId}/repositories`,
    payload: { provider: "github", url: "https://github.com/acme/repo" },
  });
  const repoId = r.json().id;

  const plan = await insertGraphSnapshot(app.db, {
    repositoryId: repoId,
    source: "plan",
    ref: "refs/heads/feature",
    commitSha: "sha-plan",
    prNumber: 128,
    graph: PLAN_GRAPH,
  });
  const docs = await insertGraphSnapshot(app.db, {
    repositoryId: repoId,
    source: "hcl",
    ref: "refs/heads/main",
    commitSha: "sha-docs",
    graph: DOCS_GRAPH,
  });
  return { projectId, repoId, planId: plan.id, docsId: docs.id };
}

const tour = (app: FastifyInstance, id: string, payload?: object) =>
  app.inject({ method: "POST", url: `/api/v1/snapshots/${id}/tour`, payload });

const cleanup = (app: FastifyInstance, projectId: string) =>
  app.inject({ method: "DELETE", url: `/api/v1/projects/${projectId}` });

test("a plan snapshot gets a change tour; the caller never names a kind", async () => {
  const ai = stubProvider(CHANGE_TOUR);
  const app = await buildApp(env, { ai });
  try {
    const { projectId, planId } = await seed(app);

    const res = await tour(app, planId);
    assert.equal(res.statusCode, 200);

    const body = res.json();
    assert.equal(body.tour.view, "infra");
    assert.equal(body.tour.title, "Adds an ingestion queue, retires the old blob store");
    assert.equal(body.tour.steps.length, 3);
    // The opener frames the whole diagram: it is about the change, not a resource.
    assert.deepEqual(body.tour.steps[0].anchors, []);
    assert.deepEqual(body.tour.steps[1].anchors, ["azurerm_servicebus_queue.ingest"]);
    assert.equal(body.model, "test-model");

    await cleanup(app, projectId);
  } finally {
    await app.close();
  }
});

test("an hcl snapshot gets a system tour off the same route", async () => {
  const ai = stubProvider(SYSTEM_TOUR);
  const app = await buildApp(env, { ai });
  try {
    const { projectId, docsId } = await seed(app);

    const res = await tour(app, docsId);
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().tour.title, "A web tier and its database");
    // No groups on this repo, so there is nothing the adapted lens would add —
    // don't move the user off the view they are already on.
    assert.equal(res.json().tour.view, "infra");

    await cleanup(app, projectId);
  } finally {
    await app.close();
  }
});

test("asking twice never reaches the model again — and the tour is identical", async () => {
  const ai = stubProvider(CHANGE_TOUR);
  const app = await buildApp(env, { ai });
  try {
    const { projectId, planId } = await seed(app);

    const first = await tour(app, planId);
    assert.equal(ai.calls, 1);

    const second = await tour(app, planId);
    assert.equal(second.statusCode, 200);
    assert.equal(ai.calls, 1, "the cached tour was replayed, not regenerated");
    assert.equal(second.json().cached, true);
    assert.deepEqual(second.json().tour, first.json().tour);

    // ...and regenerating really does ask again.
    const again = await tour(app, planId, { regenerate: true });
    assert.equal(again.statusCode, 200);
    assert.equal(ai.calls, 2);
    assert.equal(again.json().cached, false);

    await cleanup(app, projectId);
  } finally {
    await app.close();
  }
});

test("GET returns the tour once it exists, and 404 before that", async () => {
  const ai = stubProvider(CHANGE_TOUR);
  const app = await buildApp(env, { ai });
  try {
    const { projectId, planId } = await seed(app);

    const before = await app.inject({ url: `/api/v1/snapshots/${planId}/tour` });
    assert.equal(before.statusCode, 404, "never generated is not the same as empty");
    assert.equal(ai.calls, 0, "GET is a read — it must never spend money");

    await tour(app, planId);

    const after = await app.inject({ url: `/api/v1/snapshots/${planId}/tour` });
    assert.equal(after.statusCode, 200);
    assert.equal(after.json().tour.steps.length, 3);
    assert.equal(ai.calls, 1);

    await cleanup(app, projectId);
  } finally {
    await app.close();
  }
});

test("a stop the camera cannot fly to is dropped; the tour still plays", async () => {
  const partly = JSON.stringify({
    title: "T",
    steps: [
      { anchors: ["azurerm_x.ghost"], title: "Invented", body: "B" },
      { anchors: ["azurerm_servicebus_queue.ingest"], title: "Real", body: "B" },
    ],
  });
  const ai = stubProvider(partly);
  const app = await buildApp(env, { ai });
  try {
    const { projectId, planId } = await seed(app);

    const res = await tour(app, planId);
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().dropped, 1);
    assert.deepEqual(
      res.json().tour.steps.map((s: { title: string }) => s.title),
      ["Real"],
    );

    await cleanup(app, projectId);
  } finally {
    await app.close();
  }
});

test("an unusable response is a 502 and stores nothing — not even in the cache", async () => {
  const ai = stubProvider("I'm sorry, I can't do that.");
  const app = await buildApp(env, { ai });
  try {
    const { projectId, planId } = await seed(app);

    const res = await tour(app, planId);
    assert.equal(res.statusCode, 502);

    // Retriable: the failure was not cached, so a second attempt really does reach
    // the model again. A cached error is an error served forever.
    await tour(app, planId);
    assert.equal(ai.calls, 2);

    // ...and nothing is left behind for the GET to find.
    const get = await app.inject({ url: `/api/v1/snapshots/${planId}/tour` });
    assert.equal(get.statusCode, 404);

    await cleanup(app, projectId);
  } finally {
    await app.close();
  }
});

test("a tour whose every stop is invented is a failure, not an empty tour", async () => {
  // The proposer may respectably have nothing to suggest. A tour may not: it was
  // asked for a walk through this diagram and produced one that goes nowhere.
  const ghosts = JSON.stringify({
    title: "T",
    steps: [{ anchors: ["azurerm_x.ghost"], title: "Nowhere", body: "B" }],
  });
  const ai = stubProvider(ghosts);
  const app = await buildApp(env, { ai });
  try {
    const { projectId, planId } = await seed(app);

    const res = await tour(app, planId);
    assert.equal(res.statusCode, 502);
    assert.equal((await app.inject({ url: `/api/v1/snapshots/${planId}/tour` })).statusCode, 404);

    await cleanup(app, projectId);
  } finally {
    await app.close();
  }
});

test("with the AI layer off the endpoint does not exist", async () => {
  const app = await buildApp(env);
  try {
    const { projectId, planId } = await seed(app);
    assert.equal((await tour(app, planId)).statusCode, 404);
    assert.equal(
      (await app.inject({ url: `/api/v1/snapshots/${planId}/tour` })).statusCode,
      404,
    );
    await cleanup(app, projectId);
  } finally {
    await app.close();
  }
});

test("the brief names every id the tour is allowed to stop at — and never the raw graph", async () => {
  const ai = stubProvider(CHANGE_TOUR);
  const app = await buildApp(env, { ai });
  try {
    const { projectId, planId } = await seed(app);
    await tour(app, planId);

    const brief = ai.prompts[0] ?? "";
    assert.match(brief, /## Stops you may anchor to \(use these ids, exactly as written\)/);
    assert.match(brief, /`azurerm_servicebus_queue\.ingest` \| azurerm_servicebus_queue \| created/);
    assert.match(brief, /`azurerm_storage_account\.legacy` \| azurerm_storage_account \| deleted/);
    // The impacted worker is in the neighbourhood of the change, so it is a stop
    // the tour may make — that is exactly the kind of thing a reviewer needs shown.
    assert.match(brief, /`azurerm_function_app\.worker` \| azurerm_function_app \| impacted/);
    assert.doesNotMatch(brief, /"nodes":/);

    await cleanup(app, projectId);
  } finally {
    await app.close();
  }
});

test("a second, overlapping generation is refused rather than paid for twice", async () => {
  // A provider that never finishes, so the first request is still in flight when
  // the second arrives — a double-clicked "Take the tour" must cost one tour.
  const hanging: AiProvider = {
    model: "test-model",
    stream(): AiStream {
      return {
        // eslint-disable-next-line @typescript-eslint/require-await
        textStream: (async function* () {
          await new Promise(() => undefined);
          yield "";
        })(),
        usage: Promise.resolve({ inputTokens: null, outputTokens: null }),
      };
    },
  };
  const app = await buildApp(env, { ai: hanging });
  try {
    const { projectId, planId } = await seed(app);

    const first = tour(app, planId);
    // Let the first request reach (and pass) the lock before the second arrives.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const second = await tour(app, planId);

    assert.equal(second.statusCode, 409);

    void first;
    await cleanup(app, projectId);
  } finally {
    await app.close();
  }
});
