import assert from "node:assert/strict";
import { test } from "node:test";

import { diffPolicyReports, summarizePolicyDelta } from "./diff.js";
import type { PolicyReport, PolicyViolation } from "./types.js";

function violation(over: Partial<PolicyViolation> = {}): PolicyViolation {
  return {
    ruleId: "nsg-open-to-internet",
    severity: "error",
    address: "azurerm_network_security_group.web",
    message: "This network security group has an inbound Allow rule open to the internet.",
    hint: "Restrict source_address_prefix.",
    ...over,
  };
}

function report(violations: PolicyViolation[]): PolicyReport {
  return {
    version: 1,
    target: "terraform",
    status: violations.some((v) => v.severity === "error") ? "failing" : "passing",
    counts: {
      error: violations.filter((v) => v.severity === "error" && !v.waiver).length,
      warning: violations.filter((v) => v.severity === "warning" && !v.waiver).length,
      info: violations.filter((v) => v.severity === "info" && !v.waiver).length,
      waived: violations.filter((v) => v.waiver).length,
      total: violations.length,
    },
    violations,
    rules: [
      {
        ruleId: "nsg-open-to-internet",
        enabled: true,
        severity: "error",
        applicable: true,
      },
      { ruleId: "weak-tls", enabled: true, severity: "warning", applicable: true },
    ],
  };
}

const EXPOSED = violation();
const TLS = violation({
  ruleId: "weak-tls",
  severity: "warning",
  address: "azurerm_storage_account.logs",
  message: "TLS minimum is set to TLS1_0.",
  hint: "Require TLS 1.2 or newer.",
});

test("a violation main already has is pre-existing, not this change's", () => {
  const delta = diffPolicyReports(report([EXPOSED, TLS]), {
    report: report([EXPOSED]),
    snapshotId: "base-1",
  });
  assert.deepEqual(delta.added.map((v) => v.ruleId), ["weak-tls"]);
  assert.deepEqual(delta.preexisting.map((v) => v.ruleId), ["nsg-open-to-internet"]);
  assert.deepEqual(delta.resolved, []);
  assert.equal(delta.status, "warnings");
});

test("a violation the change removes is reported as resolved", () => {
  const delta = diffPolicyReports(report([TLS]), {
    report: report([EXPOSED, TLS]),
    snapshotId: "base-1",
  });
  assert.deepEqual(delta.resolved.map((v) => v.ruleId), ["nsg-open-to-internet"]);
  assert.deepEqual(delta.added, []);
  assert.equal(delta.status, "passing");
});

test("identity is rule × resource, so a reworded message is still the same violation", () => {
  const reworded = violation({ message: "This NSG is wide open." });
  const delta = diffPolicyReports(report([reworded]), {
    report: report([EXPOSED]),
    snapshotId: "base-1",
  });
  assert.deepEqual(delta.added, []);
  assert.equal(delta.preexisting.length, 1);
});

test("a new error fails the pull request; a new note does not", () => {
  const failing = diffPolicyReports(report([EXPOSED]), {
    report: report([]),
    snapshotId: "base-1",
  });
  assert.equal(failing.status, "failing");

  const note = violation({ severity: "info", ruleId: "missing-tags", address: "a" });
  const passing = diffPolicyReports(report([note]), {
    report: report([]),
    snapshotId: "base-1",
  });
  assert.equal(passing.status, "passing");
});

test("a waived new violation does not fail the pull request, but is still reported", () => {
  const waived = violation({
    waiver: { id: "w1", reason: "public CDN origin", expiresAt: null },
  });
  const delta = diffPolicyReports(report([waived]), {
    report: report([]),
    snapshotId: "base-1",
  });
  assert.equal(delta.status, "passing");
  assert.equal(delta.added.length, 1);
});

test("no baseline is recorded as such rather than assumed clean", () => {
  const delta = diffPolicyReports(report([EXPOSED, TLS]), null);
  assert.equal(delta.baseSnapshotId, null);
  assert.equal(delta.added.length, 2);
  assert.deepEqual(delta.preexisting, []);
  const md = summarizePolicyDelta(delta, report([EXPOSED, TLS]))!;
  assert.match(md, /No documentation of the default branch to compare against yet/);
});

// The golden contract: this is what lands in the pull-request comment.
test("the comment section leads with what the change introduced", () => {
  const delta = diffPolicyReports(report([EXPOSED, TLS]), {
    report: report([EXPOSED, violation({ ruleId: "missing-tags", severity: "info", address: "azurerm_resource_group.main", message: "This resource carries no tags.", hint: "Tag it." })]),
    snapshotId: "base-1",
  });
  assert.equal(
    summarizePolicyDelta(delta, report([EXPOSED, TLS])),
    `**Policy: warnings** · 1 new warning (1 resolved, 1 pre-existing)

**New violations**
- \`azurerm_storage_account.logs\` — TLS minimum is set to TLS1_0. (weak-tls)

**Resolved by this change**
- \`azurerm_resource_group.main\` — This resource carries no tags. (missing-tags)`,
  );
});

test("a change that introduces nothing says so, and counts the debt it did not touch", () => {
  const delta = diffPolicyReports(report([EXPOSED]), {
    report: report([EXPOSED]),
    snapshotId: "base-1",
  });
  assert.equal(
    summarizePolicyDelta(delta, report([EXPOSED])),
    "**Policy: passing** · no new violations (1 pre-existing)",
  );
});

test("nothing is printed when no enabled rule applies to the snapshot", () => {
  const nothingChecked: PolicyReport = {
    ...report([]),
    rules: [
      {
        ruleId: "nsg-open-to-internet",
        enabled: true,
        severity: "error",
        applicable: false,
      },
    ],
  };
  const delta = diffPolicyReports(nothingChecked, null);
  assert.equal(summarizePolicyDelta(delta, nothingChecked), null);
});

test("the same reports always produce the same section", () => {
  const base = { report: report([EXPOSED]), snapshotId: "base-1" };
  const head = report([EXPOSED, TLS]);
  const first = summarizePolicyDelta(diffPolicyReports(head, base), head);
  const second = summarizePolicyDelta(diffPolicyReports(head, base), head);
  assert.equal(first, second);
});
