/**
 * AI studio chat endpoint (GP-137): stateless streaming HCL generation.
 * The model is a scripted `MockLanguageModelV3` — no test ever reaches a real
 * provider — and functional tests run on a poisoned pool, which is the proof
 * that a chat turn writes nothing.
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import type { Pool } from "pg";
import { MockLanguageModelV3, convertArrayToReadableStream } from "ai/test";

import { buildApp } from "../app.js";
import { loadEnv } from "../config/env.js";
import { runMigrations } from "../db/migrate.js";
import { authHeader, buildTestApp } from "../test-support.js";
import {
  MAX_STUDIO_HCL_BYTES,
  MAX_STUDIO_MESSAGES,
  toModelMessages,
} from "./ai-studio.js";

const env = loadEnv();

before(async () => {
  await runMigrations(env.databaseUrl);
});

/** A pool whose every query rejects — proves the chat never touches the DB. */
function poisonedPool(): Pool {
  return {
    query: async () => {
      throw new Error("the AI studio must not touch the database");
    },
    end: async () => {},
  } as unknown as Pool;
}

const USAGE = {
  inputTokens: {
    total: 10,
    noCache: 10,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: { total: 20, text: 20, reasoning: undefined },
} as const;

const GENERATED_FILES = [
  {
    path: "main.tf",
    content: 'resource "azurerm_resource_group" "rg" {\n  name = "rg-demo"\n}\n',
  },
];

/** The mock's stream-part type — the provider package isn't a direct
 * dependency, so the shape is derived from the mock instead of imported. */
type DoStream = NonNullable<
  NonNullable<ConstructorParameters<typeof MockLanguageModelV3>[0]>["doStream"]
>;
type StreamPart =
  Awaited<ReturnType<Extract<DoStream, (...args: never) => unknown>>> extends {
    stream: ReadableStream<infer P>;
  }
    ? P
    : never;

/** A model that answers with prose and one complete `write_files` call. */
function scriptedModel() {
  const parts: StreamPart[] = [
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: "t1" },
    { type: "text-delta", id: "t1", delta: "Created a resource group." },
    { type: "text-end", id: "t1" },
    {
      type: "tool-call",
      toolCallId: "call-1",
      toolName: "write_files",
      input: JSON.stringify({ files: GENERATED_FILES }),
    },
    {
      type: "finish",
      usage: USAGE,
      finishReason: { unified: "tool-calls", raw: "tool_use" },
    },
  ];
  return new MockLanguageModelV3({
    doStream: async () => ({ stream: convertArrayToReadableStream(parts) }),
  });
}

const USER_TURN = { messages: [{ role: "user", text: "create a resource group" }] };

test("POST /ai-studio/chat streams prose and the complete file set", async () => {
  const model = scriptedModel();
  const app = await buildApp(env, { pool: poisonedPool(), studioModel: model });
  try {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/ai-studio/chat",
      payload: USER_TURN,
    });

    assert.equal(res.statusCode, 200);
    assert.match(res.headers["content-type"] as string, /text\/event-stream/);

    // The SSE body carries the UI-message protocol: streamed text deltas plus
    // the tool call whose input is the complete regenerated project.
    assert.match(res.body, /"type":"text-delta"/);
    assert.match(res.body, /Created a resource group\./);
    assert.match(res.body, /"type":"tool-input-available"/);
    assert.match(res.body, /"toolName":"write_files"/);
    assert.match(res.body, /rg-demo/);
    assert.match(res.body, /\[DONE\]/);
  } finally {
    await app.close();
  }
});

test("the current file set reaches the model as regeneration context", async () => {
  const model = scriptedModel();
  const app = await buildApp(env, { pool: poisonedPool(), studioModel: model });
  try {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/ai-studio/chat",
      payload: {
        messages: [
          { role: "user", text: "create a resource group" },
          { role: "assistant", text: "Created a resource group." },
          { role: "user", text: "add a storage account" },
        ],
        files: GENERATED_FILES,
      },
    });
    assert.equal(res.statusCode, 200);

    const call = model.doStreamCalls[0];
    assert.ok(call, "the model was called");
    const serialized = JSON.stringify(call.prompt);
    assert.match(serialized, /azurerm_resource_group/);
    // The file context rides immediately before the latest user request.
    const roles = call.prompt.map((m) => m.role);
    assert.deepEqual(roles.slice(0, 1), ["system"]);
    assert.equal(roles.at(-1), "user");
    assert.equal(roles.at(-2), "user");
  } finally {
    await app.close();
  }
});

test("provider failure surfaces as an in-stream error event, not a bare 500", async () => {
  const model = new MockLanguageModelV3({
    doStream: async () => {
      throw new Error("invalid x-api-key");
    },
  });
  const app = await buildApp(env, { pool: poisonedPool(), studioModel: model });
  try {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/ai-studio/chat",
      payload: USER_TURN,
    });
    assert.equal(res.statusCode, 200);
    assert.match(res.body, /"type":"error"/);
    assert.match(res.body, /invalid x-api-key/);
  } finally {
    await app.close();
  }
});

test("404 when the AI layer is disabled (no API key)", async () => {
  const app = await buildApp(env, { pool: poisonedPool(), studioModel: null });
  try {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/ai-studio/chat",
      payload: USER_TURN,
    });
    assert.equal(res.statusCode, 404);
  } finally {
    await app.close();
  }
});

test("guardrails: session length, HCL size, malformed turns", async () => {
  const app = await buildApp(env, {
    pool: poisonedPool(),
    studioModel: scriptedModel(),
  });
  try {
    const tooLong = await app.inject({
      method: "POST",
      url: "/api/v1/ai-studio/chat",
      payload: {
        messages: Array.from({ length: MAX_STUDIO_MESSAGES + 1 }, (_, i) => ({
          role: i % 2 === 0 ? "user" : "assistant",
          text: "turn",
        })),
      },
    });
    assert.equal(tooLong.statusCode, 422);
    assert.match(tooLong.json().message, /too long/);

    const tooBig = await app.inject({
      method: "POST",
      url: "/api/v1/ai-studio/chat",
      payload: {
        ...USER_TURN,
        files: [
          { path: "main.tf", content: "x".repeat(MAX_STUDIO_HCL_BYTES + 1) },
        ],
      },
    });
    assert.equal(tooBig.statusCode, 413);

    const assistantLast = await app.inject({
      method: "POST",
      url: "/api/v1/ai-studio/chat",
      payload: { messages: [{ role: "assistant", text: "hello" }] },
    });
    assert.equal(assistantLast.statusCode, 422);

    // Schema violations ride the app-wide 422 convention (allErrors + fields).
    const badBody = await app.inject({
      method: "POST",
      url: "/api/v1/ai-studio/chat",
      payload: { messages: [] },
    });
    assert.equal(badBody.statusCode, 422);
  } finally {
    await app.close();
  }
});

test("requires authentication under the global OIDC guard", async () => {
  const app = await buildTestApp({ studioModel: scriptedModel() });
  try {
    const anonymous = await app.inject({
      method: "POST",
      url: "/api/v1/ai-studio/chat",
      payload: USER_TURN,
    });
    assert.equal(anonymous.statusCode, 401);

    const authed = await app.inject({
      method: "POST",
      url: "/api/v1/ai-studio/chat",
      headers: await authHeader(),
      payload: USER_TURN,
    });
    assert.equal(authed.statusCode, 200);
  } finally {
    await app.close();
  }
});

test("toModelMessages: no files means the history passes through untouched", () => {
  const turns = toModelMessages([{ role: "user", text: "hi" }], []);
  assert.deepEqual(turns, [{ role: "user", content: "hi" }]);
});
