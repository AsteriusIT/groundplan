import { expect, it } from "vitest";

import {
  orthogonalMid,
  orthogonalPath,
  orthogonalPoints,
  type Point,
} from "./edge-path";

/** Assert no segment of a route runs diagonally. */
function expectAxisAligned(points: Point[]) {
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    expect(
      a.x === b.x || a.y === b.y,
      `segment ${JSON.stringify(a)}→${JSON.stringify(b)} is diagonal`,
    ).toBe(true);
  }
}

it("draws a straight line when the endpoints share a row", () => {
  expect(orthogonalPoints({ x: 0, y: 50 }, { x: 100, y: 50 }, [])).toEqual([
    { x: 0, y: 50 },
    { x: 100, y: 50 },
  ]);
});

it("leaves the source horizontally and enters the target horizontally", () => {
  // Both handles are on a left/right face. An edge that approaches one from
  // above reads as a line piercing the box, so the first and last moves must be
  // horizontal.
  const pts = orthogonalPoints({ x: 0, y: 0 }, { x: 100, y: 60 }, []);

  expect(pts[0]).toEqual({ x: 0, y: 0 });
  expect(pts[pts.length - 1]).toEqual({ x: 100, y: 60 });
  expect(pts[1]?.y).toBe(0); // first move: horizontal, off the source handle
  expect(pts[pts.length - 2]?.y).toBe(60); // last move: horizontal, into the target
  expectAxisAligned(pts);
});

it("threads ELK's bend points, keeping every segment axis-aligned", () => {
  const bends: Point[] = [
    { x: 40, y: 0 },
    { x: 40, y: 120 },
    { x: 90, y: 120 },
  ];
  const pts = orthogonalPoints({ x: 0, y: 0 }, { x: 150, y: 120 }, bends);

  expect(pts[0]).toEqual({ x: 0, y: 0 });
  expect(pts[pts.length - 1]).toEqual({ x: 150, y: 120 });
  for (const bend of bends) expect(pts).toContainEqual(bend);
  expectAxisAligned(pts);
});

it("collapses duplicate points instead of emitting zero-length segments", () => {
  const pts = orthogonalPoints({ x: 0, y: 0 }, { x: 100, y: 0 }, [
    { x: 0, y: 0 },
    { x: 100, y: 0 },
  ]);
  expect(pts).toEqual([
    { x: 0, y: 0 },
    { x: 100, y: 0 },
  ]);
});

it("renders a rounded SVG path between the endpoints", () => {
  const d = orthogonalPath({ x: 0, y: 0 }, { x: 100, y: 60 }, []);
  expect(d.startsWith("M 0,0")).toBe(true);
  expect(d.endsWith("L 100,60")).toBe(true);
  expect(d).toContain("Q"); // corners are rounded, not mitred
});

it("reports the midpoint of the routed path, for the label", () => {
  // Halfway *along the route*, not halfway between the endpoints — on a dogleg
  // those are different places, and the label belongs on the line.
  expect(orthogonalMid({ x: 0, y: 0 }, { x: 100, y: 0 }, [])).toEqual({
    labelX: 50,
    labelY: 0,
  });

  // Route: (0,0) → (50,0) → (50,100) → (100,100). Halfway along its 200 of
  // length is the middle of the vertical riser, not the straight-line midpoint.
  expect(orthogonalMid({ x: 0, y: 0 }, { x: 100, y: 100 }, [])).toEqual({
    labelX: 50,
    labelY: 50,
  });
});
