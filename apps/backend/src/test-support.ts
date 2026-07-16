/**
 * Test-only helpers for exercising OIDC auth without a network / real IdP.
 * A throwaway RSA keypair signs local JWTs; its public JWK is fed to the app
 * as a local JWKS, so verification is fully offline.
 */
import { randomBytes } from "node:crypto";

import {
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  SignJWT,
  type JWTVerifyGetKey,
} from "jose";

import type { FastifyInstance } from "fastify";

import { buildApp, type BuildAppOptions } from "./app.js";
import { loadEnv, type AppEnv } from "./config/env.js";
import { memberships, organizations } from "./db/schema.js";
import type { Role } from "./rbac/permissions.js";

export const TEST_ISSUER = "https://issuer.test.groundplan.local";
export const TEST_AUDIENCE = "groundplan-test";
const TEST_KID = "test-key-1";

function makeKeys() {
  return (async () => {
    const { publicKey, privateKey } = await generateKeyPair("RS256", {
      extractable: true,
    });
    const jwk = await exportJWK(publicKey);
    jwk.kid = TEST_KID;
    jwk.alg = "RS256";
    jwk.use = "sig";
    return { privateKey, keyResolver: createLocalJWKSet({ keys: [jwk] }) };
  })();
}

let keyMaterial: ReturnType<typeof makeKeys> | undefined;

async function keys() {
  keyMaterial ??= makeKeys();
  return keyMaterial;
}

/** The local JWKS resolver to inject into the app under test. */
export async function testKeyResolver(): Promise<JWTVerifyGetKey> {
  return (await keys()).keyResolver;
}

export type TokenClaims = {
  sub?: string;
  email?: string;
  name?: string;
  issuer?: string;
  audience?: string;
  expiresInSeconds?: number;
};

/** Sign a JWT with the test key. Override any claim; defaults are valid. */
export async function signTestToken(claims: TokenClaims = {}): Promise<string> {
  const { privateKey } = await keys();
  const nowSeconds = Math.floor(Date.now() / 1000);
  const ttl = claims.expiresInSeconds ?? 3600;
  return new SignJWT({
    email: claims.email ?? "dev@example.com",
    name: claims.name ?? "Dev User",
  })
    .setProtectedHeader({ alg: "RS256", kid: TEST_KID })
    .setSubject(claims.sub ?? "test-subject-1")
    .setIssuer(claims.issuer ?? TEST_ISSUER)
    .setAudience(claims.audience ?? TEST_AUDIENCE)
    .setIssuedAt(nowSeconds)
    .setExpirationTime(nowSeconds + ttl)
    .sign(privateKey);
}

/** Authorization header carrying a valid (or overridden) bearer token. */
export async function authHeader(
  claims?: TokenClaims,
): Promise<{ authorization: string }> {
  return { authorization: `Bearer ${await signTestToken(claims)}` };
}

/** Env with OIDC configured to the test issuer/audience. */
export function testAuthEnv(): AppEnv {
  return { ...loadEnv(), oidcIssuer: TEST_ISSUER, oidcAudience: TEST_AUDIENCE };
}

/** Build an app with OIDC auth active and the local test JWKS injected. */
export async function buildTestApp(opts: BuildAppOptions = {}) {
  return buildApp(testAuthEnv(), { jwks: await testKeyResolver(), ...opts });
}

/**
 * Seed an organization directly (GP-114) and return its id, for the many route
 * tests that now address resources under `/api/v1/orgs/:orgId/...`. A direct DB
 * insert rather than `POST /orgs` keeps this working regardless of the
 * org-creation gating that lands in GP-115. The slug carries the 13-digit
 * timestamp marker the global teardown sweeps, plus random bytes so it stays
 * unique across the parallel test processes `node --test` spawns.
 */
export async function seedOrg(
  app: FastifyInstance,
  name = "Test Org",
): Promise<string> {
  const slug = `test-org-${Date.now()}-${randomBytes(6).toString("hex")}`;
  const [org] = await app.db
    .insert(organizations)
    .values({ name, slug })
    .returning({ id: organizations.id });
  return org!.id;
}

/**
 * Seed an organization and enrol a user in it with a role (GP-114), for RBAC
 * tests that run with auth on. Returns the org id; pair it with `authHeader({ sub })`.
 */
export async function seedOrgWithMember(
  app: FastifyInstance,
  opts: { userId: string; role: Role; name?: string },
): Promise<string> {
  const orgId = await seedOrg(app, opts.name);
  await app.db
    .insert(memberships)
    .values({ userId: opts.userId, organizationId: orgId, role: opts.role });
  return orgId;
}

/**
 * Seed an org and enrol the *default* `authHeader()` user (sub "test-subject-1")
 * in it, provisioning that user first via `/me`. For auth-on functional tests
 * (`buildTestApp()` + `authHeader()`) that then address `/orgs/:orgId/...`.
 */
export async function seedOrgForDefaultUser(
  app: FastifyInstance,
  role: Role = "owner",
): Promise<string> {
  const me = await app.inject({
    method: "GET",
    url: "/api/v1/me",
    headers: await authHeader(),
  });
  const userId = me.json().id as string;
  return seedOrgWithMember(app, { userId, role });
}
