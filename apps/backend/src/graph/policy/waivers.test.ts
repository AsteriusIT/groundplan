import assert from "node:assert/strict";
import { test } from "node:test";

import { applyWaivers, reconcileWaivers, waiverInForce } from "./waivers.js";
import type { PolicyReport } from "./types.js";

const NOW = new Date("2026-07-26T12:00:00.000Z");

function report(): PolicyReport {
  return {
    version: 1,
    target: "terraform",
    status: "failing",
    counts: { error: 1, warning: 1, info: 0, waived: 0, total: 2 },
    violations: [
      {
        ruleId: "nsg-open-to-internet",
        severity: "error",
        address: "azurerm_network_security_group.web",
        message: "Open to the internet.",
        hint: "Restrict it.",
      },
      {
        ruleId: "weak-tls",
        severity: "warning",
        address: "azurerm_storage_account.logs",
        message: "TLS 1.0.",
        hint: "Require 1.2.",
      },
    ],
    rules: [
      { ruleId: "nsg-open-to-internet", enabled: true, severity: "error", applicable: true },
      { ruleId: "weak-tls", enabled: true, severity: "warning", applicable: true },
    ],
  };
}

const WAIVER = {
  id: "w1",
  ruleId: "nsg-open-to-internet",
  address: "azurerm_network_security_group.web",
  reason: "reviewed with the security team",
  expiresAt: null,
};

test("a waived violation is marked and counted apart — never removed", () => {
  const waived = applyWaivers(report(), [WAIVER], NOW);
  assert.equal(waived.violations.length, 2, "still both violations");
  const target = waived.violations.find((v) => v.ruleId === "nsg-open-to-internet");
  assert.deepEqual(target?.waiver, {
    id: "w1",
    reason: "reviewed with the security team",
    expiresAt: null,
  });
  assert.equal(waived.counts.waived, 1);
  assert.equal(waived.counts.error, 0);
  // The verdict now reflects only what nobody has answered.
  assert.equal(waived.status, "warnings");
});

test("the report version moves to 2 only when a waiver is actually applied", () => {
  assert.equal(applyWaivers(report(), [WAIVER], NOW).version, 2);
  // A waiver for something this snapshot does not violate changes nothing —
  // including the version, so an untouched report stays byte-identical.
  const untouched = applyWaivers(
    report(),
    [{ ...WAIVER, address: "azurerm_subnet.gone" }],
    NOW,
  );
  assert.deepEqual(untouched, report());
});

test("an expired waiver suspends nothing at the next report", () => {
  const expired = { ...WAIVER, expiresAt: new Date("2026-07-01T00:00:00.000Z") };
  assert.equal(waiverInForce(expired, NOW), false);
  const after = applyWaivers(report(), [expired], NOW);
  assert.equal(after.counts.waived, 0);
  assert.equal(after.status, "failing");

  // …and one that has not expired yet still does.
  const live = { ...WAIVER, expiresAt: new Date("2026-08-01T00:00:00.000Z") };
  assert.equal(waiverInForce(live, NOW), true);
  assert.equal(applyWaivers(report(), [live], NOW).counts.waived, 1);
});

test("a revoked or orphaned waiver is not in force", () => {
  assert.equal(waiverInForce({ ...WAIVER, revokedAt: NOW }, NOW), false);
  assert.equal(waiverInForce({ ...WAIVER, status: "orphaned" }, NOW), false);
  assert.equal(
    applyWaivers(report(), [{ ...WAIVER, status: "orphaned" }], NOW).counts.waived,
    0,
  );
});

test("reconciliation orphans a waiver whose resource is gone, and reverses itself", () => {
  const waivers = [{ id: "w1", address: "azurerm_subnet.a", status: "active" as const }];

  assert.deepEqual(reconcileWaivers(waivers, new Set(["azurerm_subnet.b"])), [
    { id: "w1", status: "orphaned" },
  ]);
  // The resource comes back: so does the waiver. Never a delete.
  assert.deepEqual(
    reconcileWaivers(
      [{ id: "w1", address: "azurerm_subnet.a", status: "orphaned" }],
      new Set(["azurerm_subnet.a"]),
    ),
    [{ id: "w1", status: "active" }],
  );
});
