/**
 * ResourceIcon (GP-29) — renders the icon for a resource type via the resolution
 * chain: an Azure glyph, else the lucide category icon, else the generic cube.
 * Colour comes from `currentColor` (tint it by passing a `text-cat-*` class), so
 * the whole icon system reads as one blueprint family.
 */
import { AZURE_GLYPHS } from "@/icons/azure-glyphs";
import { resolveResourceIcon } from "@/icons/resource-icon";
import { CATEGORY_META } from "@/lib/resource-category";
import { cn } from "@/lib/utils";

export function ResourceIcon({
  type,
  className,
}: {
  type: string;
  className?: string;
}) {
  const res = resolveResourceIcon(type);

  if (res.kind === "category") {
    const Icon = CATEGORY_META[res.category].icon;
    return <Icon className={className} aria-hidden="true" />;
  }

  const glyph = res.kind === "azure" ? res.glyph : "cube";
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cn("size-4", className)}
      aria-hidden="true"
    >
      {AZURE_GLYPHS[glyph]}
    </svg>
  );
}
