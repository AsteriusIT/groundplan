/**
 * A tiny in-memory fixed-window rate limiter (GP-39). Keyed by an opaque string
 * (typically the client IP). Deliberately simple — no Redis, no sliding window —
 * enough to blunt abuse of the unauthenticated public share routes. `now` is
 * injectable so the window can be tested without real time.
 */
export interface RateLimiter {
  /** Record a hit for `key`; returns false when the window budget is exceeded. */
  check(key: string): boolean;
}

export function createRateLimiter(opts: {
  windowMs: number;
  max: number;
  now?: () => number;
}): RateLimiter {
  const { windowMs, max } = opts;
  const now = opts.now ?? (() => Date.now());
  const buckets = new Map<string, { count: number; resetAt: number }>();

  return {
    check(key: string): boolean {
      const t = now();
      const bucket = buckets.get(key);
      if (!bucket || t >= bucket.resetAt) {
        buckets.set(key, { count: 1, resetAt: t + windowMs });
        return true;
      }
      bucket.count += 1;
      return bucket.count <= max;
    },
  };
}
