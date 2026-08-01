/**
 * The version watcher (GP-235). Fully offline: `fetch` is injected, so the suite
 * never touches the public registry — the rule that holds everywhere in this
 * codebase.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createRegistryClient,
  isNewer,
  isStable,
  latestStable,
  parseVersion,
  REGISTRY_USER_AGENT,
} from "./registry.js";

/** The registry's real answer shape, cut down: unordered, mixed stability. */
const VERSIONS_BODY = {
  id: "hashicorp/azurerm",
  versions: [
    { version: "4.9.0" },
    { version: "4.82.0-beta1" },
    { version: "4.10.0" },
    { version: "3.117.1" },
    { version: "4.81.0" },
    { version: "not-a-version" },
  ],
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("latestStable orders by semver, not by string, and skips pre-releases", () => {
  const versions = VERSIONS_BODY.versions.map((v) => v.version);
  assert.equal(latestStable(versions), "4.81.0");
  // The reason it is not sorted as text: "4.9.0" > "4.10.0" as strings.
  assert.equal(latestStable(["4.9.0", "4.10.0"]), "4.10.0");
  assert.equal(latestStable(["4.0.0-beta1", "4.0.0-rc.2"]), null);
  assert.equal(latestStable([]), null);
});

test("a pre-release is never what a builder generates against", () => {
  assert.equal(isStable("4.82.0"), true);
  assert.equal(isStable("4.82.0-beta1"), false);
  assert.equal(isStable("4.82.0-rc.1"), false);
  // Build metadata is not a pre-release.
  assert.equal(isStable("4.82.0+ent"), true);
  assert.equal(parseVersion("garbage"), null);
});

test("isNewer treats an unknown version as newer, and compares numerically", () => {
  assert.equal(isNewer("4.81.0", null), true);
  assert.equal(isNewer("4.10.0", "4.9.0"), true);
  assert.equal(isNewer("4.9.0", "4.10.0"), false);
  assert.equal(isNewer("4.81.0", "4.81.0"), false);
});

test("listVersions asks the documented path and identifies itself", async () => {
  const calls: { url: string; headers: Headers }[] = [];
  const client = createRegistryClient({
    baseUrl: "https://registry.example/",
    fetchImpl: async (input, init) => {
      calls.push({
        url: String(input),
        headers: new Headers(init?.headers),
      });
      return jsonResponse(VERSIONS_BODY);
    },
  });

  const versions = await client.listVersions({
    namespace: "hashicorp",
    name: "azurerm",
  });
  assert.deepEqual(versions, [
    "4.9.0",
    "4.82.0-beta1",
    "4.10.0",
    "3.117.1",
    "4.81.0",
    "not-a-version",
  ]);
  assert.equal(
    calls[0]?.url,
    "https://registry.example/v1/providers/hashicorp/azurerm/versions",
  );
  assert.equal(calls[0]?.headers.get("user-agent"), REGISTRY_USER_AGENT);
});

test("a transient failure is retried with jittered backoff", async () => {
  const slept: number[] = [];
  let attempts = 0;
  const client = createRegistryClient({
    attempts: 3,
    random: () => 1,
    sleep: async (ms) => {
      slept.push(ms);
    },
    fetchImpl: async () => {
      attempts += 1;
      if (attempts < 3) throw new Error("ECONNRESET");
      return jsonResponse(VERSIONS_BODY);
    },
  });

  assert.equal(
    (await client.listVersions({ namespace: "hashicorp", name: "azurerm" }))
      .length,
    6,
  );
  assert.equal(attempts, 3);
  // Exponential, and jittered — the same tick on every node must not become a
  // synchronised stampede on the registry.
  assert.deepEqual(slept, [500, 1000]);
});

test("a provider that does not exist is an answer, not something to retry", async () => {
  let attempts = 0;
  const client = createRegistryClient({
    fetchImpl: async () => {
      attempts += 1;
      return jsonResponse({ errors: ["Not Found"] }, 404);
    },
  });
  assert.deepEqual(
    await client.listVersions({ namespace: "nobody", name: "nothing" }),
    [],
  );
  assert.equal(attempts, 1);
});

test("an unreachable registry throws after its attempts, so a caller can decide", async () => {
  const client = createRegistryClient({
    attempts: 2,
    sleep: async () => {},
    fetchImpl: async () => {
      throw new Error("getaddrinfo ENOTFOUND");
    },
  });
  await assert.rejects(
    () => client.listVersions({ namespace: "hashicorp", name: "azurerm" }),
    /ENOTFOUND/,
  );
});
