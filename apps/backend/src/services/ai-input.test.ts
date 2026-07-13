import { test } from "node:test";
import assert from "node:assert/strict";

import { buildPrSummaryInput, type ContextInput } from "./ai-input.js";
import { summarize } from "../graph/summarize.js";
import type { Graph } from "../graph/graph.js";

const NO_CONTEXT: ContextInput = {
  projectName: "Payments",
  projectContextMd: null,
  repoContextMd: null,
};

/**
 * A plan that exercises every risk the brief is supposed to surface: a deletion,
 * an update, creations across two categories, an impacted downstream resource, a
 * pre-existing internet exposure, and a new privileged role grant.
 */
const RICH_PLAN: Graph = {
  version: 4,
  nodes: [
    {
      id: "aws_s3_bucket.legacy",
      name: "legacy",
      type: "aws_s3_bucket",
      provider: "aws",
      module_path: [],
      change: "delete",
    },
    {
      id: "aws_subnet.public",
      name: "public",
      type: "aws_subnet",
      provider: "aws",
      module_path: [],
      change: "create",
    },
    {
      id: "aws_lb.edge",
      name: "edge",
      type: "aws_lb",
      provider: "aws",
      module_path: [],
      change: "create",
    },
    {
      id: "aws_instance.api",
      name: "api",
      type: "aws_instance",
      provider: "aws",
      module_path: [],
      change: "update",
    },
    {
      id: "aws_instance.worker",
      name: "worker",
      type: "aws_instance",
      provider: "aws",
      module_path: [],
      change: null,
      impacted: true,
      impact_distance: 1,
    },
    {
      id: "azurerm_network_security_group.edge",
      name: "edge",
      type: "azurerm_network_security_group",
      provider: "azurerm",
      module_path: [],
      change: null,
      internet_exposed: true,
    },
    {
      id: "azurerm_role_assignment.deployer",
      name: "deployer",
      type: "azurerm_role_assignment",
      provider: "azurerm",
      module_path: [],
      change: "create",
      privileged: true,
      role_assignment: {
        role: "Owner",
        principal: "azurerm_user_assigned_identity.ci",
        scope: "/subscriptions/abc",
      },
    },
  ],
  edges: [],
};

function build(graph: Graph, context: ContextInput = NO_CONTEXT): string {
  return buildPrSummaryInput({
    prNumber: 42,
    summaryMd: summarize(graph),
    graph,
    context,
  });
}

test("the brief carries the deterministic summary, not the raw plan", () => {
  const input = build(RICH_PLAN);

  assert.match(input, /# Infrastructure change \(PR #42\)/);
  assert.match(input, /## Deterministic change summary/);
  // The GP-36 summary verbatim — the model reads what the PR view shows.
  assert.ok(input.includes(summarize(RICH_PLAN)));
});

test("changes are counted by category, with the blast radius", () => {
  const input = build(RICH_PLAN);

  assert.match(input, /## Change by category/);
  assert.match(input, /- Compute: 1 updated/);
  assert.match(input, /- Data: 1 deleted/);
  assert.match(input, /- Identity: 1 created/);
  assert.match(input, /- Network: 2 created/);
  assert.match(
    input,
    /- Blast radius: 1 unchanged resource depends on something that changed/,
  );
});

test("the blast-radius line agrees with itself when several are impacted", () => {
  const second = structuredClone(RICH_PLAN);
  second.nodes.push({
    id: "aws_instance.reporting",
    name: "reporting",
    type: "aws_instance",
    provider: "aws",
    module_path: [],
    change: null,
    impacted: true,
    impact_distance: 2,
  });

  assert.match(
    build(second),
    /- Blast radius: 2 unchanged resources depend on something that changed/,
  );
});

test("security flags say whether the change introduced them", () => {
  const input = build(RICH_PLAN);

  assert.match(input, /## Security flags in play/);
  // Untouched exposure is context, not news — and the brief says which it is.
  assert.match(
    input,
    /- Internet-exposed: `azurerm_network_security_group\.edge` \(pre-existing, untouched by this change\)/,
  );
  // A NEW privileged grant, with what it actually grants.
  assert.match(
    input,
    /- Privileged IAM grant: `azurerm_role_assignment\.deployer` \(created in this change\) — grants `Owner` to `azurerm_user_assigned_identity\.ci` on `\/subscriptions\/abc`/,
  );
});

test("a change with no flagged resources has no risk section at all", () => {
  const plain: Graph = {
    version: 2,
    nodes: [
      {
        id: "aws_s3_bucket.data",
        name: "data",
        type: "aws_s3_bucket",
        provider: "aws",
        module_path: [],
        change: "create",
      },
    ],
    edges: [],
  };

  const input = build(plain);
  assert.doesNotMatch(input, /Security flags/);
  assert.doesNotMatch(input, /Blast radius/);
  assert.match(input, /- Data: 1 created/);
});

test("human context is included and labelled as the team's own words", () => {
  const input = build(RICH_PLAN, {
    projectName: "Payments",
    projectContextMd: "Card processing. PCI scope — changes need a second pair of eyes.",
    repoContextMd: "`aws_instance.worker` runs settlement. It must not go down.",
  });

  assert.match(input, /## Project context \(Payments\)/);
  assert.match(input, /PCI scope/);
  assert.match(input, /## Repository context/);
  assert.match(input, /runs settlement/);
});

test("empty context contributes no section", () => {
  const input = build(RICH_PLAN, {
    projectName: "Payments",
    projectContextMd: "   ",
    repoContextMd: null,
  });
  assert.doesNotMatch(input, /Project context/);
  assert.doesNotMatch(input, /Repository context/);
});
