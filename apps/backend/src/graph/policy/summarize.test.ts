import assert from "node:assert/strict";
import { test } from "node:test";

import { summarizePolicyReport } from "./summarize.js";
import type { PolicyReport } from "./types.js";

const RULES: PolicyReport["rules"] = [
  { ruleId: "nsg-open-to-internet", enabled: true, severity: "error", applicable: true },
  { ruleId: "weak-tls", enabled: true, severity: "warning", applicable: true },
  { ruleId: "missing-tags", enabled: true, severity: "info", applicable: true },
  { ruleId: "required-tags", enabled: false, severity: "warning", applicable: true },
];

const REPORT: PolicyReport = {
  version: 2,
  target: "terraform",
  status: "failing",
  counts: { error: 1, warning: 1, info: 1, waived: 1, total: 4 },
  violations: [
    {
      ruleId: "nsg-open-to-internet",
      severity: "error",
      address: "azurerm_network_security_group.web",
      message: "This network security group has an inbound Allow rule open to the internet.",
      hint: "Restrict source_address_prefix.",
    },
    {
      ruleId: "weak-tls",
      severity: "warning",
      address: "azurerm_storage_account.logs",
      message: "TLS minimum is set to TLS1_0.",
      hint: "Require TLS 1.2 or newer.",
    },
    {
      ruleId: "missing-tags",
      severity: "info",
      address: "azurerm_resource_group.main",
      message: "This resource carries no tags.",
      hint: "Tag at least environment and managed_by.",
    },
    {
      ruleId: "storage-container-public",
      severity: "error",
      address: "azurerm_storage_container.public_assets",
      message: 'This container is publicly readable (container_access_type = "blob").',
      hint: 'Set container_access_type = "private".',
      waiver: { id: "w1", reason: "public CDN origin, reviewed 2026-07", expiresAt: null },
    },
  ],
  rules: RULES,
};

// The golden contract: this Markdown is what a PR comment and the docs panel
// both render, so it is asserted byte-for-byte.
const EXPECTED = `**Policy: failing** · 1 error · 1 warning · 1 note · 1 waived (3 rules checked)

**Errors**
- \`azurerm_network_security_group.web\` — This network security group has an inbound Allow rule open to the internet. (nsg-open-to-internet)

**Warnings**
- \`azurerm_storage_account.logs\` — TLS minimum is set to TLS1_0. (weak-tls)

**Notes**
- \`azurerm_resource_group.main\` — This resource carries no tags. (missing-tags)

**Waived**
- \`azurerm_storage_container.public_assets\` — This container is publicly readable (container_access_type = "blob"). (storage-container-public) — waived: public CDN origin, reviewed 2026-07`;

test("renders a report to deterministic Markdown", () => {
  assert.equal(summarizePolicyReport(REPORT), EXPECTED);
  assert.equal(summarizePolicyReport(REPORT), summarizePolicyReport(REPORT));
});

test("a passing report says what was checked", () => {
  assert.equal(
    summarizePolicyReport({
      ...REPORT,
      status: "passing",
      counts: { error: 0, warning: 0, info: 0, waived: 0, total: 0 },
      violations: [],
    }),
    "**Policy: passing** (3 rules checked, no violations)",
  );
});

test("a snapshot no rule applies to is not reported as a pass", () => {
  assert.equal(
    summarizePolicyReport({
      ...REPORT,
      target: "kubernetes",
      status: "passing",
      counts: { error: 0, warning: 0, info: 0, waived: 0, total: 0 },
      violations: [],
      rules: RULES.map((r) => ({ ...r, applicable: false })),
    }),
    "**Policy: not evaluated** — no enabled rule applies to this snapshot.",
  );
});

test("a long section is capped with an overflow line", () => {
  const many = Array.from({ length: 13 }, (_, i) => ({
    ruleId: "missing-tags",
    severity: "info" as const,
    address: `azurerm_resource_group.r${String(i).padStart(2, "0")}`,
    message: "This resource carries no tags.",
    hint: "Tag it.",
  }));
  const md = summarizePolicyReport({
    ...REPORT,
    status: "passing",
    counts: { error: 0, warning: 0, info: 13, waived: 0, total: 13 },
    violations: many,
  });
  assert.ok(md.includes("…and 3 more"));
  assert.equal(md.split("\n").filter((l) => l.startsWith("- ")).length, 10);
});
