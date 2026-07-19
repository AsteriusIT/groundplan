import { describe, expect, it } from "vitest";

import { gcpIconUrl } from "../icons/gcp-icons";
import { GCP_ICON_MAP, GCP_PREFIX_MAP } from "../icons/gcp";
import { resolveResourceIcon } from "../icons/resource-icon";
import { categorize } from "../lib/resource-category";

describe("GCP resource icons (GP-92)", () => {
  it("resolves an exact google type to its GCP icon", () => {
    expect(resolveResourceIcon("google_compute_instance")).toEqual({
      kind: "gcp",
      icon: "compute-engine",
    });
    expect(resolveResourceIcon("google_storage_bucket")).toEqual({
      kind: "gcp",
      icon: "cloud-storage",
    });
    expect(resolveResourceIcon("google_bigquery_dataset")).toEqual({
      kind: "gcp",
      icon: "bigquery",
    });
  });

  it("every mapped google type resolves to a GCP icon (no fallbacks)", () => {
    for (const type of Object.keys(GCP_ICON_MAP)) {
      expect(resolveResourceIcon(type).kind, type).toBe("gcp");
    }
  });

  it("every mapped icon key has a vendored official SVG", () => {
    const keys = [
      ...Object.values(GCP_ICON_MAP),
      ...Object.values(GCP_PREFIX_MAP),
    ];
    for (const key of keys) {
      expect(gcpIconUrl(key), `missing src/icons/gcp/${key}.svg`).toBeDefined();
    }
  });

  it("gives every icon-mapped type a category hue (no icon without a hue)", () => {
    for (const type of Object.keys(GCP_ICON_MAP)) {
      expect(categorize(type), type).not.toBe("other");
    }
  });

  it("normalises google-beta aliases through the same table", () => {
    expect(resolveResourceIcon("google-beta_compute_instance")).toEqual({
      kind: "gcp",
      icon: "compute-engine",
    });
    expect(resolveResourceIcon("google-beta_container_cluster")).toEqual({
      kind: "gcp",
      icon: "gke",
    });
  });

  it("falls back to the type-prefix heuristic for unmapped google types", () => {
    // Not in the exact map, but the google_pubsub / google_sql prefixes are.
    expect(resolveResourceIcon("google_pubsub_topic_iam_member")).toEqual({
      kind: "gcp",
      icon: "pubsub",
    });
    expect(resolveResourceIcon("google_sql_user")).toEqual({
      kind: "gcp",
      icon: "cloud-sql",
    });
  });

  it("prefers the longest matching prefix", () => {
    // google_compute_router_nat (Cloud NAT) must win over google_compute_router.
    expect(resolveResourceIcon("google_compute_router_nat")).toEqual({
      kind: "gcp",
      icon: "cloud-nat",
    });
    expect(resolveResourceIcon("google_compute_router_interface")).toEqual({
      kind: "gcp",
      icon: "cloud-router",
    });
  });
});
