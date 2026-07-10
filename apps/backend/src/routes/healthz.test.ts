import { test } from "node:test";
import assert from "node:assert/strict";
import type { Pool } from "pg";

import { buildApp } from "../app.js";
import { loadEnv } from "../config/env.js";

const env = loadEnv();

/** A pool stub whose `query` resolves — simulates a reachable database. */
function reachablePool(): Pool {
  return {
    query: async () => ({ rows: [{ ok: 1 }] }),
    end: async () => {},
  } as unknown as Pool;
}

/** A pool stub whose `query` rejects — simulates an unreachable database. */
function unreachablePool(): Pool {
  return {
    query: async () => {
      throw new Error("connection refused");
    },
    end: async () => {},
  } as unknown as Pool;
}

test("GET /healthz returns 200 and db:ok when the database is reachable", async () => {
  const app = await buildApp(env, { pool: reachablePool() });
  const res = await app.inject({ method: "GET", url: "/healthz" });

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { status: "ok", db: "ok" });

  await app.close();
});

test("GET /healthz returns 503 and db:down when the database is unreachable", async () => {
  const app = await buildApp(env, { pool: unreachablePool() });
  const res = await app.inject({ method: "GET", url: "/healthz" });

  assert.equal(res.statusCode, 503);
  assert.deepEqual(res.json(), { status: "error", db: "down" });

  await app.close();
});
