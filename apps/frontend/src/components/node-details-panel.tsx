import type { GraphNode } from "@/api/types";
import { changeLabel } from "@/lib/graph-layout";
import { statusOf } from "@/lib/status";
import { Chip } from "@/components/ui/chip";
import { StatusBadge } from "@/components/ui/status-badge";
import {
  SidePanel,
  SidePanelBody,
  SidePanelHeader,
  SidePanelSection,
} from "@/components/ui/side-panel";

function Field({ value }: { value: string }) {
  return <p className="font-mono text-sm break-all">{value}</p>;
}

/**
 * Details for the selected graph node, built on the GP-28 SidePanel/Chip/Badge
 * primitives. Shows only fields carried by the snapshot node — no invented data.
 * `showChange` is off for the docs view (GP-18). GP-33 enriches this with the
 * why-impacted block, the attribute diff and the connections lists.
 */
export function NodeDetailsPanel({
  node,
  onClose,
  showChange = true,
}: {
  node: GraphNode;
  onClose: () => void;
  showChange?: boolean;
}) {
  const status = statusOf(node.change);
  return (
    <SidePanel label={`Details for ${node.name}`}>
      <SidePanelHeader onClose={onClose}>
        <p className="text-muted-foreground font-mono text-[10px] tracking-[0.08em] uppercase">
          Resource
        </p>
        <p className="font-display text-sm font-semibold break-all">
          {node.name}
        </p>
        {showChange && (status || node.impacted) && (
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {status && (
              <Chip variant={status}>
                <StatusBadge kind={status} size="sm" className="-ml-0.5 ring-0" />
                {changeLabel(node.change)}
              </Chip>
            )}
            {node.impacted && (
              <Chip variant="impacted">! impacted · d{node.impact_distance ?? 1}</Chip>
            )}
          </div>
        )}
      </SidePanelHeader>

      <SidePanelBody>
        <SidePanelSection label="Terraform address">
          <code className="bg-accent-soft text-primary block rounded-md px-2 py-1.5 font-mono text-xs break-all">
            {node.id}
          </code>
        </SidePanelSection>
        <SidePanelSection label="Type">
          <Field value={node.type} />
        </SidePanelSection>
        <SidePanelSection label="Provider">
          <Field value={node.provider ?? "—"} />
        </SidePanelSection>
        <SidePanelSection label="Module path">
          <Field
            value={node.module_path.length ? node.module_path.join(" / ") : "root"}
          />
        </SidePanelSection>
      </SidePanelBody>
    </SidePanel>
  );
}
