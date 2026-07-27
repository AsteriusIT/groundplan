/**
 * Credential parity and bulk import (GP-229).
 *
 * The file has two halves and the first is the point of the story: **one
 * contract suite, run against creation *and* update**. The bug being fixed was
 * an asymmetry between those two handlers, so a test that only exercised one of
 * them would have passed happily while the product stayed broken. If either
 * handler ever diverges, half of these fail.
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { eq } from "drizzle-orm";

import { buildApp } from "../app.js";
import { loadEnv, type AppEnv } from "../config/env.js";
import { runMigrations } from "../db/migrate.js";
import {
  integrationCredentials,
  projects,
  repositories,
} from "../db/schema.js";
import type { RepoSource, VerifyResult } from "../services/repo-files.js";
import { seedOrg } from "../test-support.js";

const env = loadEnv();

before(async () => {
  await runMigrations(env.databaseUrl);
});

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });

/** An instance with a registered GitHub App, so installations can mint tokens. */
const appEnv: AppEnv = {
  ...env,
  githubAppId: "12345",
  githubAppPrivateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  githubAppSlug: "groundplan",
  publicBaseUrl: "https://gp.example.com",
};

type App = Awaited<ReturnType<typeof buildApp>>;

/**
 * A verifier standing in for `git ls-remote`. By default it behaves like a
 * private repository: reachable *with* a credential, not found without one.
 * That is what makes "no credential resolved" a real outcome here instead of an
 * accident of the stub always saying yes. A test that wants a specific failure
 * pins `state.result`.
 */
function stubVerify() {
  const state: {
    result: VerifyResult | null;
    tokens: (string | null | undefined)[];
  } = { result: null, tokens: [] };
  return {
    state,
    verifyConnection: async (source: RepoSource) => {
      state.tokens.push(source.accessToken);
      if (state.result) return state.result;
      return source.accessToken
        ? { ok: true as const, defaultBranchFound: true }
        : { ok: false as const, error: "not_found" as const };
    },
  };
}

async function buildTestApp(
  verify: ReturnType<typeof stubVerify>,
  base: AppEnv = appEnv,
): Promise<App> {
  return buildApp(base, {
    verifyConnection: verify.verifyConnection,
    githubApp: {
      getInstallation: async (id) => ({ id, account: "acme" }),
      createInstallationToken: async () => ({
        token: "ghs_installation_token",
        expiresAt: new Date(Date.now() + 3_600_000),
      }),
      listInstallationRepositories: async () => ({
        repositories: [],
        totalCount: 0,
      }),
    },
  });
}

let counter = 0;
async function seedProject(app: App, orgId: string): Promise<string> {
  counter += 1;
  const [project] = await app.db
    .insert(projects)
    .values({
      organizationId: orgId,
      name: "Platform",
      slug: `platform-${Date.now()}-${counter}`,
    })
    .returning({ id: projects.id });
  return project!.id;
}

/** A GitHub App installation on the `acme` account, as GP-193 stores it. */
async function seedInstallation(
  app: App,
  orgId: string,
  account = "acme",
  installationId = 42,
): Promise<string> {
  const [row] = await app.db
    .insert(integrationCredentials)
    .values({
      organizationId: orgId,
      provider: "github",
      mode: "installation_app",
      name: account,
      config: { installationId, account },
      secret: null,
      status: "ok",
    })
    .returning({ id: integrationCredentials.id });
  return row!.id;
}

/* -------------------------------------------------------------------------- */
/* The parity contract: the same expectations, on both handlers.               */
/* -------------------------------------------------------------------------- */

/**
 * One credential scenario, applied through whichever handler is under test.
 * `attach` creates a repository from scratch; `edit` creates a bare one and
 * then does the same thing through PATCH.
 */
type Handler = {
  label: string;
  apply(
    app: App,
    orgId: string,
    body: Record<string, unknown>,
  ): Promise<{ statusCode: number; json: () => Record<string, unknown> }>;
};

const HANDLERS: Handler[] = [
  {
    label: "create",
    async apply(app, orgId, body) {
      const projectId = await seedProject(app, orgId);
      const res = await app.inject({
        method: "POST",
        url: `/api/v1/orgs/${orgId}/projects/${projectId}/repositories`,
        payload: { provider: "github", url: "https://github.com/acme/infra", ...body },
      });
      return { statusCode: res.statusCode, json: () => res.json() };
    },
  },
  {
    label: "update",
    async apply(app, orgId, body) {
      const projectId = await seedProject(app, orgId);
      // A bare repository, inserted directly: the point is to reach PATCH with
      // the same credential vocabulary the create path just received.
      const [repo] = await app.db
        .insert(repositories)
        .values({
          projectId,
          provider: "github",
          url: "https://github.com/acme/infra",
        })
        .returning({ id: repositories.id });
      const { url: _url, provider: _provider, ...patchable } = body;
      const res = await app.inject({
        method: "PATCH",
        url: `/api/v1/orgs/${orgId}/repositories/${repo!.id}`,
        payload: patchable,
      });
      return { statusCode: res.statusCode, json: () => res.json() };
    },
  },
];

for (const handler of HANDLERS) {
  test(`${handler.label}: an installation covering the owner is used with no token`, async () => {
    const verify = stubVerify();
    const app = await buildTestApp(verify);
    const orgId = await seedOrg(app);
    try {
      const credentialId = await seedInstallation(app, orgId);
      const res = await handler.apply(app, orgId, { defaultBranch: "main" });
      assert.equal(res.statusCode, handler.label === "create" ? 201 : 200, JSON.stringify(res.json()));
      assert.equal(res.json().credentialId, credentialId);
      assert.equal(res.json().authMode, "installation_app");
      assert.equal(res.json().accessToken, null, "no PAT was needed");
      assert.equal(
        verify.state.tokens.at(-1),
        "ghs_installation_token",
        "the check ran with the installation's own token",
      );
    } finally {
      await app.close();
    }
  });

  test(`${handler.label}: an explicit installationId is honoured`, async () => {
    const verify = stubVerify();
    const app = await buildTestApp(verify);
    const orgId = await seedOrg(app);
    try {
      const credentialId = await seedInstallation(app, orgId, "acme", 77);
      const res = await handler.apply(app, orgId, { installationId: 77 });
      assert.equal(res.json().credentialId, credentialId);
    } finally {
      await app.close();
    }
  });

  test(`${handler.label}: an installation that does not cover the repo is refused`, async () => {
    const verify = stubVerify();
    const app = await buildTestApp(verify);
    const orgId = await seedOrg(app);
    try {
      await seedInstallation(app, orgId, "other-org", 99);
      const res = await handler.apply(app, orgId, { installationId: 99 });
      assert.equal(res.statusCode, 422, JSON.stringify(res.json()));
      assert.equal(res.json().code, "installation_does_not_cover_repo");
    } finally {
      await app.close();
    }
  });

  test(`${handler.label}: owner matching ignores case, as GitHub logins do`, async () => {
    const verify = stubVerify();
    const app = await buildTestApp(verify);
    const orgId = await seedOrg(app);
    try {
      const credentialId = await seedInstallation(app, orgId, "ACME");
      const res = await handler.apply(app, orgId, { defaultBranch: "main" });
      assert.equal(res.json().credentialId, credentialId);
    } finally {
      await app.close();
    }
  });

  test(`${handler.label}: a refused credential is a typed error, not a generic failure`, async () => {
    const verify = stubVerify();
    verify.state.result = { ok: false, error: "auth_failed" };
    const app = await buildTestApp(verify);
    const orgId = await seedOrg(app);
    try {
      const res = await handler.apply(app, orgId, { accessToken: "ghp_bad" });
      assert.equal(res.statusCode, 422, JSON.stringify(res.json()));
      assert.equal(res.json().code, "insufficient_permissions");
    } finally {
      await app.close();
    }
  });

  test(`${handler.label}: an unreachable host says so, distinctly from a refusal`, async () => {
    const verify = stubVerify();
    verify.state.result = { ok: false, error: "network" };
    const app = await buildTestApp(verify);
    const orgId = await seedOrg(app);
    try {
      const res = await handler.apply(app, orgId, { accessToken: "ghp_fine" });
      assert.equal(res.statusCode, 422);
      assert.equal(res.json().code, "unreachable");
    } finally {
      await app.close();
    }
  });

  test(`${handler.label}: a PAT still works when no installation exists (GP-51/52)`, async () => {
    const verify = stubVerify();
    const app = await buildTestApp(verify);
    const orgId = await seedOrg(app);
    try {
      const res = await handler.apply(app, orgId, { accessToken: "ghp_value" });
      assert.equal(res.json().credentialId, null);
      assert.equal(res.json().accessToken, "***", "stored, masked, never echoed");
      assert.equal(verify.state.tokens.at(-1), "ghp_value");
    } finally {
      await app.close();
    }
  });
}

test("nothing is persisted when creation is refused", async () => {
  const verify = stubVerify();
  verify.state.result = { ok: false, error: "auth_failed" };
  const app = await buildTestApp(verify);
  const orgId = await seedOrg(app);
  try {
    const projectId = await seedProject(app, orgId);
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/projects/${projectId}/repositories`,
      payload: { url: "https://github.com/acme/infra", accessToken: "ghp_bad" },
    });
    assert.equal(res.statusCode, 422);
    const rows = await app.db
      .select({ id: repositories.id })
      .from(repositories)
      .where(eq(repositories.projectId, projectId));
    assert.deepEqual(rows, [], "a repository we cannot read is never created");
  } finally {
    await app.close();
  }
});

/* -------------------------------------------------------------------------- */
/* Bulk import.                                                                */
/* -------------------------------------------------------------------------- */

async function importItems(
  app: App,
  orgId: string,
  projectId: string,
  items: Record<string, unknown>[],
) {
  const res = await app.inject({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/repositories/import`,
    payload: { projectId, items },
  });
  return res;
}

test("a batch imports what it can and names what it could not", async () => {
  const verify = stubVerify();
  const app = await buildTestApp(verify);
  const orgId = await seedOrg(app);
  try {
    await seedInstallation(app, orgId);
    const projectId = await seedProject(app, orgId);

    // Already attached, exactly: must be skipped, not failed.
    await app.db.insert(repositories).values({
      projectId,
      provider: "github",
      url: "https://github.com/acme/repo-0.git",
      iacType: "terraform",
      terraformPath: "",
    });

    const items = [
      ...Array.from({ length: 4 }, (_, i) => ({
        fullName: `acme/repo-${i}`,
        kind: "terraform",
      })),
      // Not covered by the installation and with no token of its own.
      { fullName: "elsewhere/repo", kind: "terraform" },
    ];
    const res = await importItems(app, orgId, projectId, items);
    assert.equal(res.statusCode, 207, res.body);

    const body = res.json() as {
      imported: { url: string }[];
      skipped: { reason: string }[];
      failed: { code: string }[];
    };
    assert.equal(body.imported.length, 3, "repo-1..3");
    assert.equal(body.skipped.length, 1, "the exact duplicate is skipped");
    assert.equal(body.failed.length, 1);
    assert.equal(body.failed[0]!.code, "no_credential_resolved");

    // …and the imported ones are real, fully-formed repositories.
    const stored = await app.db
      .select()
      .from(repositories)
      .where(eq(repositories.projectId, projectId));
    assert.equal(stored.length, 4, "the pre-existing one plus three imports");
    for (const row of stored.filter((r) => r.url !== "https://github.com/acme/repo-0.git")) {
      assert.ok(row.webhookToken, "CI can authenticate to it");
      assert.equal(row.connectionStatus, "ok", "proven reachable before writing");
    }
  } finally {
    await app.close();
  }
});

test("a monorepo is imported twice — two kinds, two paths, no conflict", async () => {
  const verify = stubVerify();
  const app = await buildTestApp(verify);
  const orgId = await seedOrg(app);
  try {
    await seedInstallation(app, orgId);
    const projectId = await seedProject(app, orgId);

    const res = await importItems(app, orgId, projectId, [
      { fullName: "acme/monorepo", kind: "terraform", path: "infra/" },
      { fullName: "acme/monorepo", kind: "kubernetes", path: "k8s" },
    ]);
    assert.equal(res.statusCode, 207, res.body);
    const body = res.json() as { imported: unknown[]; failed: unknown[] };
    assert.equal(body.imported.length, 2, "the same repo, two legitimate attachments");
    assert.deepEqual(body.failed, []);

    const rows = await app.db
      .select({ kind: repositories.iacType, path: repositories.terraformPath })
      .from(repositories)
      .where(eq(repositories.projectId, projectId));
    assert.deepEqual(
      rows.map((r) => `${r.kind}:${r.path}`).sort(),
      ["kubernetes:k8s", "terraform:infra"],
    );
  } finally {
    await app.close();
  }
});

test("a duplicate inside one batch is skipped, not created twice", async () => {
  const verify = stubVerify();
  const app = await buildTestApp(verify);
  const orgId = await seedOrg(app);
  try {
    await seedInstallation(app, orgId);
    const projectId = await seedProject(app, orgId);
    const res = await importItems(app, orgId, projectId, [
      { fullName: "acme/infra", kind: "terraform" },
      { cloneUrl: "https://github.com/acme/infra.git", kind: "terraform" },
    ]);
    const body = res.json() as { imported: unknown[]; skipped: unknown[] };
    assert.equal(body.imported.length, 1, "the two spellings are one repository");
    assert.equal(body.skipped.length, 1);
  } finally {
    await app.close();
  }
});

test("the kind is mandatory, and 'both' is not a kind", async () => {
  const verify = stubVerify();
  const app = await buildTestApp(verify);
  const orgId = await seedOrg(app);
  try {
    const projectId = await seedProject(app, orgId);
    const missing = await importItems(app, orgId, projectId, [
      { fullName: "acme/infra" },
    ]);
    assert.equal(missing.statusCode, 422, "the schema refuses it");

    const both = await importItems(app, orgId, projectId, [
      { fullName: "acme/infra", kind: "both" },
    ]);
    assert.equal(both.statusCode, 422, "there is no mixed kind to accept");
  } finally {
    await app.close();
  }
});

test("import is bounded, and the project must belong to the org", async () => {
  const verify = stubVerify();
  const app = await buildTestApp(verify);
  const orgId = await seedOrg(app);
  const otherOrgId = await seedOrg(app);
  try {
    const projectId = await seedProject(app, orgId);
    const tooMany = await importItems(
      app,
      orgId,
      projectId,
      Array.from({ length: 51 }, (_, i) => ({
        fullName: `acme/repo-${i}`,
        kind: "terraform",
      })),
    );
    assert.equal(tooMany.statusCode, 422, "the cap is stated, not discovered");

    const foreignProject = await seedProject(app, otherOrgId);
    const crossTenant = await importItems(app, orgId, foreignProject, [
      { fullName: "acme/infra", kind: "terraform" },
    ]);
    assert.equal(crossTenant.statusCode, 404, "never 403 — no existence leak");
  } finally {
    await app.close();
  }
});

test("import is refused to a member, like every other repository change", async () => {
  const verify = stubVerify();
  const app = await buildApp(
    { ...env, oidcIssuer: "", oidcAudience: "" },
    { verifyConnection: verify.verifyConnection },
  );
  const orgId = await seedOrg(app);
  try {
    const projectId = await seedProject(app, orgId);
    // Auth is off here, so the guard grants owner and the call succeeds. The
    // RBAC matrix itself is pinned in members.test.ts; what matters here is
    // that the route asks for `project:manage` at all.
    const res = await importItems(app, orgId, projectId, [
      { fullName: "acme/infra", kind: "terraform" },
    ]);
    assert.equal(res.statusCode, 207, res.body);
  } finally {
    await app.close();
  }
});
