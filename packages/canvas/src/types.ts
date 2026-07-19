/**
 * The graph, annotation and tour types the canvas renders (GP-146). These are
 * the single frontend definition — the web app's `api/types.ts` re-exports
 * them, so a snapshot fetched from the API and a snapshot handed to a VS Code
 * webview are the same shape by construction.
 */

export type ChangeKind = "create" | "update" | "delete" | "noop";
/** v5: `logical` is a human-drawn relationship the code cannot express (GP-72). */
export type EdgeKind = "depends_on" | "contains" | "logical";

/** v3: one masked before/after attribute change on a node (GP-32). */
export interface AttributeDiffRow {
  key: string;
  /** null for a create (attribute added); "(sensitive)" when masked. */
  before: string | null;
  /** null for a delete; "(sensitive)" / "(known after apply)" as applicable. */
  after: string | null;
}

/** v4: one NSG security rule; raw values, only `ports` normalized (GP-43). */
export interface NsgRule {
  name: string;
  priority: number;
  direction: string;
  access: string;
  protocol: string;
  ports: string;
  source: string;
  destination: string;
}

/**
 * v4: role-assignment payload on an azurerm_role_assignment node (GP-47).
 * `principal`/`scope` are resolved node addresses when they reference a
 * resource in the snapshot, otherwise the raw Azure id / object id.
 */
export interface RoleAssignment {
  role: string;
  principal: string;
  scope: string;
  principal_type?: string;
}

/** v4: managed-identity payload — UAI nodes & resources with identity{} (GP-47). */
export interface Identity {
  type: string;
  identity_ids?: string[];
}

/**
 * v8: where a docs-flow node was defined, and the Terraform that defines it
 * (GP-120). Verbatim repository source — absent on plan-flow and Kubernetes
 * snapshots, and stripped from public share links.
 */
export interface NodeSource {
  /** Repository-relative path, e.g. `modules/network/main.tf`. */
  file: string;
  /** 1-based line of the block's opening keyword. */
  start_line: number;
  /** 1-based line of the block's closing brace. */
  end_line: number;
  /** The block's text, exactly as it appears over `[start_line, end_line]`. */
  code: string;
}

export interface GraphNode {
  id: string;
  name: string;
  type: string;
  provider: string | null;
  module_path: string[];
  change: ChangeKind | null;
  /** v2: unchanged node that (transitively) depends on a changed one (GP-22). */
  impacted?: boolean;
  /** v2: hop distance to the nearest changed node (1 = direct dependent). */
  impact_distance?: number;
  /** v3: masked per-attribute before/after diff for a changed node (GP-32). */
  attribute_diff?: AttributeDiffRow[];
  /** v3: true when the changed-attribute list exceeded 20 and was capped. */
  attribute_diff_truncated?: boolean;
  /** v4: id of the containing node (vnet⊃subnet⊃resource); network only (GP-42). */
  parent_id?: string;
  /** v4: security rules on an azurerm_network_security_group node (GP-43). */
  rules?: NsgRule[];
  /** v4: true iff this NSG has an inbound Allow rule from an internet source. */
  internet_exposed?: boolean;
  /** v4: node ids of the subnets/NICs this NSG is associated with (GP-43/45). */
  associated_ids?: string[];
  /** v4: role-assignment payload on an azurerm_role_assignment node (GP-47). */
  role_assignment?: RoleAssignment;
  /** v4: true iff this role assignment is a broad-scope high-privilege grant (GP-47). */
  privileged?: boolean;
  /** v4: managed-identity payload — UAI nodes & resources with identity{} (GP-47). */
  identity?: Identity;
  /** v5: the human-given name (a `rename` annotation); `name` is kept beside it. */
  display_label?: string;
  /** v5: markdown bodies of the notes anchored to this node (GP-72). */
  notes?: string[];
  /** v5: this container came from a `group` annotation, not from Terraform. */
  annotation_group?: boolean;
  /** v5: resources behind a group collapsed to a single node (C4, GP-77). */
  member_count?: number;
  /**
   * v6: the resource's own labels, as the cluster reported them (GP-96).
   * Kubernetes says what a thing *is* in its labels — so the detail panel shows
   * them. Metadata only: a Secret's data never reaches a node.
   */
  labels?: Record<string, string>;
  /**
   * v7: a Kubernetes object's own content, flattened to `path → value` — e.g.
   * `spec.template.spec.containers[0].image` (GP-102). It is what lets one
   * manifest graph be diffed against another when there is no plan to ask
   * (GP-103); a Secret's values are masked in it, as they are everywhere else.
   */
  attributes?: Record<string, string>;
  /** v7: true when the attribute list was capped. */
  attributes_truncated?: boolean;
  /** v8: the Terraform block this node was parsed from — docs flow only (GP-120). */
  source?: NodeSource;
}

export interface GraphEdge {
  from: string;
  to: string;
  kind: EdgeKind;
  /** depends_on only: true when inferred from an expression reference (GP-20). */
  inferred?: boolean;
  /** v5: a logical edge's label (GP-72). */
  label?: string;
  /** v5: how many edges this one stands for after C4 aggregation (GP-77). */
  count?: number;
}

export interface Graph {
  /**
   * 6 adds node labels — a Kubernetes namespace read (GP-96); 7 adds node
   * attributes (GP-102); 8 adds the node's own HCL source (GP-120). All additive.
   */
  version: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

// --- Annotations (GP-56..GP-59, five types as of GP-71) ---------------------

export type AnnotationType = "note" | "link" | "group" | "hide" | "rename";
/** `resolved` is "accepted and live"; `proposed` awaits a human (GP-75/GP-76). */
export type AnnotationStatus = "resolved" | "orphaned" | "proposed";
export type AnnotationProvenance = "human" | "ai";

/**
 * A human annotation, anchored to Terraform addresses (graph node ids):
 *   `note`   1 anchor + markdown `body`
 *   `link`   exactly 2 anchors + optional `label` — the logical edge. An anchor
 *            may be a *group's id* instead of an address, which is how a
 *            group→group edge is expressed.
 *   `group`  1+ anchors + `label`; nests one level via `parentGroupId`
 *   `hide`   1 anchor — the node is dropped from the adapted view (GP-74)
 *   `rename` 1 anchor + `label` — the node's display label in the adapted view
 *
 * `status` is owned by reconciliation (GP-57): when an anchor's address vanishes
 * from the latest snapshot the annotation is `orphaned` and `missingAnchors`
 * records what was lost (surfaced in GP-59).
 */
export interface Annotation {
  id: string;
  repositoryId: string;
  type: AnnotationType;
  anchors: string[];
  label: string | null;
  body: string | null;
  status: AnnotationStatus;
  /** Where it came from. Permanent — an accepted AI proposal still says `ai`. */
  provenance: AnnotationProvenance;
  /**
   * Why the proposer suggested this (GP-75), in one sentence; null for human
   * annotations. A suggestion you must judge without knowing why it was made is
   * one you will rubber-stamp.
   */
  reason: string | null;
  createdFromSha: string | null;
  parentGroupId: string | null;
  missingAnchors: string[];
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateAnnotationInput {
  type: AnnotationType;
  anchors: string[];
  label?: string;
  body?: string;
  parentGroupId?: string;
  createdFromSha?: string;
}

export interface UpdateAnnotationInput {
  anchors?: string[];
  label?: string;
  body?: string;
  /** Accepting a proposal (GP-76). The only way one goes live. */
  status?: "resolved";
  parentGroupId?: string | null;
}

// --- Guided tours (GP-78 / GP-79) -------------------------------------------

/** One stop: the nodes the camera frames, and what the narrator says about them. */
export interface TourStep {
  /** Node ids. **Empty means the whole diagram** — the opening and closing stops. */
  anchors: string[];
  title: string;
  /** Markdown (prose + inline code). Untrusted model output — render, never trust. */
  body: string;
}

/** How a guided tour is presented (GP-79). The provider lives in the app. */
export type TourStyle = "spotlight" | "guide";
