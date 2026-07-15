/**
 * Kubeconfig shape validation (GP-95).
 *
 * A kubeconfig is a credential — the same class of secret as a repository PAT —
 * so it is checked *structurally* before it is ever encrypted and stored, and
 * nothing from inside it is ever quoted back: every rejection message here is
 * written from scratch, never interpolated from the file. A garbage paste is a
 * 422 the user can act on, not a cluster read that fails much later for reasons
 * nobody can see.
 *
 * We read the **current context** and nothing else (there is no context picker —
 * see GP-98): a kubeconfig whose current-context is missing or dangles is one we
 * cannot act on, so it is refused at the door.
 */
import { loadYaml } from "@kubernetes/client-node";

/** Thrown when a kubeconfig is unusable. The message never quotes the file. */
export class InvalidKubeconfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidKubeconfigError";
  }
}

/** The parts of a kubeconfig we act on. Deliberately holds no credential. */
export type ParsedKubeconfig = {
  /** The `current-context` name — the only context we ever use. */
  currentContext: string;
  /** The API server URL of that context's cluster. */
  server: string;
  /** The context's default namespace, if it declares one. */
  namespace: string | null;
};

type ContextEntry = {
  name?: unknown;
  context?: { cluster?: unknown; namespace?: unknown };
};

type ClusterEntry = {
  name?: unknown;
  cluster?: { server?: unknown };
};

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/**
 * Validate a kubeconfig's shape and return its current context. Throws
 * `InvalidKubeconfigError` for anything we could not act on.
 */
export function parseKubeconfig(raw: string): ParsedKubeconfig {
  let doc: unknown;
  try {
    doc = loadYaml<unknown>(raw);
  } catch {
    throw new InvalidKubeconfigError("kubeconfig is not valid YAML");
  }

  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) {
    throw new InvalidKubeconfigError("kubeconfig is not a YAML mapping");
  }

  const config = doc as Record<string, unknown>;
  const currentContext = config["current-context"];
  if (typeof currentContext !== "string" || currentContext.trim() === "") {
    throw new InvalidKubeconfigError(
      "kubeconfig has no current-context — Groundplan always uses the current context",
    );
  }

  const contexts = asArray(config["contexts"]) as ContextEntry[];
  const context = contexts.find((entry) => entry?.name === currentContext);
  if (!context?.context) {
    throw new InvalidKubeconfigError(
      "kubeconfig's current-context names a context the file does not define",
    );
  }

  const clusters = asArray(config["clusters"]) as ClusterEntry[];
  const cluster = clusters.find((entry) => entry?.name === context.context?.cluster);
  const server = cluster?.cluster?.server;
  if (typeof server !== "string" || server.trim() === "") {
    throw new InvalidKubeconfigError(
      "kubeconfig's current context points at a cluster with no server URL",
    );
  }

  const namespace = context.context.namespace;
  return {
    currentContext,
    server,
    namespace: typeof namespace === "string" && namespace !== "" ? namespace : null,
  };
}
