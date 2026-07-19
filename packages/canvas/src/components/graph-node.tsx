/**
 * Node design v3 (GP-30) — the "beautiful node". A white card with the resource
 * icon (GP-29), a type-first bold label and a faint name, plus the status
 * treatment from the mockup: soft fill + 1.5px status border + a 3.5px status
 * bar on the left and a circular +/~/− badge top-right. Deletes are dashed +
 * struck through; impacted (unchanged) nodes get a violet dashed outer ring and
 * a violet ! badge; the selected node gets an accent ring; hover lifts on shadow
 * only (no re-layout).
 *
 * `NodeCard` is the presentational card (no React Flow context needed — the
 * /styleguide route renders it directly); `ResourceFlowNode` is the memoized
 * React Flow node that wraps it with connection handles.
 */
import { memo, useState } from "react";
import {
  Handle,
  Position,
  type Node as FlowNode,
  type NodeProps,
} from "@xyflow/react";
import { EyeOff, ShieldAlert, Waypoints } from "lucide-react";

import type { GraphNode } from "../types";
import { changeClasses, STACK_MAX_ROWS } from "../lib/graph-layout";
import { STATUS_META, statusOf } from "../lib/status";
import { categorize, CATEGORY_META, shortType } from "../lib/resource-category";
import type { GraphNodeData } from "../lib/graph-layout";
import { cn } from "../lib/utils";
import { AttachmentChip } from "../components/attachment-chip";
import { ResourceIcon } from "../components/resource-icon";
import { StatusBadge } from "../components/ui/status-badge";

/** Short kind labels for common satellite rows; anything else falls back to
 * shortType. Three LB rows all named "app" must not read identically. */
const STACK_KIND_LABELS: Record<string, string> = {
  azurerm_lb_backend_address_pool: "pool",
  azurerm_lb_probe: "probe",
  azurerm_lb_rule: "rule",
  azurerm_lb_nat_rule: "nat rule",
  azurerm_lb_outbound_rule: "outbound",
  azurerm_network_interface: "nic",
  azurerm_public_ip: "pip",
  azurerm_public_ip_prefix: "pip prefix",
  azurerm_managed_disk: "disk",
};

const stackKindOf = (type: string): string =>
  STACK_KIND_LABELS[type] ?? shortType(type);

/**
 * GP-87: one satellite child inside a host card's stack — a kind prefix, a
 * category icon, the child's name, and its status badge. Clicking it selects
 * the child (its own detail panel), so a satellite is inspectable exactly as a
 * top-level node is.
 */
function StackRow({
  child,
  highlighted = false,
  onSelect,
}: Readonly<{
  child: GraphNode;
  highlighted?: boolean;
  onSelect?: (child: GraphNode) => void;
}>) {
  const status = statusOf(child.change);
  const iconClass = CATEGORY_META[categorize(child.type)].className;
  const label = child.display_label ?? child.name;
  return (
    <button
      type="button"
      data-stack-row
      title={child.type}
      onClick={(e) => {
        e.stopPropagation();
        onSelect?.(child);
      }}
      className={cn(
        "flex w-full items-center gap-1.5 rounded px-1.5 py-0.5 text-left transition-colors",
        highlighted ? "bg-accent ring-primary ring-1" : "hover:bg-accent",
      )}
    >
      <ResourceIcon type={child.type} className={cn("size-3 shrink-0", iconClass)} />
      <span className="text-muted-foreground shrink-0 font-mono text-[10px]">
        {stackKindOf(child.type)}
      </span>
      <span className="text-ink min-w-0 flex-1 truncate font-mono text-[10px]">
        {label}
      </span>
      {status && <StatusBadge kind={status} size="sm" />}
    </button>
  );
}

/**
 * The stack section of a host card (GP-87): up to {@link STACK_MAX_ROWS} rows,
 * then a `+n more` control that reveals the rest in place. No scrolling — the
 * card grows and overflows, which is fine for an on-demand reveal.
 */
function StackSection({
  stack,
  highlightedChildId,
  onSelectChild,
}: Readonly<{
  stack: GraphNode[];
  highlightedChildId?: string;
  onSelectChild?: (child: GraphNode) => void;
}>) {
  const [expanded, setExpanded] = useState(false);
  const overflow = stack.length > STACK_MAX_ROWS;
  const visible = expanded || !overflow ? stack : stack.slice(0, STACK_MAX_ROWS);
  return (
    <div className="border-border mt-auto flex flex-col gap-0.5 border-t px-1.5 py-1">
      {visible.map((child) => (
        <StackRow
          key={child.id}
          child={child}
          highlighted={child.id === highlightedChildId}
          onSelect={onSelectChild}
        />
      ))}
      {overflow && !expanded && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setExpanded(true);
          }}
          className="text-muted-foreground hover:text-foreground px-1.5 py-0.5 text-left font-mono text-[10px]"
        >
          +{stack.length - STACK_MAX_ROWS} more
        </button>
      )}
    </div>
  );
}

export function NodeCard({
  graphNode,
  selected = false,
  picked = false,
  dimmed = false,
  isHub = false,
  hubHiddenCount = 0,
  exposed = false,
  hiddenByAnnotation = false,
  renameLabel,
  stack,
  stackChanged = false,
  highlightedChildId,
  onSelectStackChild,
  chips,
  highlightedChipId,
  onSelectChip,
}: Readonly<{
  graphNode: GraphNode;
  selected?: boolean;
  /** GP-58: picked as a link endpoint / group member in annotate mode. */
  picked?: boolean;
  dimmed?: boolean;
  /** GP-35: this node is a hub; a subtle indicator / counter chip is shown. */
  isHub?: boolean;
  /** GP-35: number of this hub's edges hidden right now (0 = all revealed). */
  hubHiddenCount?: number;
  /** GP-45: internet-exposed (an exposed NSG or a subnet/NIC it guards). */
  exposed?: boolean;
  /**
   * GP-73: a `hide` annotation is anchored here. The raw view still draws the
   * node — it is what the code says — but marks it, so you can see the
   * instruction you left for the adapted view instead of leaving it twice.
   */
  hiddenByAnnotation?: boolean;
  /** GP-73: the name a `rename` annotation will give this node in Adapted. */
  renameLabel?: string;
  /** GP-87: satellite children stacked inside this host card, as rows. */
  stack?: GraphNode[];
  /** GP-87: a stacked child changed — the host wears the impacted ring. */
  stackChanged?: boolean;
  /** GP-87: a stacked child to pulse (search fly-to landed on it). */
  highlightedChildId?: string;
  /** GP-87: select a stacked child (opens its detail panel). */
  onSelectStackChild?: (child: GraphNode) => void;
  /** Attachments riding on this card as chips (avset on its member VM). */
  chips?: GraphNode[];
  /** A chip to pulse (search fly-to landed on it). */
  highlightedChipId?: string;
  /** Select a chip's node (opens its detail panel). */
  onSelectChip?: (node: GraphNode) => void;
}>) {
  const status = statusOf(graphNode.change); // create | update | delete | null
  const impacted = graphNode.impacted === true;
  const isDelete = graphNode.change === "delete";
  const iconClass = CATEGORY_META[categorize(graphNode.type)].className;
  // The projection has the last word: a node it renames shows that name here too.
  const displayName = graphNode.display_label ?? renameLabel ?? graphNode.name;
  // Extracted out of the hub title to avoid a nested ternary (S3358).
  const hubHiddenPlural = hubHiddenCount === 1 ? "" : "s";
  const hasStack = stack !== undefined && stack.length > 0;
  const hasChips = chips !== undefined && chips.length > 0;
  // A literal `count` from the docs producer (plan snapshots expand instances).
  const countLiteral = graphNode.attributes?.["count"];
  // A diff inside the stack must never be less visible than a floating one: the
  // host takes the impacted ring when any child changed (GP-87).
  const showImpactRing = impacted || stackChanged;

  return (
    <div
      title={graphNode.type}
      className={cn(
        // No overflow-hidden here: the status badge intentionally overhangs the
        // top-right corner and must not be clipped (GP-30).
        "relative flex h-full w-full flex-col rounded-[7px] border-[1.5px] shadow-sm transition-shadow hover:shadow-md",
        changeClasses(graphNode.change),
        // A picked node (annotate mode) gets the strongest, filled treatment so
        // link endpoints / group members read at a glance (GP-58).
        picked && "ring-primary ring-offset-background bg-primary/10 ring-[3px] ring-offset-1",
        selected && !picked && "ring-primary ring-offset-background ring-2 ring-offset-1",
        showImpactRing &&
          !selected &&
          !picked &&
          "outline-impacted outline-2 outline-offset-2 outline-dashed",
        exposed &&
          !selected &&
          !picked &&
          "ring-exposed ring-offset-background ring-2 ring-offset-1",
        // Marked for hiding: still drawn (this is the raw view — it shows what
        // the code says), but visibly on its way out.
        hiddenByAnnotation && !picked && "border-dashed opacity-50",
        dimmed && "opacity-20",
      )}
    >
      {/* The card header — the node's own anatomy. Fills the card when there is
          no stack, so a plain node looks exactly as it did before (GP-87). */}
      <div
        className={cn(
          "flex w-full items-center gap-2 py-1.5 pr-3 pl-4",
          !hasStack && "h-full flex-1",
        )}
      >
      {picked && (
        <span
          aria-hidden="true"
          className="bg-primary text-primary-foreground absolute -top-2 -left-2 grid size-4 place-items-center rounded-full text-[9px] shadow-sm"
        >
          ✓
        </span>
      )}
      {status && (
        <span
          aria-hidden="true"
          className={cn(
            "absolute top-1.5 bottom-1.5 left-1 w-[3.5px] rounded-full",
            STATUS_META[status].bg,
          )}
        />
      )}

      <ResourceIcon
        type={graphNode.type}
        className={cn("size-4 shrink-0", iconClass)}
      />

      <div className="min-w-0 flex-1">
        <p
          className={cn(
            "text-ink truncate font-mono text-xs font-semibold",
            isDelete && "line-through",
          )}
        >
          {shortType(graphNode.type)}
        </p>
        <p
          className="text-faint truncate font-mono text-[10px]"
          title={displayName === graphNode.name ? undefined : graphNode.name}
        >
          {displayName}
        </p>
      </div>

      {/* GP-73: this node carries a `hide`. Say so — a hidden node that looks
          exactly like every other node is an instruction you will give twice. */}
      {hiddenByAnnotation && (
        <span
          role="img"
          aria-label="Hidden in the adapted view"
          title="Hidden in the adapted view"
          className="bg-muted text-muted-foreground inline-grid size-4 shrink-0 place-items-center rounded-full"
        >
          <EyeOff className="size-2.5" />
        </span>
      )}

      {/* ×n for a literal count — one card standing for n instances. */}
      {countLiteral !== undefined && (
        <span
          className="bg-muted text-muted-foreground shrink-0 rounded-full px-1.5 py-0.5 font-mono text-[10px]"
          title={`count = ${countLiteral}`}
        >
          ×{countLiteral}
        </span>
      )}

      {/* GP-35: hub indicator + hidden-connection counter chip. */}
      {isHub && (
        <span
          className="bg-muted text-muted-foreground inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 font-mono text-[10px]"
          title={
            hubHiddenCount > 0
              ? `${hubHiddenCount} hidden connection${hubHiddenPlural} — select to reveal`
              : "hub — connections shown"
          }
        >
          <Waypoints className="size-3" />
          {hubHiddenCount > 0 && <span>{hubHiddenCount}</span>}
        </span>
      )}
      </div>

      {/* Attachments riding on this card as chips (avset on its member VM). */}
      {hasChips && (
        <div className="flex flex-wrap gap-1 px-2 pb-1">
          {chips.map((chip) => (
            <AttachmentChip
              key={chip.id}
              node={chip}
              highlighted={chip.id === highlightedChipId}
              onSelect={onSelectChip}
            />
          ))}
        </div>
      )}

      {/* GP-87: the satellite stack — the host's children as rows. */}
      {hasStack && (
        <StackSection
          stack={stack}
          highlightedChildId={highlightedChildId}
          onSelectChild={onSelectStackChild}
        />
      )}

      {status && (
        <StatusBadge kind={status} size="sm" className="absolute -top-2 -right-2" />
      )}
      {!status && impacted && (
        <StatusBadge
          kind="impacted"
          size="sm"
          className="absolute -top-2 -right-2"
        />
      )}

      {/* GP-45: internet-exposure warning — a distinct shield badge (top-left so
          it never collides with the status/impacted badge on the right). */}
      {exposed && (
        <span
          role="img"
          aria-label="Internet-exposed"
          title="Internet-exposed"
          className="bg-exposed absolute -top-2 -left-2 inline-grid size-4 place-items-center rounded-full text-white ring-2 ring-white"
        >
          <ShieldAlert className="size-2.5" />
        </span>
      )}
    </div>
  );
}

/** React Flow node: the card plus (invisible) left/right connection handles. */
export const ResourceFlowNode = memo(function ResourceFlowNode({
  data,
}: NodeProps<FlowNode<GraphNodeData>>) {
  return (
    <div className="h-full w-full">
      <Handle type="target" position={Position.Left} className="!opacity-0" />
      <NodeCard
        graphNode={data.graphNode}
        selected={data.selected === true}
        picked={data.picked === true}
        dimmed={data.dimmed}
        isHub={data.isHub === true}
        hubHiddenCount={data.hubHiddenCount ?? 0}
        exposed={data.exposed === true}
        hiddenByAnnotation={data.hiddenByAnnotation === true}
        renameLabel={data.renameLabel as string | undefined}
        stack={data.stack}
        stackChanged={data.stackChanged === true}
        highlightedChildId={data.highlightedChildId as string | undefined}
        onSelectStackChild={
          data.onSelectStackChild as ((child: GraphNode) => void) | undefined
        }
        chips={data.chips}
        highlightedChipId={data.highlightedChipId as string | undefined}
        onSelectChip={data.onSelectChip as ((node: GraphNode) => void) | undefined}
      />
      <Handle type="source" position={Position.Right} className="!opacity-0" />
    </div>
  );
});
