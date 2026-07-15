import fp from "fastify-plugin";

import { pollAllRepositories } from "../services/ref-poller.js";

declare module "fastify" {
  interface FastifyInstance {
    /** Run one ref-poll tick over every repository now (never overlaps). */
    pollRefsOnce(): Promise<void>;
  }
}

export type RefPollerOptions = {
  /** How often to poll, in ms. `0` disables the timer (tests drive it by hand). */
  intervalMs: number;
};

/**
 * The ref poller's clock (GP-107). A plain `setInterval`, no queue and no worker
 * pool (ADR #7): every `intervalMs` it walks the repositories once. Ticks never
 * overlap — a slow tick just means the next one is skipped — and the timer is
 * `unref`'d so it can never hold the process open on shutdown.
 *
 * `pollRefsOnce` is decorated regardless of the interval, so tests (and any
 * future manual trigger) can run a tick deterministically without a timer.
 */
export const refPollerPlugin = fp<RefPollerOptions>(async (app, opts) => {
  let running = false;

  const tick = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      await pollAllRepositories(app);
    } catch (err) {
      app.log.error({ err }, "ref poll tick failed");
    } finally {
      running = false;
    }
  };

  app.decorate("pollRefsOnce", tick);

  if (opts.intervalMs > 0) {
    const timer = setInterval(() => void tick(), opts.intervalMs);
    timer.unref();
    app.addHook("onClose", async () => {
      clearInterval(timer);
    });
  }
});
