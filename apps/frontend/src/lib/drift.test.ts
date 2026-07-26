import { describe, expect, it } from "vitest";

import type { DriftState, DriftedResource } from "@/api/types";
import {
  driftFreshness,
  driftLabels,
  driftRowsByNode,
  outsideIacAddresses,
} from "./drift";

const resource = (
  address: string,
  over: Partial<DriftedResource> = {},
): DriftedResource => ({
  address,
  type: "azurerm_storage_account",
  provider: "azurerm",
  module_path: [],
  change: "update",
  attribute_diff: [
    { key: "min_tls_version", before: "TLS1_2", after: "TLS1_0" },
  ],
  ...over,
});

const state = (over: Partial<DriftState> = {}): DriftState => ({
  id: "d1",
  repositoryId: "r1",
  ref: "main",
  commitSha: "aaaaaaaaaa",
  snapshotId: "s1",
  baseCommitSha: "aaaaaaaaaa",
  stale: false,
  measuredAt: "2026-07-26T03:00:00.000Z",
  report: {
    version: 1,
    counts: { updated: 1, deleted: 0, total: 1 },
    resources: [resource("azurerm_storage_account.data")],
  },
  summaryMd: "",
  ...over,
});

describe("drift marks", () => {
  it("labels a modified resource with what moved", () => {
    const labels = driftLabels(state());
    expect(labels.get("azurerm_storage_account.data")).toMatch(/min_tls_version/);
  });

  it("says outright when a resource no longer exists", () => {
    const labels = driftLabels(
      state({
        report: {
          version: 1,
          counts: { updated: 0, deleted: 1, total: 1 },
          resources: [
            resource("aws_s3_bucket.logs", { change: "delete", attribute_diff: [] }),
          ],
        },
      }),
    );
    expect(labels.get("aws_s3_bucket.logs")).toMatch(/no longer exists/i);
  });

  it("hands the attribute rows out by node, for the detail panel", () => {
    const rows = driftRowsByNode(state());
    expect(rows.get("azurerm_storage_account.data")).toHaveLength(1);
  });

  it("marks nothing at all when the measurement is stale", () => {
    // A stale measurement is about a main nobody is looking at. Badging today's
    // diagram from it would be the exact confusion the whole story avoids.
    expect(driftLabels(state({ stale: true })).size).toBe(0);
    expect(driftRowsByNode(state({ stale: true })).size).toBe(0);
  });

  it("marks nothing when there is no measurement", () => {
    expect(driftLabels(null).size).toBe(0);
    expect(driftRowsByNode(null).size).toBe(0);
  });
});

describe("introduced outside IaC", () => {
  it("names the resources whose violations exist in the cloud only", () => {
    const addresses = outsideIacAddresses(
      state({
        report: {
          version: 2,
          counts: { updated: 1, deleted: 0, total: 1 },
          resources: [resource("azurerm_network_security_group.web")],
          policy: {
            version: 1,
            added: [
              {
                ruleId: "nsg-open-to-internet",
                severity: "error",
                address: "azurerm_network_security_group.web",
                message: "open",
                hint: "close it",
              },
            ],
            resolved: [],
            preexisting: [],
            status: "failing",
            baseSnapshotId: "s1",
          },
        },
      }),
    );
    expect([...addresses]).toEqual(["azurerm_network_security_group.web"]);
  });

  it("is empty when the engine could not compare", () => {
    expect(outsideIacAddresses(state()).size).toBe(0);
  });
});

describe("freshness", () => {
  it("reads as measured when the sha still matches", () => {
    const f = driftFreshness(state());
    expect(f.tone).toBe("fresh");
    expect(f.text).toMatch(/aaaaaaa/);
  });

  it("reads as stale, and names the sha to re-measure against", () => {
    const f = driftFreshness(state({ stale: true, baseCommitSha: "bbbbbbbbbb" }));
    expect(f.tone).toBe("stale");
    expect(f.text).toMatch(/bbbbbbb/);
    expect(f.text).toMatch(/re-measure/i);
  });

  it("says main has no diagram rather than implying the drift is current", () => {
    const f = driftFreshness(state({ snapshotId: null, baseCommitSha: null }));
    expect(f.tone).toBe("unanchored");
  });
});

describe("how long ago", () => {
  const at = (msAgo: number): DriftState =>
    state({ measuredAt: new Date(Date.now() - msAgo).toISOString() });

  it("counts seconds, minutes, hours and days in their own units", () => {
    expect(driftFreshness(at(5_000)).text).toMatch(/5 seconds ago/);
    expect(driftFreshness(at(90_000)).text).toMatch(/1 minute ago/);
    expect(driftFreshness(at(3 * 3_600_000)).text).toMatch(/3 hours ago/);
    expect(driftFreshness(at(2 * 86_400_000)).text).toMatch(/2 days ago/);
  });

  it("stops counting past a month rather than printing 40 days", () => {
    expect(driftFreshness(at(60 * 86_400_000)).text).toMatch(/over a month ago/);
  });
});
