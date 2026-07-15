import fp from "fastify-plugin";

declare module "fastify" {
  interface FastifyInstance {
    /** Run a promise after the response is sent. Rejections are logged. */
    runInBackground(task: Promise<unknown>): void;
    /** Await all currently-pending background tasks (shutdown / tests). */
    flushBackgroundTasks(): Promise<void>;
  }
}

/**
 * A tiny fire-and-forget task tracker — no queue infrastructure. Used by the CI
 * webhook to kick off docs generation on merge (GP-23) without blocking the 202.
 * Pending tasks are awaited on shutdown so nothing is silently dropped.
 */
export const backgroundPlugin = fp(async (app) => {
  const pending = new Set<Promise<unknown>>();

  app.decorate("runInBackground", (task: Promise<unknown>) => {
    const tracked = Promise.resolve(task).catch((err) => {
      app.log.error({ err }, "background task failed");
    });
    pending.add(tracked);
    void tracked.finally(() => pending.delete(tracked));
  });

  app.decorate("flushBackgroundTasks", async () => {
    await Promise.allSettled(pending);
  });

  app.addHook("onClose", async () => {
    await Promise.allSettled(pending);
  });
});
