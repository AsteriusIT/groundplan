/**
 * Organization member management (GP-118). Auth on; orgs/memberships seeded
 * directly so the tests are independent of deployment mode.
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";

import { memberships } from "../db/schema.js";
import { loadEnv } from "../config/env.js";
import { runMigrations } from "../db/migrate.js";
import type { Role } from "../rbac/permissions.js";
import {
  authHeader,
  buildTestApp,
  seedOrg,
  seedOrgWithMember,
} from "../test-support.js";

const env = loadEnv();

before(async () => {
  await runMigrations(env.databaseUrl);
});

async function provision(app: Awaited<ReturnType<typeof buildTestApp>>, sub: string) {
  const res = await app.inject({
    method: "GET",
    url: "/api/v1/me",
    headers: await authHeader({ sub }),
  });
  return res.json().id as string;
}

async function enrol(
  app: Awaited<ReturnType<typeof buildTestApp>>,
  userId: string,
  orgId: string,
  role: Role,
) {
  await app.db
    .insert(memberships)
    .values({ userId, organizationId: orgId, role });
}

test("admin can change member↔admin roles and remove members", async () => {
  const app = await buildTestApp();
  const adminSub = `m-admin-${Date.now()}`;
  const targetSub = `m-target-${Date.now()}`;
  try {
    const adminId = await provision(app, adminSub);
    const targetId = await provision(app, targetSub);
    const orgId = await seedOrgWithMember(app, { userId: adminId, role: "admin" });
    await enrol(app, targetId, orgId, "member");

    // Promote member -> admin.
    const promote = await app.inject({
      method: "PATCH",
      url: `/api/v1/orgs/${orgId}/members/${targetId}`,
      headers: await authHeader({ sub: adminSub }),
      payload: { role: "admin" },
    });
    assert.equal(promote.statusCode, 200);
    assert.equal(promote.json().role, "admin");

    // Remove them.
    const remove = await app.inject({
      method: "DELETE",
      url: `/api/v1/orgs/${orgId}/members/${targetId}`,
      headers: await authHeader({ sub: adminSub }),
    });
    assert.equal(remove.statusCode, 204);
  } finally {
    await app.close();
  }
});

test("an admin cannot make or remove an owner — that needs an owner", async () => {
  const app = await buildTestApp();
  const adminSub = `own-admin-${Date.now()}`;
  const ownerSub = `own-owner-${Date.now()}`;
  try {
    const adminId = await provision(app, adminSub);
    const ownerId = await provision(app, ownerSub);
    const orgId = await seedOrgWithMember(app, { userId: adminId, role: "admin" });
    await enrol(app, ownerId, orgId, "owner");

    // Admin tries to promote themselves to owner → 403.
    const grab = await app.inject({
      method: "PATCH",
      url: `/api/v1/orgs/${orgId}/members/${adminId}`,
      headers: await authHeader({ sub: adminSub }),
      payload: { role: "owner" },
    });
    assert.equal(grab.statusCode, 403);

    // Admin tries to remove the owner → 403.
    const boot = await app.inject({
      method: "DELETE",
      url: `/api/v1/orgs/${orgId}/members/${ownerId}`,
      headers: await authHeader({ sub: adminSub }),
    });
    assert.equal(boot.statusCode, 403);
  } finally {
    await app.close();
  }
});

test("a member cannot manage other members", async () => {
  const app = await buildTestApp();
  const memberSub = `plain-${Date.now()}`;
  const otherSub = `other-${Date.now()}`;
  try {
    const memberId = await provision(app, memberSub);
    const otherId = await provision(app, otherSub);
    const orgId = await seedOrgWithMember(app, { userId: memberId, role: "member" });
    await enrol(app, otherId, orgId, "member");

    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/orgs/${orgId}/members/${otherId}`,
      headers: await authHeader({ sub: memberSub }),
      payload: { role: "admin" },
    });
    assert.equal(res.statusCode, 403);
  } finally {
    await app.close();
  }
});

test("the last owner can be neither demoted nor removed", async () => {
  const app = await buildTestApp();
  const ownerSub = `last-${Date.now()}`;
  try {
    const ownerId = await provision(app, ownerSub);
    const orgId = await seedOrgWithMember(app, { userId: ownerId, role: "owner" });

    const demote = await app.inject({
      method: "PATCH",
      url: `/api/v1/orgs/${orgId}/members/${ownerId}`,
      headers: await authHeader({ sub: ownerSub }),
      payload: { role: "member" },
    });
    assert.equal(demote.statusCode, 400);

    const remove = await app.inject({
      method: "DELETE",
      url: `/api/v1/orgs/${orgId}/members/${ownerId}`,
      headers: await authHeader({ sub: ownerSub }),
    });
    assert.equal(remove.statusCode, 400);
  } finally {
    await app.close();
  }
});

test("a second owner frees the first to step down (ownership transfer)", async () => {
  const app = await buildTestApp();
  const firstSub = `t1-${Date.now()}`;
  const secondSub = `t2-${Date.now()}`;
  try {
    const firstId = await provision(app, firstSub);
    const secondId = await provision(app, secondSub);
    const orgId = await seedOrgWithMember(app, { userId: firstId, role: "owner" });
    await enrol(app, secondId, orgId, "admin");

    // First owner promotes the admin to owner (ownership transfer needs owner).
    const promote = await app.inject({
      method: "PATCH",
      url: `/api/v1/orgs/${orgId}/members/${secondId}`,
      headers: await authHeader({ sub: firstSub }),
      payload: { role: "owner" },
    });
    assert.equal(promote.statusCode, 200);

    // Now there are two owners, so the first can step down to member.
    const stepDown = await app.inject({
      method: "PATCH",
      url: `/api/v1/orgs/${orgId}/members/${firstId}`,
      headers: await authHeader({ sub: firstSub }),
      payload: { role: "member" },
    });
    assert.equal(stepDown.statusCode, 200);
    assert.equal(stepDown.json().role, "member");
  } finally {
    await app.close();
  }
});

test("GET /members lists the roster for any member", async () => {
  const app = await buildTestApp();
  const sub = `roster-${Date.now()}`;
  try {
    const userId = await provision(app, sub);
    const orgId = await seedOrg(app);
    await enrol(app, userId, orgId, "member");

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/orgs/${orgId}/members`,
      headers: await authHeader({ sub }),
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().length, 1);
    assert.equal(res.json()[0].userId, userId);
  } finally {
    await app.close();
  }
});
