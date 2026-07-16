import { test, before } from "node:test";
import assert from "node:assert/strict";

import { buildApp } from "../app.js";
import { loadEnv } from "../config/env.js";
import { runMigrations } from "../db/migrate.js";
import { seedOrg } from "../test-support.js";

const env = loadEnv();

// Integration tests: real HTTP + Postgres (`docker compose up -d`).
before(async () => {
  await runMigrations(env.databaseUrl);
});

// --- Terraform path (repositories whose HCL is not at the repository root) ---

test("a repository stores a normalized terraform path, and rejects one that escapes", async () => {
  const app = await buildApp(env);
  const orgId = await seedOrg(app);
  try {
    const project = (
      await app.inject({
        method: "POST",
        url: `/api/v1/orgs/${orgId}/projects`,
        payload: { name: "P", slug: `tfpath-${Date.now()}` },
      })
    ).json();

    // Default: the repository root.
    const rooted = await app.inject({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/projects/${project.id}/repositories`,
      payload: { url: "https://github.com/acme/rooted" },
    });
    assert.equal(rooted.statusCode, 201);
    assert.equal(rooted.json().terraformPath, "");

    // Given a path, it is stored clean — the user's slashes are not our problem.
    const nested = await app.inject({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/projects/${project.id}/repositories`,
      payload: { url: "https://github.com/acme/nested", terraformPath: "/infra/azure/" },
    });
    assert.equal(nested.statusCode, 201);
    assert.equal(nested.json().terraformPath, "infra/azure");

    // It can be moved, and moved back to the root.
    const moved = await app.inject({
      method: "PATCH",
      url: `/api/v1/orgs/${orgId}/repositories/${nested.json().id}`,
      payload: { terraformPath: "terraform" },
    });
    assert.equal(moved.statusCode, 200);
    assert.equal(moved.json().terraformPath, "terraform");

    const backToRoot = await app.inject({
      method: "PATCH",
      url: `/api/v1/orgs/${orgId}/repositories/${nested.json().id}`,
      payload: { terraformPath: "" },
    });
    assert.equal(backToRoot.json().terraformPath, "");

    // A path that climbs out of the repository is refused, on create and update.
    const escaping = await app.inject({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/projects/${project.id}/repositories`,
      payload: { url: "https://github.com/acme/evil", terraformPath: "../../etc" },
    });
    assert.equal(escaping.statusCode, 422);
    assert.equal(escaping.json().fields[0].field, "terraformPath");

    const escapingPatch = await app.inject({
      method: "PATCH",
      url: `/api/v1/orgs/${orgId}/repositories/${nested.json().id}`,
      payload: { terraformPath: "../secrets" },
    });
    assert.equal(escapingPatch.statusCode, 422);

    await app.inject({ method: "DELETE", url: `/api/v1/orgs/${orgId}/projects/${project.id}` });
  } finally {
    await app.close();
  }
});

// --- IaC type (GP-101): what a repository holds ---

test("a repository declares what it holds; terraform unless it says otherwise", async () => {
  const app = await buildApp(env);
  const orgId = await seedOrg(app);
  try {
    const project = (
      await app.inject({
        method: "POST",
        url: `/api/v1/orgs/${orgId}/projects`,
        payload: { name: "P", slug: `iactype-${Date.now()}` },
      })
    ).json();

    // Say nothing and you get today's behaviour — every existing repo is one of these.
    const implicit = await app.inject({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/projects/${project.id}/repositories`,
      payload: { url: "https://github.com/acme/tf" },
    });
    assert.equal(implicit.statusCode, 201);
    assert.equal(implicit.json().iacType, "terraform");

    // A manifests repo says so, and the same path field means "where the YAML is".
    const k8s = await app.inject({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/projects/${project.id}/repositories`,
      payload: {
        url: "https://github.com/acme/manifests",
        iacType: "kubernetes",
        terraformPath: "deploy/prod",
      },
    });
    assert.equal(k8s.statusCode, 201);
    assert.equal(k8s.json().iacType, "kubernetes");
    assert.equal(k8s.json().terraformPath, "deploy/prod");

    // It survives a read and a list.
    const read = await app.inject({
      method: "GET",
      url: `/api/v1/orgs/${orgId}/repositories/${k8s.json().id}`,
    });
    assert.equal(read.json().iacType, "kubernetes");

    const listed = (
      await app.inject({
        method: "GET",
        url: `/api/v1/orgs/${orgId}/projects/${project.id}/repositories`,
      })
    ).json();
    assert.deepEqual(
      listed.map((r: { url: string; iacType: string }) => [r.url, r.iacType]).sort(),
      [
        ["https://github.com/acme/manifests", "kubernetes"],
        ["https://github.com/acme/tf", "terraform"],
      ].sort(),
    );

    // A repo escaping its own root is refused whatever it holds.
    const escaping = await app.inject({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/projects/${project.id}/repositories`,
      payload: {
        url: "https://github.com/acme/evil",
        iacType: "kubernetes",
        terraformPath: "../../etc",
      },
    });
    assert.equal(escaping.statusCode, 422);
    assert.equal(escaping.json().fields[0].field, "terraformPath");

    // There is no third kind of infrastructure-as-code here.
    const nonsense = await app.inject({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/projects/${project.id}/repositories`,
      payload: { url: "https://github.com/acme/x", iacType: "pulumi" },
    });
    assert.equal(nonsense.statusCode, 422);
    assert.equal(nonsense.json().fields[0].field, "iacType");

    // Immutable in v1: a repo does not change what it holds (GP-100, no mixed repos).
    const patched = await app.inject({
      method: "PATCH",
      url: `/api/v1/orgs/${orgId}/repositories/${k8s.json().id}`,
      payload: { iacType: "terraform" },
    });
    assert.equal(patched.statusCode, 422);

    const unchanged = await app.inject({
      method: "GET",
      url: `/api/v1/orgs/${orgId}/repositories/${k8s.json().id}`,
    });
    assert.equal(unchanged.json().iacType, "kubernetes");

    await app.inject({ method: "DELETE", url: `/api/v1/orgs/${orgId}/projects/${project.id}` });
  } finally {
    await app.close();
  }
});
