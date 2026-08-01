/**
 * Refresh orchestration (GP-235), against a real Postgres and a fake registry.
 *
 * The acceptance criteria are all about what a *reader* experiences while the
 * catalog is moving underneath: concurrent refreshes must extract once, an
 * unreachable registry must change nothing, and a version being extracted must
 * be invisible until it succeeds.
 */
import { test, before, describe } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

import { drizzle } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";
import { Pool } from "pg";

import type { ProviderResourceSchema } from "@groundplan/builder";

import { loadEnv } from "../config/env.js";
import { runMigrations } from "../db/migrate.js";
import { catalogProviders } from "../db/schema.js";
import type { ProviderRef } from "./providers.js";
import {
  refreshCatalog,
  refreshProvider,
  refusingExtractor,
  retryDelayMs,
  shouldCheckRegistry,
  type RefreshOptions,
  type SchemaExtractor,
} from "./refresh.js";
import type { RegistryClient } from "./registry.js";
import { catalogRepository } from "./repository.js";
import { AZURERM_SCHEMAS as SCHEMAS } from "./__fixtures__/azurerm.js";

const env = loadEnv();
const pool = new Pool({ connectionString: env.databaseUrl });
const db = drizzle(pool);
const repo = catalogRepository(db);

const TTL_MS = 60 * 60 * 1000;

before(async () => {
  await runMigrations(env.databaseUrl);
});

function uniqueProvider(): ProviderRef {
  return {
    namespace: `test-${Date.now()}-${randomBytes(4).toString("hex")}`,
    name: "azurerm",
  };
}

async function cleanup(ref: ProviderRef): Promise<void> {
  await db
    .delete(catalogProviders)
    .where(eq(catalogProviders.namespace, ref.namespace));
}

/** A registry that answers from a list, and counts how often it was asked. */
function fakeRegistry(versions: readonly string[]) {
  let calls = 0;
  const client: RegistryClient = {
    listVersions: async () => {
      calls += 1;
      return versions;
    },
  };
  return { client, calls: () => calls };
}

/** An extractor that answers with the fixture, and counts how often it ran. */
function fakeExtractor(schemas: readonly ProviderResourceSchema[] = SCHEMAS) {
  let calls = 0;
  const extractor: SchemaExtractor = {
    extract: async () => {
      calls += 1;
      return schemas;
    },
  };
  return { extractor, calls: () => calls };
}

function options(
  ref: ProviderRef,
  over: Partial<RefreshOptions> = {},
): RefreshOptions {
  return {
    repo,
    registry: fakeRegistry(["4.81.0"]).client,
    extractor: fakeExtractor().extractor,
    allowlist: [ref],
    mode: "auto",
    ttlMs: TTL_MS,
    ...over,
  };
}

describe("trigger policy (GP-235)", () => {
  const now = new Date("2026-08-01T12:00:00Z");

  test("never checked means check now — the first tick fills an empty catalog", () => {
    assert.equal(shouldCheckRegistry(null, now, TTL_MS), true);
  });

  test("inside the TTL, nothing is asked", () => {
    const recent = new Date(now.getTime() - TTL_MS / 2);
    assert.equal(shouldCheckRegistry(recent, now, TTL_MS), false);
  });

  test("past the TTL, ask again", () => {
    const old = new Date(now.getTime() - TTL_MS - 1);
    assert.equal(shouldCheckRegistry(old, now, TTL_MS), true);
  });

  test("a version that keeps failing is retried further and further apart, capped", () => {
    assert.equal(retryDelayMs(1, TTL_MS), TTL_MS);
    assert.equal(retryDelayMs(2, TTL_MS), TTL_MS * 2);
    assert.equal(retryDelayMs(4, TTL_MS), TTL_MS * 8);
    // Capped, so a long-broken provider is still retried rather than abandoned.
    assert.equal(retryDelayMs(40, TTL_MS), TTL_MS * 8);
  });
});

describe("refreshProvider (GP-235)", () => {
  test("extracts a version nobody has, and serves it afterwards", async () => {
    const ref = uniqueProvider();
    try {
      const extractor = fakeExtractor();
      const outcome = await refreshProvider(
        ref,
        options(ref, { extractor: extractor.extractor }),
      );
      assert.deepEqual(outcome, {
        provider: `${ref.namespace}/azurerm`,
        action: "extracted",
        version: "4.81.0",
        types: SCHEMAS.length,
      });
      assert.equal(extractor.calls(), 1);
      assert.equal((await repo.getLatestReadyVersion(ref))?.version, "4.81.0");
    } finally {
      await cleanup(ref);
    }
  });

  test("a pre-release is skipped: the newest stable is what gets extracted", async () => {
    const ref = uniqueProvider();
    try {
      const outcome = await refreshProvider(
        ref,
        options(ref, {
          registry: fakeRegistry(["4.81.0", "4.82.0-beta1"]).client,
        }),
      );
      assert.equal(outcome.action, "extracted");
      assert.equal((await repo.getLatestReadyVersion(ref))?.version, "4.81.0");
    } finally {
      await cleanup(ref);
    }
  });

  test("inside the TTL the registry is not asked at all", async () => {
    const ref = uniqueProvider();
    try {
      const registry = fakeRegistry(["4.81.0"]);
      const at = new Date();
      await refreshProvider(
        ref,
        options(ref, { registry: registry.client, now: () => at }),
      );
      assert.equal(registry.calls(), 1);

      const soon = new Date(at.getTime() + TTL_MS / 2);
      const outcome = await refreshProvider(
        ref,
        options(ref, { registry: registry.client, now: () => soon }),
      );
      assert.equal(outcome.action, "skipped_fresh");
      assert.equal(registry.calls(), 1);
    } finally {
      await cleanup(ref);
    }
  });

  test("an unreachable registry leaves the cached catalog fully served", async () => {
    const ref = uniqueProvider();
    try {
      await refreshProvider(ref, options(ref));
      const before = await repo.getLatestReadyVersion(ref);

      const later = new Date(Date.now() + TTL_MS * 2);
      const outcome = await refreshProvider(
        ref,
        options(ref, {
          now: () => later,
          registry: {
            listVersions: async () => {
              throw new Error("getaddrinfo ENOTFOUND registry.terraform.io");
            },
          },
        }),
      );
      assert.equal(outcome.action, "registry_unreachable");

      const after = await repo.getLatestReadyVersion(ref);
      assert.equal(after?.version, before?.version);
      const types = await repo.listResourceTypes(after!.versionId, {
        limit: 500,
      });
      assert.ok(types.total > 0, "every stored type is still readable");

      // And the failed check did not start the TTL: the next tick asks again.
      const row = await repo.findProvider(ref);
      assert.ok(row!.lastCheckedAt!.getTime() < later.getTime());
    } finally {
      await cleanup(ref);
    }
  });

  test("refresh disabled: no outbound call is ever made", async () => {
    const ref = uniqueProvider();
    try {
      const registry = fakeRegistry(["4.81.0"]);
      const extractor = fakeExtractor();
      const outcome = await refreshProvider(
        ref,
        options(ref, {
          mode: "disabled",
          registry: registry.client,
          extractor: extractor.extractor,
        }),
      );
      assert.equal(outcome.action, "skipped_disabled");
      assert.equal(registry.calls(), 0);
      assert.equal(extractor.calls(), 0);
    } finally {
      await cleanup(ref);
    }
  });

  test("a provider outside the allowlist is never fetched", async () => {
    const ref = uniqueProvider();
    try {
      const registry = fakeRegistry(["4.81.0"]);
      const outcome = await refreshProvider(
        ref,
        options(ref, { allowlist: [], registry: registry.client }),
      );
      assert.equal(outcome.action, "skipped_disabled");
      assert.equal(registry.calls(), 0);
      // The row is still there, with the flag cleared — an ex-allowlisted
      // provider keeps its schemas readable and simply stops being refreshed.
      assert.equal((await repo.findProvider(ref))?.allowlisted, false);
    } finally {
      await cleanup(ref);
    }
  });

  test("a version already served is not extracted again", async () => {
    const ref = uniqueProvider();
    try {
      await refreshProvider(ref, options(ref));
      const extractor = fakeExtractor();
      const later = new Date(Date.now() + TTL_MS * 2);
      const outcome = await refreshProvider(
        ref,
        options(ref, { extractor: extractor.extractor, now: () => later }),
      );
      assert.deepEqual(outcome, {
        provider: `${ref.namespace}/azurerm`,
        action: "up_to_date",
        version: "4.81.0",
      });
      assert.equal(extractor.calls(), 0);
    } finally {
      await cleanup(ref);
    }
  });

  test("concurrent refreshes extract exactly once, and reads never degrade", async () => {
    const ref = uniqueProvider();
    try {
      // Seed a ready 4.81.0, so there is something to keep serving.
      await refreshProvider(ref, options(ref));

      let running = 0;
      let peak = 0;
      let release: (() => void) | undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const slow: SchemaExtractor = {
        extract: async () => {
          running += 1;
          peak = Math.max(peak, running);
          await gate;
          running -= 1;
          return SCHEMAS.map((s) => ({ ...s, version: "4.82.0" }));
        },
      };

      // A zero TTL so every pass genuinely reaches the claim: with a real TTL
      // the losers would be turned away one step earlier, by the check the
      // winner just recorded, and the claim would never be exercised.
      const later = new Date(Date.now() + TTL_MS * 2);
      let settled = 0;
      const passes = Array.from({ length: 4 }, () =>
        refreshProvider(
          ref,
          options(ref, {
            registry: fakeRegistry(["4.81.0", "4.82.0"]).client,
            extractor: slow,
            ttlMs: 0,
            now: () => later,
          }),
        ).then((outcome) => {
          settled += 1;
          return outcome;
        }),
      );

      // Wait for the three that did not win the claim, rather than for a
      // wall-clock moment: the winner is held on the gate and cannot settle, so
      // this is the point where "one extracting, three turned away" is true.
      const deadline = Date.now() + 10_000;
      while (settled < 3 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      assert.equal(settled, 3, "three passes should have been turned away");

      // While the new version is being extracted, every read is served the old
      // one — that is what stale-while-revalidate has to mean.
      const during = await repo.getLatestReadyVersion(ref);
      assert.equal(during?.version, "4.81.0");

      release!();
      const outcomes = await Promise.all(passes);
      assert.equal(peak, 1, "exactly one extraction ran");
      assert.equal(
        outcomes.filter((o) => o.action === "extracted").length,
        1,
      );
      assert.equal(
        outcomes.filter((o) => o.action === "already_running").length,
        3,
      );
      assert.equal((await repo.getLatestReadyVersion(ref))?.version, "4.82.0");
    } finally {
      await cleanup(ref);
    }
  });

  test("a failed extraction keeps the previous version served and records why", async () => {
    const ref = uniqueProvider();
    try {
      await refreshProvider(ref, options(ref));

      const later = new Date(Date.now() + TTL_MS * 2);
      const outcome = await refreshProvider(
        ref,
        options(ref, {
          registry: fakeRegistry(["4.82.0"]).client,
          extractor: {
            extract: async () => {
              throw new Error("terraform init timed out");
            },
          },
          now: () => later,
        }),
      );
      assert.equal(outcome.action, "failed");
      assert.equal((await repo.getLatestReadyVersion(ref))?.version, "4.81.0");

      const states = await repo.listProviders();
      const state = states.find((s) => s.namespace === ref.namespace);
      assert.equal(state?.lastError, "terraform init timed out");
      assert.equal(state?.readyVersion, "4.81.0");
    } finally {
      await cleanup(ref);
    }
  });

  test("a version that just failed backs off instead of retrying every tick", async () => {
    const ref = uniqueProvider();
    try {
      const failing: SchemaExtractor = {
        extract: async () => {
          throw new Error("nope");
        },
      };
      const at = new Date();
      await refreshProvider(
        ref,
        options(ref, { extractor: failing, now: () => at }),
      );

      const extractor = fakeExtractor();
      const soon = new Date(at.getTime() + TTL_MS + 1);
      const outcome = await refreshProvider(
        ref,
        options(ref, { extractor: extractor.extractor, now: () => soon }),
      );
      assert.equal(outcome.action, "already_running");
      assert.equal(extractor.calls(), 0);

      const past = new Date(at.getTime() + TTL_MS * 3);
      const retried = await refreshProvider(
        ref,
        options(ref, { extractor: extractor.extractor, now: () => past }),
      );
      assert.equal(retried.action, "extracted");
    } finally {
      await cleanup(ref);
    }
  });

  test("the API process refuses to extract, and says so in the version's error", async () => {
    const ref = uniqueProvider();
    try {
      const outcome = await refreshProvider(
        ref,
        options(ref, { extractor: refusingExtractor }),
      );
      assert.equal(outcome.action, "failed");
      assert.match(outcome.action === "failed" ? outcome.error : "", /worker/);
      // Nothing was left `pending` with no explanation.
      const states = await repo.listProviders();
      assert.match(
        states.find((s) => s.namespace === ref.namespace)?.lastError ?? "",
        /does not run in this process/,
      );
    } finally {
      await cleanup(ref);
    }
  });
});

describe("refreshCatalog (GP-235)", () => {
  test("walks every allowlisted provider, one at a time", async () => {
    const first = uniqueProvider();
    const second = { ...uniqueProvider(), name: "aws" };
    try {
      let running = 0;
      let peak = 0;
      const extractor: SchemaExtractor = {
        extract: async () => {
          running += 1;
          peak = Math.max(peak, running);
          await new Promise((resolve) => setTimeout(resolve, 5));
          running -= 1;
          return SCHEMAS;
        },
      };
      const outcomes = await refreshCatalog({
        ...options(first, { extractor }),
        allowlist: [first, second],
      });
      assert.deepEqual(
        outcomes.map((o) => o.action),
        ["extracted", "extracted"],
      );
      // Sequential: an extraction downloads hundreds of megabytes, and four at
      // once is how a worker gets killed for memory instead of finishing three.
      assert.equal(peak, 1);
    } finally {
      await cleanup(first);
      await cleanup(second);
    }
  });
});
