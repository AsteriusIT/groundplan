import { test, before } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";

import { buildApp } from "../app.js";
import { seedOrg } from "../test-support.js";
import { loadEnv } from "../config/env.js";
import { runMigrations } from "../db/migrate.js";
import { aiGenerations } from "../db/schema.js";
import { insertGraphSnapshot } from "../services/graph-snapshots.js";
import {
  loadPrompt,
  streamGeneration,
  type AiProvider,
  type AiStream,
} from "../services/ai.js";
import type { Graph } from "../graph/graph.js";

const env = loadEnv();
const MISSING_ID = "00000000-0000-4000-8000-000000000000";

const PLAN_GRAPH: Graph = {
  version: 2,
  nodes: [
    {
      id: "aws_s3_bucket.data",
      name: "data",
      type: "aws_s3_bucket",
      provider: "aws",
      module_path: [],
      change: "delete",
    },
  ],
  edges: [],
};

const DOCS_GRAPH: Graph = {
  version: 1,
  nodes: [
    {
      id: "aws_vpc.main",
      name: "main",
      type: "aws_vpc",
      provider: "aws",
      module_path: [],
      change: null,
    },
  ],
  edges: [],
};

/**
 * A provider that yields a scripted answer word by word, counting its calls —
 * so a test can prove a second request never reached a model.
 */
function stubProvider(text = "The bucket is being deleted."): AiProvider & {
  calls: number;
  prompts: string[];
} {
  const stub = {
    calls: 0,
    prompts: [] as string[],
    model: "test-model",
    stream({ prompt }: { system: string; prompt: string }): AiStream {
      stub.calls += 1;
      stub.prompts.push(prompt);
      const words = `${stub.calls === 1 ? text : `${text} (take ${stub.calls})`}`.split(" ");
      return {
        // eslint-disable-next-line @typescript-eslint/require-await
        textStream: (async function* () {
          for (const word of words) yield `${word} `;
        })(),
        usage: Promise.resolve({ inputTokens: 120, outputTokens: 8 }),
      };
    },
  };
  return stub;
}

/** A provider that fails the way a bad key or an unknown model does. */
function failingProvider(message = "invalid x-api-key"): AiProvider {
  return {
    model: "test-model",
    stream(): AiStream {
      return {
        // eslint-disable-next-line require-yield
        textStream: (async function* () {
          throw new Error(message);
        })(),
        usage: Promise.resolve({ inputTokens: null, outputTokens: null }),
      };
    },
  };
}

/** A provider that dies partway through, after some prose is already out. */
function midStreamFailure(): AiProvider {
  return {
    model: "test-model",
    stream(): AiStream {
      return {
        textStream: (async function* () {
          yield "The change ";
          throw new Error("connection reset");
        })(),
        usage: Promise.resolve({ inputTokens: null, outputTokens: null }),
      };
    },
  };
}

/** A provider that never finishes until released — for the in-flight lock test. */
function hangingProvider(): AiProvider & { release: () => void } {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    release,
    model: "test-model",
    stream(): AiStream {
      return {
        textStream: (async function* () {
          yield "start ";
          await gate;
          yield "end";
        })(),
        usage: Promise.resolve({ inputTokens: 1, outputTokens: 2 }),
      };
    },
  };
}

let counter = 0;

/** A project + repo + one plan snapshot and one docs snapshot. */
async function seed(app: FastifyInstance, orgId: string) {
  counter += 1;
  const project = await app.inject({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/projects`,
    payload: { name: "AI", slug: `ai-${Date.now()}-${counter}` },
  });
  const projectId = project.json().id;

  const repo = await app.inject({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/projects/${projectId}/repositories`,
    payload: {
      provider: "github",
      url: "https://example.com/acme/infra.git",
      defaultBranch: "main",
    },
  });
  const repoId = repo.json().id;

  const plan = await insertGraphSnapshot(app.db, {
    repositoryId: repoId,
    source: "plan",
    ref: "refs/pull/42/head",
    commitSha: `sha-plan-${counter}`,
    prNumber: 42,
    graph: PLAN_GRAPH,
  });
  const docs = await insertGraphSnapshot(app.db, {
    repositoryId: repoId,
    source: "hcl",
    ref: "main",
    commitSha: `sha-docs-${counter}`,
    graph: DOCS_GRAPH,
  });

  return { projectId, repoId, planId: plan.id, docsId: docs.id };
}

before(async () => {
  await runMigrations(env.databaseUrl);
});

test("with no API key the AI layer is off: status disabled, routes 404", async () => {
  // The real provider with an empty key — exactly what a keyless deployment gets.
  const app = await buildApp({ ...env, aiApiKey: "" });
  try {
    const orgId = await seedOrg(app);
    const { projectId, planId } = await seed(app, orgId);

    const status = await app.inject({ method: "GET", url: "/api/v1/ai/status" });
    assert.equal(status.statusCode, 200);
    assert.deepEqual(status.json(), { enabled: false, model: null });

    const generate = await app.inject({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/snapshots/${planId}/ai/pr_summary`,
    });
    assert.equal(generate.statusCode, 404, "no route to a model without a key");

    const cached = await app.inject({
      method: "GET",
      url: `/api/v1/orgs/${orgId}/snapshots/${planId}/ai/pr_summary`,
    });
    assert.equal(cached.statusCode, 404);

    await app.inject({ method: "DELETE", url: `/api/v1/orgs/${orgId}/projects/${projectId}` });
  } finally {
    await app.close();
  }
});

test("a generation streams, persists with token usage, then serves from cache", async () => {
  const ai = stubProvider();
  const app = await buildApp(env, { ai });
  try {
    const orgId = await seedOrg(app);
    const { projectId, planId } = await seed(app, orgId);

    const status = await app.inject({ method: "GET", url: "/api/v1/ai/status" });
    assert.deepEqual(status.json(), { enabled: true, model: "test-model" });

    const first = await app.inject({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/snapshots/${planId}/ai/pr_summary`,
    });
    assert.equal(first.statusCode, 200);
    assert.match(first.headers["content-type"] as string, /text\/plain/);
    assert.equal(first.body.trim(), "The bucket is being deleted.");
    assert.equal(ai.calls, 1);

    // The prompt is grounded in our deterministic summary, never a raw plan.
    assert.match(ai.prompts[0]!, /aws_s3_bucket\.data/);
    assert.match(ai.prompts[0]!, /PR #42/);

    // Persisted with usage, under the current prompt version + model.
    const [row] = await app.db
      .select()
      .from(aiGenerations)
      .where(
        and(
          eq(aiGenerations.kind, "pr_summary"),
          eq(aiGenerations.targetId, planId),
        ),
      );
    assert.ok(row);
    assert.equal(row.output.trim(), "The bucket is being deleted.");
    assert.equal(row.inputTokens, 120);
    assert.equal(row.outputTokens, 8);
    assert.equal(row.model, "test-model");
    assert.equal(row.promptVersion, loadPrompt("pr_summary").version);

    // Second POST for the same snapshot: same text, and no provider call.
    const second = await app.inject({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/snapshots/${planId}/ai/pr_summary`,
    });
    assert.equal(second.statusCode, 200);
    assert.equal(second.body.trim(), "The bucket is being deleted.");
    assert.equal(ai.calls, 1, "cache hit must not reach the provider");

    // And GET serves it too, with its usage.
    const cached = await app.inject({
      method: "GET",
      url: `/api/v1/orgs/${orgId}/snapshots/${planId}/ai/pr_summary`,
    });
    assert.equal(cached.statusCode, 200);
    assert.equal(cached.json().output.trim(), "The bucket is being deleted.");
    assert.equal(cached.json().outputTokens, 8);
    assert.equal(ai.calls, 1);

    await app.inject({ method: "DELETE", url: `/api/v1/orgs/${orgId}/projects/${projectId}` });
  } finally {
    await app.close();
  }
});

test("regenerate drops the cached prose and calls the model again", async () => {
  const ai = stubProvider();
  const app = await buildApp(env, { ai });
  try {
    const orgId = await seedOrg(app);
    const { projectId, planId } = await seed(app, orgId);

    await app.inject({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/snapshots/${planId}/ai/pr_summary`,
    });
    assert.equal(ai.calls, 1);

    const again = await app.inject({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/snapshots/${planId}/ai/pr_summary`,
      payload: { regenerate: true },
    });
    assert.equal(again.statusCode, 200);
    assert.equal(ai.calls, 2);
    assert.match(again.body, /take 2/);

    // The replacement is what is cached now — not both.
    const rows = await app.db
      .select()
      .from(aiGenerations)
      .where(eq(aiGenerations.targetId, planId));
    assert.equal(rows.length, 1);
    assert.match(rows[0]!.output, /take 2/);

    await app.inject({ method: "DELETE", url: `/api/v1/orgs/${orgId}/projects/${projectId}` });
  } finally {
    await app.close();
  }
});

test("a generation kind must match the snapshot's source", async () => {
  const ai = stubProvider();
  const app = await buildApp(env, { ai });
  try {
    const orgId = await seedOrg(app);
    const { projectId, planId, docsId } = await seed(app, orgId);

    const wrongOnPlan = await app.inject({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/snapshots/${planId}/ai/docs_explain`,
    });
    assert.equal(wrongOnPlan.statusCode, 422);

    const wrongOnDocs = await app.inject({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/snapshots/${docsId}/ai/pr_summary`,
    });
    assert.equal(wrongOnDocs.statusCode, 422);
    assert.equal(ai.calls, 0, "a mismatch must not reach the provider");

    // The right pairing works.
    const ok = await app.inject({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/snapshots/${docsId}/ai/docs_explain`,
    });
    assert.equal(ok.statusCode, 200);
    assert.equal(ai.calls, 1);

    await app.inject({ method: "DELETE", url: `/api/v1/orgs/${orgId}/projects/${projectId}` });
  } finally {
    await app.close();
  }
});

test("unknown snapshot 404s; an unknown kind is rejected by the schema", async () => {
  const app = await buildApp(env, { ai: stubProvider() });
  try {
    const orgId = await seedOrg(app);
    const missing = await app.inject({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/snapshots/${MISSING_ID}/ai/pr_summary`,
    });
    assert.equal(missing.statusCode, 404);

    const badKind = await app.inject({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/snapshots/${MISSING_ID}/ai/haiku`,
    });
    assert.equal(badKind.statusCode, 422);
  } finally {
    await app.close();
  }
});

test("a second generation for the same target while one runs returns 409", async () => {
  const ai = hangingProvider();
  const app = await buildApp(env, { ai });
  try {
    const orgId = await seedOrg(app);
    const { projectId, planId } = await seed(app, orgId);

    // Start a generation and leave it mid-stream. Called directly rather than
    // over HTTP: `streamGeneration` takes the lock synchronously, so this makes
    // the request below deterministically the *second* one (two racing HTTP
    // requests would both await a DB read first, and either could win).
    const running = streamGeneration(app.db, ai, {
      kind: "pr_summary",
      targetId: planId,
      input: "# Infrastructure change",
    });

    const concurrent = await app.inject({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/snapshots/${planId}/ai/pr_summary`,
    });
    assert.equal(concurrent.statusCode, 409);

    // Let the held generation finish and drain it — that releases the lock and
    // caches its output.
    ai.release();
    let held = "";
    for await (const chunk of running) held += chunk;
    assert.equal(held, "start end");

    // Lock released, so a request proceeds again (served from that cache).
    const after = await app.inject({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/snapshots/${planId}/ai/pr_summary`,
    });
    assert.equal(after.statusCode, 200);
    assert.equal(after.body, "start end");

    await app.inject({ method: "DELETE", url: `/api/v1/orgs/${orgId}/projects/${projectId}` });
  } finally {
    await app.close();
  }
});

test("a provider that fails answers cleanly — and caches nothing", async () => {
  const app = await buildApp(env, { ai: failingProvider("invalid x-api-key") });
  try {
    const orgId = await seedOrg(app);
    const { projectId, planId } = await seed(app, orgId);

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/snapshots/${planId}/ai/pr_summary`,
    });

    // A readable reason and a real status — not an opaque 500 from trying to
    // serialise a JSON error into a response already committed to text/plain.
    assert.equal(res.statusCode, 502);
    assert.equal(res.json().error, "Bad Gateway");
    assert.match(res.json().message, /invalid x-api-key/);

    // A failed generation is never cached — a cached error would be served forever.
    const rows = await app.db
      .select()
      .from(aiGenerations)
      .where(eq(aiGenerations.targetId, planId));
    assert.equal(rows.length, 0);

    await app.inject({ method: "DELETE", url: `/api/v1/orgs/${orgId}/projects/${projectId}` });
  } finally {
    await app.close();
  }
});

test("a failed generation releases the lock, so a retry can run", async () => {
  const app = await buildApp(env, { ai: failingProvider() });
  try {
    const orgId = await seedOrg(app);
    const { projectId, planId } = await seed(app, orgId);

    const first = await app.inject({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/snapshots/${planId}/ai/pr_summary`,
    });
    assert.equal(first.statusCode, 502);

    // 409 here would mean the failure leaked the in-flight lock, wedging this
    // target until the process restarts.
    const retry = await app.inject({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/snapshots/${planId}/ai/pr_summary`,
    });
    assert.equal(retry.statusCode, 502);

    await app.inject({ method: "DELETE", url: `/api/v1/orgs/${orgId}/projects/${projectId}` });
  } finally {
    await app.close();
  }
});

test("a mid-stream failure keeps the prose already sent, and caches nothing", async () => {
  const app = await buildApp(env, { ai: midStreamFailure() });
  try {
    const orgId = await seedOrg(app);
    const { projectId, planId } = await seed(app, orgId);

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/snapshots/${planId}/ai/pr_summary`,
    });

    // Bytes were already on the wire, so there is no status left to change —
    // the partial prose stands rather than the whole response collapsing.
    assert.equal(res.statusCode, 200);
    assert.equal(res.body, "The change ");

    // But a truncated generation must never become the cached answer.
    const rows = await app.db
      .select()
      .from(aiGenerations)
      .where(eq(aiGenerations.targetId, planId));
    assert.equal(rows.length, 0);

    await app.inject({ method: "DELETE", url: `/api/v1/orgs/${orgId}/projects/${projectId}` });
  } finally {
    await app.close();
  }
});
