/**
 * GP-141/GP-142: the studio session — one in-memory store for what the
 * conversation has built so far. The chat's messages live in `useChat`;
 * everything derived from completed turns (file set, parsed snapshot, lint
 * findings, what is new since the previous turn) lives here. Nothing is
 * persisted anywhere: leaving the studio or refreshing starts clean, by design.
 *
 * The commit rule (GP-142): a turn's files are committed only when they parse.
 * On a parse failure the canvas keeps the last good snapshot, the failure is
 * surfaced as an error card in the chat, and the broken files are *not*
 * committed — so the next turn regenerates from the last state that drew.
 */
import { useCallback, useRef, useState } from "react";

import { ApiError, parseStudioFiles } from "@/api/client";
import type {
  Graph,
  LintFinding,
  StudioFile,
  StudioParseDiagnostic,
} from "@/api/types";

export type StudioParseFailure = {
  message: string;
  diagnostics: StudioParseDiagnostic[];
};

export type StudioSession = {
  /** The committed file set — what the canvas and code panel show. */
  files: StudioFile[];
  /** Read the current files without re-rendering (the transport's view). */
  filesRef: () => StudioFile[];
  /** The parsed snapshot of the committed files, once one exists. */
  snapshot: Graph | null;
  /** Lint findings by node id (terraform address) — badges + panel section. */
  lint: ReadonlyMap<string, LintFinding[]>;
  /** Node ids new since the previous snapshot — the fresh highlight. */
  freshNodeIds: ReadonlySet<string>;
  /** Non-error parse diagnostics of the current snapshot (warnings). */
  warnings: StudioParseDiagnostic[];
  /** The last turn's parse failure, if it failed — rendered in the chat. */
  parseFailure: StudioParseFailure | null;
  /** True while a completed turn's file set is being parsed. */
  parsing: boolean;
  /** A turn completed with this regenerated file set: parse, then commit. */
  commitTurn: (files: StudioFile[]) => Promise<void>;
  /** Anything worth guarding with a "your session will be lost" prompt? */
  hasWork: boolean;
  reset: () => void;
};

/** Findings grouped by the node they anchor to. */
function lintByNode(findings: LintFinding[]): Map<string, LintFinding[]> {
  const map = new Map<string, LintFinding[]>();
  for (const finding of findings) {
    const list = map.get(finding.terraformAddress) ?? [];
    list.push(finding);
    map.set(finding.terraformAddress, list);
  }
  return map;
}

const NO_LINT: ReadonlyMap<string, LintFinding[]> = new Map();
const NO_FRESH: ReadonlySet<string> = new Set();

export function useStudioSession(): StudioSession {
  const [files, setFiles] = useState<StudioFile[]>([]);
  const [snapshot, setSnapshot] = useState<Graph | null>(null);
  const [lint, setLint] = useState<ReadonlyMap<string, LintFinding[]>>(NO_LINT);
  const [freshNodeIds, setFreshNodeIds] = useState<ReadonlySet<string>>(NO_FRESH);
  const [warnings, setWarnings] = useState<StudioParseDiagnostic[]>([]);
  const [parseFailure, setParseFailure] = useState<StudioParseFailure | null>(
    null,
  );
  const [parsing, setParsing] = useState(false);
  const ref = useRef<StudioFile[]>([]);
  // The previous snapshot's node ids — what "new since last turn" compares to.
  const prevIdsRef = useRef<Set<string>>(new Set());

  const filesRef = useCallback(() => ref.current, []);

  const commitTurn = useCallback(async (next: StudioFile[]) => {
    setParsing(true);
    setParseFailure(null);
    try {
      const parsed = await parseStudioFiles(next);
      // Presentation only (GP-142): which nodes this turn introduced.
      const previous = prevIdsRef.current;
      const ids = new Set(parsed.snapshot.nodes.map((n) => n.id));
      const fresh = new Set(
        [...ids].filter((id) => previous.size > 0 && !previous.has(id)),
      );
      prevIdsRef.current = ids;

      ref.current = next;
      setFiles(next);
      setSnapshot(parsed.snapshot);
      setLint(lintByNode(parsed.diagnostics.lint));
      setWarnings(
        parsed.diagnostics.parse.filter((d) => d.severity === "warning"),
      );
      setFreshNodeIds(fresh);
      // A partial parse still commits (the server drew what it could), but
      // the per-file errors deserve the same chat card a hard failure gets.
      const errors = parsed.diagnostics.parse.filter(
        (d) => d.severity === "error",
      );
      if (errors.length > 0) {
        setParseFailure({
          message: "Some generated files did not parse and were left out.",
          diagnostics: errors,
        });
      }
    } catch (err) {
      // The turn's files are NOT committed: the canvas keeps the last good
      // snapshot and the next turn regenerates from it.
      if (err instanceof ApiError) {
        setParseFailure({
          message: err.message,
          diagnostics: (err.fields ?? []).map((f) => ({
            severity: "error",
            file: f.field,
            message: f.message,
          })),
        });
      } else {
        setParseFailure({
          message: "The generated project could not be parsed.",
          diagnostics: [],
        });
      }
    } finally {
      setParsing(false);
    }
  }, []);

  const reset = useCallback(() => {
    ref.current = [];
    prevIdsRef.current = new Set();
    setFiles([]);
    setSnapshot(null);
    setLint(NO_LINT);
    setFreshNodeIds(NO_FRESH);
    setWarnings([]);
    setParseFailure(null);
  }, []);

  return {
    files,
    filesRef,
    snapshot,
    lint,
    freshNodeIds,
    warnings,
    parseFailure,
    parsing,
    commitTurn,
    hasWork: files.length > 0,
    reset,
  };
}
