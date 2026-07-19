/**
 * The package's public entry point (GP-145): a pure function from a set of
 * repository files to a GraphSnapshot plus editor-shaped diagnostics.
 *
 * `parse` is a thin projection over `parseHclRepo` — the parser itself is
 * unchanged (its snapshots stay byte-identical); this only reshapes the two
 * existing diagnostic channels (`warnings`, `unresolvedReferences`) into one
 * list that carries a file and a 1-based line range when one is known, so a
 * consumer (the VS Code extension's Problems panel, GP-138's endpoint) can
 * point at code without re-parsing our own warning strings.
 */
import type { Graph } from "./graph.js";
import {
  parseHclRepo,
  type HclFile,
  type HclParseOptions,
} from "./hcl-parser.js";

/** A 1-based, inclusive line span inside `file`. Columns are not tracked. */
export type DiagnosticRange = {
  start_line: number;
  end_line: number;
};

/**
 * One thing the parser wants to tell the author. `error` means a file's
 * contents could not be parsed at all (its resources are missing from the
 * snapshot); `warning` means the snapshot is complete but something in it
 * deserves attention (an unresolved reference, an empty root).
 */
export type Diagnostic = {
  severity: "error" | "warning";
  message: string;
  /** Repository-relative path, when the diagnostic points at a file. */
  file?: string;
  /** Line span within `file`, when one is known. */
  range?: DiagnosticRange;
};

export type ParseResult = {
  snapshot: Graph;
  diagnostics: Diagnostic[];
};

/** `skipped <path>: <reason>` — the parser's wire format for a dropped file. */
const SKIPPED_RE = /^skipped (.+?): (.+)$/;

/** Parse a repository's `.tf` files into a snapshot + diagnostics. Pure. */
export function parse(
  files: HclFile[],
  options: HclParseOptions = {},
): ParseResult {
  const { graph, warnings, unresolvedReferences } = parseHclRepo(
    files,
    options,
  );

  const diagnostics: Diagnostic[] = [];

  for (const warning of warnings) {
    const skipped = SKIPPED_RE.exec(warning);
    if (skipped) {
      diagnostics.push({
        severity: "error",
        file: skipped[1],
        message: skipped[2] ?? warning,
      });
    } else {
      diagnostics.push({ severity: "warning", message: warning });
    }
  }

  const nodesById = new Map(graph.nodes.map((n) => [n.id, n]));
  for (const ref of unresolvedReferences) {
    const source = nodesById.get(ref.from)?.source;
    diagnostics.push({
      severity: "warning",
      message: `unresolved reference '${ref.ref}' from ${ref.from}${
        ref.reason ? `: ${ref.reason}` : ""
      }`,
      ...(source
        ? {
            file: source.file,
            range: {
              start_line: source.start_line,
              end_line: source.end_line,
            },
          }
        : {}),
    });
  }

  return { snapshot: graph, diagnostics };
}
