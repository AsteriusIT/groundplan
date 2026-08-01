/**
 * The Build mode document (GP-133): the composed graph, what is selected, and
 * what is wrong with it.
 *
 * State lives here rather than in the page so switching Build → Edit HCL →
 * Build is lossless within the session. It is never persisted: a draft holds
 * files, and after generation the files are the truth (ADR #5).
 */
import { useCallback, useMemo, useRef, useState } from "react";

import {
  emptyBuilderGraph,
  validateBuilderGraph,
  type BuilderGraph,
  type BuilderIssue,
  type BuilderValue,
} from "@groundplan/builder";

import * as ops from "./builder-ops";

export type BuilderController = {
  graph: BuilderGraph;
  issues: BuilderIssue[];
  /** True when the composition is ready to generate. */
  valid: boolean;
  selectedId: string | null;
  select: (id: string | null) => void;
  addNode: (type: string) => void;
  rename: (id: string, name: string) => void;
  setAttribute: (
    id: string,
    attribute: string,
    value: BuilderValue | undefined,
  ) => void;
  move: (id: string, position: { x: number; y: number }) => void;
  remove: (id: string) => void;
  connect: (from: string, attribute: string, to: string) => void;
  disconnect: (from: string, attribute: string, to: string) => void;
};

export function useBuilderGraph(): BuilderController {
  const [graph, setGraph] = useState<BuilderGraph>(emptyBuilderGraph);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Counted, not random: a stable id makes a composition reproducible in a
  // test, and the id never leaves the session anyway.
  const nextId = useRef(1);

  const issues = useMemo(() => validateBuilderGraph(graph), [graph]);

  const addNode = useCallback((type: string) => {
    const id = `n${nextId.current++}`;
    setGraph((current) => {
      const next = ops.addNode(current, type, id);
      // A type the catalog does not know adds nothing — and selecting an id
      // that was never created would leave an empty form open.
      if (next !== current) setSelectedId(id);
      return next;
    });
  }, []);

  const remove = useCallback((id: string) => {
    setGraph((current) => ops.removeNode(current, id));
    setSelectedId((current) => (current === id ? null : current));
  }, []);

  const rename = useCallback((id: string, name: string) => {
    setGraph((current) => ops.renameNode(current, id, name));
  }, []);

  const setAttribute = useCallback(
    (id: string, attribute: string, value: BuilderValue | undefined) => {
      setGraph((current) => ops.setAttribute(current, id, attribute, value));
    },
    [],
  );

  const move = useCallback((id: string, position: { x: number; y: number }) => {
    setGraph((current) => ops.moveNode(current, id, position));
  }, []);

  const connect = useCallback(
    (from: string, attribute: string, to: string) => {
      setGraph((current) => ops.connect(current, from, attribute, to));
    },
    [],
  );

  const disconnect = useCallback(
    (from: string, attribute: string, to: string) => {
      setGraph((current) => ops.disconnect(current, from, attribute, to));
    },
    [],
  );

  return {
    graph,
    issues,
    valid: graph.nodes.length > 0 && issues.length === 0,
    selectedId,
    select: setSelectedId,
    addNode,
    rename,
    setAttribute,
    move,
    remove,
    connect,
    disconnect,
  };
}
