/**
 * First-login onboarding & SINGLE_ORG mode (GP-115).
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { and, eq } from "drizzle-orm";

import { buildApp } from "../app.js";
import { loadEnv } from "../config/env.js";
import { runMigrations } from "../db/migrate.js";
import { memberships, organizations, users } from "../db/schema.js";
import {
  authHeader,
  buildSaasTestApp,
  buildTestApp,
  seedOrg,
} from "../test-support.js";
import {
  ensureOnboarded,
  roleForNewMember,
  DEFAULT_ORG_SLUG,
} from "./onboarding.js";

const env = loadEnv();

before(async () => {
  await runMigrations(env.databaseUrl);
});

let seq = 0;
async function makeUser(app: Awaited<ReturnType<typeof buildApp>>) {
  seq += 1;
  const [user] = await app.db
    .insert(users)
    .values({ oidcSubject: `onb-${Date.now()}-${seq}`, email: "u@example.com" })
    .returning();
  return user!.id;
}

test("roleForNewMember: owner for the first, member for everyone after", async () => {
  const app = await buildApp(env);
  try {
    const orgId = await seedOrg(app);
    // Empty org → the first member is the owner.
    assert.equal(await roleForNewMember(app.db, orgId), "owner");

    // Give the org a member; now new joiners are plain members.
    const userId = await makeUser(app);
    await app.db
      .insert(memberships)
      .values({ userId, organizationId: orgId, role: "owner" });
    assert.equal(await roleForNewMember(app.db, orgId), "member");
  } finally {
    await app.close();
  }
});

test("ensureOnboarded joins the default org, idempotently", async () => {
  const app = await buildApp(env);
  try {
    const userId = await makeUser(app);

    const role = await ensureOnboarded(app.db, userId);
    assert.ok(role === "owner" || role === "member");

    const [defaultOrg] = await app.db
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.slug, DEFAULT_ORG_SLUG));
    const rows = await app.db
      .select()
      .from(memberships)
      .where(
        and(
          eq(memberships.userId, userId),
          eq(memberships.organizationId, defaultOrg!.id),
        ),
      );
    assert.equal(rows.length, 1, "exactly one default-org membership");

    // Calling again is a no-op (no duplicate, same role).
    const again = await ensureOnboarded(app.db, userId);
    assert.equal(again, rows[0]!.role);
    const after = await app.db
      .select()
      .from(memberships)
      .where(
        and(
          eq(memberships.userId, userId),
          eq(memberships.organizationId, defaultOrg!.id),
        ),
      );
    assert.equal(after.length, 1);
  } finally {
    await app.close();
  }
});

test("single-org: a first login auto-joins the default org; /me reflects it", async () => {
  const app = await buildTestApp(); // singleOrg defaults on
  const sub = `single-${Date.now()}`;
  try {
    const me = await app.inject({
      method: "GET",
      url: "/api/v1/me",
      headers: await authHeader({ sub }),
    });
    assert.equal(me.statusCode, 200);
    const body = me.json();
    assert.equal(body.singleOrg, true);
    assert.ok(Array.isArray(body.memberships));
    const inDefault = body.memberships.find(
      (m: { organization: { slug: string } }) =>
        m.organization.slug === DEFAULT_ORG_SLUG,
    );
    assert.ok(inDefault, "single-org user is auto-joined to the default org");
    assert.ok(["owner", "member"].includes(inDefault.role));
  } finally {
    await app.close();
  }
});

test("single-org: POST /orgs is disabled (400)", async () => {
  const app = await buildTestApp();
  try {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/orgs",
      headers: await authHeader({ sub: `so-${Date.now()}` }),
      payload: { name: "Nope", slug: `nope-${Date.now()}` },
    });
    assert.equal(res.statusCode, 400);
  } finally {
    await app.close();
  }
});

test("SaaS: a first login has no memberships and no auto-join", async () => {
  const app = await buildSaasTestApp();
  const sub = `saas-${Date.now()}`;
  try {
    const me = await app.inject({
      method: "GET",
      url: "/api/v1/me",
      headers: await authHeader({ sub, email: "saas@example.com" }),
    });
    assert.equal(me.statusCode, 200);
    const body = me.json();
    assert.equal(body.singleOrg, false);
    assert.deepEqual(body.memberships, [], "a fresh SaaS user belongs to nothing");
  } finally {
    await app.close();
  }
});

test("SaaS: creating an org makes you its owner and it shows in /me", async () => {
  const app = await buildSaasTestApp();
  const sub = `saas-owner-${Date.now()}`;
  const headers = await authHeader({ sub, email: "founder@example.com" });
  try {
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/orgs",
      headers,
      payload: { name: "Founded", slug: `founded-${Date.now()}` },
    });
    assert.equal(created.statusCode, 201);
    const org = created.json();

    const me = await app.inject({ method: "GET", url: "/api/v1/me", headers });
    const mine = me
      .json()
      .memberships.find((m: { organization: { id: string } }) => m.organization.id === org.id);
    assert.ok(mine, "the new org is in the founder's memberships");
    assert.equal(mine.role, "owner");

    await app.inject({
      method: "DELETE",
      url: `/api/v1/orgs/${org.id}`,
      headers,
      payload: { confirmName: "Founded" },
    });
  } finally {
    await app.close();
  }
});
