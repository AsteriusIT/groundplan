/**
 * Tenant scoping & RBAC (GP-114). These run with auth ON (`buildTestApp`), so the
 * org-scope guard resolves a real membership: they exercise cross-org isolation
 * (404, no existence leak), the role matrix (403), and the webhook's exemption
 * from the guard.
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";

import { memberships, projects } from "../db/schema.js";
import { buildTestApp, authHeader, seedOrg, seedOrgWithMember } from "../test-support.js";
import { loadEnv } from "../config/env.js";
import { runMigrations } from "../db/migrate.js";

const env = loadEnv();

before(async () => {
  await runMigrations(env.databaseUrl);
});

/** JIT-provision a user by making one authed call, and return their id. */
async function provision(app: Awaited<ReturnType<typeof buildTestApp>>, sub: string) {
  const res = await app.inject({
    method: "GET",
    url: "/api/v1/me",
    headers: await authHeader({ sub }),
  });
  assert.equal(res.statusCode, 200);
  return res.json().id as string;
}

test("a member of org A gets 404 on org B's resources (no existence leak)", async () => {
  const app = await buildTestApp();
  const subA = `iso-a-${Date.now()}`;
  try {
    const userA = await provision(app, subA);
    const orgA = await seedOrgWithMember(app, { userId: userA, role: "member" });

    // Org B, with a project, that user A has nothing to do with.
    const orgB = await seedOrg(app);
    const [projectB] = await app.db
      .insert(projects)
      .values({ organizationId: orgB, name: "B", slug: `b-${Date.now()}` })
      .returning();

    const headers = await authHeader({ sub: subA });

    // Not a member of org B → 404 (not 403: must not leak that org B exists).
    const crossOrg = await app.inject({
      method: "GET",
      url: `/api/v1/orgs/${orgB}/projects/${projectB!.id}`,
      headers,
    });
    assert.equal(crossOrg.statusCode, 404);

    // Member of org A, but the project belongs to B → still 404 (ownership).
    const wrongOrg = await app.inject({
      method: "GET",
      url: `/api/v1/orgs/${orgA}/projects/${projectB!.id}`,
      headers,
    });
    assert.equal(wrongOrg.statusCode, 404);

    // But user A can read their own org's project list.
    const own = await app.inject({
      method: "GET",
      url: `/api/v1/orgs/${orgA}/projects`,
      headers,
    });
    assert.equal(own.statusCode, 200);
  } finally {
    await app.close();
  }
});

test("the role matrix: member reads, admin writes projects", async () => {
  const app = await buildTestApp();
  const subMember = `mtx-m-${Date.now()}`;
  const subAdmin = `mtx-a-${Date.now()}`;
  try {
    const memberId = await provision(app, subMember);
    const adminId = await provision(app, subAdmin);
    const orgId = await seedOrgWithMember(app, { userId: memberId, role: "member" });
    await app.db
      .insert(memberships)
      .values({ userId: adminId, organizationId: orgId, role: "admin" });

    // A member cannot create a project.
    const memberCreate = await app.inject({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/projects`,
      headers: await authHeader({ sub: subMember }),
      payload: { name: "Nope", slug: `nope-${Date.now()}` },
    });
    assert.equal(memberCreate.statusCode, 403);

    // An admin can.
    const adminCreate = await app.inject({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/projects`,
      headers: await authHeader({ sub: subAdmin }),
      payload: { name: "Yes", slug: `yes-${Date.now()}` },
    });
    assert.equal(adminCreate.statusCode, 201);

    // And a member can read the list (that same project is in it).
    const list = await app.inject({
      method: "GET",
      url: `/api/v1/orgs/${orgId}/projects`,
      headers: await authHeader({ sub: subMember }),
    });
    assert.equal(list.statusCode, 200);
    assert.equal(list.json().length, 1);
  } finally {
    await app.close();
  }
});

test("only an owner may delete an org; an admin cannot", async () => {
  const app = await buildTestApp();
  const subAdmin = `del-a-${Date.now()}`;
  const subOwner = `del-o-${Date.now()}`;
  try {
    const adminId = await provision(app, subAdmin);
    const ownerId = await provision(app, subOwner);
    const orgId = await seedOrgWithMember(app, {
      userId: adminId,
      role: "admin",
      name: "DeleteMe",
    });
    await app.db
      .insert(memberships)
      .values({ userId: ownerId, organizationId: orgId, role: "owner" });

    const adminDel = await app.inject({
      method: "DELETE",
      url: `/api/v1/orgs/${orgId}`,
      headers: await authHeader({ sub: subAdmin }),
      payload: { confirmName: "DeleteMe" },
    });
    assert.equal(adminDel.statusCode, 403);

    const ownerDel = await app.inject({
      method: "DELETE",
      url: `/api/v1/orgs/${orgId}`,
      headers: await authHeader({ sub: subOwner }),
      payload: { confirmName: "DeleteMe" },
    });
    assert.equal(ownerDel.statusCode, 204);
  } finally {
    await app.close();
  }
});

test("the CI webhook is exempt from auth and the org guard", async () => {
  const app = await buildTestApp();
  const sub = `wh-${Date.now()}`;
  try {
    const userId = await provision(app, sub);
    const orgId = await seedOrgWithMember(app, { userId, role: "owner" });
    const headers = await authHeader({ sub });

    const projectRes = await app.inject({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/projects`,
      headers,
      payload: { name: "WH", slug: `wh-${Date.now()}` },
    });
    assert.equal(projectRes.statusCode, 201, projectRes.body);
    const project = projectRes.json();

    const repoRes = await app.inject({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/projects/${project.id}/repositories`,
      headers,
      payload: { url: "https://github.com/acme/wh" },
    });
    assert.equal(repoRes.statusCode, 201, repoRes.body);
    const repo = repoRes.json();

    // No bearer token at all — only the per-repo webhook secret. The webhook is
    // outside both the auth hook and the org guard, so this is a 202, not a 401.
    const hook = await app.inject({
      method: "POST",
      url: `/api/v1/webhooks/ci/${repo.id}`,
      headers: { "x-groundplan-token": repo.webhookToken },
      payload: {
        event: "pull_request",
        ref: "refs/heads/feature",
        commit_sha: "sha-wh",
        pr_number: 3,
        pr_title: "hi",
        payload: {
          format_version: "1.2",
          resource_changes: [
            {
              address: "aws_s3_bucket.b",
              mode: "managed",
              type: "aws_s3_bucket",
              name: "b",
              provider_name: "registry.terraform.io/hashicorp/aws",
              change: { actions: ["create"] },
            },
          ],
        },
      },
    });
    assert.equal(hook.statusCode, 202);
  } finally {
    await app.close();
  }
});
