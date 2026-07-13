import { test, before } from "node:test";
import assert from "node:assert/strict";

import { buildApp } from "../app.js";
import { loadEnv } from "../config/env.js";
import { runMigrations } from "../db/migrate.js";

const env = loadEnv();

// Integration tests: real HTTP + Postgres (`docker compose up -d`).
before(async () => {
  await runMigrations(env.databaseUrl);
});

// --- Terraform path (repositories whose HCL is not at the repository root) ---

test("a repository stores a normalized terraform path, and rejects one that escapes", async () => {
  const app = await buildApp(env);
  try {
    const project = (
      await app.inject({
        method: "POST",
        url: "/api/v1/projects",
        payload: { name: "P", slug: `tfpath-${Date.now()}` },
      })
    ).json();

    // Default: the repository root.
    const rooted = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${project.id}/repositories`,
      payload: { url: "https://github.com/acme/rooted" },
    });
    assert.equal(rooted.statusCode, 201);
    assert.equal(rooted.json().terraformPath, "");

    // Given a path, it is stored clean — the user's slashes are not our problem.
    const nested = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${project.id}/repositories`,
      payload: { url: "https://github.com/acme/nested", terraformPath: "/infra/azure/" },
    });
    assert.equal(nested.statusCode, 201);
    assert.equal(nested.json().terraformPath, "infra/azure");

    // It can be moved, and moved back to the root.
    const moved = await app.inject({
      method: "PATCH",
      url: `/api/v1/repositories/${nested.json().id}`,
      payload: { terraformPath: "terraform" },
    });
    assert.equal(moved.statusCode, 200);
    assert.equal(moved.json().terraformPath, "terraform");

    const backToRoot = await app.inject({
      method: "PATCH",
      url: `/api/v1/repositories/${nested.json().id}`,
      payload: { terraformPath: "" },
    });
    assert.equal(backToRoot.json().terraformPath, "");

    // A path that climbs out of the repository is refused, on create and update.
    const escaping = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${project.id}/repositories`,
      payload: { url: "https://github.com/acme/evil", terraformPath: "../../etc" },
    });
    assert.equal(escaping.statusCode, 422);
    assert.equal(escaping.json().fields[0].field, "terraformPath");

    const escapingPatch = await app.inject({
      method: "PATCH",
      url: `/api/v1/repositories/${nested.json().id}`,
      payload: { terraformPath: "../secrets" },
    });
    assert.equal(escapingPatch.statusCode, 422);

    await app.inject({ method: "DELETE", url: `/api/v1/projects/${project.id}` });
  } finally {
    await app.close();
  }
});
