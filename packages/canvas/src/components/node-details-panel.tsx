import { useRef, useState, type ReactNode } from "react";
import { ArrowRight, Maximize2 } from "lucide-react";

import type {
  AttributeDiffRow,
  Graph,
  GraphNode,
  LintFinding,
  LintSeverity,
  NodeSource,
} from "../types";
import { tokenizeHcl, type CodeTokenKind } from "../lib/hcl-highlight";
import {
  PANEL_MAX_WIDTH,
  PANEL_MIN_WIDTH,
  usePanelPrefs,
} from "../panel/panel-prefs";
import { changeLabel, STATUS_META, statusOf } from "../lib/status";
import {
  categorize,
  CATEGORY_META,
  isDataSource,
  shortType,
} from "../lib/resource-category";
import {
  connectionsOf,
  nearestChangedAncestor,
  sortedRules,
  type ChangedAncestor,
  type FlaggedRule,
} from "../lib/node-details";
import { cn } from "../lib/utils";
import { Chip, type ChipVariant } from "../components/ui/chip";
import { StatusBadge } from "../components/ui/status-badge";
import {
  SidePanel,
  SidePanelBody,
  SidePanelHeader,
  SidePanelSection,
} from "../components/ui/side-panel";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog";
import { Button } from "../components/ui/button";
import { CopyButton } from "../components/copy-button";
import { ResourceIcon } from "../components/resource-icon";

/**
 * The detail side panel v2 (GP-33): the place a reviewer decides. Header +
 * why-impacted + Terraform address + attribute changes (GP-32) + connections.
 * Everything is derived from the snapshot — no AI, no invented data. `showChange`
 * is off for the docs view (no plan change data); old (v1/v2) snapshots simply
 * render fewer sections (no attribute_diff → the Changes section is hidden).
 */
/** Same hue mapping as the node badge (graph-node): red / amber / violet. */
const LINT_CHIP_VARIANT: Record<LintSeverity, ChipVariant> = {
  high: "delete",
  warn: "update",
  info: "impacted",
};

export function NodeDetailsPanel({
  graph,
  node,
  onClose,
  onSelect,
  showChange = true,
  lintFindings,
  footer,
}: Readonly<{
  graph: Graph;
  node: GraphNode;
  onClose: () => void;
  /** Select + fly to another node (from the why-impacted / connections links). */
  onSelect: (node: GraphNode) => void;
  showChange?: boolean;
  /** GP-142: the studio lint findings anchored to this node, if any. */
  lintFindings?: LintFinding[];
  /** Optional action bar pinned below the scrolling body (e.g. cross-view jump). */
  footer?: ReactNode;
}>) {
  const status = statusOf(node.change);
  const impacted = showChange && node.impacted === true;
  const ancestor = impacted ? nearestChangedAncestor(graph, node.id) : null;
  const diff = showChange ? (node.attribute_diff ?? []) : [];
  const { dependencies, dependents } = connectionsOf(graph, node.id);
  const rules = sortedRules(node);
  const catClass = CATEGORY_META[categorize(node.type)].className;

  // Opt-in resizing (Settings → Appearance). While a drag is live the width
  // previews through local state; only release persists it.
  const { mode, width, setWidth } = usePanelPrefs();
  const [dragWidth, setDragWidth] = useState<number | null>(null);
  const resizable = mode === "resizable";
  const shownWidth = dragWidth ?? width;

  return (
    <SidePanel
      label={`Details for ${node.name}`}
      className="w-[26rem]"
      style={resizable ? { width: shownWidth } : undefined}
    >
      {resizable && (
        <ResizeHandle
          width={shownWidth}
          onPreview={setDragWidth}
          onCommit={(w) => {
            setDragWidth(null);
            setWidth(w);
          }}
        />
      )}
      <SidePanelHeader onClose={onClose}>
        <p className="text-muted-foreground font-mono text-[10px] tracking-[0.08em] uppercase">
          {isDataSource(node.id) ? "Data source" : "Resource"}
        </p>
        <p className="font-display text-sm font-semibold break-all">
          {node.display_label ?? node.name}
        </p>
        {/* A rename is a lens, not an erasure (GP-74): the name Terraform gave
            this resource is what you will search the repository for. */}
        {node.display_label && (
          <p className="text-faint font-mono text-[11px] break-all">
            renamed from {node.name}
          </p>
        )}
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
        {isDataSource(node.id) && (
          <p className="text-faint mt-1 text-[11px]">
            Read from the provider at plan time — defined outside this
            configuration.
          </p>
        )}
      </SidePanelHeader>

      <SidePanelBody>
        {ancestor && (
          <WhyImpacted
            ancestor={ancestor}
            distance={node.impact_distance ?? ancestor.distance}
            onSelect={onSelect}
          />
        )}

        {/* Notes the projection attached to this node (GP-74). In the adapted
            view the annotation layer is folded into the graph, so the notes
            arrive on the node itself rather than through the editor. */}
        {(node.notes?.length ?? 0) > 0 && (
          <SidePanelSection label="Notes">
            <ul className="space-y-2">
              {node.notes?.map((note) => (
                <li
                  key={note}
                  className="border-primary/30 bg-accent-soft text-ink rounded-md border-l-2 px-2.5 py-1.5 text-xs whitespace-pre-wrap"
                >
                  {note}
                </li>
              ))}
            </ul>
          </SidePanelSection>
        )}

        {/* A Kubernetes node's id is `Kind/name` (GP-96), not a Terraform address.
            Calling it one would be the panel telling the reader something untrue
            about where the thing came from. */}
        <SidePanelSection
          label={node.provider === "kubernetes" ? "Resource" : "Terraform address"}
        >
          <div className="flex items-start gap-1.5">
            <code className="bg-accent-soft text-primary min-w-0 flex-1 rounded-md px-2 py-1.5 font-mono text-xs break-all">
              {node.id}
            </code>
            <CopyButton value={node.id} label="Copy" className="shrink-0" />
          </div>
        </SidePanelSection>

        {/* Kubernetes says what a thing *is* in its labels (GP-96), so they are
            worth as much here as an attribute diff is on a plan. */}
        {node.labels && Object.keys(node.labels).length > 0 && (
          <SidePanelSection label="Labels">
            <ul className="flex flex-wrap gap-1.5">
              {Object.entries(node.labels)
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([key, value]) => (
                  <li
                    key={key}
                    className="bg-accent-soft text-ink rounded-md px-2 py-1 font-mono text-[11px]"
                  >
                    <span className="text-muted-foreground">{key}</span>={value}
                  </li>
                ))}
            </ul>
          </SidePanelSection>
        )}

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

        {rules.length > 0 && (
          <SidePanelSection label="Security rules">
            <SecurityRules rules={rules} />
          </SidePanelSection>
        )}

        {/* GP-142: what the deterministic lint pass found here — the node
            badge's long form, with the fix in hand. */}
        {lintFindings && lintFindings.length > 0 && (
          <SidePanelSection label="Best practices">
            <ul className="space-y-2">
              {lintFindings.map((finding) => (
                <li
                  key={finding.ruleId + finding.message}
                  className="border-border rounded-md border px-2.5 py-2 text-xs"
                >
                  <p className="flex items-center gap-1.5">
                    <Chip variant={LINT_CHIP_VARIANT[finding.severity]}>
                      {finding.severity}
                    </Chip>
                    <code className="text-faint font-mono text-[10px]">
                      {finding.ruleId}
                    </code>
                  </p>
                  <p className="mt-1.5">{finding.message}</p>
                  <p className="text-muted-foreground mt-1">{finding.fixHint}</p>
                </li>
              ))}
            </ul>
          </SidePanelSection>
        )}

        {/* The Terraform that defines this node (GP-121). Docs-flow only: a plan
            snapshot has no source to point at, so the section simply is not there
            — which is also why the PR view needs no flag to suppress it. */}
        {node.source && <SourceSection source={node.source} />}
      </SidePanelBody>

      {footer && (
        <div className="border-border shrink-0 border-t px-4 py-3">{footer}</div>
      )}
    </SidePanel>
  );
}

function WhyImpacted({
  ancestor,
  distance,
  onSelect,
}: Readonly<{
  ancestor: ChangedAncestor;
  distance: number;
  onSelect: (node: GraphNode) => void;
}>) {
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

/**
 * NSG security rules (GP-45): a priority-sorted table; rows whose source is an
 * internet source are tinted with the exposure token and flagged, so a reviewer
 * sees exactly which rule opens the group to the internet.
 */
function SecurityRules({ rules }: Readonly<{ rules: FlaggedRule[] }>) {
  return (
    <div className="border-border divide-border divide-y rounded-md border font-mono text-[11px]">
      {rules.map(({ rule, internet }) => (
        <div
          key={rule.name}
          className={cn(
            "flex flex-col gap-1 px-2.5 py-1.5",
            internet && "bg-exposed-soft",
          )}
        >
          {/* Priority + name on their own line: the name takes the full width so
              it never collapses into a one-character-per-line strip in the narrow
              panel (the metadata below no longer competes for the row). */}
          <div className="flex items-baseline gap-2">
            <span className="text-faint w-8 shrink-0 tabular-nums">{rule.priority}</span>
            <span className="text-ink min-w-0 flex-1 break-words font-medium">
              {rule.name}
            </span>
          </div>
          {/* Direction/access · ports · source, indented under the name. */}
          <div className="text-muted-foreground flex flex-wrap items-center gap-x-2 gap-y-0.5 pl-10">
            <span>
              {rule.direction} {rule.access}
            </span>
            <span>:{rule.ports}</span>
            {internet ? (
              <span aria-label="internet source" className="text-exposed font-medium">
                {rule.source}
              </span>
            ) : (
              <span>{rule.source}</span>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * The Terraform block this node was parsed from (GP-121): where it lives, and
 * what it says. Verbatim — the snippet the backend stored is the file's own text
 * (GP-120), and highlighting only colours it, never rewrites it.
 *
 * Collapsible, open by default: seeing the HCL is the point of the epic, and it
 * sits last so it never pushes the change data a reviewer came for off-screen.
 */
function SourceSection({ source }: Readonly<{ source: NodeSource }>) {
  const [expanded, setExpanded] = useState(false);
  const span =
    source.start_line === source.end_line
      ? `L${source.start_line}`
      : `L${source.start_line}–L${source.end_line}`;

  return (
    <SidePanelSection>
      <details open className="group">
        {/* The buttons ride the summary row so the path below them gets the
            panel's full width — squeezed beside a button it wraps, and a line
            beginning "· L12–L22" reads like a fragment of nothing. */}
        <summary className="text-muted-foreground hover:text-foreground marker:text-faint flex cursor-pointer items-center gap-1.5 text-[10px] font-medium">
          <span className="flex-1 font-mono tracking-[0.08em] uppercase">Source</span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-label="Expand source"
            title="Expand source"
            className="shrink-0"
            onClick={() => setExpanded(true)}
          >
            <Maximize2 className="size-3.5" />
          </Button>
          {/* Copies the raw block, not what is on screen — highlighting is a lens. */}
          <CopyButton value={source.code} label="Copy source" className="shrink-0" />
        </summary>

        <p
          className="text-faint mt-1.5 font-mono text-[11px] break-all"
          title={`${source.file} · ${span}`}
        >
          {source.file} · {span}
        </p>

        {/* Horizontal scroll rather than wrapping: a wrapped HCL block stops
            looking like the file it came from. Capped at half the viewport so a
            300-line resource can never swallow the panel. */}
        <HclBlock code={source.code} className="mt-1.5 max-h-[50vh] text-[11px]" />
      </details>

      {/* The same verbatim block at reading width — the panel is a letterbox
          for real HCL, and this is where a whole resource fits on screen. */}
      <Dialog open={expanded} onOpenChange={setExpanded}>
        <DialogContent className="sm:max-w-[min(92vw,60rem)]">
          <DialogHeader>
            <DialogTitle className="font-mono text-sm font-medium break-all">
              {source.file}
            </DialogTitle>
            <DialogDescription>
              {span} · verbatim from the repository
            </DialogDescription>
          </DialogHeader>
          <HclBlock code={source.code} className="max-h-[70vh] text-xs" />
          <div className="flex justify-end">
            <CopyButton value={source.code} label="Copy source" />
          </div>
        </DialogContent>
      </Dialog>
    </SidePanelSection>
  );
}

/** The tokenized, verbatim HCL block — one renderer for panel and overlay. */
function HclBlock({
  code,
  className,
}: Readonly<{ code: string; className?: string }>) {
  return (
    <pre
      className={cn(
        "border-border bg-muted text-ink overflow-auto rounded-md border p-2.5 font-mono leading-relaxed",
        className,
      )}
    >
      <code>
        {tokenizeHcl(code).map((token, i) => (
          <span
            // Tokens are positional and the list is regenerated wholesale on
            // every source change; the index is the only stable identity.
            key={`${i}-${token.kind}`}
            className={token.kind === "plain" ? undefined : CODE_TOKEN_CLASS[token.kind]}
          >
            {token.text}
          </span>
        ))}
      </code>
    </pre>
  );
}

/**
 * The resizable panel's left-edge grip. Pointer capture previews the width
 * live; release commits it. Left grows the panel (the edge moves left),
 * arrows nudge by 16px — the provider clamps whatever comes in.
 */
function ResizeHandle({
  width,
  onPreview,
  onCommit,
}: Readonly<{
  width: number;
  onPreview: (width: number | null) => void;
  onCommit: (width: number) => void;
}>) {
  const drag = useRef<{ startX: number; startWidth: number } | null>(null);

  const clamp = (w: number) =>
    Math.min(PANEL_MAX_WIDTH, Math.max(PANEL_MIN_WIDTH, w));

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize panel"
      aria-valuenow={width}
      aria-valuemin={PANEL_MIN_WIDTH}
      aria-valuemax={PANEL_MAX_WIDTH}
      tabIndex={0}
      className="hover:bg-primary/40 focus-visible:bg-primary/60 absolute inset-y-0 left-0 z-10 w-1 cursor-col-resize rounded-l-lg transition-colors outline-none"
      onPointerDown={(e) => {
        drag.current = { startX: e.clientX, startWidth: width };
        // jsdom has no pointer capture; in browsers it routes the drag here.
        e.currentTarget.setPointerCapture?.(e.pointerId);
      }}
      onPointerMove={(e) => {
        if (!drag.current) return;
        onPreview(clamp(drag.current.startWidth + (drag.current.startX - e.clientX)));
      }}
      onPointerUp={(e) => {
        if (!drag.current) return;
        const next = clamp(drag.current.startWidth + (drag.current.startX - e.clientX));
        drag.current = null;
        onCommit(next);
      }}
      onPointerCancel={() => {
        drag.current = null;
        onPreview(null);
      }}
      onKeyDown={(e) => {
        if (e.key === "ArrowLeft") onCommit(clamp(width + 16));
        if (e.key === "ArrowRight") onCommit(clamp(width - 16));
      }}
    />
  );
}

const CODE_TOKEN_CLASS: Record<CodeTokenKind, string> = {
  comment: "text-code-comment italic",
  string: "text-code-string",
  number: "text-code-number",
  keyword: "text-code-keyword",
  plain: "",
};

const SPECIAL_VALUES = new Set(["(sensitive)", "(known after apply)"]);

function ValueBadge({
  value,
  side,
}: Readonly<{
  value: string | null;
  side: "before" | "after";
}>) {
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

function ChangeRow({ row }: Readonly<{ row: AttributeDiffRow }>) {
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
}: Readonly<{
  title: string;
  nodes: GraphNode[];
  onSelect: (node: GraphNode) => void;
  empty: string;
  className?: string;
}>) {
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
}: Readonly<{
  node: GraphNode;
  onSelect: (node: GraphNode) => void;
}>) {
  const status = statusOf(node.change);
  const impactedDot = node.impacted ? "bg-impacted" : "bg-edge";
  const dot = status ? STATUS_META[status].bg : impactedDot;
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
        {isDataSource(node.id) && "data."}
        {shortType(node.type)}.{node.name}
      </span>
    </button>
  );
}
