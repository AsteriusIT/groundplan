import type { FastifyPluginAsync } from "fastify";

import { membershipsFor } from "../services/onboarding.js";

/**
 * The current user, plus everything the frontend needs to route onboarding and
 * switch orgs in one call (GP-115): the caller's memberships (org identity +
 * role) and the deployment's `singleOrg` flag. Requires a valid bearer token.
 */
export const meRoutes: FastifyPluginAsync = async (app) => {
  app.get("/me", async (request, reply) => {
    const user = request.authUser;
    if (!user) {
      // The auth hook guarantees this on protected routes; guard defensively.
      return reply
        .code(401)
        .send({ error: "Unauthorized", message: "not authenticated" });
    }
    const memberships = await membershipsFor(app.db, user.id);
    return {
      id: user.id,
      email: user.email,
      display_name: user.displayName,
      memberships,
      singleOrg: app.singleOrg,
    };
  });
};
