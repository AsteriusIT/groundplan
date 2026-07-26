/**
 * The provider contract suite (GP-192): one spec, run against every adapter.
 *
 * This is the file that keeps the abstraction honest. Every provider — the three
 * real ones and a fictitious one defined at the bottom — is put through the same
 * assertions. A new provider that implements the interfaces passes without a
 * line being added here; a provider that lies about its capabilities fails.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { createAzureDevOpsProvider } from "./adapters/azure-devops.js";
import { createGenericProvider } from "./adapters/generic.js";
import { createGitHubProvider } from "./adapters/github.js";
import { createGitLabProvider } from "./adapters/gitlab.js";
import { NO_INTEGRATIONS_CONFIG } from "./config.js";
import { defineProvider } from "./provider.js";
import { createProviderRegistry } from "./registry.js";
import {
  CAPABILITIES,
  CREDENTIAL_MODES,
  type IntegrationProvider,
  type UpsertCommentArgs,
} from "./types.js";

/* -------------------------------------------------------------------------- */
/* Fake REST clients: the contract runs entirely offline.                      */
/* -------------------------------------------------------------------------- */

type Call = { name: string; args: unknown[] };

/**
 * One recorder standing in for all three REST clients. Each adapter's commenter
 * calls list → (create | update); recording the *shape* of that sequence is what
 * lets the same assertions cover three different APIs.
 */
function recorder(existingBody: string | null) {
  const calls: Call[] = [];
  const record =
    (name: string) =>
    (...args: unknown[]) => {
      calls.push({ name, args });
      return Promise.resolve({ id: 1, body: "", content: "" });
    };

  const listed = existingBody === null ? [] : [{ id: 7, body: existingBody }];
  const threads =
    existingBody === null
      ? []
      : [{ id: 7, comments: [{ id: 8, content: existingBody }] }];

  return {
    calls,
    github: {
      listIssueComments: (...args: unknown[]) => {
        calls.push({ name: "list", args });
        return Promise.resolve(listed);
      },
      createIssueComment: record("create"),
      updateIssueComment: record("update"),
    },
    gitlab: {
      listMergeRequestNotes: (...args: unknown[]) => {
        calls.push({ name: "list", args });
        return Promise.resolve(listed);
      },
      createMergeRequestNote: record("create"),
      updateMergeRequestNote: record("update"),
    },
    azureDevOps: {
      listThreads: (...args: unknown[]) => {
        calls.push({ name: "list", args });
        return Promise.resolve(threads);
      },
      createThread: record("create"),
      updateComment: record("update"),
    },
  };
}

/** A repository URL each provider recognises, for the commenter assertions. */
const SAMPLE_URL: Record<string, string> = {
  github: "https://github.com/acme/infra",
  gitlab: "https://gitlab.com/acme/infra",
  azure_devops: "https://dev.azure.com/acme/infra/_git/repo",
  generic: "https://git.example.com/acme/infra",
  fake: "https://fake.example/acme/infra",
};

const MARKER = "<!-- groundplan:comment -->";

function commentArgs(provider: IntegrationProvider): UpsertCommentArgs {
  return {
    repoUrl: SAMPLE_URL[provider.id] ?? "https://example.com/a/b",
    prNumber: 42,
    marker: MARKER,
    body: `${MARKER}\nhello`,
    token: "token-value",
  };
}

/* -------------------------------------------------------------------------- */
/* The contract.                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Assert one provider honours the port contract. `build` returns a provider
 * wired to a fresh recorder, so the commenter assertions can inspect the calls.
 */
function runProviderContract(
  label: string,
  build: (existingBody: string | null) => {
    provider: IntegrationProvider;
    calls: Call[];
  },
) {
  const { provider } = build(null);

  test(`${label}: declares a usable identity`, () => {
    assert.ok(provider.id.length > 0);
    assert.ok(provider.label.length > 0, "a provider must be nameable in the UI");
  });

  test(`${label}: offers at least one credential mode, all of them known`, () => {
    assert.ok(provider.credentialModes.length > 0);
    for (const mode of provider.credentialModes) {
      assert.ok(
        CREDENTIAL_MODES.includes(mode),
        `${mode} is not a credential mode`,
      );
    }
  });

  test(`${label}: can be cloned in every mode it offers`, () => {
    for (const mode of provider.credentialModes) {
      const username = provider.repo.cloneUsername(mode);
      assert.ok(
        typeof username === "string" && username.length > 0,
        `no clone username for ${mode}`,
      );
    }
  });

  test(`${label}: declares only capabilities it implements`, () => {
    for (const capability of provider.capabilities) {
      assert.ok(CAPABILITIES.includes(capability), `${capability} is not a capability`);
      assert.ok(provider.supports(capability));
    }
    assert.ok(provider.supports("repo:read"), "every provider can be read");
    assert.equal(provider.supports("pr:comment"), provider.commenter !== null);
    assert.equal(provider.supports("check:publish"), provider.checks !== null);
    assert.equal(provider.supports("ref:events"), provider.refEvents !== null);
  });

  test(`${label}: never claims a URL it cannot parse`, () => {
    assert.equal(provider.matchesUrl("not a url"), false);
    assert.equal(provider.matchesUrl("https://nobody.example.invalid/x/y"), false);
  });

  if (!provider.commenter) return;

  test(`${label}: creates the comment when none carries the marker`, async () => {
    const { provider: p, calls } = build(null);
    await p.commenter!.upsertComment(commentArgs(p));
    assert.deepEqual(
      calls.map((c) => c.name),
      ["list", "create"],
      "an absent comment is posted once",
    );
  });

  test(`${label}: updates in place when the marker is already there`, async () => {
    const { provider: p, calls } = build(`${MARKER}\nolder body`);
    await p.commenter!.upsertComment(commentArgs(p));
    assert.deepEqual(
      calls.map((c) => c.name),
      ["list", "update"],
      "idempotence: the marked comment is edited, never duplicated",
    );
  });

  test(`${label}: ignores comments without our marker`, async () => {
    const { provider: p, calls } = build("someone else's review comment");
    await p.commenter!.upsertComment(commentArgs(p));
    assert.deepEqual(calls.map((c) => c.name), ["list", "create"]);
  });

  test(`${label}: never puts the token in a positional URL slot`, async () => {
    const { provider: p, calls } = build(null);
    const args = commentArgs(p);
    await p.commenter!.upsertComment(args);
    // The token is always the *last* argument of these clients — a sanity check
    // that no adapter interpolated it into a path it also logs.
    for (const call of calls) {
      const stringArgs = call.args.filter((a): a is string => typeof a === "string");
      const inPath = stringArgs.some(
        (a) => a.includes(args.token) && a.startsWith("http"),
      );
      assert.equal(inPath, false, `${call.name} leaked the token into a URL`);
    }
  });
}

/* -------------------------------------------------------------------------- */
/* The three real adapters.                                                    */
/* -------------------------------------------------------------------------- */

runProviderContract("github", (existing) => {
  const r = recorder(existing);
  return {
    provider: createGitHubProvider(
      r.github as never,
      NO_INTEGRATIONS_CONFIG,
      {} as never,
    ),
    calls: r.calls,
  };
});

runProviderContract("gitlab", (existing) => {
  const r = recorder(existing);
  return { provider: createGitLabProvider(r.gitlab as never), calls: r.calls };
});

runProviderContract("azure_devops", (existing) => {
  const r = recorder(existing);
  return {
    provider: createAzureDevOpsProvider(r.azureDevOps as never),
    calls: r.calls,
  };
});

runProviderContract("generic", () => ({
  provider: createGenericProvider(),
  calls: [],
}));

/* -------------------------------------------------------------------------- */
/* A provider that does not exist, to prove extension costs only interfaces.   */
/* -------------------------------------------------------------------------- */

runProviderContract("fictitious", (existing) => {
  const calls: Call[] = [];
  const provider = defineProvider({
    // The id is typed to the pg enum; a real new provider adds an enum value.
    id: "generic",
    label: "Fictitious Forge",
    credentialModes: ["oauth2", "pat"],
    hosts: ["fake.example"],
    repo: { cloneUsername: (mode) => (mode === "oauth2" ? "oauth2" : "forge") },
    commenter: {
      async upsertComment(args) {
        calls.push({ name: "list", args: [args.repoUrl] });
        calls.push({
          name: existing?.includes(args.marker) ? "update" : "create",
          args: [args.repoUrl],
        });
      },
    },
  });
  return { provider, calls };
});

/* -------------------------------------------------------------------------- */
/* Registry behaviour.                                                         */
/* -------------------------------------------------------------------------- */

function testRegistry() {
  const r = recorder(null);
  return createProviderRegistry({
    github: r.github as never,
    gitlab: r.gitlab as never,
    azureDevOps: r.azureDevOps as never,
  });
}

test("registry detects a provider from a repository URL", () => {
  const registry = testRegistry();
  assert.equal(registry.detect("https://github.com/acme/infra.git"), "github");
  assert.equal(registry.detect("https://gitlab.com/acme/infra"), "gitlab");
  assert.equal(
    registry.detect("https://dev.azure.com/acme/infra/_git/repo"),
    "azure_devops",
  );
  assert.equal(
    registry.detect("https://acme.visualstudio.com/infra/_git/repo"),
    "azure_devops",
  );
});

test("registry falls back to generic for unclaimed and self-hosted hosts", () => {
  const registry = testRegistry();
  assert.equal(registry.detect("https://gitlab.example.com/acme/infra"), "generic");
  assert.equal(registry.detect("not a url"), "generic");
});

test("registry detection is case-insensitive on the host", () => {
  assert.equal(testRegistry().detect("https://GitHub.com/Acme/Infra"), "github");
});

test("registry lists every provider exactly once", () => {
  const ids = testRegistry().list().map((p) => p.id);
  assert.deepEqual(ids, ["github", "gitlab", "azure_devops", "generic"]);
});

test("registry filters by capability, which is how the core branches", () => {
  const commenters = testRegistry()
    .withCapability("pr:comment")
    .map((p) => p.id);
  assert.deepEqual(commenters, ["github", "gitlab", "azure_devops"]);
  assert.equal(
    testRegistry().withCapability("repo:read").length,
    4,
    "every provider can be read with a credential",
  );
});

test("registry throws loudly for a provider with no adapter", () => {
  assert.throws(
    () => testRegistry().get("nope" as never),
    /no adapter registered/,
  );
});
