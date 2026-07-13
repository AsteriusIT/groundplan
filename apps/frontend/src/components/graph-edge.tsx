/**
 * Edge design v3 (GP-30), routed orthogonally.
 *
 * Colour comes from the relationship to the change set — new dependency green,
 * removed red, impact-carrying violet, plain dependency neutral — with a matching
 * arrowhead. An expression-inferred dependency (GP-20) is dashed *and* drawn in a
 * fainter tone than an explicit `depends_on`: one encoding is a legend entry
 * people forget, two is a difference you can see at a crossing.
 *
 * The route itself is ELK's (right-angle bend points, see lib/edge-path) — React
 * Flow's own bezier would cross its neighbours at arbitrary angles, which is what
 * turns a dense right-hand side into a cable bundle. Edges with no ELK route (hub
 * edges, annotation links) fall back to a curve.
 *
 * The resting state is calm on purpose. A plain dependency sits at a third
 * opacity; pointing at a node raises *its* edges to full and pushes everything
 * else back. Diff-coloured edges never fade into the background — they are the
 * signal a plan view exists for.
 */
import { EdgeLabelRenderer, getBezierPath, type EdgeProps } from "@xyflow/react";

import { orthogonalMid, orthogonalPath, type Point } from "@/lib/edge-path";
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

/** At rest: structure recedes, change stays legible. */
const RESTING_OPACITY: Record<EdgeRel, number> = {
  new: 0.9,
  removed: 0.9,
  impact: 0.9,
  neutral: 0.35,
};

const DIMMED_OPACITY = 0.06;

type EdgeData = {
  rel?: EdgeRel;
  dimmed?: boolean;
  /** This edge touches the focused (hovered or selected) node — draw it fully. */
  active?: boolean;
  inferred?: boolean;
  /** ELK's right-angle bend points, in flow coordinates. */
  bends?: Point[];
  /** Optional relationship label (e.g. a port or kind); absent for plain deps. */
  label?: string;
  /** GP-58: a human annotation link — dashed, accent-toned, no arrowhead. */
  annotation?: boolean;
};

function edgeOpacity(d: EdgeData, rel: EdgeRel): number {
  if (d.dimmed) return DIMMED_OPACITY;
  if (d.active) return 1;
  return RESTING_OPACITY[rel];
}

/** Stroke token: annotation accent, the faint tone for an inferred reference, or the relationship's colour. */
function edgeStroke(d: EdgeData, rel: EdgeRel): string {
  if (d.annotation) return "stroke-primary";
  if (d.inferred && rel === "neutral") return "stroke-edge-inferred";
  return STROKE[rel];
}

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

  const source: Point = { x: sourceX, y: sourceY };
  const target: Point = { x: targetX, y: targetY };
  // Routed iff ELK actually routed it. On the raw canvas an annotation link is
  // drawn *over* a layout it never entered, so it has no bend points and keeps
  // its curve; in the adapted view (GP-74) the same relationship is part of the
  // graph, so it goes through ELK and gets right angles like everything else.
  const routed = d.bends !== undefined;

  let edgePath: string;
  let labelX: number;
  let labelY: number;
  if (routed) {
    edgePath = orthogonalPath(source, target, d.bends ?? []);
    ({ labelX, labelY } = orthogonalMid(source, target, d.bends ?? []));
  } else {
    [edgePath, labelX, labelY] = getBezierPath({
      sourceX,
      sourceY,
      sourcePosition,
      targetX,
      targetY,
      targetPosition,
    });
  }

  const stroke = edgeStroke(d, rel);

  return (
    <>
      <path
        d={edgePath}
        fill="none"
        // Annotation links carry no arrowhead — they are human relationships,
        // not generated dependencies (GP-58).
        markerEnd={annotation || d.dimmed ? undefined : MARKER[rel]}
        className={cn(
          "react-flow__edge-path",
          stroke,
          dashed && "[stroke-dasharray:6_4]",
        )}
        style={{
          strokeWidth: d.active ? 2 : 1.5,
          opacity: edgeOpacity(d, rel),
          transition: "opacity 120ms ease-out, stroke-width 120ms ease-out",
        }}
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
