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
  CATALOG,
  emptyBuilderGraph,
  mergeCatalog,
  validateBuilderGraph,
  type BuilderGraph,
  type BuilderIssue,
  type BuilderValue,
  type ResourceDef,
} from "@groundplan/builder";

import { NEW_REFERENCE_HANDLE } from "./builder-node";
import * as ops from "./builder-ops";

export type BuilderController = {
  graph: BuilderGraph;
  issues: BuilderIssue[];
  /** True when the composition is ready to generate. */
  valid: boolean;
  selectedId: string | null;
  select: (id: string | null) => void;
  /**
   * Add a resource — at a dropped position, or below what is already there.
   * `def` is the definition of a type whose schema has just arrived (GP-238):
   * it is used for this call without waiting for the catalog prop to come round
   * again, which would be a render too late.
   */
  addNode: (
    type: string,
    position?: { x: number; y: number },
    def?: ResourceDef,
  ) => void;
  rename: (id: string, name: string) => void;
  /** Retype a custom resource (the only node whose type the user writes). */
  retype: (id: string, type: string) => void;
  /** Rename the attribute a custom resource's reference is written into. */
  renameReference: (from: string, attribute: string, next: string) => void;
  /** Set which attribute of the target a custom reference reads. */
  setTargetAttribute: (
    from: string,
    attribute: string,
    targetAttribute: string,
  ) => void;
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

/**
 * `catalog` is what the composition is checked against (GP-238): the curated
 * entries plus whatever the provider catalog has loaded so far. It changes as
 * schemas arrive, and every rule — prefilled defaults, which connections are
 * allowed, what validation complains about — reads the current one, so a
 * resource added before its schema arrived is judged by it the moment it does.
 */
export function useBuilderGraph(
  catalog: readonly ResourceDef[] = CATALOG,
): BuilderController {
  const [graph, setGraph] = useState<BuilderGraph>(emptyBuilderGraph);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Counted, not random: a stable id makes a composition reproducible in a
  // test, and the id never leaves the session anyway.
  const nextId = useRef(1);

  const issues = useMemo(
    () => validateBuilderGraph(graph, catalog),
    [graph, catalog],
  );

  // Read by the callbacks, so adding a resource or drawing a connection always
  // uses the catalog as it stands rather than the one a stale closure captured.
  const current = useRef(catalog);
  current.current = catalog;

  const addNode = useCallback(
    (type: string, position?: { x: number; y: number }, def?: ResourceDef) => {
    const id = `n${nextId.current++}`;
    setGraph((graph) => {
      const known = def ? mergeCatalog([def], current.current) : current.current;
      const next = ops.addNode(graph, type, id, position, known);
      // A type the catalog does not know adds nothing — and selecting an id
      // that was never created would leave an empty form open.
      if (next !== graph) setSelectedId(id);
      return next;
    });
    },
    [],
  );

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
      setGraph((graph) =>
        // A custom resource has no slot to connect into, so the connection
        // makes one and names it after what it points at.
        attribute === NEW_REFERENCE_HANDLE
          ? ops.connectCustom(graph, from, to)
          : ops.connect(graph, from, attribute, to, current.current),
      );
    },
    [],
  );

  const retype = useCallback((id: string, type: string) => {
    setGraph((current) => ops.retypeNode(current, id, type));
  }, []);

  const renameReference = useCallback(
    (from: string, attribute: string, next: string) => {
      setGraph((current) => ops.renameReference(current, from, attribute, next));
    },
    [],
  );

  const setTargetAttribute = useCallback(
    (from: string, attribute: string, targetAttribute: string) => {
      setGraph((current) =>
        ops.setTargetAttribute(current, from, attribute, targetAttribute),
      );
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
    retype,
    renameReference,
    setTargetAttribute,
    setAttribute,
    move,
    remove,
    connect,
    disconnect,
  };
}
