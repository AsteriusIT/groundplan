import { test } from "node:test";
import assert from "node:assert/strict";

import { CliError } from "./push-plan.js";
import { pushState, stateUrl, type PushStateConfig } from "./push-state.js";
import type { PushDeps } from "./transport.js";
import type { GitContext } from "./git-context.js";

const STATE = JSON.stringify({
  version: 4,
  terraform_version: "1.9.5",
  serial: 7,
  lineage: "9f4c0b1e-0000-4000-8000-000000000000",
  outputs: {
    db_password: { value: "hunter2-the-real-one", type: "string", sensitive: true },
  },
  resources: [
    {
      mode: "managed",
      type: "azurerm_storage_account",
      name: "data",
      provider: 'provider["registry.terraform.io/hashicorp/azurerm"]',
      instances: [
        {
          attributes: {
            name: "sadata",
            location: "westeurope",
            primary_access_key: "AAAABBBBCCCC",
          },
          sensitive_attributes: [[{ type: "get_attr", value: "primary_access_key" }]],
        },
      ],
    },
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
  const written: { path: string; contents: string }[] = [];
  const deps = {
    readFile: over.readFile ?? (() => STATE),
    gitContext: over.gitContext ?? (() => CONTEXT),
    fetch: fetchImpl,
    sleep: async () => {},
    log: (m: string) => logs.push(m),
    writeFile: (path: string, contents: string) => written.push({ path, contents }),
  };
  return { deps, logs, written };
}

const config = (over: Partial<PushStateConfig> = {}): PushStateConfig => ({
  url: "https://gp.example.com/api/v1/webhooks/ci/repo-id",
  token: "secret",
  file: "terraform.tfstate",
  ...over,
});

test("the state endpoint is the repository webhook plus /state", () => {
  assert.equal(
    stateUrl("https://gp.example.com/api/v1/webhooks/ci/repo-id"),
    "https://gp.example.com/api/v1/webhooks/ci/repo-id/state",
  );
});

// --- The promise: the raw state never leaves the machine --------------------

test("only the derived graph is sent — never the state", async () => {
  const { fn, calls } = fakeFetch([makeResponse(202)]);
  const { deps } = makeDeps(fn);

  await pushState(config(), deps);

  const body = String(calls[0]?.init.body);
  assert.ok(!body.includes("hunter2"), "a sensitive output was sent");
  assert.ok(!body.includes("AAAABBBBCCCC"), "a sensitive attribute was sent");
  assert.ok(!body.includes("lineage"), "the state's own identity was sent");
  assert.ok(!body.includes("serial"));

  const sent = JSON.parse(body);
  assert.equal(sent.payload.nodes[0].id, "azurerm_storage_account.data");
  assert.equal(sent.payload.nodes[0].attributes.location, "westeurope");
  assert.equal(sent.payload.nodes[0].attributes.primary_access_key, undefined);
});

test("the summary says what is going and what was withheld, before it goes", async () => {
  const { fn } = fakeFetch([makeResponse(202)]);
  const { deps, logs } = makeDeps(fn);

  await pushState(config(), deps);

  const printed = logs.join("\n");
  assert.match(printed, /1 resource/);
  assert.match(printed, /withheld|masked|excluded/i);
  assert.match(printed, /no sensitive value/i);
});

test("the branch and sha ride along, and never a pull request", async () => {
  const { fn, calls } = fakeFetch([makeResponse(202)]);
  const { deps } = makeDeps(fn, {
    gitContext: () => ({ branch: "main", sha: "deadbeefcafe", prNumber: 12 }),
  });

  await pushState(config(), deps);

  const sent = JSON.parse(String(calls[0]?.init.body));
  assert.equal(sent.ref, "main");
  assert.equal(sent.commit_sha, "deadbeefcafe");
  assert.equal(sent.pr_number, undefined);
});

test("the writer's Terraform version travels, so the snapshot says what read it", async () => {
  const { fn, calls } = fakeFetch([makeResponse(202)]);
  const { deps } = makeDeps(fn);

  await pushState(config(), deps);
  const sent = JSON.parse(String(calls[0]?.init.body));
  assert.equal(sent.terraform_version, "1.9.5");
});

// --- --dry-run: auditing exactly what would go ------------------------------

test("--dry-run writes the snapshot locally and sends nothing", async () => {
  const { fn, calls } = fakeFetch([]);
  const { deps, written, logs } = makeDeps(fn);

  await pushState(config({ dryRun: true }), deps);

  assert.equal(calls.length, 0, "a dry run must not touch the network");
  assert.equal(written.length, 1);
  assert.match(written[0]!.path, /groundplan-state\.json$/);
  const snapshot = JSON.parse(written[0]!.contents);
  assert.equal(snapshot.nodes[0].id, "azurerm_storage_account.data");
  assert.match(logs.join("\n"), /groundplan-state\.json/);
});

test("--dry-run honours --out", async () => {
  const { fn } = fakeFetch([]);
  const { deps, written } = makeDeps(fn);

  await pushState(config({ dryRun: true, out: "/tmp/audit.json" }), deps);
  assert.equal(written[0]?.path, "/tmp/audit.json");
});

test("a dry run needs no URL or token — it is a local audit", async () => {
  const { fn } = fakeFetch([]);
  const { deps, written } = makeDeps(fn);

  await pushState(config({ dryRun: true, url: undefined, token: undefined }), deps);
  assert.equal(written.length, 1);
});

// --- Local validation --------------------------------------------------------

test("a state format we cannot read fails locally, with the reason", async () => {
  const { fn, calls } = fakeFetch([]);
  const { deps } = makeDeps(fn, {
    readFile: () => JSON.stringify({ version: 3, modules: [] }),
  });

  await assert.rejects(pushState(config(), deps), (err: unknown) => {
    assert.ok(err instanceof CliError);
    assert.match(err.message, /version 3/);
    return true;
  });
  assert.equal(calls.length, 0);
});

test("a plan.json sent by mistake is refused, not uploaded", async () => {
  const { fn, calls } = fakeFetch([]);
  const { deps } = makeDeps(fn, {
    readFile: () => JSON.stringify({ format_version: "1.2", resource_changes: [] }),
  });

  await assert.rejects(pushState(config(), deps), CliError);
  assert.equal(calls.length, 0);
});

test("no --file is a usage error", async () => {
  const { fn } = fakeFetch([]);
  const { deps } = makeDeps(fn);
  await assert.rejects(pushState(config({ file: undefined }), deps), (err: unknown) => {
    assert.ok(err instanceof CliError);
    assert.equal(err.exitCode, 2);
    return true;
  });
});

test("an empty state is still worth sending — it says the estate is empty", async () => {
  const { fn, calls } = fakeFetch([makeResponse(202)]);
  const { deps } = makeDeps(fn, {
    readFile: () =>
      JSON.stringify({ version: 4, terraform_version: "1.9.5", resources: [] }),
  });

  await pushState(config(), deps);
  assert.equal(calls.length, 1);
});

test("the server's refusal is surfaced, and not retried", async () => {
  const { fn, calls } = fakeFetch([
    makeResponse(422, { message: "that looks like a raw state file" }),
  ]);
  const { deps } = makeDeps(fn);

  await assert.rejects(pushState(config(), deps), (err: unknown) => {
    assert.ok(err instanceof CliError);
    assert.match(err.message, /raw state/);
    return true;
  });
  assert.equal(calls.length, 1);
});
