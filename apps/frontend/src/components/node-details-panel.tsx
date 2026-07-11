import { ArrowRight } from "lucide-react";

import type { AttributeDiffRow, Graph, GraphNode } from "@/api/types";
import { changeLabel, STATUS_META, statusOf } from "@/lib/status";
import { categorize, CATEGORY_META, shortType } from "@/lib/resource-category";
import {
  connectionsOf,
  nearestChangedAncestor,
  type ChangedAncestor,
} from "@/lib/node-details";
import { cn } from "@/lib/utils";
import { Chip } from "@/components/ui/chip";
import { StatusBadge } from "@/components/ui/status-badge";
import {
  SidePanel,
  SidePanelBody,
  SidePanelHeader,
  SidePanelSection,
} from "@/components/ui/side-panel";
import { CopyButton } from "@/components/copy-button";
import { ResourceIcon } from "@/components/resource-icon";

/**
 * The detail side panel v2 (GP-33): the place a reviewer decides. Header +
 * why-impacted + Terraform address + attribute changes (GP-32) + connections.
 * Everything is derived from the snapshot — no AI, no invented data. `showChange`
 * is off for the docs view (no plan change data); old (v1/v2) snapshots simply
 * render fewer sections (no attribute_diff → the Changes section is hidden).
 */
export function NodeDetailsPanel({
  graph,
  node,
  onClose,
  onSelect,
  showChange = true,
}: {
  graph: Graph;
  node: GraphNode;
  onClose: () => void;
  /** Select + fly to another node (from the why-impacted / connections links). */
  onSelect: (node: GraphNode) => void;
  showChange?: boolean;
}) {
  const status = statusOf(node.change);
  const impacted = showChange && node.impacted === true;
  const ancestor = impacted ? nearestChangedAncestor(graph, node.id) : null;
  const diff = showChange ? (node.attribute_diff ?? []) : [];
  const { dependencies, dependents } = connectionsOf(graph, node.id);
  const catClass = CATEGORY_META[categorize(node.type)].className;

  return (
    <SidePanel label={`Details for ${node.name}`}>
      <SidePanelHeader onClose={onClose}>
        <p className="text-muted-foreground font-mono text-[10px] tracking-[0.08em] uppercase">
          Resource
        </p>
        <p className="font-display text-sm font-semibold break-all">
          {node.name}
        </p>
        {(status || impacted) && (
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {status && (
              <Chip variant={status}>
                <StatusBadge kind={status} size="sm" className="-ml-0.5 ring-0" />
                {changeLabel(node.change)}
              </Chip>
            )}
            {impacted && (
              <Chip variant="impacted">! impacted · d{node.impact_distance ?? 1}</Chip>
            )}
          </div>
        )}
        <div className="text-faint mt-2 flex items-center gap-1.5 font-mono text-[11px]">
          <ResourceIcon type={node.type} className={cn("size-3.5 shrink-0", catClass)} />
          <span className="truncate">
            {node.type}
            {node.provider ? ` · ${node.provider}` : ""}
          </span>
        </div>
      </SidePanelHeader>

      <SidePanelBody>
        {ancestor && (
          <WhyImpacted
            ancestor={ancestor}
            distance={node.impact_distance ?? ancestor.distance}
            onSelect={onSelect}
          />
        )}

        <SidePanelSection label="Terraform address">
          <div className="flex items-start gap-1.5">
            <code className="bg-accent-soft text-primary min-w-0 flex-1 rounded-md px-2 py-1.5 font-mono text-xs break-all">
              {node.id}
            </code>
            <CopyButton value={node.id} label="Copy" className="shrink-0" />
          </div>
        </SidePanelSection>

        {node.module_path.length > 0 && (
          <SidePanelSection label="Module">
            <p className="font-mono text-sm break-all">
              {node.module_path.join(" / ")}
            </p>
          </SidePanelSection>
        )}

        {diff.length > 0 && (
          <SidePanelSection
            label={`Changes${node.attribute_diff_truncated ? " · first 20" : ""}`}
          >
            <div className="border-border divide-border divide-y rounded-md border">
              {diff.map((row) => (
                <ChangeRow key={row.key} row={row} />
              ))}
            </div>
          </SidePanelSection>
        )}

        <SidePanelSection label="Connections">
          <ConnectionList
            title="Depends on"
            nodes={dependencies}
            onSelect={onSelect}
            empty="No dependencies"
          />
          <ConnectionList
            title="Used by"
            nodes={dependents}
            onSelect={onSelect}
            empty="Nothing depends on this"
            className="mt-3"
          />
        </SidePanelSection>
      </SidePanelBody>
    </SidePanel>
  );
}

function WhyImpacted({
  ancestor,
  distance,
  onSelect,
}: {
  ancestor: ChangedAncestor;
  distance: number;
  onSelect: (node: GraphNode) => void;
}) {
  const label = (n: GraphNode) => `${shortType(n.type)}.${n.name}`;
  const throughHop = distance > 1 && ancestor.firstHop.id !== ancestor.node.id;
  return (
    <SidePanelSection label="Why impacted">
      <div className="border-impacted/30 bg-impacted-soft text-ink rounded-md border px-3 py-2 text-xs leading-relaxed">
        This unchanged resource is impacted because it depends on{" "}
        <button
          type="button"
          onClick={() => onSelect(ancestor.node)}
          className="text-impacted font-mono font-medium underline-offset-2 hover:underline"
        >
          {label(ancestor.node)}
        </button>{" "}
        <span className="text-muted-foreground">
          ({changeLabel(ancestor.node.change)} · distance {distance})
        </span>
        {throughHop && (
          <>
            {" "}
            through{" "}
            <button
              type="button"
              onClick={() => onSelect(ancestor.firstHop)}
              className="font-mono underline-offset-2 hover:underline"
            >
              {label(ancestor.firstHop)}
            </button>
          </>
        )}
        .
      </div>
    </SidePanelSection>
  );
}

const SPECIAL_VALUES = new Set(["(sensitive)", "(known after apply)"]);

function ValueBadge({
  value,
  side,
}: {
  value: string | null;
  side: "before" | "after";
}) {
  if (value === null) return <span className="text-faint">—</span>;
  if (SPECIAL_VALUES.has(value)) {
    return (
      <span className="bg-muted text-muted-foreground rounded px-1.5 py-0.5 italic">
        {value}
      </span>
    );
  }
  return (
    <span
      className={cn(
        "rounded px-1.5 py-0.5 break-all",
        side === "before" ? "bg-delete-soft text-delete" : "bg-create-soft text-create",
      )}
    >
      {value}
    </span>
  );
}

function ChangeRow({ row }: { row: AttributeDiffRow }) {
  return (
    <div className="flex flex-col gap-1 px-2.5 py-1.5">
      <span className="text-ink font-mono text-[11px] font-medium break-all">
        {row.key}
      </span>
      <div className="flex flex-wrap items-center gap-1.5 font-mono text-[11px]">
        <ValueBadge value={row.before} side="before" />
        <ArrowRight className="text-faint size-3 shrink-0" />
        <ValueBadge value={row.after} side="after" />
      </div>
    </div>
  );
}

function ConnectionList({
  title,
  nodes,
  onSelect,
  empty,
  className,
}: {
  title: string;
  nodes: GraphNode[];
  onSelect: (node: GraphNode) => void;
  empty: string;
  className?: string;
}) {
  return (
    <div className={className}>
      <p className="text-faint mb-1 font-mono text-[10px] tracking-wide uppercase">
        {title}
      </p>
      {nodes.length === 0 ? (
        <p className="text-faint text-xs">{empty}</p>
      ) : (
        <ul className="space-y-0.5">
          {nodes.map((n) => (
            <li key={n.id}>
              <ConnectionRow node={n} onSelect={onSelect} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ConnectionRow({
  node,
  onSelect,
}: {
  node: GraphNode;
  onSelect: (node: GraphNode) => void;
}) {
  const status = statusOf(node.change);
  const dot = status
    ? STATUS_META[status].bg
    : node.impacted
      ? "bg-impacted"
      : "bg-edge";
  const catClass = CATEGORY_META[categorize(node.type)].className;
  return (
    <button
      type="button"
      onClick={() => onSelect(node)}
      className="hover:bg-accent flex w-full items-center gap-2 rounded px-1.5 py-1 text-left"
    >
      <span className={cn("size-1.5 shrink-0 rounded-full", dot)} />
      <ResourceIcon type={node.type} className={cn("size-3.5 shrink-0", catClass)} />
      <span className="text-ink min-w-0 flex-1 truncate font-mono text-[11px]">
        {shortType(node.type)}.{node.name}
      </span>
    </button>
  );
}
