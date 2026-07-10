/**
 * Test-only helpers for exercising OIDC auth without a network / real IdP.
 * A throwaway RSA keypair signs local JWTs; its public JWK is fed to the app
 * as a local JWKS, so verification is fully offline.
 */
import {
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  SignJWT,
  type JWTVerifyGetKey,
} from "jose";

import { buildApp, type BuildAppOptions } from "./app.js";
import { loadEnv, type AppEnv } from "./config/env.js";

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
  if (!keyMaterial) keyMaterial = makeKeys();
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
