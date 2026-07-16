import fp from "fastify-plugin";
import type { FastifyReply, FastifyRequest } from "fastify";
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";

import { users, type User } from "../db/schema.js";
import { ensureOnboarded } from "../services/onboarding.js";

declare module "fastify" {
  interface FastifyRequest {
    /** The authenticated user (set by the auth hook on protected routes). */
    authUser?: User;
  }
}

export type AuthPluginOptions = {
  issuer: string;
  audience: string;
  nodeEnv: string;
  /** Single-org mode (GP-115): auto-join new users to the default org. */
  singleOrg?: boolean;
  /** Injected JWKS resolver (tests). Otherwise built from OIDC discovery. */
  keyResolver?: JWTVerifyGetKey;
};

/** Routes that never require a bearer token. */
function isExempt(routeUrl: string | undefined): boolean {
  if (!routeUrl) return true; // unmatched -> let the 404 handler respond
  if (routeUrl === "/healthz") return true;
  if (routeUrl === "/api/v1/health") return true;
  if (routeUrl.startsWith("/api/v1/webhooks/")) return true;
  // Public share links (GP-39): tokenized, no bearer token.
  if (routeUrl.startsWith("/api/v1/public/")) return true;
  return false;
}

function unauthorized(reply: FastifyReply) {
  return reply
    .code(401)
    .send({ error: "Unauthorized", message: "invalid or missing token" });
}

export const authPlugin = fp<AuthPluginOptions>(async (app, opts) => {
  const { issuer, audience, keyResolver, nodeEnv, singleOrg } = opts;

  if (!issuer || !audience) {
    if (nodeEnv === "production") {
      throw new Error(
        "OIDC_ISSUER_URL and OIDC_AUDIENCE are required in production",
      );
    }
    app.log.warn("OIDC not configured — API auth is DISABLED (dev only)");
    return;
  }

  // Resolve the JWKS key getter once (injected in tests; discovered otherwise).
  let remote: JWTVerifyGetKey | undefined;
  async function getKey(): Promise<JWTVerifyGetKey> {
    if (keyResolver) return keyResolver;
    if (!remote) {
      const base = issuer.replace(/\/$/, "");
      const res = await fetch(`${base}/.well-known/openid-configuration`);
      if (!res.ok) throw new Error(`OIDC discovery failed: ${res.status}`);
      const doc = (await res.json()) as { jwks_uri?: string };
      if (!doc.jwks_uri) throw new Error("OIDC discovery missing jwks_uri");
      remote = createRemoteJWKSet(new URL(doc.jwks_uri));
    }
    return remote;
  }

  app.addHook("onRequest", async (request: FastifyRequest, reply) => {
    if (isExempt(request.routeOptions?.url)) return;

    const header = request.headers.authorization;
    if (!header?.startsWith("Bearer ")) return unauthorized(reply);
    const token = header.slice("Bearer ".length).trim();

    let subject: string;
    let email: string | null;
    let displayName: string | null;
    try {
      const { payload } = await jwtVerify(token, await getKey(), {
        issuer,
        audience,
      });
      if (!payload.sub) return unauthorized(reply);
      subject = payload.sub;
      email = typeof payload.email === "string" ? payload.email : null;
      const fallbackName =
        typeof payload.preferred_username === "string"
          ? payload.preferred_username
          : null;
      displayName =
        typeof payload.name === "string" ? payload.name : fallbackName;
    } catch (err) {
      request.log.warn({ err }, "auth: token verification failed");
      return unauthorized(reply);
    }

    // JIT provisioning: create the user on first sight, keep profile fresh.
    const [user] = await app.db
      .insert(users)
      .values({ oidcSubject: subject, email, displayName })
      .onConflictDoUpdate({
        target: users.oidcSubject,
        set: { email, displayName },
      })
      .returning();
    request.authUser = user;

    // Single-org onboarding (GP-115): make sure the user belongs to the default
    // org. Idempotent, so it never overwrites a later role change.
    if (singleOrg && user) {
      await ensureOnboarded(app.db, user.id);
    }
  });
});
