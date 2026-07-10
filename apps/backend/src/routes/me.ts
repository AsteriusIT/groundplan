import type { FastifyPluginAsync } from "fastify";

/** Returns the currently authenticated user. Requires a valid bearer token. */
export const meRoutes: FastifyPluginAsync = async (app) => {
  app.get("/me", async (request, reply) => {
    const user = request.authUser;
    if (!user) {
      // The auth hook guarantees this on protected routes; guard defensively.
      return reply
        .code(401)
        .send({ error: "Unauthorized", message: "not authenticated" });
    }
    return {
      id: user.id,
      email: user.email,
      display_name: user.displayName,
    };
  });
};
