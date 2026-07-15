import type { FastifyPluginAsync } from "fastify";

import {
  clearAppWebhookToken,
  getIngestionSettings,
  rotateAppWebhookToken,
} from "../services/app-settings.js";

/**
 * Global settings the app exposes to authenticated users. Today it is only the
 * app-wide CI ingestion token — a second webhook secret that any repository
 * accepts, so an estate can wire one secret instead of one per repository.
 *
 * There is no role model yet, so any authenticated user may read and rotate it;
 * that is a documented limitation, scoped here (beside dashboard/clusters) when
 * ownership lands. The token's value leaves the server exactly once, from the
 * rotate endpoint — the read masks it to a boolean.
 */
export const settingsRoutes: FastifyPluginAsync = async (app) => {
  // Is an app-wide token set, and when was it last set? Never the value itself.
  app.get("/settings/ingestion", async () => {
    return getIngestionSettings(app.db);
  });

  // Generate or rotate the app-wide token. The previous value stops working the
  // moment this returns; the new one is shown once here and then only ever masked.
  app.post("/settings/ingestion/webhook-token", async (_request, reply) => {
    const token = await rotateAppWebhookToken(app.db);
    return reply.code(201).send({ webhookToken: token });
  });

  // Revoke the app-wide token. Per-repository tokens keep working.
  app.delete("/settings/ingestion/webhook-token", async (_request, reply) => {
    await clearAppWebhookToken(app.db);
    return reply.code(204).send();
  });
};
