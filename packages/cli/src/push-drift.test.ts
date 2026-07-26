import { test } from "node:test";
import assert from "node:assert/strict";

import { CliError } from "./push-plan.js";
import { driftUrl, pushDrift, type PushDriftConfig } from "./push-drift.js";
import type { PushDeps } from "./transport.js";
import type { GitContext } from "./git-context.js";

const REFRESH_ONLY = JSON.stringify({
  format_version: "1.2",
  resource_changes: [],
  resource_drift: [
    {
      address: "azurerm_storage_account.data",
      mode: "managed",
      type: "azurerm_storage_account",
      change: { actions: ["update"] },
    },
  ],
});

const PR_PLAN = JSON.stringify({
  format_version: "1.2",
  resource_changes: [
    { address: "aws_s3_bucket.a", change: { actions: ["create"] } },
  ],
});

const CONTEXT: GitContext = { branch: "main", sha: "abcdef1234567", prNumber: null };

function makeResponse(status: number, body: unknown = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: `HTTP ${status}`,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  } as unknown as Response;
}

function fakeFetch(actions: (Response | Error)[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const action = actions[calls.length - 1];
    if (action === undefined) throw new Error("unexpected extra fetch call");
    if (action instanceof Error) throw action;
    return action;
  }) as typeof fetch;
  return { fn, calls };
}

function makeDeps(
  fetchImpl: typeof fetch,
  over: Partial<Pick<PushDeps, "readFile" | "gitContext">> = {},
) {
  const logs: string[] = [];
  const deps: PushDeps = {
    readFile: over.readFile ?? (() => REFRESH_ONLY),
    gitContext: over.gitContext ?? (() => CONTEXT),
    fetch: fetchImpl,
    sleep: async () => {},
    log: (m) => logs.push(m),
  };
  return { deps, logs };
}

const config = (over: Partial<PushDriftConfig> = {}): PushDriftConfig => ({
  url: "https://gp.example.com/api/v1/webhooks/ci/repo-id",
  token: "secret",
  file: "plan.json",
  ...over,
});

// --- the drift endpoint is derived from the one URL CI already has ----------

test("the drift endpoint is the repository webhook plus /drift", () => {
  assert.equal(
    driftUrl("https://gp.example.com/api/v1/webhooks/ci/repo-id"),
    "https://gp.example.com/api/v1/webhooks/ci/repo-id/drift",
  );
});

test("a trailing slash does not produce a double one", () => {
  assert.equal(driftUrl("https://gp.example.com/ci/repo/"), "https://gp.example.com/ci/repo/drift");
});

test("a URL already pointing at the drift endpoint is left alone", () => {
  assert.equal(driftUrl("https://gp.example.com/ci/repo/drift"), "https://gp.example.com/ci/repo/drift");
});

// --- local validation -------------------------------------------------------

test("a plan that proposes changes is refused locally, before any request", async () => {
  const { fn, calls } = fakeFetch([]);
  const { deps } = makeDeps(fn, { readFile: () => PR_PLAN });

  await assert.rejects(pushDrift(config(), deps), (err: unknown) => {
    assert.ok(err instanceof CliError);
    assert.match(err.message, /-refresh-only/);
    return true;
  });
  assert.equal(calls.length, 0, "nothing should have been sent");
});

test("a file that is not a plan at all is refused with the command that makes one", async () => {
  const { fn, calls } = fakeFetch([]);
  const { deps } = makeDeps(fn, { readFile: () => JSON.stringify({ hello: 1 }) });

  await assert.rejects(pushDrift(config(), deps), CliError);
  assert.equal(calls.length, 0);
});

test("a missing file fails with exit 2 when no --file was given", async () => {
  const { fn } = fakeFetch([]);
  const { deps } = makeDeps(fn);
  await assert.rejects(pushDrift(config({ file: undefined }), deps), (err: unknown) => {
    assert.ok(err instanceof CliError);
    assert.equal(err.exitCode, 2);
    return true;
  });
});

// --- the request ------------------------------------------------------------

test("a refresh-only plan is posted to the drift endpoint, anchored on the branch sha", async () => {
  const { fn, calls } = fakeFetch([makeResponse(202, { drifted: 1 })]);
  const { deps, logs } = makeDeps(fn);

  await pushDrift(config(), deps);

  assert.equal(calls.length, 1);
  assert.equal(
    calls[0]?.url,
    "https://gp.example.com/api/v1/webhooks/ci/repo-id/drift",
  );
  const sent = JSON.parse(String(calls[0]?.init.body));
  assert.equal(sent.ref, "main");
  assert.equal(sent.commit_sha, "abcdef1234567");
  assert.ok(sent.payload.resource_drift, "the plan should be the payload");
  assert.match(logs.join("\n"), /1 drifted/);
});

test("a pull request in the CI context is ignored — drift is about main", async () => {
  const { fn, calls } = fakeFetch([makeResponse(202)]);
  const { deps } = makeDeps(fn, {
    gitContext: () => ({ branch: "feature-x", sha: "deadbeef", prNumber: 42 }),
  });

  await pushDrift(config(), deps);

  const sent = JSON.parse(String(calls[0]?.init.body));
  assert.equal(sent.pr_number, undefined);
  assert.equal(sent.event, undefined);
});

test("--branch and --sha override what the checkout says", async () => {
  const { fn, calls } = fakeFetch([makeResponse(202)]);
  const { deps } = makeDeps(fn);

  await pushDrift(config({ branch: "trunk", sha: "1234567" }), deps);

  const sent = JSON.parse(String(calls[0]?.init.body));
  assert.equal(sent.ref, "trunk");
  assert.equal(sent.commit_sha, "1234567");
});

test("the server's refusal is surfaced verbatim, and not retried", async () => {
  const { fn, calls } = fakeFetch([
    makeResponse(422, { message: "this plan proposes changes (create)" }),
  ]);
  const { deps } = makeDeps(fn);

  await assert.rejects(pushDrift(config(), deps), (err: unknown) => {
    assert.ok(err instanceof CliError);
    assert.match(err.message, /proposes changes/);
    return true;
  });
  assert.equal(calls.length, 1, "a 4xx is our mistake, not a blip");
});

test("a 5xx is retried, then succeeds", async () => {
  const { fn, calls } = fakeFetch([makeResponse(503), makeResponse(202)]);
  const { deps } = makeDeps(fn);

  await pushDrift(config(), deps);
  assert.equal(calls.length, 2);
});

test("a plan with nothing drifted still reports, and says the estate matches", async () => {
  const { fn } = fakeFetch([makeResponse(202, { drifted: 0 })]);
  const { deps, logs } = makeDeps(fn, {
    readFile: () => JSON.stringify({ format_version: "1.2", resource_changes: [] }),
  });

  await pushDrift(config(), deps);
  assert.match(logs.join("\n"), /no drift/i);
});
