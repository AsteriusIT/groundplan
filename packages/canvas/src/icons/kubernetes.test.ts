import { describe, expect, it } from "vitest";

import { kubernetesIconUrl } from "../icons/kubernetes-icons";
import {
  KUBERNETES_ICON_MAP,
  KUBERNETES_PREFIX_MAP,
} from "../icons/kubernetes";
import { resolveResourceIcon } from "../icons/resource-icon";
import { categorize } from "../lib/resource-category";

describe("Kubernetes resource icons (GP-93)", () => {
  it("resolves a Terraform type and its bare kind to the same icon", () => {
    const pairs: [string, string, string][] = [
      ["kubernetes_deployment", "Deployment", "deployment"],
      ["kubernetes_service", "Service", "service"],
      ["kubernetes_config_map", "ConfigMap", "config-map"],
      ["kubernetes_persistent_volume_claim", "PersistentVolumeClaim", "persistent-volume-claim"],
      ["kubernetes_cluster_role_binding", "ClusterRoleBinding", "cluster-role-binding"],
    ];
    for (const [tfType, kind, icon] of pairs) {
      expect(resolveResourceIcon(tfType), tfType).toEqual({
        kind: "kubernetes",
        icon,
      });
      expect(resolveResourceIcon(kind), kind).toEqual({
        kind: "kubernetes",
        icon,
      });
    }
  });

  it("every mapped type/kind resolves to a Kubernetes icon (no fallbacks)", () => {
    for (const type of Object.keys(KUBERNETES_ICON_MAP)) {
      expect(resolveResourceIcon(type).kind, type).toBe("kubernetes");
    }
  });

  it("every mapped icon key has a vendored community SVG", () => {
    const keys = [
      ...Object.values(KUBERNETES_ICON_MAP),
      ...Object.values(KUBERNETES_PREFIX_MAP),
    ];
    for (const key of keys) {
      expect(
        kubernetesIconUrl(key),
        `missing src/icons/kubernetes/${key}.svg`,
      ).toBeDefined();
    }
  });

  it("gives every icon-mapped type/kind a category hue (no new tokens)", () => {
    for (const type of Object.keys(KUBERNETES_ICON_MAP)) {
      expect(categorize(type), type).not.toBe("other");
    }
  });

  it("catches versioned Terraform variants via the prefix heuristic", () => {
    expect(resolveResourceIcon("kubernetes_deployment_v1")).toEqual({
      kind: "kubernetes",
      icon: "deployment",
    });
    expect(resolveResourceIcon("kubernetes_ingress_v1")).toEqual({
      kind: "kubernetes",
      icon: "ingress",
    });
  });

  it("prefers the longest matching prefix (service_account over service)", () => {
    expect(resolveResourceIcon("kubernetes_service_account_v1")).toEqual({
      kind: "kubernetes",
      icon: "service-account",
    });
    expect(resolveResourceIcon("kubernetes_service_v1")).toEqual({
      kind: "kubernetes",
      icon: "service",
    });
  });

  it("leaves an unmapped kind to the category fallback (CRDs, Helm)", () => {
    // A CRD kind we do not map falls back cleanly; helm_release gets the compute
    // hue, not a misleading kind icon.
    expect(resolveResourceIcon("CustomResourceDefinition").kind).toBe("generic");
    expect(resolveResourceIcon("helm_release")).toEqual({
      kind: "category",
      category: "compute",
    });
  });
});
