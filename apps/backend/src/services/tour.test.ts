/**
 * GP-78: what a tour must survive before anyone is flown to it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import type { Graph } from "../graph/graph.js";
import {
  MalformedTourError,
  MAX_ANCHORS,
  MAX_STEPS,
  parseTour,
  validSteps,
  type RawStep,
} from "./tour.js";

const GRAPH: Graph = {
  version: 1,
  nodes: ["web", "db", "queue"].map((name) => ({
    id: `azurerm_x.${name}`,
    name,
    type: "azurerm_x",
    provider: "azurerm",
    module_path: [],
    change: null,
  })),
  edges: [],
};

const step = (over: Partial<RawStep> = {}): RawStep => ({
  anchors: ["azurerm_x.web"],
  title: "A stop",
  body: "Something worth saying.",
  ...over,
});

test("a fenced response is read anyway — models do this even when told not to", () => {
  const tour = parseTour(
    'Here you go!\n```json\n{"title":"T","steps":[{"anchors":["a"],"title":"S","body":"B"}]}\n```\nHope that helps.',
  );
  assert.equal(tour.title, "T");
  assert.deepEqual(tour.steps, [{ anchors: ["a"], title: "S", body: "B" }]);
});

test("a stop with no anchors is the whole-diagram stop, not a malformed one", () => {
  const tour = parseTour(
    '{"steps":[{"anchors":[],"title":"Overview","body":"B"},{"title":"Closer","body":"B"}]}',
  );
  // Both the explicit empty array and an absent `anchors` mean "frame everything" —
  // the opener and the closer, which is exactly where a tour says what it is about.
  assert.deepEqual(
    tour.steps.map((s) => s.anchors),
    [[], []],
  );
});

test("prose instead of JSON is unusable — and it says so", () => {
  assert.throws(() => parseTour("I'm sorry, I can't do that."), MalformedTourError);
  assert.throws(() => parseTour('{"title":"T"}'), MalformedTourError);
  assert.throws(() => parseTour('{"steps":[{'), MalformedTourError);
});

test("a stop missing its text is dropped, and the rest of the tour survives", () => {
  const tour = parseTour(
    '{"steps":[{"anchors":["a"],"title":"S"},{"anchors":["b"],"title":"S2","body":"B"}]}',
  );
  assert.deepEqual(
    tour.steps.map((s) => s.title),
    ["S2"],
  );
});

test("a stop anchored at an id that does not exist is dropped whole", () => {
  const { steps, dropped } = validSteps(
    [
      step({ anchors: ["azurerm_x.web", "azurerm_x.ghost"], title: "Invented" }),
      step({ anchors: ["azurerm_x.db"], title: "Real" }),
    ],
    GRAPH,
  );

  // Not "fly to the anchors that happen to exist": a stop whose text is about two
  // things and whose camera shows one is worse than no stop at all.
  assert.deepEqual(
    steps.map((s) => s.title),
    ["Real"],
  );
  assert.equal(dropped.length, 1);
  assert.match(dropped[0]!.why, /azurerm_x\.ghost/);
});

test("caps are enforced, and what they cost is recorded — never silent", () => {
  const many = Array.from({ length: MAX_STEPS + 2 }, (_, i) =>
    step({ title: `Stop ${i}` }),
  );
  const capped = validSteps(many, GRAPH);
  assert.equal(capped.steps.length, MAX_STEPS);
  assert.equal(capped.dropped.length, 2);
  assert.match(capped.dropped[0]!.why, new RegExp(`${MAX_STEPS}-stop cap`));

  const wide = validSteps(
    [step({ anchors: Array.from({ length: MAX_ANCHORS + 1 }, () => "azurerm_x.web") })],
    GRAPH,
  );
  // ...though duplicates collapse first: six anchors that are all the same node is
  // one anchor, not an over-wide stop.
  assert.equal(wide.steps.length, 1);
  assert.deepEqual(wide.steps[0]!.anchors, ["azurerm_x.web"]);
});

test("a stop framing more distinct nodes than the cap is dropped", () => {
  const graph: Graph = {
    version: 1,
    nodes: Array.from({ length: MAX_ANCHORS + 1 }, (_, i) => ({
      id: `azurerm_x.n${i}`,
      name: `n${i}`,
      type: "azurerm_x",
      provider: "azurerm",
      module_path: [],
      change: null,
    })),
    edges: [],
  };
  const { steps, dropped } = validSteps(
    [step({ anchors: graph.nodes.map((n) => n.id) })],
    graph,
  );
  assert.equal(steps.length, 0);
  assert.match(dropped[0]!.why, new RegExp(`over the ${MAX_ANCHORS} cap`));
});
