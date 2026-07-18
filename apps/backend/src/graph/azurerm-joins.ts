/**
 * The azurerm join-resource catalog: association/attachment resources whose whole
 * purpose is to bind two other resources (see docs/azurerm-connection-catalog.md,
 * derived from the full provider schema). Both producers classify every join
 * resource through this one table, replacing per-type substring special-cases.
 *
 * Three semantics, matching how the renderer says a relationship:
 *  - `attach`: the satellite is an attachment *to* its anchor — it lands in the
 *    satellite's `associated_ids` (a subnet-anchored attachment renders as a
 *    header chip, GP-89). A non-subnet anchor also gets a direct edge, because
 *    there is no chip anchor for it to ride on and the association node itself is
 *    dropped from the network view.
 *  - `contain`: the satellite nests under its anchor (`parent_id` — subnet
 *    containment or a host stack, GP-42/86/87). Never guessed: an ambiguous
 *    anchor (a NAT gateway bound to two subnets) degrades to plain edges.
 *  - `edge`: the join *is* the relationship (a peering, a vnet link) — collapse
 *    it to one direct edge between the endpoints.
 *
 * Unknown `*_association` types degrade gracefully: exactly two resolved
 * references collapse to an `edge`, anything else is left to the generic
 * dependency edges. So a provider upgrade never draws worse than today.
 */
import {
  resolveReference,
  type DependencySource,
  type EdgeContext,
} from "./dependency-edges.js";
import type { GraphEdge } from "./graph.js";

export type JoinSemantic = "attach" | "contain" | "edge";

export type JoinRule = {
  /** Node types of the satellite (the attached / stacked / linked thing). */
  satellite: readonly string[];
  /** Node types of the anchor it binds to. Empty = any resolved resource. */
  anchor: readonly string[];
  semantic: JoinSemantic;
};

const VM_TYPES = [
  "azurerm_linux_virtual_machine",
  "azurerm_windows_virtual_machine",
  "azurerm_virtual_machine",
];

export const AZURERM_JOINS: ReadonlyMap<string, JoinRule> = new Map<
  string,
  JoinRule
>([
  // --- subnet attachments (chips) -----------------------------------------
  [
    "azurerm_subnet_network_security_group_association",
    {
      satellite: ["azurerm_network_security_group"],
      anchor: ["azurerm_subnet"],
      semantic: "attach",
    },
  ],
  [
    "azurerm_subnet_route_table_association",
    {
      satellite: ["azurerm_route_table"],
      anchor: ["azurerm_subnet"],
      semantic: "attach",
    },
  ],
  // --- subnet containment (the resource serves this subnet) ----------------
  [
    "azurerm_subnet_nat_gateway_association",
    {
      satellite: ["azurerm_nat_gateway"],
      anchor: ["azurerm_subnet"],
      semantic: "contain",
    },
  ],
  [
    "azurerm_application_load_balancer_subnet_association",
    {
      satellite: ["azurerm_application_load_balancer"],
      anchor: ["azurerm_subnet"],
      semantic: "contain",
    },
  ],
  // --- NIC attachments ------------------------------------------------------
  [
    "azurerm_network_interface_security_group_association",
    {
      satellite: ["azurerm_network_security_group"],
      anchor: ["azurerm_network_interface"],
      semantic: "attach",
    },
  ],
  [
    "azurerm_network_interface_application_security_group_association",
    {
      satellite: ["azurerm_application_security_group"],
      anchor: ["azurerm_network_interface"],
      semantic: "attach",
    },
  ],
  [
    "azurerm_network_interface_backend_address_pool_association",
    {
      satellite: ["azurerm_network_interface"],
      anchor: ["azurerm_lb_backend_address_pool"],
      semantic: "edge",
    },
  ],
  [
    // The pool here is an *inline* block of the application gateway, so the
    // reference resolves to the gateway node itself.
    "azurerm_network_interface_application_gateway_backend_address_pool_association",
    {
      satellite: ["azurerm_network_interface"],
      anchor: ["azurerm_application_gateway"],
      semantic: "edge",
    },
  ],
  [
    "azurerm_network_interface_nat_rule_association",
    {
      satellite: ["azurerm_network_interface"],
      anchor: ["azurerm_lb_nat_rule"],
      semantic: "edge",
    },
  ],
  // --- host stacking --------------------------------------------------------
  [
    "azurerm_nat_gateway_public_ip_association",
    {
      satellite: ["azurerm_public_ip"],
      anchor: ["azurerm_nat_gateway"],
      semantic: "contain",
    },
  ],
  [
    "azurerm_nat_gateway_public_ip_prefix_association",
    {
      satellite: ["azurerm_public_ip_prefix"],
      anchor: ["azurerm_nat_gateway"],
      semantic: "contain",
    },
  ],
  [
    "azurerm_virtual_machine_data_disk_attachment",
    {
      satellite: ["azurerm_managed_disk"],
      anchor: VM_TYPES,
      semantic: "contain",
    },
  ],
  [
    "azurerm_private_endpoint_application_security_group_association",
    {
      satellite: ["azurerm_application_security_group"],
      anchor: ["azurerm_private_endpoint"],
      semantic: "attach",
    },
  ],
  [
    "azurerm_virtual_machine_gallery_application_assignment",
    {
      satellite: ["azurerm_gallery_application_version"],
      anchor: VM_TYPES,
      semantic: "contain",
    },
  ],
  // --- network edges (the join is the relationship) ------------------------
  [
    "azurerm_virtual_network_peering",
    {
      satellite: ["azurerm_virtual_network"],
      anchor: ["azurerm_virtual_network"],
      semantic: "edge",
    },
  ],
  [
    "azurerm_databricks_virtual_network_peering",
    {
      satellite: ["azurerm_databricks_workspace"],
      anchor: ["azurerm_virtual_network"],
      semantic: "edge",
    },
  ],
  [
    "azurerm_virtual_hub_connection",
    {
      satellite: ["azurerm_virtual_hub"],
      anchor: ["azurerm_virtual_network"],
      semantic: "edge",
    },
  ],
  [
    "azurerm_virtual_network_gateway_connection",
    {
      satellite: ["azurerm_virtual_network_gateway"],
      anchor: [
        "azurerm_local_network_gateway",
        "azurerm_express_route_circuit",
        "azurerm_virtual_network_gateway",
      ],
      semantic: "edge",
    },
  ],
  [
    "azurerm_vpn_gateway_connection",
    {
      satellite: ["azurerm_vpn_gateway"],
      anchor: ["azurerm_vpn_site"],
      semantic: "edge",
    },
  ],
  [
    "azurerm_express_route_connection",
    {
      satellite: ["azurerm_express_route_gateway"],
      anchor: ["azurerm_express_route_circuit_peering"],
      semantic: "edge",
    },
  ],
  [
    "azurerm_express_route_circuit_connection",
    {
      satellite: ["azurerm_express_route_circuit_peering"],
      anchor: ["azurerm_express_route_circuit_peering"],
      semantic: "edge",
    },
  ],
  [
    "azurerm_private_dns_zone_virtual_network_link",
    {
      satellite: ["azurerm_private_dns_zone"],
      anchor: ["azurerm_virtual_network"],
      semantic: "edge",
    },
  ],
  [
    "azurerm_private_dns_resolver_virtual_network_link",
    {
      satellite: ["azurerm_private_dns_resolver_dns_forwarding_ruleset"],
      anchor: ["azurerm_virtual_network"],
      semantic: "edge",
    },
  ],
  [
    "azurerm_app_service_virtual_network_swift_connection",
    {
      satellite: [], // app_service_id may point at any of the app types
      anchor: ["azurerm_subnet"],
      semantic: "edge",
    },
  ],
  [
    "azurerm_app_service_slot_virtual_network_swift_connection",
    {
      satellite: [],
      anchor: ["azurerm_subnet"],
      semantic: "edge",
    },
  ],
]);

/**
 * The `edge`-semantic join types: the network view drops these nodes and draws
 * the direct edge instead. Mirrored by the frontend's network plumbing filter
 * (`lib/graph-layout`).
 */
export const NETWORK_EDGE_JOIN_TYPES: ReadonlySet<string> = new Set(
  [...AZURERM_JOINS.entries()]
    .filter(([, rule]) => rule.semantic === "edge")
    .map(([type]) => type),
);

/** One resolved binding: the satellite and the anchor a join resource states. */
export type JoinLink = {
  semantic: JoinSemantic;
  satelliteId: string;
  anchorId: string;
};

/** Resource type of an index-free address (`module.m.azurerm_x.y` → `azurerm_x`). */
function typeOfBase(fromBase: string): string {
  return fromBase.split(".").at(-2) ?? "";
}

const compareStrings = (a: string, b: string): number => {
  if (a < b) return -1;
  return a > b ? 1 : 0;
};

const compareLinks = (a: JoinLink, b: JoinLink): number =>
  compareStrings(a.satelliteId, b.satelliteId) ||
  compareStrings(a.anchorId, b.anchorId);

/**
 * Classify every join resource in `sources` into the links it states. A source
 * whose type is in the table matches its resolved references against the rule's
 * satellite/anchor types (empty satellite = any resolved resource that is not an
 * anchor). An unknown `*_association` resolving to exactly two distinct nodes
 * degrades to an `edge` between them; anything else yields nothing.
 */
export function classifyJoins(
  sources: readonly DependencySource[],
  ctx: EdgeContext,
  typeById: ReadonlyMap<string, string>,
): JoinLink[] {
  const links: JoinLink[] = [];
  const seen = new Set<string>();
  const push = (link: JoinLink): void => {
    if (link.satelliteId === link.anchorId) return;
    // An edge is undirected: a hub-and-spoke pair declared from both sides (two
    // peering resources) is still one relationship.
    const key =
      link.semantic === "edge"
        ? `edge|${[link.satelliteId, link.anchorId].sort(compareStrings).join("|")}`
        : `${link.semantic}|${link.satelliteId}|${link.anchorId}`;
    if (seen.has(key)) return;
    seen.add(key);
    links.push(link);
  };

  for (const src of sources) {
    const type = typeOfBase(src.fromBase);
    const rule = AZURERM_JOINS.get(type);
    // Resolved, deduped reference targets that exist as resource nodes — the
    // join's own instances excluded (an association's `virtual_network_name`
    // style ref can resolve back to itself).
    const resolved = [
      ...new Set(
        src.refs.flatMap(({ ref }) => resolveReference(src.prefix, ref, ctx)),
      ),
    ]
      .filter((id) => !id.startsWith(src.fromBase) && typeById.has(id))
      .sort(compareStrings);

    if (!rule) {
      if (!type.endsWith("_association")) continue;
      if (resolved.length === 2) {
        push({
          semantic: "edge",
          satelliteId: resolved[0] as string,
          anchorId: resolved[1] as string,
        });
      }
      continue;
    }

    const anchors = resolved.filter((id) =>
      rule.anchor.includes(typeById.get(id) ?? ""),
    );
    const satellites = resolved.filter((id) => {
      const t = typeById.get(id) ?? "";
      if (rule.satellite.length > 0) return rule.satellite.includes(t);
      return !rule.anchor.includes(t); // empty satellite = anything else
    });
    for (const satelliteId of satellites) {
      for (const anchorId of anchors) {
        push({ semantic: rule.semantic, satelliteId, anchorId });
      }
    }
  }

  return links.sort(compareLinks);
}

const SCALE_SET_SUFFIX = "_virtual_machine_scale_set";
const INLINE_GUARD_TYPES = new Set([
  "azurerm_network_security_group",
  "azurerm_application_security_group",
]);

/**
 * The inline half of the NSG duality: a scale set declares its NSG/ASG *inside*
 * `network_interface {}` instead of through an association resource
 * (`docs/azurerm-connection-catalog.md` §3). Both spellings must yield the same
 * attachment, so a guard referenced inline by a scale set links exactly as an
 * association resource would have said it. `refs` are the scale set's own raw
 * references; anything not resolving to a guard type is ignored.
 */
export function inlineScaleSetLinks(
  fromBase: string,
  prefix: string,
  refs: Iterable<string>,
  ctx: EdgeContext,
  typeById: ReadonlyMap<string, string>,
): JoinLink[] {
  if (!typeOfBase(fromBase).endsWith(SCALE_SET_SUFFIX)) return [];
  const anchors = ctx.instancesByBase.get(fromBase) ?? [fromBase];
  const satellites = new Set<string>();
  for (const ref of refs) {
    for (const id of resolveReference(prefix, ref, ctx)) {
      if (INLINE_GUARD_TYPES.has(typeById.get(id) ?? "")) satellites.add(id);
    }
  }
  const links: JoinLink[] = [];
  for (const satelliteId of [...satellites].sort(compareStrings)) {
    for (const anchorId of anchors) {
      links.push({ semantic: "attach", satelliteId, anchorId });
    }
  }
  return links;
}

/** What the classified links do to the graph, ready for the producers to apply. */
export type JoinEffects = {
  /** satellite id → anchor ids, for `associated_ids` (`attach` semantic). */
  attachments: Map<string, string[]>;
  /** satellite id → its single unambiguous parent (`contain` semantic). */
  parents: Map<string, string>;
  /** Direct edges: `edge` links, ambiguous containment, non-subnet attachments. */
  edges: { from: string; to: string }[];
};

/**
 * Fold links into effects. Containment never guesses: a satellite with several
 * anchors gets edges to each instead of a parent. An attachment to a non-subnet
 * anchor also emits a direct edge — the network view drops association nodes, so
 * without it the relationship would only survive where a chip can carry it.
 */
function addTo(map: Map<string, string[]>, key: string, value: string): void {
  const list = map.get(key) ?? [];
  if (!list.includes(value)) list.push(value);
  map.set(key, list);
}

/** Unique parent per satellite; an ambiguous one degrades to edges instead. */
function resolveParents(
  containAnchors: ReadonlyMap<string, string[]>,
  pushEdge: (from: string, to: string) => void,
): Map<string, string> {
  const parents = new Map<string, string>();
  for (const [satelliteId, anchors] of containAnchors) {
    if (anchors.length === 1) parents.set(satelliteId, anchors[0] as string);
    else for (const anchorId of anchors) pushEdge(satelliteId, anchorId);
  }
  return parents;
}

export function joinEffects(
  links: readonly JoinLink[],
  typeById: ReadonlyMap<string, string>,
): JoinEffects {
  const attachments = new Map<string, string[]>();
  const containAnchors = new Map<string, string[]>();
  const edges: { from: string; to: string }[] = [];
  const edgeSeen = new Set<string>();
  const pushEdge = (from: string, to: string): void => {
    const key = [from, to].sort(compareStrings).join("|");
    if (edgeSeen.has(key)) return;
    edgeSeen.add(key);
    edges.push({ from, to });
  };

  for (const link of links) {
    switch (link.semantic) {
      case "attach":
        addTo(attachments, link.satelliteId, link.anchorId);
        if (typeById.get(link.anchorId) !== "azurerm_subnet") {
          pushEdge(link.satelliteId, link.anchorId);
        }
        break;
      case "contain":
        addTo(containAnchors, link.satelliteId, link.anchorId);
        break;
      default:
        pushEdge(link.satelliteId, link.anchorId);
    }
  }

  const parents = resolveParents(containAnchors, pushEdge);
  for (const list of attachments.values()) list.sort(compareStrings);
  edges.sort((a, b) => compareStrings(a.from, b.from) || compareStrings(a.to, b.to));
  return { attachments, parents, edges };
}

/**
 * The `depends_on` edges the joins add to a producer's edge list: every stated
 * direct edge whose pair is not already drawn by a reference, in either
 * direction (an inline VMSS→NSG reference already says what the attach edge
 * would). Marked inferred — they were derived, not declared.
 */
export function joinEdgeAdditions(
  joins: JoinEffects,
  existing: readonly GraphEdge[],
): GraphEdge[] {
  const pairKey = (a: string, b: string): string =>
    [a, b].sort(compareStrings).join("|");
  const seen = new Set(
    existing
      .filter((e) => e.kind === "depends_on")
      .map((e) => pairKey(e.from, e.to)),
  );
  return joins.edges
    .filter((e) => !seen.has(pairKey(e.from, e.to)))
    .map((e) => ({ from: e.from, to: e.to, kind: "depends_on", inferred: true }));
}
