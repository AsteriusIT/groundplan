import { describe, expect, it } from "vitest";

import { azureIconUrl } from "@/icons/azure-icons";
import { AZURERM_ICON_MAP, AZURERM_PREFIX_MAP } from "@/icons/azurerm";
import { resolveResourceIcon } from "@/icons/resource-icon";

describe("resolveResourceIcon (GP-29)", () => {
  it("resolves an exact azurerm type to its Azure icon", () => {
    expect(resolveResourceIcon("azurerm_linux_virtual_machine")).toEqual({
      kind: "azure",
      icon: "virtual-machine",
    });
    expect(resolveResourceIcon("azurerm_subnet")).toEqual({
      kind: "azure",
      icon: "subnet",
    });
  });

  it("every mapped azurerm type resolves to an Azure icon (no fallbacks)", () => {
    for (const type of Object.keys(AZURERM_ICON_MAP)) {
      expect(resolveResourceIcon(type).kind, type).toBe("azure");
    }
  });

  it("every mapped icon key has a vendored official SVG", () => {
    const keys = [
      ...Object.values(AZURERM_ICON_MAP),
      ...Object.values(AZURERM_PREFIX_MAP),
    ];
    for (const key of keys) {
      expect(azureIconUrl(key), `missing src/icons/azure/${key}.svg`).toBeDefined();
    }
  });

  it("falls back to the type-prefix heuristic for unmapped azurerm types", () => {
    // Not in the exact map, but azurerm_storage / azurerm_mssql prefixes are.
    expect(resolveResourceIcon("azurerm_storage_share")).toEqual({
      kind: "azure",
      icon: "storage-account",
    });
    expect(resolveResourceIcon("azurerm_mssql_elasticpool")).toEqual({
      kind: "azure",
      icon: "sql-database",
    });
  });

  it("prefers the longest matching prefix", () => {
    // The scale_set prefix must win over the plain virtual_machine prefix.
    expect(
      resolveResourceIcon("azurerm_virtual_machine_scale_set_extension"),
    ).toEqual({ kind: "azure", icon: "vm-scale-set" });
    expect(resolveResourceIcon("azurerm_virtual_machine_extension")).toEqual({
      kind: "azure",
      icon: "virtual-machine",
    });
  });

  it("falls back to the category icon for a non-azurerm provider", () => {
    expect(resolveResourceIcon("aws_instance")).toEqual({
      kind: "category",
      category: "compute",
    });
    expect(resolveResourceIcon("google_storage_bucket")).toEqual({
      kind: "category",
      category: "data",
    });
  });

  it("falls back to the category icon for an unmapped azurerm type with a known category", () => {
    // Not in either azurerm table, but categorize() knows the family.
    expect(resolveResourceIcon("aws_kms_key")).toEqual({
      kind: "category",
      category: "security",
    });
  });

  it("uses the generic cube for a truly unknown type", () => {
    expect(resolveResourceIcon("azurerm_totally_made_up")).toEqual({
      kind: "generic",
    });
    expect(resolveResourceIcon("frobnicator_widget")).toEqual({
      kind: "generic",
    });
  });
});
