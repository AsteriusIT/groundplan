import assert from "node:assert/strict";
import { test } from "node:test";

import type { Diagnostic } from "@groundplan/graph-parser";

import {
  createDebouncer,
  createSignatureTracker,
  hasParseErrors,
  postSignature,
  postWhileCurrent,
  toFileDiagnostics,
  type PostPayload,
} from "./live-core";

const error: Diagnostic = {
  severity: "error",
  message: "unbalanced braces",
  file: "broken.tf",
};
const warning: Diagnostic = {
  severity: "warning",
  message: "unresolved reference 'azurerm_subnet.missing' from azurerm_linux_virtual_machine.vm",
  file: "main.tf",
  range: { start_line: 4, end_line: 6 },
};
const fileless: Diagnostic = {
  severity: "warning",
  message: "no .tf files found in 'stacks/prod'",
};

test("only error diagnostics trigger the last-good contract", () => {
  assert.equal(hasParseErrors([error, warning]), true);
  assert.equal(hasParseErrors([warning, fileless]), false);
  assert.equal(hasParseErrors([]), false);
});

test("diagnostics group by file with 0-based lines; file-less ones stay out of Problems", () => {
  const byFile = toFileDiagnostics([error, warning, fileless]);
  assert.deepEqual([...byFile.keys()].sort(), ["broken.tf", "main.tf"]);

  const broken = byFile.get("broken.tf");
  // No range known — the entry still lands on a real line (the first).
  assert.deepEqual(broken, [
    { startLine: 0, endLine: 0, message: "unbalanced braces", severity: "error" },
  ]);

  const main = byFile.get("main.tf");
  assert.equal(main?.[0]?.startLine, 3);
  assert.equal(main?.[0]?.endLine, 5);
  assert.equal(main?.[0]?.severity, "warning");
});

test("the debouncer collapses a burst into the trailing call and can be disposed", async () => {
  let calls = 0;
  const debouncer = createDebouncer(() => {
    calls += 1;
  }, 20);

  debouncer.schedule();
  debouncer.schedule();
  debouncer.schedule();
  assert.equal(calls, 0);
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(calls, 1);

  debouncer.schedule();
  debouncer.dispose();
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(calls, 1, "a disposed debouncer never fires");
});

const payload = (): PostPayload => ({
  snapshot: { nodes: [{ id: "aws_s3_bucket.b" }], edges: [] },
  folder: "ws",
  multiRoot: false,
  rootDir: "infra",
  diff: { enabled: false, available: false, ref: null, clean: false },
  outOfSync: false,
});

test("an unchanged payload keeps its signature — the panel is told nothing", () => {
  assert.equal(postSignature(payload()), postSignature(payload()));
});

test("every field the panel is told about moves the signature", () => {
  const base = postSignature(payload());
  const moved: PostPayload[] = [
    { ...payload(), snapshot: { nodes: [], edges: [] } },
    { ...payload(), folder: "other" },
    { ...payload(), multiRoot: true },
    { ...payload(), rootDir: "envs/prod" },
    { ...payload(), diff: { enabled: true, available: true, ref: "HEAD", clean: true } },
    { ...payload(), outOfSync: true },
  ];
  for (const [index, next] of moved.entries()) {
    assert.notEqual(postSignature(next), base, `field ${index} was dropped`);
  }
});

test("createSignatureTracker: a fresh tracker posts, then suppresses a repeat", () => {
  const tracker = createSignatureTracker();
  assert.equal(tracker.shouldPost("S1"), true);
  tracker.markSent("S1");
  assert.equal(tracker.shouldPost("S1"), false, "an unchanged signature is suppressed");
  assert.equal(tracker.shouldPost("S2"), true, "a different signature still posts");
});

test(
  "createSignatureTracker: reset() un-suppresses the identical signature — " +
    "the `ready` regression. A `ready` message means the webview holds " +
    "nothing (a first mount that missed everything posted before its " +
    "listener existed, or a reload), so the very next refresh must post " +
    "even when it recomputes the signature this host already believes it " +
    "delivered; without reset() the panel is stuck on 'Reading Terraform…' " +
    "until a content-changing edit or a reopen.",
  () => {
    const tracker = createSignatureTracker();
    tracker.markSent("S1");
    assert.equal(tracker.shouldPost("S1"), false, "sanity: suppressed before reset");

    tracker.reset();
    assert.equal(
      tracker.shouldPost("S1"),
      true,
      "the identical signature must post again after a ready reset",
    );
  },
);

test(
  "postWhileCurrent: a run overtaken mid-post stops before its remaining " +
    "messages, so a newer run's three land last",
  async () => {
    let current = 1;
    const sent: string[] = [];

    // Refresh A (generation 1) suspends on its first message — the same
    // point refresh() suspends on `await this.post(...)` — until released.
    let releaseA1: () => void = () => {};
    const a1Gate = new Promise<void>((resolve) => {
      releaseA1 = resolve;
    });
    const a = postWhileCurrent(1, () => current, ["A1", "A2", "A3"], async (m) => {
      sent.push(m);
      if (m === "A1") await a1Gate;
    });

    // While A is suspended, refresh B (generation 2) starts and runs to
    // completion — the brief's "Ctrl+Tab quickly between two stacks",
    // undebounced and re-entrant, before A ever gets to send a second
    // message.
    current = 2;
    await postWhileCurrent(2, () => current, ["B1", "B2", "B3"], async (m) => {
      sent.push(m);
    });

    // Now let A resume: it must find itself superseded and stop.
    releaseA1();
    await a;

    assert.deepEqual(
      sent,
      ["A1", "B1", "B2", "B3"],
      "A's remaining messages must never interleave after B's",
    );
  },
);
