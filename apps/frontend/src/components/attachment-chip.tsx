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
        "rounded-full transition-shadow hover:shadow-sm",
        highlighted && "ring-primary ring-2 ring-offset-1",
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
