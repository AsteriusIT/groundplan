/**
 * Resource icon resolution chain (GP-29). Pure and unit-tested:
 *
 *   exact azurerm type  →  azurerm type-prefix heuristic  →  category icon
 *   (GP-24)  →  generic cube.
 *
 * Only azurerm types try the Azure glyphs; any other provider skips straight to
 * the category icon, then the generic cube.
 */
import { categorize, type Category } from "@/lib/resource-category";
import type { AzureIconKey } from "@/icons/azure-icons";
import { AZURERM_ICON_MAP, AZURERM_PREFIX_MAP } from "@/icons/azurerm";

export type IconResolution =
  | { kind: "azure"; icon: AzureIconKey }
  | { kind: "category"; category: Exclude<Category, "other"> }
  | { kind: "generic" };

// Longest-first so e.g. azurerm_virtual_machine_scale_set beats
// azurerm_virtual_machine.
const SORTED_PREFIXES = Object.keys(AZURERM_PREFIX_MAP).sort(
  (a, b) => b.length - a.length,
);

export function resolveResourceIcon(type: string): IconResolution {
  if (type.startsWith("azurerm_")) {
    const exact = AZURERM_ICON_MAP[type];
    if (exact) return { kind: "azure", icon: exact };
    for (const prefix of SORTED_PREFIXES) {
      if (type === prefix || type.startsWith(`${prefix}_`)) {
        return { kind: "azure", icon: AZURERM_PREFIX_MAP[prefix] as AzureIconKey };
      }
    }
  }
  const category = categorize(type);
  if (category !== "other") return { kind: "category", category };
  return { kind: "generic" };
}
