import { test } from "node:test";
import assert from "node:assert/strict";

import {
  UnsupportedStateError,
  isRawState,
  parseState,
  type StateGraph,
} from "./state-parser.js";

/** A v4 state as Terraform ≥ 0.12 and every OpenTofu release writes it. */
const STATE = {
  version: 4,
  terraform_version: "1.9.5",
  serial: 42,
  lineage: "9f4c0b1e-0000-4000-8000-000000000000",
  outputs: {
    db_password: { value: "hunter2-the-real-one", type: "string", sensitive: true },
    region: { value: "westeurope", type: "string" },
  },
  resources: [
    {
      mode: "managed",
      type: "azurerm_virtual_network",
      name: "main",
      provider: 'provider["registry.terraform.io/hashicorp/azurerm"]',
      instances: [
        {
          schema_version: 0,
          attributes: {
            name: "vnet-main",
            location: "westeurope",
            address_space: ["10.0.0.0/16"],
            tags: { env: "prod" },
          },
          dependencies: [],
        },
      ],
    },
    {
      module: "module.network",
      mode: "managed",
      type: "azurerm_subnet",
      name: "web",
      provider: 'provider["registry.terraform.io/hashicorp/azurerm"]',
      instances: [
        {
          schema_version: 0,
          attributes: { name: "snet-web", address_prefixes: ["10.0.1.0/24"] },
          dependencies: ["azurerm_virtual_network.main"],
        },
      ],
    },
  ],
};

function graphOf(state: unknown): StateGraph {
  return parseState(state).graph;
}

const ids = (graph: StateGraph): string[] => graph.nodes.map((n) => n.id);

// --- What the estate is -----------------------------------------------------

test("every managed resource becomes a node at its Terraform address", () => {
  assert.deepEqual(ids(graphOf(STATE)), [
    "azurerm_virtual_network.main",
    "module.network",
    "module.network.azurerm_subnet.web",
  ]);
});

test("a node carries its type, name, provider and module path", () => {
  const subnet = graphOf(STATE).nodes.find(
    (n) => n.id === "module.network.azurerm_subnet.web",
  );
  assert.equal(subnet?.type, "azurerm_subnet");
  assert.equal(subnet?.name, "web");
  assert.equal(subnet?.provider, "azurerm");
  assert.deepEqual(subnet?.module_path, ["network"]);
  assert.equal(subnet?.change, null, "the state is not a change to anything");
});

test("state dependencies become the graph's edges", () => {
  const graph = graphOf(STATE);
  assert.ok(
    graph.edges.some(
      (e) =>
        e.kind === "depends_on" &&
        e.from === "module.network.azurerm_subnet.web" &&
        e.to === "azurerm_virtual_network.main",
    ),
  );
});

test("a module gets a container node and contains its resources", () => {
  const graph = graphOf(STATE);
  assert.ok(
    graph.edges.some(
      (e) =>
        e.kind === "contains" &&
        e.from === "module.network" &&
        e.to === "module.network.azurerm_subnet.web",
    ),
  );
});

test("data sources are not part of the estate — they are reads of somebody else's", () => {
  const graph = graphOf({
    ...STATE,
    resources: [
      {
        mode: "data",
        type: "azurerm_client_config",
        name: "current",
        provider: 'provider["registry.terraform.io/hashicorp/azurerm"]',
        instances: [{ attributes: { tenant_id: "t" } }],
      },
    ],
  });
  assert.deepEqual(ids(graph), []);
});

// --- The version matrix -----------------------------------------------------

test("count instances become one node each, indexed", () => {
  const graph = graphOf({
    ...STATE,
    resources: [
      {
        mode: "managed",
        type: "aws_instance",
        name: "web",
        provider: 'provider["registry.terraform.io/hashicorp/aws"]',
        instances: [
          { index_key: 0, attributes: { ami: "ami-1" } },
          { index_key: 1, attributes: { ami: "ami-1" } },
        ],
      },
    ],
  });
  assert.deepEqual(ids(graph), ["aws_instance.web[0]", "aws_instance.web[1]"]);
});

test("for_each instances keep their quoted key, as Terraform addresses them", () => {
  const graph = graphOf({
    ...STATE,
    resources: [
      {
        mode: "managed",
        type: "aws_instance",
        name: "web",
        provider: 'provider["registry.terraform.io/hashicorp/aws"]',
        instances: [{ index_key: "blue", attributes: {} }],
      },
    ],
  });
  assert.deepEqual(ids(graph), ['aws_instance.web["blue"]']);
});

test("a dependency on a bare address reaches every instance of it", () => {
  const graph = graphOf({
    ...STATE,
    resources: [
      {
        mode: "managed",
        type: "aws_instance",
        name: "web",
        provider: 'provider["registry.terraform.io/hashicorp/aws"]',
        instances: [
          { index_key: 0, attributes: {} },
          { index_key: 1, attributes: {} },
        ],
      },
      {
        mode: "managed",
        type: "aws_lb",
        name: "front",
        provider: 'provider["registry.terraform.io/hashicorp/aws"]',
        instances: [{ attributes: {}, dependencies: ["aws_instance.web"] }],
      },
    ],
  });
  const targets = graph.edges
    .filter((e) => e.from === "aws_lb.front")
    .map((e) => e.to);
  assert.deepEqual(targets, ["aws_instance.web[0]", "aws_instance.web[1]"]);
});

test("nested modules produce the whole chain", () => {
  const graph = graphOf({
    ...STATE,
    resources: [
      {
        module: "module.app.module.db",
        mode: "managed",
        type: "aws_db_instance",
        name: "main",
        provider: 'provider["registry.terraform.io/hashicorp/aws"]',
        instances: [{ attributes: {} }],
      },
    ],
  });
  assert.deepEqual(ids(graph), [
    "module.app",
    "module.app.module.db",
    "module.app.module.db.aws_db_instance.main",
  ]);
});

test("a state with no resources is an empty estate, not an error", () => {
  const graph = graphOf({ version: 4, terraform_version: "1.9.5", resources: [] });
  assert.deepEqual(graph.nodes, []);
});

test("a state version we do not read is refused, and says why", () => {
  assert.throws(
    () => parseState({ version: 3, modules: [] }),
    (err: unknown) => {
      assert.ok(err instanceof UnsupportedStateError);
      assert.match(err.message, /version 3/);
      return true;
    },
  );
});

test("something that is not a state at all is refused", () => {
  assert.throws(() => parseState({ hello: "world" }), UnsupportedStateError);
});

test("the same state always produces the same graph, byte for byte", () => {
  assert.equal(JSON.stringify(graphOf(STATE)), JSON.stringify(graphOf(STATE)));
});

// --- Sanitisation: the whole point ------------------------------------------

test("a sensitive output never reaches the graph", () => {
  const serialized = JSON.stringify(parseState(STATE));
  assert.ok(!serialized.includes("hunter2"), "a sensitive output leaked");
});

test("outputs do not reach the graph at all — sensitive or not", () => {
  const serialized = JSON.stringify(parseState(STATE));
  assert.ok(!serialized.includes("db_password"));
});

test("an attribute Terraform marked sensitive is dropped", () => {
  const result = parseState({
    ...STATE,
    resources: [
      {
        mode: "managed",
        type: "azurerm_storage_account",
        name: "data",
        provider: 'provider["registry.terraform.io/hashicorp/azurerm"]',
        instances: [
          {
            attributes: { name: "sa", shared_key: "AAAABBBBCCCC" },
            sensitive_attributes: [
              [{ type: "get_attr", value: "shared_key" }],
            ],
          },
        ],
      },
    ],
  });
  assert.ok(!JSON.stringify(result).includes("AAAABBBBCCCC"));
  assert.equal(result.graph.nodes[0]?.attributes?.["shared_key"], undefined);
  assert.equal(result.masked, 1);
});

test("a secret-shaped attribute name is dropped even when Terraform said nothing", () => {
  const result = parseState({
    ...STATE,
    resources: [
      {
        mode: "managed",
        type: "aws_db_instance",
        name: "main",
        provider: 'provider["registry.terraform.io/hashicorp/aws"]',
        instances: [
          {
            attributes: {
              identifier: "db-main",
              password: "correct-horse",
              master_user_secret: "arn:x",
              connection_string: "postgres://u:p@h/db",
              ca_cert_identifier: "rds-ca-2019",
            },
          },
        ],
      },
    ],
  });
  const attrs = result.graph.nodes[0]?.attributes ?? {};
  assert.equal(attrs["identifier"], "db-main");
  assert.equal(attrs["password"], undefined);
  assert.equal(attrs["master_user_secret"], undefined);
  assert.equal(attrs["connection_string"], undefined);
  assert.ok(!JSON.stringify(result).includes("correct-horse"));
});

test("nested structures never travel — only scalars do", () => {
  const attrs =
    parseState(STATE).graph.nodes.find(
      (n) => n.id === "azurerm_virtual_network.main",
    )?.attributes ?? {};
  assert.equal(attrs["location"], "westeurope");
  assert.equal(attrs["name"], "vnet-main");
  // `tags` is an object and `address_space` a list: both collapse rather than
  // being dumped, exactly as the plan differ collapses them.
  assert.equal(attrs["tags"], undefined);
  assert.equal(attrs["address_space"], undefined);
});

test("a nested secret cannot escape inside a collapsed object", () => {
  const result = parseState({
    ...STATE,
    resources: [
      {
        mode: "managed",
        type: "aws_lambda_function",
        name: "fn",
        provider: 'provider["registry.terraform.io/hashicorp/aws"]',
        instances: [
          {
            attributes: {
              function_name: "fn",
              environment: { variables: { API_KEY: "sk-live-abcdef" } },
            },
          },
        ],
      },
    ],
  });
  assert.ok(!JSON.stringify(result).includes("sk-live-abcdef"));
});

test("a very long scalar is truncated rather than shipped whole", () => {
  const result = parseState({
    ...STATE,
    resources: [
      {
        mode: "managed",
        type: "aws_iam_policy",
        name: "p",
        provider: 'provider["registry.terraform.io/hashicorp/aws"]',
        instances: [{ attributes: { description: "x".repeat(5000) } }],
      },
    ],
  });
  const value = result.graph.nodes[0]?.attributes?.["description"] ?? "";
  assert.ok(value.length < 300, `expected a truncated value, got ${value.length}`);
});

test("the report counts what was sent and what was withheld", () => {
  const result = parseState(STATE);
  assert.equal(result.resources, 2);
  assert.equal(result.modules, 1);
  assert.ok(result.attributes > 0);
});

// --- The server-side refusal ------------------------------------------------

test("a raw state is recognisable, so the API can refuse one", () => {
  assert.equal(isRawState(STATE), true);
  assert.equal(isRawState({ version: 4, resources: [], lineage: "x" }), true);
});

test("a graph snapshot is not mistaken for a state", () => {
  assert.equal(isRawState(parseState(STATE).graph), false);
  assert.equal(isRawState({ version: 7, nodes: [], edges: [] }), false);
});
