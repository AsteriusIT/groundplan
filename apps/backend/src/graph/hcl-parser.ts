/**
 * Producer B: statically parse a repository's Terraform (`.tf`) source into a
 * GraphSnapshot graph — no plan, no terraform binary, no AI. Used by the docs
 * flow (GP-15) to document the official branch.
 *
 * HCL parser choice: a small, dedicated block scanner (below) rather than an
 * external dependency (`@cdktf/hcl2json`, `hcl2json` binary, `python-hcl2`).
 * Rationale: the scope is deliberately narrow — top-level block headers, a
 * module's `source`, and reference-shaped tokens. A focused scanner keeps this
 * offline (no WASM/native download), deterministic, and fully unit-testable.
 *
 * Dependencies (GP-21): explicit `depends_on` PLUS references extracted from
 * attribute expressions via regex (chosen over full expression evaluation).
 * Resolution to node ids is done by the shared `dependency-edges` builder (the
 * same one Producer A uses). References that don't resolve to a parsed block are
 * dropped and counted in `stats.warnings`. References inside comments/strings
 * that don't resolve are ignored (best effort, documented limitation).
 */
import { deriveContainment } from "./containment.js";
import {
  buildDependencyEdges,
  buildInstancesByBase,
  resolveReference,
  type DependencySource,
  type EdgeContext,
  type RawRef,
} from "./dependency-edges.js";
import type {
  Graph,
  GraphEdge,
  GraphNode,
  Identity,
  NsgRule,
  RoleAssignment,
  UnresolvedReference,
} from "./graph.js";
import { attachIam, type ExtractedIam } from "./iam.js";
import { attachAssociations, attachNsg, normalizePorts, type ExtractedNsg } from "./nsg.js";

export type HclFile = { path: string; content: string };
export type HclParseResult = {
  graph: Graph;
  warnings: string[];
  /** References that pointed at no parsed block — the "could not resolve" list. */
  unresolvedReferences: UnresolvedReference[];
};

type Block = { type: string; labels: string[]; body: string };

/** Thrown when a `.tf` file can't be scanned (e.g. unbalanced braces). */
class HclSyntaxError extends Error {}

/**
 * Scan a `.tf` source into its top-level blocks. Comment-, string- and
 * heredoc-aware so braces inside those don't affect nesting. Throws
 * `HclSyntaxError` on a block that never closes.
 */
function scanTopLevelBlocks(src: string): Block[] {
  const blocks: Block[] = [];
  const n = src.length;
  let i = 0;

  const isIdent = (c: string) => /[A-Za-z0-9_.-]/.test(c);

  function skipTrivia(): void {
    while (i < n) {
      const c = src[i]!;
      if (c === " " || c === "\t" || c === "\r" || c === "\n") i++;
      else if (c === "#") while (i < n && src[i] !== "\n") i++;
      else if (c === "/" && src[i + 1] === "/") while (i < n && src[i] !== "\n") i++;
      else if (c === "/" && src[i + 1] === "*") {
        i += 2;
        while (i < n && !(src[i] === "*" && src[i + 1] === "/")) i++;
        i += 2;
      } else break;
    }
  }

  function readIdent(): string {
    const start = i;
    while (i < n && isIdent(src[i]!)) i++;
    return src.slice(start, i);
  }

  function readString(): void {
    i++; // opening quote
    while (i < n) {
      const c = src[i]!;
      if (c === "\\") i += 2;
      else if (c === '"') { i++; return; }
      else i++;
    }
  }

  function skipHeredoc(): void {
    i += 2; // '<<'
    if (src[i] === "-") i++;
    const tag = readIdent();
    while (i < n && src[i] !== "\n") i++; // rest of the opening line
    i++;
    while (i < n) {
      let j = i;
      while (j < n && (src[j] === " " || src[j] === "\t")) j++;
      if (src.startsWith(tag, j)) {
        const after = src[j + tag.length];
        if (after === undefined || after === "\n" || after === "\r") {
          i = j + tag.length;
          return;
        }
      }
      while (i < n && src[i] !== "\n") i++;
      i++;
    }
  }

  function readBody(): string {
    const start = i + 1; // past '{'
    i++;
    let depth = 1;
    while (i < n && depth > 0) {
      const c = src[i]!;
      if (c === "#") while (i < n && src[i] !== "\n") i++;
      else if (c === "/" && src[i + 1] === "/") while (i < n && src[i] !== "\n") i++;
      else if (c === "/" && src[i + 1] === "*") {
        i += 2;
        while (i < n && !(src[i] === "*" && src[i + 1] === "/")) i++;
        i += 2;
      } else if (c === '"') readString();
      else if (c === "<" && src[i + 1] === "<") skipHeredoc();
      else if (c === "{") { depth++; i++; }
      else if (c === "}") { depth--; i++; }
      else i++;
    }
    if (depth > 0) throw new HclSyntaxError("unbalanced braces");
    return src.slice(start, i - 1);
  }

  while (i < n) {
    skipTrivia();
    if (i >= n) break;
    if (!isIdent(src[i]!)) { i++; continue; }
    const type = readIdent();
    const labels: string[] = [];
    for (;;) {
      skipTrivia();
      if (i >= n) return blocks;
      const c = src[i]!;
      if (c === '"') {
        const start = i;
        readString();
        labels.push(src.slice(start + 1, i - 1));
      } else if (c === "{") {
        blocks.push({ type, labels, body: readBody() });
        break;
      } else if (isIdent(c)) {
        labels.push(readIdent());
      } else if (c === "=") {
        // A top-level attribute (unexpected in real .tf) — skip its line.
        while (i < n && src[i] !== "\n") i++;
        break;
      } else {
        i++;
      }
    }
  }
  return blocks;
}

/** First `source = "..."` value in a module block body. */
function extractSource(body: string): string | null {
  const m = /(^|\n)\s*source\s*=\s*"([^"]*)"/.exec(body);
  return m ? (m[2] as string) : null;
}

/** References inside an explicit `depends_on = [ ... ]` attribute. */
function extractDependsOn(body: string): string[] {
  const m = /depends_on\s*=\s*\[([\s\S]*?)\]/.exec(body);
  if (!m) return [];
  return (m[1] as string)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

// Dotted identifier chains (with optional [index]) — reference-shaped tokens.
const REFERENCE_RE =
  /[A-Za-z_]\w*(?:\[[^\]]*\])?(?:\.[A-Za-z_]\w*(?:\[[^\]]*\])?)+/g;

/** Every reference-shaped token in an attribute body (over-extraction is fine). */
function extractReferences(body: string): string[] {
  return [...body.matchAll(REFERENCE_RE)].map((m) => m[0]);
}

/** Read a scalar attribute (`key = "v"` or `key = 123`) from a block body. */
function readAttr(body: string, key: string): string | undefined {
  const m = new RegExp(String.raw`(?:^|\n)\s*${key}\s*=\s*(?:"([^"]*)"|(\d+))`).exec(body);
  if (!m) return undefined;
  return m[1] ?? m[2];
}

/** Inline `security_rule { … }` blocks within an NSG body → NsgRule[]. */
function scanSecurityRules(body: string): NsgRule[] {
  return scanTopLevelBlocks(body)
    .filter((b) => b.type === "security_rule")
    .map((b) => hclRule(b.body))
    .filter((r): r is NsgRule => r !== null);
}

/** Parse one `security_rule { … }` block body into an NsgRule (raw values). */
function hclRule(body: string): NsgRule | null {
  const name = readAttr(body, "name");
  if (!name) return null;
  return {
    name,
    priority: Number(readAttr(body, "priority") ?? 0),
    direction: readAttr(body, "direction") ?? "",
    access: readAttr(body, "access") ?? "",
    protocol: readAttr(body, "protocol") ?? "",
    ports: normalizePorts(readAttr(body, "destination_port_range")),
    source: readAttr(body, "source_address_prefix") ?? "*",
    destination: readAttr(body, "destination_address_prefix") ?? "*",
  };
}

/** Provider name from a resource type ("aws_s3_bucket" → "aws"). Heuristic. */
function providerFromType(type: string): string | null {
  const provider = type.split("_")[0];
  return provider || null;
}

function isLocalSource(source: string): boolean {
  return source.startsWith("./") || source.startsWith("../");
}

/** Resolve a local module source directory relative to its parent dir. */
function resolveLocalDir(baseDir: string, source: string): string {
  const joined = baseDir ? `${baseDir}/${source}` : source;
  const parts: string[] = [];
  for (const segment of joined.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") parts.pop();
    else parts.push(segment);
  }
  return parts.join("/");
}

const compareStrings = (a: string, b: string): number => {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
};

type PendingSource = { fromBase: string; prefix: string; body: string };

type Ctx = {
  filesByDir: Map<string, HclFile[]>;
  nodes: Map<string, GraphNode>;
  containsEdges: Map<string, GraphEdge>;
  warnings: string[];
  visited: Set<string>;
  pendingSources: PendingSource[];
  /** Resource types seen — used to tell a real (droppable) ref from noise. */
  resourceTypes: Set<string>;
  /** NSG node id → its inline security rules (GP-43). */
  nsgRules: Map<string, NsgRule[]>;
};

function addContains(ctx: Ctx, parent: string | null, child: string): void {
  if (!parent) return;
  ctx.containsEdges.set(`contains ${parent} ${child}`, {
    from: parent,
    to: child,
    kind: "contains",
  });
}

function parseModuleDir(
  ctx: Ctx,
  dir: string,
  prefix: string,
  modulePath: string[],
  parentModuleId: string | null,
): void {
  const key = `${prefix}::${dir}`;
  if (ctx.visited.has(key)) return; // guard against local-module cycles
  ctx.visited.add(key);

  const files = [...(ctx.filesByDir.get(dir) ?? [])].sort((a, b) =>
    compareStrings(a.path, b.path),
  );

  for (const file of files) {
    let blocks: Block[];
    try {
      blocks = scanTopLevelBlocks(file.content);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      ctx.warnings.push(`skipped ${file.path}: ${reason}`);
      continue;
    }

    for (const block of blocks) {
      if (block.type === "resource" || block.type === "data") {
        const [type, name] = block.labels;
        if (!type || !name) continue;
        const localId =
          block.type === "data" ? `data.${type}.${name}` : `${type}.${name}`;
        const id = prefix + localId;
        ctx.nodes.set(id, {
          id,
          name,
          type,
          provider: providerFromType(type),
          module_path: modulePath,
          change: null,
        });
        if (block.type === "resource") ctx.resourceTypes.add(type);
        if (type === "azurerm_network_security_group") {
          const rules = scanSecurityRules(block.body);
          if (rules.length > 0) ctx.nsgRules.set(id, rules);
        }
        addContains(ctx, parentModuleId, id);
        ctx.pendingSources.push({ fromBase: id, prefix, body: block.body });
      } else if (block.type === "module") {
        const [name] = block.labels;
        if (!name) continue;
        const moduleId = `${prefix}module.${name}`;
        ctx.nodes.set(moduleId, {
          id: moduleId,
          name,
          type: "module",
          provider: null,
          module_path: modulePath,
          change: null,
        });
        addContains(ctx, parentModuleId, moduleId);
        // Module inputs can reference resources → edges from the module node.
        ctx.pendingSources.push({ fromBase: moduleId, prefix, body: block.body });

        const source = extractSource(block.body);
        if (source && isLocalSource(source)) {
          parseModuleDir(
            ctx,
            resolveLocalDir(dir, source),
            `${moduleId}.`,
            [...modulePath, name],
            moduleId,
          );
        }
      }
    }
  }
}

/** Would this reference point at a real block (vs. an attribute name / noise)? */
function isReferenceable(ref: string, resourceTypes: ReadonlySet<string>): boolean {
  if (ref.startsWith("module.") || ref.startsWith("data.")) return true;
  const firstType = (ref.split(".")[0] ?? "").replace(/\[.*\]$/, "");
  return resourceTypes.has(firstType);
}

/** Resolve an association block body's refs to the (NSG, subnet/NIC) it links. */
const ASSOCIATION_OWNERS = new Set([
  "azurerm_network_security_group",
  "azurerm_route_table",
]);

function hclAssociationTargets(
  ps: PendingSource,
  ctx: Ctx,
  edgeCtx: EdgeContext,
): { ownerId: string; targetId: string } | null {
  const resolved = extractReferences(ps.body).flatMap((ref) =>
    resolveReference(ps.prefix, ref, edgeCtx),
  );
  const ownerId = resolved.find((rid) =>
    ASSOCIATION_OWNERS.has(ctx.nodes.get(rid)?.type ?? ""),
  );
  const targetId = resolved.find((rid) => {
    const t = ctx.nodes.get(rid)?.type;
    return t === "azurerm_subnet" || t === "azurerm_network_interface";
  });
  return ownerId && targetId ? { ownerId, targetId } : null;
}

/** Route-table → subnet associations (GP-89), keyed by route-table node id. */
function extractHclRouteTableAssociations(
  ctx: Ctx,
  edgeCtx: EdgeContext,
): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const ps of ctx.pendingSources) {
    if (!ps.fromBase.includes("_route_table_association")) continue;
    const assoc = hclAssociationTargets(ps, ctx, edgeCtx);
    if (!assoc) continue;
    const list = out.get(assoc.ownerId) ?? [];
    list.push(assoc.targetId);
    out.set(assoc.ownerId, list);
  }
  return out;
}

/** Collect per-NSG inline rules + subnet/NIC associations for the docs producer. */
function extractHclNsg(ctx: Ctx, edgeCtx: EdgeContext): Map<string, ExtractedNsg> {
  const extracted = new Map<string, ExtractedNsg>();
  const nsgOf = (id: string): ExtractedNsg => {
    let e = extracted.get(id);
    if (!e) {
      e = { rules: [], associatedIds: [] };
      extracted.set(id, e);
    }
    return e;
  };
  for (const [id, rules] of ctx.nsgRules) nsgOf(id).rules.push(...rules);
  for (const ps of ctx.pendingSources) {
    if (!ps.fromBase.includes("_security_group_association")) continue;
    const assoc = hclAssociationTargets(ps, ctx, edgeCtx);
    if (assoc) nsgOf(assoc.ownerId).associatedIds.push(assoc.targetId);
  }
  return extracted;
}

/** Read the raw right-hand side of `key = <rhs>` up to end of line (may be a ref). */
function readRawAttr(body: string, key: string): string | undefined {
  const m = new RegExp(String.raw`(?:^|\n)[ \t]*${key}[ \t]*=[ \t]*([^\n]*)`).exec(body);
  return m ? (m[1] as string).trim() : undefined;
}

/**
 * Resolve an HCL attribute value to a node address (when it references a parsed
 * resource) or keep the literal / raw expression string otherwise (GP-47).
 */
function resolveHclValue(
  raw: string | undefined,
  prefix: string,
  edgeCtx: EdgeContext,
  ctx: Ctx,
): string {
  if (raw === undefined) return "";
  const literal = /^"([^"]*)"$/.exec(raw);
  if (literal) return literal[1] as string;
  for (const ref of extractReferences(raw)) {
    for (const id of resolveReference(prefix, ref, edgeCtx)) {
      if (ctx.nodes.has(id)) return id;
    }
  }
  return raw;
}

/** Resolve an `identity {}` block body's refs to user-assigned-identity node ids. */
function hclIdentityIds(
  body: string,
  prefix: string,
  edgeCtx: EdgeContext,
  ctx: Ctx,
): string[] {
  const ids = new Set<string>();
  for (const ref of extractReferences(body)) {
    for (const id of resolveReference(prefix, ref, edgeCtx)) {
      if (ctx.nodes.get(id)?.type === "azurerm_user_assigned_identity") ids.add(id);
    }
  }
  return [...ids].sort(compareStrings);
}

/** Collect role-assignment triples and managed-identity payloads from HCL bodies. */
function extractHclIam(ctx: Ctx, edgeCtx: EdgeContext): Map<string, ExtractedIam> {
  const extracted = new Map<string, ExtractedIam>();
  const bodyById = new Map(ctx.pendingSources.map((ps) => [ps.fromBase, ps]));

  for (const [id, node] of ctx.nodes) {
    if (node.type === "azurerm_user_assigned_identity") {
      extracted.set(id, { identity: { type: "UserAssigned" } });
      continue;
    }
    const ps = bodyById.get(id);
    if (!ps) continue;

    if (node.type === "azurerm_role_assignment") {
      const role =
        readAttr(ps.body, "role_definition_name") ??
        readAttr(ps.body, "role_definition_id") ??
        "";
      const roleAssignment: RoleAssignment = {
        role,
        principal: resolveHclValue(
          readRawAttr(ps.body, "principal_id"),
          ps.prefix,
          edgeCtx,
          ctx,
        ),
        scope: resolveHclValue(readRawAttr(ps.body, "scope"), ps.prefix, edgeCtx, ctx),
      };
      const principalType = readAttr(ps.body, "principal_type");
      if (principalType) roleAssignment.principal_type = principalType;
      extracted.set(id, { role: roleAssignment });
      continue;
    }

    const block = scanTopLevelBlocks(ps.body).find((b) => b.type === "identity");
    if (block) {
      const identity: Identity = { type: readAttr(block.body, "type") ?? "" };
      const ids = hclIdentityIds(block.body, ps.prefix, edgeCtx, ctx);
      if (ids.length > 0) identity.identity_ids = ids;
      extracted.set(id, { identity });
    }
  }

  return extracted;
}

export type HclParseOptions = {
  /**
   * The directory the parse starts from — the repository's Terraform root.
   * Empty (the default) is the repository root itself.
   *
   * This selects the *entrypoint*, the way `terraform -chdir` does; every `.tf`
   * file in the repository is still available, so a module sourced from above
   * the root (`../modules/shared`) resolves normally. Directories the entrypoint
   * never reaches — a second, unrelated stack — simply do not appear.
   */
  rootDir?: string;
};

/** Parse a repository's `.tf` files into a GraphSnapshot graph + warnings. */
export function parseHclRepo(
  files: HclFile[],
  options: HclParseOptions = {},
): HclParseResult {
  const rootDir = options.rootDir ?? "";
  const filesByDir = new Map<string, HclFile[]>();
  for (const file of files) {
    if (!file.path.endsWith(".tf")) continue;
    const slash = file.path.lastIndexOf("/");
    const dir = slash === -1 ? "" : file.path.slice(0, slash);
    const bucket = filesByDir.get(dir);
    if (bucket) bucket.push(file);
    else filesByDir.set(dir, [file]);
  }

  const ctx: Ctx = {
    filesByDir,
    nodes: new Map(),
    containsEdges: new Map(),
    warnings: [],
    visited: new Set(),
    pendingSources: [],
    resourceTypes: new Set(),
    nsgRules: new Map(),
  };

  // A configured root that holds no Terraform is a misconfiguration, not an
  // empty repository — say so rather than storing a silently empty graph.
  if (rootDir && !filesByDir.has(rootDir)) {
    ctx.warnings.push(`no .tf files found in '${rootDir}'`);
  }

  parseModuleDir(ctx, rootDir, "", [], null);

  const resourceIds = new Set<string>();
  const moduleIds = new Set<string>();
  for (const node of ctx.nodes.values()) {
    if (node.type === "module") moduleIds.add(node.id);
    else resourceIds.add(node.id);
  }
  const edgeCtx: EdgeContext = {
    resourceIds,
    moduleIds,
    instancesByBase: buildInstancesByBase(resourceIds),
  };

  // Build dependency sources (explicit + expression-inferred). The edge builder
  // resolves them; references that look real but resolve to no parsed block are
  // captured (not just counted) so the reader can read exactly which ones.
  const sources: DependencySource[] = [];
  for (const ps of ctx.pendingSources) {
    const refs: RawRef[] = [];
    for (const r of extractDependsOn(ps.body)) refs.push({ ref: r, inferred: false });
    for (const r of extractReferences(ps.body)) refs.push({ ref: r, inferred: true });
    sources.push({ fromBase: ps.fromBase, prefix: ps.prefix, refs });
  }

  const unresolvedRefs: UnresolvedReference[] = [];
  const dependsOnEdges = buildDependencyEdges(sources, edgeCtx, {
    referenceable: (ref) => isReferenceable(ref, ctx.resourceTypes),
    out: unresolvedRefs,
  });

  // Network containment (GP-42): set parent_id on nodes with a single unambiguous
  // vnet/subnet parent. Mutates the node objects still held in ctx.nodes.
  deriveContainment([...ctx.nodes.values()], sources, edgeCtx);

  // NSG payload (GP-43): rules + internet_exposed + associations on NSG nodes.
  attachNsg([...ctx.nodes.values()], extractHclNsg(ctx, edgeCtx));

  // Route-table → subnet associations (GP-89): associated_ids only, no NSG payload.
  attachAssociations(
    [...ctx.nodes.values()],
    extractHclRouteTableAssociations(ctx, edgeCtx),
  );

  // IAM payload (GP-47): role-assignment triples, identities, privileged flag.
  attachIam([...ctx.nodes.values()], extractHclIam(ctx, edgeCtx));

  const nodes = [...ctx.nodes.values()].toSorted((a, b) => compareStrings(a.id, b.id));
  const edges = [...ctx.containsEdges.values(), ...dependsOnEdges].toSorted(
    (a, b) =>
      compareStrings(a.kind, b.kind) ||
      compareStrings(a.from, b.from) ||
      compareStrings(a.to, b.to),
  );

  // Unresolved references are no longer an opaque count in `warnings`: they carry
  // their `from → ref` so the reader can open the list and see each one.
  const unresolvedReferences = unresolvedRefs
    .map((u) => ({ ...u, reason: "no matching resource, data source, or module" }))
    .sort((a, b) => compareStrings(a.from, b.from) || compareStrings(a.ref, b.ref));

  // v4 when any node carries containment, NSG, or IAM payload; else v1 (docs stay v1).
  const isV4 = (n: GraphNode): boolean =>
    n.parent_id !== undefined ||
    n.rules !== undefined ||
    n.internet_exposed !== undefined ||
    n.associated_ids !== undefined ||
    n.role_assignment !== undefined ||
    n.identity !== undefined;
  const version: Graph["version"] = nodes.some(isV4) ? 4 : 1;
  return {
    graph: { version, nodes, edges },
    warnings: [...ctx.warnings].sort(compareStrings),
    unresolvedReferences,
  };
}
