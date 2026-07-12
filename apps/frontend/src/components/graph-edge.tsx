/**
 * Edge design v3 (GP-30). A custom React Flow edge coloured by relationship —
 * new dependency (target created) green, removed (endpoint deleted) red dashed,
 * impact-carrying violet, plain dependency neutral grey — with a matching
 * arrowhead. Inferred (expression-derived) edges stay dashed (GP-20). A label
 * pill renders only when the edge carries information (`data.label`); plain deps
 * carry nothing. All colours are tokens (stroke-… and fill-… classes).
 */
import { EdgeLabelRenderer, getBezierPath, type EdgeProps } from "@xyflow/react";

import type { EdgeRel } from "@/lib/graph-layout";
import { cn } from "@/lib/utils";

const STROKE: Record<EdgeRel, string> = {
  new: "stroke-create",
  removed: "stroke-delete",
  impact: "stroke-impacted",
  neutral: "stroke-edge",
};

const MARKER: Record<EdgeRel, string> = {
  new: "url(#gp-arrow-create)",
  removed: "url(#gp-arrow-delete)",
  impact: "url(#gp-arrow-impacted)",
  neutral: "url(#gp-arrow-neutral)",
};

type EdgeData = {
  rel?: EdgeRel;
  dimmed?: boolean;
  inferred?: boolean;
  /** Optional relationship label (e.g. a port or kind); absent for plain deps. */
  label?: string;
  /** GP-58: a human annotation link — dashed, accent-toned, no arrowhead. */
  annotation?: boolean;
};

export function RelationshipEdge({
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
}: EdgeProps) {
  const d = (data ?? {}) as EdgeData;
  const rel = d.rel ?? "neutral";
  const annotation = d.annotation === true;
  const dashed = annotation || rel === "removed" || d.inferred === true;
  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });

  return (
    <>
      <path
        d={edgePath}
        // Annotation links carry no arrowhead — they are human relationships,
        // not generated dependencies (GP-58).
        markerEnd={annotation || d.dimmed ? undefined : MARKER[rel]}
        className={cn(
          "react-flow__edge-path",
          annotation ? "stroke-primary" : STROKE[rel],
          dashed && "[stroke-dasharray:6_4]",
        )}
        style={{ strokeWidth: 1.5, opacity: d.dimmed ? 0.12 : 1 }}
      />
      {d.label && !d.dimmed && (
        <EdgeLabelRenderer>
          <div
            style={{
              transform: `translate(-50%,-50%) translate(${labelX}px,${labelY}px)`,
            }}
            className={cn(
              "pointer-events-none absolute rounded-full border px-1.5 py-0.5 font-mono text-[9px] leading-none",
              annotation
                ? "bg-primary/10 border-primary/40 text-primary"
                : "bg-panel border-border-strong text-muted-foreground",
            )}
          >
            {d.label}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

const ARROWS: { id: string; fill: string }[] = [
  { id: "gp-arrow-create", fill: "fill-create" },
  { id: "gp-arrow-delete", fill: "fill-delete" },
  { id: "gp-arrow-impacted", fill: "fill-impacted" },
  { id: "gp-arrow-neutral", fill: "fill-edge" },
];

/** Once-per-canvas SVG defs holding the four token-coloured arrowheads. */
export function EdgeArrowMarkers() {
  return (
    <svg className="pointer-events-none absolute size-0" aria-hidden="true">
      <defs>
        {ARROWS.map((a) => (
          <marker
            key={a.id}
            id={a.id}
            viewBox="0 0 10 10"
            refX="8"
            refY="5"
            markerWidth="6"
            markerHeight="6"
            orient="auto"
          >
            <path d="M0,0 L10,5 L0,10 z" className={a.fill} />
          </marker>
        ))}
      </defs>
    </svg>
  );
}
