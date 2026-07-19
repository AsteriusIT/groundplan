import assert from "node:assert/strict";
import { test } from "node:test";

import type { Diagnostic } from "@groundplan/graph-parser";

import { createDebouncer, hasParseErrors, toFileDiagnostics } from "./live-core";

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
