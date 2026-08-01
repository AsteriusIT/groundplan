/**
 * What the status bar's notice slot says, when it has something to say.
 *
 * One slot, one notice. Three conditions can want it, and the old panel let
 * all three have it at once — a banner across the top, a chip in the corner
 * and a pill in the middle, each floating over the diagram they were about.
 * Ranked here rather than in the component so the ranking can be argued with.
 */
import { strings } from "../strings";
import type { DiffFacts } from "./panel-state";

export type Notice = {
  kind: "diff-unavailable" | "out-of-sync" | "multi-root";
  text: string;
  /** True when this is a warning rather than an aside. */
  warn: boolean;
};

export function statusNotice({
  diffEnabled,
  facts,
  outOfSync,
  multiRoot,
  folder,
}: Readonly<{
  diffEnabled: boolean;
  facts: DiffFacts;
  outOfSync: boolean;
  multiRoot: boolean;
  folder: string;
}>): Notice | null {
  // A diff that was asked for and could not run: the reader is looking at the
  // live view while believing they asked for a comparison.
  if (diffEnabled && !facts.available) {
    return {
      kind: "diff-unavailable",
      text: strings.status.diffUnavailable(facts.reason),
      warn: true,
    };
  }
  // The diagram is not what is in the editor. Nothing else matters as much.
  if (outOfSync) {
    return { kind: "out-of-sync", text: strings.status.outOfSync, warn: true };
  }
  // Which folder — worth saying once, not worth a banner.
  if (multiRoot) {
    return { kind: "multi-root", text: strings.status.multiRoot(folder), warn: false };
  }
  return null;
}
