/**
 * Orthogonal edge routing. ELK computes the bend points (elk.edgeRouting:
 * ORTHOGONAL); React Flow throws them away and draws its own bezier, so we build
 * the path ourselves from the points ELK gave us.
 *
 * Why right angles: on a dense many-to-many graph, curves cross at arbitrary
 * angles and the eye cannot trace one edge through the crossing — the right-hand
 * side of the diagram collapses into a cable bundle. Orthogonal segments overlap
 * cleanly and share lanes, so a crossing reads as a crossing.
 *
 * Pure and unit-tested; the component only renders what these functions return.
 */
export type Point = { x: number; y: number };

/** Corner radius. Small enough to still read as a right angle. */
const RADIUS = 8;

const same = (a: Point, b: Point): boolean => a.x === b.x && a.y === b.y;

/** Drop consecutive duplicates — they would emit zero-length segments. */
function dedupe(points: Point[]): Point[] {
  return points.filter((p, i) => i === 0 || !same(p, points[i - 1]!));
}

/**
 * Every corner the route visits: the source handle, ELK's bend points, and the
 * target handle, with an elbow inserted wherever a segment would otherwise run
 * diagonally.
 *
 * The route must leave the source horizontally and arrive at the target
 * horizontally — those are left/right handles, and an edge approaching one from
 * above reads as a line piercing the box. So elbows turn horizontal-first
 * everywhere except the last segment, which turns vertical-first to settle onto
 * the target's row before entering it.
 */
export function orthogonalPoints(
  source: Point,
  target: Point,
  bends: Point[],
): Point[] {
  const via = dedupe([source, ...bends, target]);

  // Straight from source to target on different rows: neither a single
  // horizontal-first nor a single vertical-first elbow works — one would leave
  // the source vertically, the other would enter the target vertically. Step
  // across at the midpoint instead, which does both.
  if (via.length === 2) {
    const [from, to] = via as [Point, Point];
    if (from.x === to.x || from.y === to.y) return via;
    const midX = (from.x + to.x) / 2;
    return [from, { x: midX, y: from.y }, { x: midX, y: to.y }, to];
  }

  const out: Point[] = [via[0]!];
  for (let i = 1; i < via.length; i++) {
    const prev = via[i - 1]!;
    const next = via[i]!;
    if (prev.x !== next.x && prev.y !== next.y) {
      // Only the final approach turns vertical-first, so it lands on the
      // target's row and enters the handle horizontally. Everywhere else turns
      // horizontal-first, which is how the route leaves the source handle.
      const last = i === via.length - 1;
      out.push(last ? { x: prev.x, y: next.y } : { x: next.x, y: prev.y });
    }
    out.push(next);
  }
  return dedupe(out);
}

/** Move from `from` towards `to` by at most `dist`. */
function towards(from: Point, to: Point, dist: number): Point {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.abs(dx) + Math.abs(dy); // axis-aligned: one term is zero
  const step = Math.min(dist, len / 2);
  if (len === 0) return { ...from };
  return {
    x: from.x + Math.sign(dx) * step * (dx !== 0 ? 1 : 0),
    y: from.y + Math.sign(dy) * step * (dy !== 0 ? 1 : 0),
  };
}

/** An SVG path through the orthogonal route, with rounded corners. */
export function orthogonalPath(
  source: Point,
  target: Point,
  bends: Point[],
): string {
  const pts = orthogonalPoints(source, target, bends);
  if (pts.length < 2) return "";

  let d = `M ${pts[0]!.x},${pts[0]!.y}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const corner = pts[i]!;
    const before = towards(corner, pts[i - 1]!, RADIUS);
    const after = towards(corner, pts[i + 1]!, RADIUS);
    d += ` L ${before.x},${before.y} Q ${corner.x},${corner.y} ${after.x},${after.y}`;
  }
  const end = pts[pts.length - 1]!;
  d += ` L ${end.x},${end.y}`;
  return d;
}

/** The point halfway *along* the route — where a label belongs. */
export function orthogonalMid(
  source: Point,
  target: Point,
  bends: Point[],
): { labelX: number; labelY: number } {
  const pts = orthogonalPoints(source, target, bends);
  const lengths: number[] = [];
  let total = 0;
  for (let i = 1; i < pts.length; i++) {
    const len =
      Math.abs(pts[i]!.x - pts[i - 1]!.x) + Math.abs(pts[i]!.y - pts[i - 1]!.y);
    lengths.push(len);
    total += len;
  }

  let travelled = 0;
  for (let i = 0; i < lengths.length; i++) {
    const len = lengths[i]!;
    if (travelled + len >= total / 2) {
      const along = len === 0 ? 0 : (total / 2 - travelled) / len;
      const a = pts[i]!;
      const b = pts[i + 1]!;
      return {
        labelX: a.x + (b.x - a.x) * along,
        labelY: a.y + (b.y - a.y) * along,
      };
    }
    travelled += len;
  }
  const first = pts[0] ?? source;
  return { labelX: first.x, labelY: first.y };
}
