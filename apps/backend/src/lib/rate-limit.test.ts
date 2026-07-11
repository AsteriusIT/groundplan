import assert from "node:assert/strict";
import { test } from "node:test";

import { createRateLimiter } from "./rate-limit.js";

test("allows up to max requests per window, then blocks", () => {
  let clock = 1000;
  const limiter = createRateLimiter({ windowMs: 100, max: 3, now: () => clock });
  assert.equal(limiter.check("ip"), true);
  assert.equal(limiter.check("ip"), true);
  assert.equal(limiter.check("ip"), true);
  assert.equal(limiter.check("ip"), false); // 4th in the window is blocked
});

test("resets after the window elapses", () => {
  let clock = 0;
  const limiter = createRateLimiter({ windowMs: 100, max: 1, now: () => clock });
  assert.equal(limiter.check("ip"), true);
  assert.equal(limiter.check("ip"), false);
  clock = 101;
  assert.equal(limiter.check("ip"), true);
});

test("tracks each key independently", () => {
  const limiter = createRateLimiter({ windowMs: 100, max: 1, now: () => 0 });
  assert.equal(limiter.check("a"), true);
  assert.equal(limiter.check("b"), true);
  assert.equal(limiter.check("a"), false);
});
