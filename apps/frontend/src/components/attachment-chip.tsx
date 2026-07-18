import type { GraphNode } from "@/api/types";
import { ResourceIcon } from "@/components/resource-icon";
import { Chip, type ChipVariant } from "@/components/ui/chip";
import { categorize, CATEGORY_META } from "@/lib/resource-category";
import { STATUS_META, statusOf } from "@/lib/status";
import { cn } from "@/lib/utils";

/** GP-89: the chip variant for an attached node — exposure outranks its change. */
function chipVariant(node: GraphNode): ChipVariant {
  if (node.internet_exposed) return "exposed";
  return statusOf(node.change) ?? "neutral";
}

/**
 * GP-89, generalized: one attachment pinned to its anchor as a chip — an NSG /
 * route table on its subnet header, an availability set on a member VM's card.
 * The chip *is* the node — clicking it opens the node's detail panel (rules,
 * exposure) — so its status shows as a dot and it is reachable by keyboard.
 */
export function AttachmentChip({
  node,
  highlighted = false,
  onSelect,
}: Readonly<{
  node: GraphNode;
  highlighted?: boolean;
  onSelect?: (node: GraphNode) => void;
}>) {
  const status = statusOf(node.change);
  const iconClass = CATEGORY_META[categorize(node.type)].className;
  const dot = status ? STATUS_META[status].bg : "bg-edge";
  return (
    <button
      type="button"
      data-subnet-chip
      title={`${node.type} · ${node.name}`}
      onClick={(e) => {
        e.stopPropagation();
        onSelect?.(node);
      }}
      className={cn(
        // inline-flex so the button shrink-wraps the pill exactly: as inline
        // content the pill would sit on a text baseline and the button's box
        // (and so the ring) would be taller and wider than the pill it wraps.
        "inline-flex rounded-full transition-shadow hover:shadow-sm",
        // The small-element ring (same as a stacked row): 1px, no offset. The
        // card-sized ring-2 + offset reads as a fat halo on a 20px pill.
        highlighted && "ring-primary ring-1",
      )}
    >
      <Chip variant={chipVariant(node)}>
        <span
          aria-hidden="true"
          className={cn("size-1.5 shrink-0 rounded-full", dot)}
        />
        <ResourceIcon type={node.type} className={cn("size-3 shrink-0", iconClass)} />
        <span className="max-w-[140px] truncate">{node.display_label ?? node.name}</span>
      </Chip>
    </button>
  );
}
