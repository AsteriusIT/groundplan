/**
 * The Kubernetes producer (GP-96, generalised in GP-102): a **set of Kubernetes
 * objects** → an ordinary GraphSnapshot.
 *
 * A **pure function**, and that is the whole point: everything the renderer needs
 * to draw is decided here, deterministically, so the canvas draws it knowing
 * nothing about Kubernetes (ADR #2) and a golden test can hold the entire output
 * still. No I/O lives here — where the objects came from is somebody else's job,
 * and deliberately so: they arrive from a live namespace read (GP-97), from YAML
 * manifests in a repository (GP-102), or from a `helm template` rendered by the
 * user's CI (GP-103), and all three map through this one function. One engine,
 * three sources — the alternative was three drifting copies of the same rules.
 *
 * The rules the other producers follow, followed here:
 *   - A relationship we cannot resolve is **not drawn**. A Service whose selector
 *     matches nothing gets no edges; an Ingress pointing at a Service that is gone
 *     gets none either. Guessing would be worse than silence.
 *   - Two workloads behind one selector is two edges. That is not ambiguity — the
 *     traffic really does go to both.
 *   - Output is sorted canonically, so the same objects map to a byte-identical
 *     graph every time.
 *
 * References are resolved **within a namespace**, because that is where Kubernetes
 * resolves them: a Deployment in `staging` mounting `ConfigMap/settings` means the
 * one in `staging`, and drawing a line to the production one would be a lie about
 * how the cluster behaves.
 *
 * Containment is said **twice**, on purpose. `parent_id` is the semantic fact (the
 * namespace contains this resource, the way a VNET contains a subnet — GP-42), and
 * a `contains` edge is how every renderer in the product has always been told to
 * nest something. Emitting both is what lets the existing canvas draw a namespace
 * container with no renderer change at all (GP-99).
 *
 * A Secret's *values* never reach a node: the live reader never fetches them
 * (GP-97), and a Secret parsed from a manifest — where the values are right there
 * in the file — has them masked here (see `attributesOf`). The graph is stored and
 * served; it is not a place to keep somebody's password.
 */
import type { Graph, GraphEdge, GraphNode } from "./graph.js";
import { render } from "./attribute-diff.js";

/**
 * A Kubernetes object, however it reached us. Structurally this is the API's own
 * shape (a manifest and a `kubectl get -o json` differ in what is *filled in*,
 * never in what things are called), so the typed reads below hold for all three
 * sources — and every one of them is optional-chained, because a manifest is
 * whatever somebody typed.
 */
export type K8sObject = {
  apiVersion?: string;
  kind?: string;
  metadata?: {
    name?: string;
    namespace?: string;
    labels?: { [key: string]: string };
    ownerReferences?: {
      apiVersion?: string;
      kind?: string;
      name?: string;
      uid?: string;
    }[];
  };
  /** Whatever this kind's spec happens to be — read by path, never by type. */
  spec?: unknown;
  data?: unknown;
  stringData?: unknown;
};

/** The container a namespace-less object lives in: cluster-scoped, or just unsaid. */
export const NO_NAMESPACE = "(no namespace)";

/** Per-node attribute cap. Beyond this the node says it was capped (never silently). */
const MAX_ATTRIBUTES = 200;

/**
 * Object fields that say nothing about what the object *is*. `status` is the
 * cluster's opinion of the moment (a live read has it, a manifest never does —
 * keeping it would make the same workload diff against itself); the rest is
 * bookkeeping that changes on every apply.
 */
const IGNORED_PATHS = new Set([
  "status",
  "kind",
  "metadata.name",
  "metadata.namespace",
  "metadata.uid",
  "metadata.resourceVersion",
  "metadata.generation",
  "metadata.creationTimestamp",
  "metadata.selfLink",
  "metadata.managedFields",
  "metadata.annotations.kubectl.kubernetes.io/last-applied-configuration",
]);

/** The node id of an object: `namespace/Kind/name`, or `Kind/name` if it has none. */
function nodeId(namespace: string, kind: string, name: string): string {
  return namespace ? `${namespace}/${kind}/${name}` : `${kind}/${name}`;
}

/** The namespace an object lives in; "" for cluster-scoped or unsaid. */
function namespaceOf(object: K8sObject): string {
  return object.metadata?.namespace ?? "";
}

/** Is this object a Namespace? Then it *is* a container, not a thing inside one. */
function isNamespace(object: K8sObject): boolean {
  return object.kind === "Namespace";
}

/**
 * Flatten an object to `path → rendered scalar`, which is what makes two versions
 * of the same workload comparable (GP-103): the image lives at
 * `spec.template.spec.containers[0].image`, so that is the key it diffs under.
 *
 * A Secret's values are masked rather than dropped: "this key changed" is worth
 * knowing, and the value never is.
 */
function attributesOf(object: K8sObject): {
  attributes: Record<string, string>;
  truncated: boolean;
} {
  const secret = object.kind === "Secret";
  const out: Record<string, string> = {};

  const walk = (value: unknown, path: string): void => {
    if (IGNORED_PATHS.has(path)) return;
    // A Secret's data is the one thing we hold and never show.
    if (secret && (path.startsWith("data.") || path.startsWith("stringData."))) {
      out[path] = "(sensitive)";
      return;
    }
    if (Array.isArray(value)) {
      if (value.length === 0) out[path] = "[]";
      else value.forEach((item, i) => walk(item, `${path}[${i}]`));
      return;
    }
    if (value !== null && typeof value === "object") {
      const entries = Object.entries(value as Record<string, unknown>);
      if (entries.length === 0) out[path] = "{}";
      else for (const [key, child] of entries) walk(child, path ? `${path}.${key}` : key);
      return;
    }
    out[path] = render(value);
  };

  for (const [key, value] of Object.entries(object)) walk(value, key);

  const keys = Object.keys(out).sort((a, b) => a.localeCompare(b));
  if (keys.length <= MAX_ATTRIBUTES) return { attributes: out, truncated: false };
  const capped: Record<string, string> = {};
  for (const key of keys.slice(0, MAX_ATTRIBUTES)) capped[key] = out[key] as string;
  return { attributes: capped, truncated: true };
}

/** A workload and the pod template that says what it needs. */
type Workload = { kind: string; name: string; template: PodTemplate | undefined };

type PodTemplate = {
  metadata?: { labels?: { [key: string]: string } };
  spec?: {
    volumes?: {
      configMap?: { name?: string };
      secret?: { secretName?: string };
      persistentVolumeClaim?: { claimName?: string };
    }[];
    initContainers?: Container[];
    containers?: Container[];
    serviceAccountName?: string;
  };
};

type Container = {
  envFrom?: { configMapRef?: { name?: string }; secretRef?: { name?: string } }[];
  env?: {
    valueFrom?: {
      configMapKeyRef?: { name?: string };
      secretKeyRef?: { name?: string };
    };
  }[];
};

/** Read a path off an object we only know the shape of by convention. */
function at<T>(object: K8sObject, ...path: string[]): T | undefined {
  let current: unknown = object;
  for (const key of path) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current as T | undefined;
}

/** Is this Job the CronJob's doing? Then the CronJob already says it (dedup). */
function ownedByCronJob(object: K8sObject): boolean {
  return (object.metadata?.ownerReferences ?? []).some((ref) => ref.kind === "CronJob");
}

/** The pod template of a workload, wherever its kind happens to keep it. */
function podTemplateOf(object: K8sObject): PodTemplate | undefined {
  if (object.kind === "CronJob") {
    return at<PodTemplate>(object, "spec", "jobTemplate", "spec", "template");
  }
  return at<PodTemplate>(object, "spec", "template");
}

/** The kinds whose pod template we understand well enough to draw its needs. */
const WORKLOAD_KINDS = new Set([
  "Deployment",
  "StatefulSet",
  "DaemonSet",
  "CronJob",
  "Job",
]);

/** The names a pod template mounts or reads, by the kind that holds them. */
function referencedNames(template: PodTemplate | undefined): {
  configMaps: string[];
  secrets: string[];
  claims: string[];
  serviceAccount: string | null;
} {
  const configMaps: string[] = [];
  const secrets: string[] = [];
  const claims: string[] = [];
  const spec = template?.spec;

  for (const volume of spec?.volumes ?? []) {
    if (volume.configMap?.name) configMaps.push(volume.configMap.name);
    if (volume.secret?.secretName) secrets.push(volume.secret.secretName);
    if (volume.persistentVolumeClaim?.claimName) {
      claims.push(volume.persistentVolumeClaim.claimName);
    }
  }

  // Init containers count: a workload that cannot start without a ConfigMap
  // depends on it just as surely as one that reads it at runtime.
  const containers = [...(spec?.initContainers ?? []), ...(spec?.containers ?? [])];
  for (const container of containers) {
    for (const source of container.envFrom ?? []) {
      if (source.configMapRef?.name) configMaps.push(source.configMapRef.name);
      if (source.secretRef?.name) secrets.push(source.secretRef.name);
    }
    for (const env of container.env ?? []) {
      const from = env.valueFrom;
      if (from?.configMapKeyRef?.name) configMaps.push(from.configMapKeyRef.name);
      if (from?.secretKeyRef?.name) secrets.push(from.secretKeyRef.name);
    }
  }

  return {
    configMaps,
    secrets,
    claims,
    serviceAccount: spec?.serviceAccountName ?? null,
  };
}

/**
 * Does a Service's selector select this pod template? Every key must match — and
 * an empty or absent selector selects nothing here, deliberately: in Kubernetes it
 * would select the whole namespace, which on a diagram is a line from a Service to
 * everything, i.e. a lie shaped like information.
 */
function selects(
  selector: { [key: string]: string } | undefined,
  template: PodTemplate | undefined,
): boolean {
  const entries = Object.entries(selector ?? {});
  if (entries.length === 0) return false;
  const labels = template?.metadata?.labels ?? {};
  return entries.every(([key, value]) => labels[key] === value);
}

/** The Services an Ingress routes to (default backend included). */
function ingressBackends(ingress: K8sObject): string[] {
  const names: string[] = [];
  const fallback = at<string>(ingress, "spec", "defaultBackend", "service", "name");
  if (fallback) names.push(fallback);
  const rules =
    at<{ http?: { paths?: { backend?: { service?: { name?: string } } }[] } }[]>(
      ingress,
      "spec",
      "rules",
    ) ?? [];
  for (const rule of rules) {
    for (const path of rule.http?.paths ?? []) {
      const name = path.backend?.service?.name;
      if (name) names.push(name);
    }
  }
  return names;
}

/**
 * Map a set of Kubernetes objects to a graph.
 *
 * Every well-formed object becomes a node — a CRD we have never heard of included,
 * because a diagram that quietly omits the thing you came to look at is worse than
 * one that draws it without knowing what it does. Edges are drawn only between the
 * shapes we genuinely understand.
 *
 * Note what is NOT reused: `deriveContainment` (GP-42), whose rule table resolves a
 * Terraform resource's parent by walking references. Here containment is a fact,
 * not an inference — an object names its namespace — so it is a direct assignment.
 */
export function mapK8sObjects(objects: K8sObject[]): Graph {
  const nodes: GraphNode[] = [];
  const namespaceIds = new Map<string, string>();

  /** The container for a namespace, made on first sight of something inside it. */
  const containerFor = (namespace: string): string => {
    const existing = namespaceIds.get(namespace);
    if (existing) return existing;
    const name = namespace || NO_NAMESPACE;
    const id = nodeId("", "Namespace", name);
    namespaceIds.set(namespace, id);
    nodes.push({
      id,
      name,
      type: "Namespace",
      provider: "kubernetes",
      module_path: [],
      change: null,
    });
    return id;
  };

  const toNode = (object: K8sObject, id: string, parentId: string | null): GraphNode => {
    const labels = object.metadata?.labels;
    const { attributes, truncated } = attributesOf(object);
    return {
      id,
      name: object.metadata?.name as string,
      type: object.kind as string,
      provider: "kubernetes",
      module_path: [],
      // Nothing here is changing: a set of objects is a state, not a plan. The
      // change colours of a pull request are computed against a base (GP-103).
      change: null,
      ...(parentId ? { parent_id: parentId } : {}),
      ...(labels && Object.keys(labels).length > 0 ? { labels } : {}),
      ...(Object.keys(attributes).length > 0 ? { attributes } : {}),
      ...(truncated ? { attributes_truncated: true } : {}),
    };
  };

  // Namespaces first, so a namespace the manifests actually declare keeps its own
  // labels and attributes instead of being synthesized bare by the first thing in it.
  const byId = new Map<string, GraphNode>();
  for (const object of objects) {
    const name = object.metadata?.name;
    if (!name || !object.kind || !isNamespace(object)) continue;
    const id = nodeId("", "Namespace", name);
    namespaceIds.set(name, id);
    const node = toNode(object, id, null);
    nodes.push(node);
    byId.set(id, node);
  }

  const members: { object: K8sObject; id: string; namespace: string }[] = [];
  for (const object of objects) {
    const name = object.metadata?.name;
    // A nameless or kindless document is not an object we can point at.
    if (!name || !object.kind || isNamespace(object)) continue;
    // A Job the CronJob spawned is the CronJob, said twice.
    if (object.kind === "Job" && ownedByCronJob(object)) continue;

    const namespace = namespaceOf(object);
    const id = nodeId(namespace, object.kind, name);
    // The same object declared twice (a base and an overlay both in the walk) is
    // one node: the last one wins, as it would in `kubectl apply`.
    const existing = byId.get(id);
    const node = toNode(object, id, containerFor(namespace));
    if (existing) {
      Object.assign(existing, node);
      continue;
    }
    byId.set(id, node);
    nodes.push(node);
    members.push({ object, id, namespace });
  }

  const present = new Set(nodes.map((node) => node.id));
  const edges: GraphEdge[] = [];

  for (const node of nodes) {
    if (node.parent_id) edges.push({ from: node.parent_id, to: node.id, kind: "contains" });
  }

  /** Draw an edge only when both ends are on the diagram, and in one namespace. */
  const link = (namespace: string, from: string, kind: string, name: string): void => {
    const to = nodeId(namespace, kind, name);
    if (!present.has(from) || !present.has(to) || from === to) return;
    edges.push({ from, to, kind: "depends_on", inferred: true });
  };

  const workloads = members
    .filter((member) => WORKLOAD_KINDS.has(member.object.kind as string))
    .map((member) => ({
      namespace: member.namespace,
      id: member.id,
      workload: {
        kind: member.object.kind as string,
        name: member.object.metadata?.name as string,
        template: podTemplateOf(member.object),
      } satisfies Workload,
    }));

  for (const { namespace, id, workload } of workloads) {
    const refs = referencedNames(workload.template);
    for (const name of refs.configMaps) link(namespace, id, "ConfigMap", name);
    for (const name of refs.secrets) link(namespace, id, "Secret", name);
    for (const name of refs.claims) link(namespace, id, "PersistentVolumeClaim", name);
    if (refs.serviceAccount) link(namespace, id, "ServiceAccount", refs.serviceAccount);
  }

  for (const member of members) {
    const { object, id, namespace } = member;

    if (object.kind === "Service") {
      const selector = at<{ [key: string]: string }>(object, "spec", "selector");
      for (const other of workloads) {
        if (other.namespace === namespace && selects(selector, other.workload.template)) {
          link(namespace, id, other.workload.kind, other.workload.name);
        }
      }
    }

    if (object.kind === "Ingress") {
      for (const backend of ingressBackends(object)) link(namespace, id, "Service", backend);
    }

    if (object.kind === "HorizontalPodAutoscaler") {
      const target = at<{ kind?: string; name?: string }>(object, "spec", "scaleTargetRef");
      if (target?.kind && target.name) link(namespace, id, target.kind, target.name);
    }
  }

  return {
    version: 7,
    nodes: [...nodes].sort((a, b) => a.id.localeCompare(b.id)),
    edges: dedupe(edges).sort(
      (a, b) =>
        a.kind.localeCompare(b.kind) ||
        a.from.localeCompare(b.from) ||
        a.to.localeCompare(b.to),
    ),
  };
}

/** One relationship said twice (a ConfigMap mounted *and* read as env) is one edge. */
function dedupe(edges: GraphEdge[]): GraphEdge[] {
  const seen = new Set<string>();
  return edges.filter((edge) => {
    const key = `${edge.kind} ${edge.from} ${edge.to}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Everything GP-97 lists for one namespace. Plain objects; no client, no I/O. */
export type K8sResourceSet = {
  namespace: string;
  deployments: K8sObject[];
  statefulSets: K8sObject[];
  daemonSets: K8sObject[];
  cronJobs: K8sObject[];
  jobs: K8sObject[];
  services: K8sObject[];
  ingresses: K8sObject[];
  configMaps: K8sObject[];
  /** Metadata only — `data` is never read, and never mapped. */
  secrets: K8sObject[];
  persistentVolumeClaims: K8sObject[];
  serviceAccounts: K8sObject[];
  horizontalPodAutoscalers: K8sObject[];
  networkPolicies: K8sObject[];
};

/** What the live reader (GP-97) hands back, keyed by the kind each list holds. */
const LIVE_KINDS: [keyof K8sResourceSet, string][] = [
  ["deployments", "Deployment"],
  ["statefulSets", "StatefulSet"],
  ["daemonSets", "DaemonSet"],
  ["cronJobs", "CronJob"],
  ["jobs", "Job"],
  ["services", "Service"],
  ["ingresses", "Ingress"],
  ["configMaps", "ConfigMap"],
  ["secrets", "Secret"],
  ["persistentVolumeClaims", "PersistentVolumeClaim"],
  ["serviceAccounts", "ServiceAccount"],
  ["horizontalPodAutoscalers", "HorizontalPodAutoscaler"],
  ["networkPolicies", "NetworkPolicy"],
];

/**
 * Map one live namespace read (GP-97) — the kind-keyed lists the Kubernetes client
 * returns, which say their kind in the *name of the list* rather than in each
 * object, since the API server drops `kind` from items inside a List.
 */
export function mapNamespace(resources: K8sResourceSet): Graph {
  const objects: K8sObject[] = [
    { kind: "Namespace", metadata: { name: resources.namespace } },
  ];
  for (const [key, kind] of LIVE_KINDS) {
    for (const object of resources[key] as K8sObject[]) {
      objects.push({
        ...object,
        kind,
        metadata: { ...object.metadata, namespace: resources.namespace },
      });
    }
  }
  return mapK8sObjects(objects);
}
