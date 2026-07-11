/**
 * Producer B: statically parse a repository's Terraform (`.tf`) source into a
 * GraphSnapshot graph — no plan, no terraform binary, no AI. Used by the docs
 * flow (GP-15) to document the official branch.
 *
 * HCL parser choice: a small, dedicated block scanner (below) rather than an
 * external dependency (`@cdktf/hcl2json`, `hcl2json` binary, `python-hcl2`).
 * Rationale: the scope is deliberately narrow — top-level block headers, a
 * module's `source`, and explicit `depends_on`. A focused scanner keeps this
 * offline (no WASM/native download), deterministic, and fully unit-testable,
 * which matters more here than full HCL fidelity. Expressions are NOT evaluated
 * (per GP-15): only explicit `depends_on` produces edges.
 */
import type { Graph, GraphEdge, GraphNode } from "./graph.js";

export type HclFile = { path: string; content: string };
export type HclParseResult = { graph: Graph; warnings: string[] };

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

  const isIdent = (c: string) => /[A-Za-z0-9_.\-]/.test(c);

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

const compareStrings = (a: string, b: string): number =>
  a < b ? -1 : a > b ? 1 : 0;

type Ctx = {
  filesByDir: Map<string, HclFile[]>;
  nodes: Map<string, GraphNode>;
  edges: Map<string, GraphEdge>;
  warnings: string[];
  visited: Set<string>;
  pendingDeps: { from: string; prefix: string; ref: string }[];
};

function addContains(ctx: Ctx, parent: string | null, child: string): void {
  if (!parent) return;
  ctx.edges.set(`contains ${parent} ${child}`, {
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
        const localId = block.type === "data" ? `data.${type}.${name}` : `${type}.${name}`;
        const id = prefix + localId;
        ctx.nodes.set(id, {
          id,
          name,
          type,
          provider: providerFromType(type),
          module_path: modulePath,
          change: null,
        });
        addContains(ctx, parentModuleId, id);
        for (const ref of extractDependsOn(block.body)) {
          ctx.pendingDeps.push({ from: id, prefix, ref });
        }
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

/** Parse a repository's `.tf` files into a GraphSnapshot graph + warnings. */
export function parseHclRepo(files: HclFile[]): HclParseResult {
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
    edges: new Map(),
    warnings: [],
    visited: new Set(),
    pendingDeps: [],
  };

  parseModuleDir(ctx, "", "", [], null);

  // Resolve explicit depends_on against the full node set (edges only to known
  // nodes; anything else — vars, cross-module attrs — is skipped).
  for (const dep of ctx.pendingDeps) {
    const target = dep.prefix + dep.ref;
    if (ctx.nodes.has(target) && target !== dep.from) {
      ctx.edges.set(`depends_on ${dep.from} ${target}`, {
        from: dep.from,
        to: target,
        kind: "depends_on",
      });
    }
  }

  const nodes = [...ctx.nodes.values()].sort((a, b) => compareStrings(a.id, b.id));
  const edges = [...ctx.edges.values()].sort(
    (a, b) =>
      compareStrings(a.kind, b.kind) ||
      compareStrings(a.from, b.from) ||
      compareStrings(a.to, b.to),
  );

  return {
    graph: { version: 1, nodes, edges },
    warnings: [...ctx.warnings].sort(compareStrings),
  };
}
