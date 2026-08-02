/**
 * BuilderGraph validation (GP-132): every problem, machine-readable, at once.
 *
 * Nothing throws and nothing is thrown away — the canvas badges what it gets,
 * the endpoint turns the same list into a 422 naming every offending node. A
 * validator that stopped at the first issue would make the user generate,
 * read, fix, generate again, once per mistake.
 */
import type { BuilderGraph, BuilderNode, BuilderValue } from "./builder-graph.js";
import { addressOf } from "./builder-graph.js";
import {
  attributeKey,
  CATALOG,
  defFor,
  referenceSlot,
  type AttributeDef,
  type ResourceDef,
} from "./catalog.js";

export type BuilderIssueReason =
  | "unknown_type"
  | "invalid_type"
  | "invalid_name"
  | "duplicate_name"
  | "missing_required"
  | "invalid_value"
  | "unknown_attribute"
  | "unknown_slot"
  | "wrong_target_type"
  | "dangling_reference"
  | "duplicate_reference";

export type BuilderIssue = {
  /** The node the problem belongs to — the badge's anchor. */
  nodeId: string;
  /**
   * The catalog attribute or slot at fault, when the problem has one.
   * Deliberately absent on `invalid_name` and `duplicate_name`: those are
   * about the resource's *Terraform* name, which is not a catalog attribute —
   * and most types do have an attribute called `name`, so reusing the key
   * would make a form show one field's problem under another's (see
   * {@link isNameIssue}).
   */
  attribute?: string;
  reason: BuilderIssueReason;
  /** One sentence, in the language of the person composing. */
  message: string;
};

/** Terraform's rule for a block label: a letter or underscore, then word characters or dashes. */
const TERRAFORM_NAME = /^[A-Za-z_][A-Za-z0-9_-]*$/;

/** A provider resource type: `azurerm_subnet`, `random_password`, `null_resource`. */
const TERRAFORM_TYPE = /^[a-z][a-z0-9]*(_[a-z0-9]+)+$/;

/** Does a value fit the kind its attribute declares? */
function fitsKind(def: AttributeDef, value: BuilderValue): boolean {
  switch (def.kind) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "bool":
      return typeof value === "boolean";
    case "enum":
      return typeof value === "string" && (def.values ?? []).includes(value);
    case "list":
      return Array.isArray(value) && value.every((v) => typeof v === "string");
    default:
      return false;
  }
}

/** An empty string, an empty list — present in the record, but not filled in. */
export function isBlank(value: BuilderValue | undefined): boolean {
  if (value === undefined) return true;
  if (typeof value === "string") return value.trim() === "";
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

/** The value of an attribute, falling back to the catalog's default. */
export function attributeValue(
  def: AttributeDef,
  node: BuilderNode,
): BuilderValue | undefined {
  const own = node.attributes[attributeKey(def)];
  if (!isBlank(own)) return own;
  const fallback = def.default;
  if (fallback === undefined) return undefined;
  return typeof fallback === "object" ? [...fallback] : fallback;
}

/** The Terraform block label: legal, and unique among its own type. */
function validateName(
  node: BuilderNode,
  label: string,
  nameOwners: Map<string, string[]>,
  issues: BuilderIssue[],
): void {
  if (!TERRAFORM_NAME.test(node.name)) {
    issues.push({
      nodeId: node.id,
      reason: "invalid_name",
      message:
        node.name.trim() === ""
          ? "this resource needs a Terraform name"
          : `"${node.name}" is not a valid Terraform name (letters, digits, _ and -, starting with a letter or _)`,
    });
    return;
  }
  if ((nameOwners.get(addressOf(node)) ?? []).length > 1) {
    issues.push({
      nodeId: node.id,
      reason: "duplicate_name",
      message: `another ${label} is already called "${node.name}"`,
    });
  }
}

/** One attribute: filled in when required, and of the kind it declares. */
function validateAttribute(
  attribute: AttributeDef,
  node: BuilderNode,
  issues: BuilderIssue[],
): void {
  const value = attributeValue(attribute, node);
  if (value === undefined || isBlank(value)) {
    if (attribute.required) {
      issues.push({
        nodeId: node.id,
        attribute: attributeKey(attribute),
        reason: "missing_required",
        message: `${attribute.label} is required`,
      });
    }
    return;
  }
  if (!fitsKind(attribute, value)) {
    issues.push({
      nodeId: node.id,
      attribute: attributeKey(attribute),
      reason: "invalid_value",
      message:
        attribute.kind === "enum"
          ? `${attribute.label} must be one of ${(attribute.values ?? []).join(", ")}`
          : `${attribute.label} must be a ${attribute.kind}`,
    });
  }
}

/** Check one node's own fields — name, then every attribute of its type. */
function validateNode(
  node: BuilderNode,
  def: ResourceDef,
  nameOwners: Map<string, string[]>,
  issues: BuilderIssue[],
): void {
  validateName(node, def.label, nameOwners, issues);

  const known = new Set(def.attributes.map(attributeKey));
  for (const name of Object.keys(node.attributes)) {
    if (!known.has(name)) {
      issues.push({
        nodeId: node.id,
        attribute: name,
        reason: "unknown_attribute",
        message: `${def.label} has no attribute "${name}"`,
      });
    }
  }

  for (const attribute of def.attributes) {
    validateAttribute(attribute, node, issues);
  }
}

/**
 * A custom node's reference: the user named both ends of it, so both are
 * checked as syntax — an attribute to write it into, an attribute of the target
 * to read, and a target that is actually on the canvas.
 */
function validateCustomReference(
  reference: BuilderGraph["references"][number],
  from: BuilderNode,
  byId: Map<string, BuilderNode>,
  issues: BuilderIssue[],
): void {
  if (!TERRAFORM_NAME.test(reference.attribute)) {
    issues.push({
      nodeId: from.id,
      attribute: reference.attribute,
      reason: "invalid_value",
      message: "a reference needs the attribute name to write it into",
    });
    return;
  }
  if (!byId.has(reference.to)) {
    issues.push({
      nodeId: from.id,
      attribute: reference.attribute,
      reason: "dangling_reference",
      message: `${reference.attribute} points at a resource that is not on the canvas`,
    });
    return;
  }
  if (!TERRAFORM_NAME.test(reference.targetAttribute ?? "")) {
    issues.push({
      nodeId: from.id,
      attribute: reference.attribute,
      reason: "invalid_value",
      message: `${reference.attribute} needs the target's attribute to read, e.g. id`,
    });
  }
}

/** Slot occupancy, keyed by the node and the slot it belongs to. */
const slotKey = (nodeId: string, attribute: string) => `${nodeId} ${attribute}`;

/**
 * One reference: it starts somewhere real, names a slot its source has, lands
 * on a type the slot accepts, and does not crowd a single-valued slot. What it
 * filled is recorded in `filled`, so a required slot nobody connected can be
 * reported afterwards.
 */
function validateReference(
  reference: BuilderGraph["references"][number],
  byId: Map<string, BuilderNode>,
  catalog: readonly ResourceDef[],
  filled: Map<string, number>,
  issues: BuilderIssue[],
): void {
  const from = byId.get(reference.from);
  if (!from) {
    issues.push({
      nodeId: reference.from,
      attribute: reference.attribute,
      reason: "dangling_reference",
      message: "this reference starts at a resource that is not on the canvas",
    });
    return;
  }
  if (from.custom) {
    validateCustomReference(reference, from, byId, issues);
    return;
  }
  const def = defFor(from, catalog);
  if (!def) return; // already reported as unknown_type
  const slot = referenceSlot(def, reference.attribute);
  if (!slot) {
    issues.push({
      nodeId: from.id,
      attribute: reference.attribute,
      reason: "unknown_slot",
      message: `${def.label} has no "${reference.attribute}" connection`,
    });
    return;
  }
  // The slot counts as used the moment somebody connected something to it,
  // right or wrong: a bad connection deserves one precise complaint, not that
  // one *and* "must be connected" for the very slot the user just filled.
  const key = slotKey(from.id, slot.attribute);
  const count = (filled.get(key) ?? 0) + 1;
  filled.set(key, count);

  const to = byId.get(reference.to);
  if (!to) {
    issues.push({
      nodeId: from.id,
      attribute: reference.attribute,
      reason: "dangling_reference",
      message: `${slot.label} points at a resource that is not on the canvas`,
    });
    return;
  }
  if (!slot.targetTypes.includes(to.type)) {
    issues.push({
      nodeId: from.id,
      attribute: reference.attribute,
      reason: "wrong_target_type",
      message: `${slot.label} cannot point at a ${to.type}`,
    });
    return;
  }
  if (count > 1 && !slot.list) {
    issues.push({
      nodeId: from.id,
      attribute: reference.attribute,
      reason: "duplicate_reference",
      message: `${slot.label} takes a single connection`,
    });
  }
}

/**
 * Every issue in the graph, in a stable order: node problems in node order,
 * then reference problems in reference order, then the connections a node
 * still owes.
 */
export function validateBuilderGraph(
  graph: BuilderGraph,
  catalog: readonly ResourceDef[] = CATALOG,
): BuilderIssue[] {
  const issues: BuilderIssue[] = [];
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));

  // Terraform addresses are only unique per (type, name) — two subnets may not
  // share a name, a subnet and a vnet may.
  const nameOwners = new Map<string, string[]>();
  for (const node of graph.nodes) {
    const address = addressOf(node);
    nameOwners.set(address, [...(nameOwners.get(address) ?? []), node.id]);
  }

  for (const node of graph.nodes) {
    if (node.custom) {
      validateCustomNode(node, nameOwners, issues);
      continue;
    }
    const def = defFor(node, catalog);
    if (!def) {
      issues.push({
        nodeId: node.id,
        reason: "unknown_type",
        message:
          node.mode === "data"
            ? `"${node.type}" is not a data source the builder can read`
            : `"${node.type}" is not a resource type the builder knows`,
      });
      continue;
    }
    validateNode(node, def, nameOwners, issues);
  }

  // Which slots ended up filled, so required-but-unconnected is reported on
  // the node rather than becoming a silent omission in the generated file.
  const filled = new Map<string, number>();
  for (const reference of graph.references) {
    validateReference(reference, byId, catalog, filled, issues);
  }

  for (const node of graph.nodes) {
    if (node.custom) continue;
    const def = defFor(node, catalog);
    if (!def) continue;
    for (const slot of def.references) {
      if (slot.required && !filled.has(slotKey(node.id, slot.attribute))) {
        issues.push({
          nodeId: node.id,
          attribute: slot.attribute,
          reason: "missing_required",
          message: `${slot.label} must be connected`,
        });
      }
    }
  }

  return issues;
}

/** Is this issue about the resource's Terraform name, rather than a field? */
export function isNameIssue(issue: BuilderIssue): boolean {
  return issue.reason === "invalid_name" || issue.reason === "duplicate_name";
}

/** Is this issue about a custom resource's typed-in Terraform type? */
export function isTypeIssue(issue: BuilderIssue): boolean {
  return issue.reason === "invalid_type";
}

/**
 * A custom node (GP-133 follow-up): the catalog knows nothing about it, so the
 * checks are the ones that hold for any resource — a syntactically valid type,
 * a legal name, and attribute values that are actually values. What the
 * provider requires is between the user and `terraform validate`.
 */
function validateCustomNode(
  node: BuilderNode,
  nameOwners: Map<string, string[]>,
  issues: BuilderIssue[],
): void {
  if (!TERRAFORM_TYPE.test(node.type)) {
    issues.push({
      nodeId: node.id,
      reason: "invalid_type",
      message:
        node.type.trim() === ""
          ? "this resource needs a Terraform type, e.g. azurerm_management_lock"
          : `"${node.type}" is not a Terraform resource type (lowercase words joined by _)`,
    });
  }
  validateName(node, "custom resource", nameOwners, issues);
  for (const [name, value] of Object.entries(node.attributes)) {
    if (typeof value === "object" && !Array.isArray(value)) {
      issues.push({
        nodeId: node.id,
        attribute: name,
        reason: "invalid_value",
        message: `${name} must be a value, not a structure`,
      });
    }
  }
}

/** The issues of each node, keyed by node id — what the canvas badges from. */
export function issuesByNode(
  issues: readonly BuilderIssue[],
): Map<string, BuilderIssue[]> {
  const byNode = new Map<string, BuilderIssue[]>();
  for (const issue of issues) {
    byNode.set(issue.nodeId, [...(byNode.get(issue.nodeId) ?? []), issue]);
  }
  return byNode;
}
