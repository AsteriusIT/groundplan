/**
 * Resource type → embedded vendor icon for draw.io exports (GP-175/GP-176).
 * Mirrors the canvas resolution chain (GP-29): exact type → longest matching
 * type-prefix → none. The data (maps + SVGs) is generated from the canvas
 * package — see drawio-icons.generated.ts — so the export always shows the
 * same official icons the app draws.
 */
import { EXACT_ICON, ICON_DATA, PREFIX_ICON } from "./drawio-icons.generated.js";

const SORTED_PREFIXES = Object.keys(PREFIX_ICON).sort((a, b) => b.length - a.length);

/**
 * A style-safe data URI for an icon id ("azure/subnet"). draw.io's comma form
 * (no ";base64") keeps the URI free of semicolons, which would end the style
 * key/value pair.
 */
export function iconDataUri(id: string): string {
  return `data:image/svg+xml,${ICON_DATA[id] ?? ""}`;
}

/** The embedded icon for a resource type, or null when nothing maps. */
export function drawioIconUri(type: string): string | null {
  let id = EXACT_ICON[type];
  if (!id) {
    const prefix = SORTED_PREFIXES.find((p) => type === p || type.startsWith(`${p}_`));
    id = prefix ? PREFIX_ICON[prefix] : undefined;
  }
  return id ? iconDataUri(id) : null;
}
