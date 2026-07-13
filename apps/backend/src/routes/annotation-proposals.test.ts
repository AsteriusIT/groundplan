/**
 * GP-75, end to end through the route — against a stub model, always.
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

const GRAPH: Graph = {
  version: 1,
  nodes: ["web", "db", "suffix"].map((name) => ({
    id: `azurerm_x.${name}`,
    name,
    type: "azurerm_x",
    provider: "azurerm",
    module_path: [],
    change: null,
  })),
  edges: [{ from: "azurerm_x.web", to: "azurerm_x.db", kind: "depends_on" }],
};

/** A model that answers with a fixed script and counts how often it was asked. */
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

const GOOD = JSON.stringify({
  proposals: [
    {
      type: "group",
      anchors: ["azurerm_x.web", "azurerm_x.db"],
      label: "Storefront",
      reason: "The web tier and the database it reads.",
    },
    { type: "hide", anchors: ["azurerm_x.suffix"], reason: "Naming plumbing." },
  ],
});

let counter = 0;
async function seed(app: FastifyInstance) {
  counter += 1;
  const p = await app.inject({
    method: "POST",
    url: "/api/v1/projects",
    payload: { name: "P", slug: `proposals-${Date.now()}-${counter}` },
  });
  const projectId = p.json().id;
  const r = await app.inject({
    method: "POST",
    url: `/api/v1/projects/${projectId}/repositories`,
    payload: { provider: "github", url: "https://github.com/acme/repo" },
  });
  const repoId = r.json().id;
  const snapshot = await insertGraphSnapshot(app.db, {
    repositoryId: repoId,
    source: "hcl",
    ref: "refs/heads/main",
    commitSha: "sha-1",
    graph: GRAPH,
  });
  return { projectId, repoId, snapshotId: snapshot.id };
}

const propose = (app: FastifyInstance, snapshotId: string) =>
  app.inject({
    method: "POST",
    url: `/api/v1/snapshots/${snapshotId}/annotation-proposals`,
  });

const list = (app: FastifyInstance, repoId: string, status?: string) =>
  app.inject({
    method: "GET",
    url: `/api/v1/repositories/${repoId}/annotations${status ? `?status=${status}` : ""}`,
  });

test("valid proposals are stored as proposed/ai and never as accepted", async () => {
  const ai = stubProvider(GOOD);
  const app = await buildApp(env, { ai });
  try {
    const { projectId, repoId, snapshotId } = await seed(app);

    const res = await propose(app, snapshotId);
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().proposals.length, 2);

    const proposals = list(app, repoId, "proposed");
    const rows = (await proposals).json();
    assert.equal(rows.length, 2);
    for (const row of rows) {
      assert.equal(row.status, "proposed");
      assert.equal(row.provenance, "ai");
      assert.equal(row.createdFromSha, "sha-1");
    }
    // The reason is kept, because a suggestion you must judge without knowing why
    // it was made is one you will rubber-stamp.
    const group = rows.find((r: { type: string }) => r.type === "group");
    assert.equal(group.reason, "The web tier and the database it reads.");

    // Nothing is live. The adapted view is unmoved until a human says otherwise.
    assert.equal((await list(app, repoId, "resolved")).json().length, 0);

    await app.inject({ method: "DELETE", url: `/api/v1/projects/${projectId}` });
  } finally {
    await app.close();
  }
});

test("asking twice for the same snapshot never reaches the model again", async () => {
  const ai = stubProvider(GOOD);
  const app = await buildApp(env, { ai });
  try {
    const { projectId, repoId, snapshotId } = await seed(app);

    await propose(app, snapshotId);
    assert.equal(ai.calls, 1);

    const second = await propose(app, snapshotId);
    assert.equal(second.statusCode, 200);
    assert.equal(ai.calls, 1, "the cached response was replayed, not regenerated");
    assert.equal(second.json().cached, true);

    // ...and it did not quietly duplicate what it stored the first time.
    assert.equal(second.json().proposals.length, 0);
    assert.equal((await list(app, repoId, "proposed")).json().length, 2);

    await app.inject({ method: "DELETE", url: `/api/v1/projects/${projectId}` });
  } finally {
    await app.close();
  }
});

test("proposals that point at nothing are dropped, and the rest still land", async () => {
  const partly = JSON.stringify({
    proposals: [
      { type: "group", anchors: ["azurerm_x.ghost"], label: "Invented" },
      { type: "rename", anchors: ["azurerm_x.suffix"], label: "Suffix" },
    ],
  });
  const ai = stubProvider(partly);
  const app = await buildApp(env, { ai });
  try {
    const { projectId, repoId, snapshotId } = await seed(app);

    const res = await propose(app, snapshotId);
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().dropped, 1);

    const rows = (await list(app, repoId, "proposed")).json();
    assert.deepEqual(rows.map((r: { type: string }) => r.type), ["rename"]);

    await app.inject({ method: "DELETE", url: `/api/v1/projects/${projectId}` });
  } finally {
    await app.close();
  }
});

test("an unusable response is a 502 and stores nothing — not even in the cache", async () => {
  const ai = stubProvider("I'm sorry, I can't do that.");
  const app = await buildApp(env, { ai });
  try {
    const { projectId, repoId, snapshotId } = await seed(app);

    const res = await propose(app, snapshotId);
    assert.equal(res.statusCode, 502);
    assert.equal((await list(app, repoId)).json().length, 0);

    // Retriable: the failure was not cached, so a second attempt really does
    // reach the model again. A cached error is an error served forever.
    await propose(app, snapshotId);
    assert.equal(ai.calls, 2);

    await app.inject({ method: "DELETE", url: `/api/v1/projects/${projectId}` });
  } finally {
    await app.close();
  }
});

test("a proposal is never made twice — re-running does not bury the reviewer", async () => {
  const ai = stubProvider(GOOD);
  const app = await buildApp(env, { ai });
  try {
    const { projectId, repoId, snapshotId } = await seed(app);
    await propose(app, snapshotId);

    // A second snapshot of the same repo — a new cache key, so the model really
    // is asked again, and it says the same thing it said last time.
    const second = await insertGraphSnapshot(app.db, {
      repositoryId: repoId,
      source: "hcl",
      ref: "refs/heads/main",
      commitSha: "sha-2",
      graph: GRAPH,
    });
    const res = await propose(app, second.id);
    assert.equal(ai.calls, 2);
    assert.equal(res.json().proposals.length, 0, "nothing new to say, nothing added");
    assert.equal((await list(app, repoId, "proposed")).json().length, 2);

    await app.inject({ method: "DELETE", url: `/api/v1/projects/${projectId}` });
  } finally {
    await app.close();
  }
});

test("with the AI layer off the endpoint does not exist", async () => {
  // No key ⇒ no model ⇒ no AI surface anywhere (GP-62). The frontend hides the
  // button off the same signal, so a 404 here is what "the feature is off" means.
  const app = await buildApp(env);
  try {
    const { projectId, snapshotId } = await seed(app);
    const res = await propose(app, snapshotId);
    assert.equal(res.statusCode, 404);
    await app.inject({ method: "DELETE", url: `/api/v1/projects/${projectId}` });
  } finally {
    await app.close();
  }
});

test("a plan snapshot is refused — you organise a system, not a diff", async () => {
  const ai = stubProvider(GOOD);
  const app = await buildApp(env, { ai });
  try {
    const { projectId, repoId } = await seed(app);
    const plan = await insertGraphSnapshot(app.db, {
      repositoryId: repoId,
      source: "plan",
      ref: "refs/heads/feature",
      commitSha: "sha-plan",
      prNumber: 7,
      graph: GRAPH,
    });

    const res = await propose(app, plan.id);
    assert.equal(res.statusCode, 422);
    assert.equal(ai.calls, 0);

    await app.inject({ method: "DELETE", url: `/api/v1/projects/${projectId}` });
  } finally {
    await app.close();
  }
});

test("the brief names every address the model is allowed to anchor to", async () => {
  const ai = stubProvider('{"proposals":[]}');
  const app = await buildApp(env, { ai });
  try {
    const { projectId, snapshotId } = await seed(app);
    await propose(app, snapshotId);

    const brief = ai.prompts[0] ?? "";
    // The model's output is a set of addresses; an address it never saw is an
    // address it invented. So they are all in front of it, verbatim.
    assert.match(brief, /## Resources \(anchor to these addresses, exactly as written\)/);
    assert.match(brief, /`azurerm_x\.web`/);
    assert.match(brief, /`azurerm_x\.db`/);
    assert.match(brief, /## Dependencies/);
    // ...and never the raw graph JSON.
    assert.doesNotMatch(brief, /"nodes":/);

    await app.inject({ method: "DELETE", url: `/api/v1/projects/${projectId}` });
  } finally {
    await app.close();
  }
});
