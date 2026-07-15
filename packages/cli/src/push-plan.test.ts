import { test } from "node:test";
import assert from "node:assert/strict";

import { CliError, pushPlan, type PushPlanConfig, type PushPlanDeps } from "./push-plan.js";
import type { GitContext } from "./git-context.js";

const PLAN = JSON.stringify({
  format_version: "1.2",
  resource_changes: [
    { address: "aws_s3_bucket.a", change: { actions: ["create"] } },
  ],
});

const CONTEXT: GitContext = { branch: "feature-x", sha: "abcdef1234567", prNumber: 7 };

function makeResponse(status: number, body: unknown = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: `HTTP ${status}`,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  } as unknown as Response;
}

type Action = Response | Error;

function fakeFetch(actions: Action[]) {
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
  over: Partial<Pick<PushPlanDeps, "readFile" | "gitContext">> = {},
) {
  const logs: string[] = [];
  const sleeps: number[] = [];
  const deps: PushPlanDeps = {
    readFile: over.readFile ?? (() => PLAN),
    gitContext: over.gitContext ?? (() => CONTEXT),
    fetch: fetchImpl,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    log: (m) => logs.push(m),
  };
  return { deps, logs, sleeps };
}

const config = (over: Partial<PushPlanConfig> = {}): PushPlanConfig => ({
  url: "https://gp.example.com/api/v1/webhooks/ci/repo-id",
  token: "secret",
  file: "plan.json",
  ...over,
});

// --- local validation: never touches the network -----------------------------

test("a missing GROUNDPLAN_URL fails with exit 2 and no request", async () => {
  const { fn, calls } = fakeFetch([]);
  const { deps } = makeDeps(fn);
  await assert.rejects(pushPlan(config({ url: undefined }), deps), (err: unknown) => {
    assert.ok(err instanceof CliError);
    assert.equal(err.exitCode, 2);
    return true;
  });
  assert.equal(calls.length, 0);
});

test("a missing GROUNDPLAN_TOKEN fails with exit 2", async () => {
  const { fn } = fakeFetch([]);
  const { deps } = makeDeps(fn);
  await assert.rejects(pushPlan(config({ token: undefined }), deps), CliError);
});

test("a missing file fails locally with no request", async () => {
  const { fn, calls } = fakeFetch([]);
  const enoent = Object.assign(new Error("nope"), { code: "ENOENT" });
  const { deps } = makeDeps(fn, {
    readFile: () => {
      throw enoent;
    },
  });
  await assert.rejects(pushPlan(config(), deps), /plan file not found/);
  assert.equal(calls.length, 0);
});

test("invalid JSON fails locally with a clear message and no request", async () => {
  const { fn, calls } = fakeFetch([]);
  const { deps } = makeDeps(fn, { readFile: () => "{ not json" });
  await assert.rejects(pushPlan(config(), deps), /not valid JSON/);
  assert.equal(calls.length, 0);
});

test("a JSON file that is not a plan is rejected locally", async () => {
  const { fn, calls } = fakeFetch([]);
  const { deps } = makeDeps(fn, {
    readFile: () => JSON.stringify({ hello: "world" }),
  });
  await assert.rejects(pushPlan(config(), deps), /does not look like a Terraform plan/);
  assert.equal(calls.length, 0);
});

test("the branch cannot be guessed and no flag was given -> clear error", async () => {
  const { fn, calls } = fakeFetch([]);
  const { deps } = makeDeps(fn, {
    gitContext: () => ({ branch: null, sha: "abc", prNumber: null }),
  });
  await assert.rejects(pushPlan(config(), deps), /could not determine the branch/);
  assert.equal(calls.length, 0);
});

// --- the happy path -----------------------------------------------------------

test("a valid plan on a PR is POSTed as a pull_request with its context", async () => {
  const { fn, calls } = fakeFetch([makeResponse(202, { id: "e1" })]);
  const { deps } = makeDeps(fn);
  await pushPlan(config(), deps);

  assert.equal(calls.length, 1);
  const call = calls[0]!;
  assert.equal(call.url, "https://gp.example.com/api/v1/webhooks/ci/repo-id");
  const headers = call.init.headers as Record<string, string>;
  assert.equal(headers["X-Groundplan-Token"], "secret");
  assert.equal(headers["Content-Type"], "application/json");
  const body = JSON.parse(call.init.body as string);
  assert.equal(body.ref, "feature-x");
  assert.equal(body.commit_sha, "abcdef1234567");
  assert.equal(body.event, "pull_request");
  assert.equal(body.pr_number, 7);
  assert.equal(body.payload.format_version, "1.2");
});

test("with no PR context the plan is sent as a push, with no pr_number", async () => {
  const { fn, calls } = fakeFetch([makeResponse(202)]);
  const { deps } = makeDeps(fn, {
    gitContext: () => ({ branch: "main", sha: "deadbeef", prNumber: null }),
  });
  await pushPlan(config(), deps);
  const body = JSON.parse(calls[0]!.init.body as string);
  assert.equal(body.event, "push");
  assert.ok(!("pr_number" in body));
});

test("flags override the detected context", async () => {
  const { fn, calls } = fakeFetch([makeResponse(202)]);
  const { deps } = makeDeps(fn);
  await pushPlan(config({ branch: "override", sha: "0000000", prNumber: 99 }), deps);
  const body = JSON.parse(calls[0]!.init.body as string);
  assert.equal(body.ref, "override");
  assert.equal(body.commit_sha, "0000000");
  assert.equal(body.pr_number, 99);
});

// --- retry / fail-fast --------------------------------------------------------

test("a 401 fails fast (no retry) with an actionable message", async () => {
  const { fn, calls } = fakeFetch([makeResponse(401, { message: "bad token" })]);
  const { deps, sleeps } = makeDeps(fn);
  await assert.rejects(pushPlan(config(), deps), /authentication failed.*GROUNDPLAN_TOKEN/);
  assert.equal(calls.length, 1, "4xx is not retried");
  assert.equal(sleeps.length, 0);
});

test("a 404 points at GROUNDPLAN_URL", async () => {
  const { fn } = fakeFetch([makeResponse(404)]);
  const { deps } = makeDeps(fn);
  await assert.rejects(pushPlan(config(), deps), /repository not found.*GROUNDPLAN_URL/);
});

test("a transient 500 is retried, then succeeds", async () => {
  const { fn, calls } = fakeFetch([makeResponse(500), makeResponse(202)]);
  const { deps, sleeps } = makeDeps(fn);
  await pushPlan(config(), deps);
  assert.equal(calls.length, 2);
  assert.equal(sleeps.length, 1, "one backoff between the two attempts");
});

test("a network error is retried, then succeeds", async () => {
  const { fn, calls } = fakeFetch([new Error("ECONNRESET"), makeResponse(202)]);
  const { deps } = makeDeps(fn);
  await pushPlan(config(), deps);
  assert.equal(calls.length, 2);
});

test("persistent 500s give up after 4 attempts with a non-zero exit", async () => {
  const { fn, calls } = fakeFetch([
    makeResponse(500),
    makeResponse(500),
    makeResponse(500),
    makeResponse(500),
  ]);
  const { deps, sleeps } = makeDeps(fn);
  await assert.rejects(pushPlan(config(), deps), (err: unknown) => {
    assert.ok(err instanceof CliError);
    assert.notEqual(err.exitCode, 0);
    return true;
  });
  assert.equal(calls.length, 4, "1 initial + 3 retries");
  assert.equal(sleeps.length, 3);
});
