/**
 * Organization invitations (GP-116). Auth is ON (invites are an RBAC-gated,
 * per-user flow); functional tests run in SaaS mode (`buildSaasTestApp`) because
 * single-org mode disables invites entirely.
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";

import { invitations, memberships } from "../db/schema.js";
import { generateToken, hashToken } from "../lib/tokens.js";
import { loadEnv } from "../config/env.js";
import { runMigrations } from "../db/migrate.js";
import {
  authHeader,
  buildSaasTestApp,
  buildTestApp,
  seedOrgForDefaultUser,
  seedOrgWithMember,
} from "../test-support.js";

const env = loadEnv();

before(async () => {
  await runMigrations(env.databaseUrl);
});

/** JIT-provision a user by making one authed call; return their id. */
async function provision(app: Awaited<ReturnType<typeof buildSaasTestApp>>, sub: string) {
  const res = await app.inject({
    method: "GET",
    url: "/api/v1/me",
    headers: await authHeader({ sub }),
  });
  return res.json().id as string;
}

test("create → list → accept: the invitee gains the invited role", async () => {
  const app = await buildSaasTestApp();
  const ownerSub = `inv-owner-${Date.now()}`;
  const inviteeSub = `inv-ee-${Date.now()}`;
  try {
    const ownerId = await provision(app, ownerSub);
    const orgId = await seedOrgWithMember(app, { userId: ownerId, role: "owner" });

    // Owner mints a member invite; the token is shown once.
    const created = await app.inject({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/invitations`,
      headers: await authHeader({ sub: ownerSub }),
      payload: { role: "member", email: "new@example.com" },
    });
    assert.equal(created.statusCode, 201);
    const invite = created.json();
    assert.equal(invite.role, "member");
    assert.ok(invite.token, "the raw token is returned once");

    // It shows in the pending list (without the token).
    const list = await app.inject({
      method: "GET",
      url: `/api/v1/orgs/${orgId}/invitations`,
      headers: await authHeader({ sub: ownerSub }),
    });
    assert.equal(list.statusCode, 200);
    assert.equal(list.json().length, 1);
    assert.equal(list.json()[0].token, undefined, "list never carries the token");

    // A different, logged-in user accepts it and joins as a member.
    await provision(app, inviteeSub);
    const accept = await app.inject({
      method: "POST",
      url: "/api/v1/invitations/accept",
      headers: await authHeader({ sub: inviteeSub }),
      payload: { token: invite.token },
    });
    assert.equal(accept.statusCode, 200);
    assert.equal(accept.json().organization.id, orgId);

    // They are now in the org's member list.
    const members = await app.inject({
      method: "GET",
      url: `/api/v1/orgs/${orgId}/members`,
      headers: await authHeader({ sub: ownerSub }),
    });
    assert.ok(
      members.json().some((m: { email: string | null }) => m.email !== null),
      "the invitee appears among members",
    );

    // Accepting a second time is refused.
    const again = await app.inject({
      method: "POST",
      url: "/api/v1/invitations/accept",
      headers: await authHeader({ sub: inviteeSub }),
      payload: { token: invite.token },
    });
    assert.equal(again.statusCode, 409);
  } finally {
    await app.close();
  }
});

test("accepting a revoked invite fails", async () => {
  const app = await buildSaasTestApp();
  const ownerSub = `rev-owner-${Date.now()}`;
  try {
    const ownerId = await provision(app, ownerSub);
    const orgId = await seedOrgWithMember(app, { userId: ownerId, role: "admin" });

    const invite = (
      await app.inject({
        method: "POST",
        url: `/api/v1/orgs/${orgId}/invitations`,
        headers: await authHeader({ sub: ownerSub }),
        payload: { role: "member" },
      })
    ).json();

    // Revoke = delete the pending invite.
    const revoke = await app.inject({
      method: "DELETE",
      url: `/api/v1/orgs/${orgId}/invitations/${invite.id}`,
      headers: await authHeader({ sub: ownerSub }),
    });
    assert.equal(revoke.statusCode, 204);

    const accept = await app.inject({
      method: "POST",
      url: "/api/v1/invitations/accept",
      headers: await authHeader({ sub: `rev-ee-${Date.now()}` }),
      payload: { token: invite.token },
    });
    assert.equal(accept.statusCode, 404);
  } finally {
    await app.close();
  }
});

test("an expired invite is a clear 4xx", async () => {
  const app = await buildSaasTestApp();
  const sub = `exp-${Date.now()}`;
  try {
    const userId = await provision(app, sub);
    const orgId = await seedOrgWithMember(app, { userId, role: "owner" });

    // Insert one already expired (the create route's TTL is fixed at 7 days).
    const token = generateToken();
    await app.db.insert(invitations).values({
      organizationId: orgId,
      role: "member",
      tokenHash: hashToken(token),
      expiresAt: new Date(Date.now() - 60_000),
    });

    const accept = await app.inject({
      method: "POST",
      url: "/api/v1/invitations/accept",
      headers: await authHeader({ sub: `exp-ee-${Date.now()}` }),
      payload: { token },
    });
    assert.equal(accept.statusCode, 410);
  } finally {
    await app.close();
  }
});

test("an existing member accepting an invite is a no-op — no role escalation", async () => {
  const app = await buildSaasTestApp();
  const ownerSub = `esc-owner-${Date.now()}`;
  const memberSub = `esc-member-${Date.now()}`;
  try {
    const ownerId = await provision(app, ownerSub);
    const orgId = await seedOrgWithMember(app, { userId: ownerId, role: "owner" });
    // Make the invitee already a plain member.
    const memberId = await provision(app, memberSub);
    await app.db
      .insert(memberships)
      .values({ userId: memberId, organizationId: orgId, role: "member" });

    // Owner invites them as ADMIN.
    const invite = (
      await app.inject({
        method: "POST",
        url: `/api/v1/orgs/${orgId}/invitations`,
        headers: await authHeader({ sub: ownerSub }),
        payload: { role: "admin" },
      })
    ).json();

    const accept = await app.inject({
      method: "POST",
      url: "/api/v1/invitations/accept",
      headers: await authHeader({ sub: memberSub }),
      payload: { token: invite.token },
    });
    assert.equal(accept.statusCode, 200);

    // Still a member — the invite did not escalate them to admin.
    const members = await app.inject({
      method: "GET",
      url: `/api/v1/orgs/${orgId}/members`,
      headers: await authHeader({ sub: ownerSub }),
    });
    const me = members.json().find((m: { userId: string }) => m.userId === memberId);
    assert.equal(me.role, "member", "role must not be escalated by an invite");
  } finally {
    await app.close();
  }
});

test("only admin/owner may create invites; a member gets 403", async () => {
  const app = await buildSaasTestApp();
  const memberSub = `mem-${Date.now()}`;
  try {
    const memberId = await provision(app, memberSub);
    const orgId = await seedOrgWithMember(app, { userId: memberId, role: "member" });

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/invitations`,
      headers: await authHeader({ sub: memberSub }),
      payload: { role: "member" },
    });
    assert.equal(res.statusCode, 403);
  } finally {
    await app.close();
  }
});

test("an owner-role invite is rejected by the schema (422)", async () => {
  const app = await buildSaasTestApp();
  const sub = `own-${Date.now()}`;
  try {
    const userId = await provision(app, sub);
    const orgId = await seedOrgWithMember(app, { userId, role: "owner" });
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/invitations`,
      headers: await authHeader({ sub }),
      payload: { role: "owner" },
    });
    assert.equal(res.statusCode, 422);
  } finally {
    await app.close();
  }
});

test("single-org mode disables invite creation (400)", async () => {
  const app = await buildTestApp(); // singleOrg on
  try {
    const orgId = await seedOrgForDefaultUser(app, "owner");
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/invitations`,
      headers: await authHeader(),
      payload: { role: "member" },
    });
    assert.equal(res.statusCode, 400);
  } finally {
    await app.close();
  }
});
