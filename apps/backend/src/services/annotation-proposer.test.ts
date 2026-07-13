/**
 * GP-75. Every test here runs against a stub provider — the AI layer is never
 * allowed to reach a real model from a test, and a proposer that only behaves on
 * a good day is a proposer nobody can trust with the estate.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  MalformedProposalsError,
  parseProposals,
  validProposals,
  type RawProposal,
} from "./annotation-proposer.js";
import type { AnnotationRow } from "../db/schema.js";
import type { Graph } from "../graph/graph.js";

const GRAPH: Graph = {
  version: 1,
  nodes: ["web", "db", "suffix"].map((name) => ({
    id: `azurerm_x.${name}`,
    name,
    type: "azurerm_x",
    provider: "azurerm",
    module_path: [],
    change: null,
  })),
  edges: [],
};

const existing = (
  over: Partial<AnnotationRow> & Pick<AnnotationRow, "type" | "anchors">,
): AnnotationRow =>
  ({
    id: "x",
    repositoryId: "r",
    label: null,
    body: null,
    status: "resolved",
    provenance: "human",
    reason: null,
    createdFromSha: null,
    parentGroupId: null,
    missingAnchors: [],
    createdBy: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  }) as AnnotationRow;

// --- parsing ----------------------------------------------------------------

test("reads the proposals out of a clean JSON response", () => {
  const parsed = parseProposals(
    JSON.stringify({
      proposals: [
        {
          type: "group",
          anchors: ["azurerm_x.web", "azurerm_x.db"],
          label: "Storefront",
          reason: "They serve one flow.",
        },
      ],
    }),
  );
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0]?.label, "Storefront");
  assert.equal(parsed[0]?.reason, "They serve one flow.");
});

test("tolerates a code fence and surrounding chatter", () => {
  // Refusing these costs a retry and buys nothing — models do this even when told
  // not to.
  const parsed = parseProposals(
    'Sure! Here you go:\n```json\n{"proposals":[{"type":"hide","anchors":["azurerm_x.suffix"]}]}\n```\nHope that helps.',
  );
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0]?.type, "hide");
});

test("drops individual junk items but keeps the good ones", () => {
  const parsed = parseProposals(
    JSON.stringify({
      proposals: [
        { type: "note", anchors: ["azurerm_x.web"] }, // not a proposable type
        { type: "group", anchors: "not-an-array", label: "x" }, // wrong shape
        "nonsense",
        { type: "rename", anchors: ["azurerm_x.db"], label: "Ledger" }, // good
      ],
    }),
  );
  assert.deepEqual(
    parsed.map((p) => p.type),
    ["rename"],
  );
});

test("a response that is not JSON at all is an error, not an empty result", () => {
  // The difference matters: "the model had nothing to suggest" is a fine outcome
  // to cache, and "the model broke" is a thing to retry.
  assert.throws(
    () => parseProposals("I'm afraid I can't help with that."),
    MalformedProposalsError,
  );
  assert.throws(() => parseProposals('{"suggestions": []}'), MalformedProposalsError);
  assert.throws(() => parseProposals("{ this is not json }"), MalformedProposalsError);
});

test("an empty proposal list is a valid answer", () => {
  assert.deepEqual(parseProposals('{"proposals":[]}'), []);
});

// --- validation -------------------------------------------------------------

const raw = (over: Partial<RawProposal> & Pick<RawProposal, "type">): RawProposal => ({
  anchors: ["azurerm_x.web"],
  ...over,
});

test("an invented address is dropped — the failure mode that matters most", () => {
  const { valid, dropped } = validProposals(
    [
      raw({ type: "group", anchors: ["azurerm_x.web", "azurerm_x.ghost"], label: "X" }),
      raw({ type: "group", anchors: ["azurerm_x.web"], label: "Real" }),
    ],
    GRAPH,
    [],
  );
  assert.deepEqual(valid.map((p) => p.label), ["Real"]);
  assert.match(dropped[0]?.why ?? "", /unknown address/);
});

test("per-type shape rules are enforced on the model exactly as on a human", () => {
  const { valid } = validProposals(
    [
      raw({ type: "group", anchors: ["azurerm_x.web"] }), // group needs a label
      raw({ type: "rename", anchors: ["azurerm_x.web", "azurerm_x.db"], label: "X" }), // 1 anchor
      raw({ type: "hide", anchors: ["azurerm_x.suffix"], label: "nope" }), // no label
      raw({ type: "hide", anchors: ["azurerm_x.suffix"] }), // good
    ],
    GRAPH,
    [],
  );
  assert.deepEqual(valid.map((p) => p.type), ["hide"]);
});

test("a proposal identical to an existing annotation is skipped, whatever its status", () => {
  const { valid, dropped } = validProposals(
    [raw({ type: "group", anchors: ["azurerm_x.web", "azurerm_x.db"], label: "Storefront" })],
    GRAPH,
    [
      existing({
        type: "group",
        // Same members, written in the other order — still the same claim.
        anchors: ["azurerm_x.db", "azurerm_x.web"],
        label: "Storefront",
        status: "orphaned",
      }),
    ],
  );
  assert.deepEqual(valid, []);
  assert.match(dropped[0]?.why ?? "", /already exists/);
});

test("the model is deduped against itself within one response", () => {
  const { valid } = validProposals(
    [
      raw({ type: "hide", anchors: ["azurerm_x.suffix"] }),
      raw({ type: "hide", anchors: ["azurerm_x.suffix"] }),
    ],
    GRAPH,
    [],
  );
  assert.equal(valid.length, 1);
});

test("a group listing the same resource twice is not a group", () => {
  const { valid } = validProposals(
    [raw({ type: "group", anchors: ["azurerm_x.web", "azurerm_x.web"], label: "X" })],
    GRAPH,
    [],
  );
  assert.deepEqual(valid, []);
});
