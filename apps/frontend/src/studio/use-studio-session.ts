/**
 * GP-141: the studio session — one in-memory store for what the conversation
 * has built so far. The chat's messages live in `useChat`; everything derived
 * from completed turns (the current file set, and from GP-142 on the parsed
 * snapshot beside it) lives here. Nothing is persisted anywhere: leaving the
 * studio or refreshing starts clean, by design.
 */
import { useCallback, useRef, useState } from "react";

import type { StudioFile } from "./chat";

export type StudioSession = {
  /** The committed file set — what the canvas and code panel show. */
  files: StudioFile[];
  /** Read the current files without re-rendering (the transport's view). */
  filesRef: () => StudioFile[];
  /** A turn completed with this regenerated file set. */
  commitTurn: (files: StudioFile[]) => void;
  /** Anything worth guarding with a "your session will be lost" prompt? */
  hasWork: boolean;
  reset: () => void;
};

export function useStudioSession(): StudioSession {
  const [files, setFiles] = useState<StudioFile[]>([]);
  const ref = useRef<StudioFile[]>([]);

  const filesRef = useCallback(() => ref.current, []);

  const commitTurn = useCallback((next: StudioFile[]) => {
    ref.current = next;
    setFiles(next);
  }, []);

  const reset = useCallback(() => {
    ref.current = [];
    setFiles([]);
  }, []);

  return { files, filesRef, commitTurn, hasWork: files.length > 0, reset };
}
