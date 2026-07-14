/**
 * Producer C (GP-96): the listed resources of one Kubernetes namespace → an
 * ordinary GraphSnapshot.
 *
 * A **pure function**, and that is the whole point: everything the renderer needs
 * to draw a namespace is decided here, deterministically, so the canvas draws it
 * knowing nothing about Kubernetes (ADR #2) and a golden test can hold the entire
 * output still. No I/O lives here — the cluster read is GP-97's job.
 *
 * The rules the other producers follow, followed here:
 *   - A relationship we cannot resolve is **not drawn**. A Service whose selector
 *     matches nothing gets no edges; an Ingress pointing at a Service that is gone
 *     gets none either. Guessing would be worse than silence.
 *   - Two workloads behind one selector is two edges. That is not ambiguity — the
 *     traffic really does go to both.
 *   - Output is sorted canonically, so the same namespace maps to a byte-identical
 *     graph every time.
 *
 * Containment is said **twice**, on purpose. `parent_id` is the semantic fact (the
 * namespace contains this resource, the way a VNET contains a subnet — GP-42), and
 * a `contains` edge is how every renderer in the product has always been told to
 * nest something (module hierarchy, and what `networkProjection` synthesizes from
 * `parent_id` before drawing). Emitting both is what lets the existing canvas draw
 * a namespace container with no renderer change at all (GP-99).
 *
 * A Secret reaches this function as metadata and leaves as a name: the reader
 * never fetches Secret values (GP-97), and nothing here could put one on a node
 * even if it did.
 */
import type {
  V1ConfigMap,
  V1CronJob,
  V1DaemonSet,
  V1Deployment,
  V1HorizontalPodAutoscaler,
  V1Ingress,
  V1Job,
  V1NetworkPolicy,
  V1PersistentVolumeClaim,
  V1PodTemplateSpec,
  V1Secret,
  V1Service,
  V1ServiceAccount,
  V1StatefulSet,
} from "@kubernetes/client-node";

import type { Graph, GraphEdge, GraphNode } from "./graph.js";

/** Everything GP-97 lists for one namespace. Plain objects; no client, no I/O. */
export type K8sResourceSet = {
  namespace: string;
  deployments: V1Deployment[];
  statefulSets: V1StatefulSet[];
  daemonSets: V1DaemonSet[];
  cronJobs: V1CronJob[];
  jobs: V1Job[];
  services: V1Service[];
  ingresses: V1Ingress[];
  configMaps: V1ConfigMap[];
  /** Metadata only — `data` is never read, and never mapped. */
  secrets: V1Secret[];
  persistentVolumeClaims: V1PersistentVolumeClaim[];
  serviceAccounts: V1ServiceAccount[];
  horizontalPodAutoscalers: V1HorizontalPodAutoscaler[];
  networkPolicies: V1NetworkPolicy[];
};

/** The node id of a resource: `Kind/name` — the GP-93 icon key space. */
function nodeId(kind: string, name: string): string {
  return `${kind}/${name}`;
}

type Resource = { metadata?: { name?: string; labels?: { [k: string]: string } } };

/** A workload and the pod template that says what it needs. */
type Workload = { kind: string; name: string; template: V1PodTemplateSpec | undefined };

/** Is this Job the CronJob's doing? Then the CronJob already says it (dedup). */
function ownedByCronJob(job: V1Job): boolean {
  return (job.metadata?.ownerReferences ?? []).some((ref) => ref.kind === "CronJob");
}

/** Every workload in the set, paired with its pod template. */
function workloads(resources: K8sResourceSet): Workload[] {
  const out: Workload[] = [];
  for (const d of resources.deployments) {
    if (d.metadata?.name) {
      out.push({ kind: "Deployment", name: d.metadata.name, template: d.spec?.template });
    }
  }
  for (const s of resources.statefulSets) {
    if (s.metadata?.name) {
      out.push({ kind: "StatefulSet", name: s.metadata.name, template: s.spec?.template });
    }
  }
  for (const d of resources.daemonSets) {
    if (d.metadata?.name) {
      out.push({ kind: "DaemonSet", name: d.metadata.name, template: d.spec?.template });
    }
  }
  for (const c of resources.cronJobs) {
    if (c.metadata?.name) {
      out.push({
        kind: "CronJob",
        name: c.metadata.name,
        template: c.spec?.jobTemplate?.spec?.template,
      });
    }
  }
  for (const j of resources.jobs) {
    if (j.metadata?.name && !ownedByCronJob(j)) {
      out.push({ kind: "Job", name: j.metadata.name, template: j.spec?.template });
    }
  }
  return out;
}

/** The names a pod template mounts or reads, by the kind that holds them. */
function referencedNames(template: V1PodTemplateSpec | undefined): {
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
  selector: { [k: string]: string } | undefined,
  template: V1PodTemplateSpec | undefined,
): boolean {
  const entries = Object.entries(selector ?? {});
  if (entries.length === 0) return false;
  const labels = template?.metadata?.labels ?? {};
  return entries.every(([key, value]) => labels[key] === value);
}

/** The Services an Ingress routes to (default backend included). */
function ingressBackends(ingress: V1Ingress): string[] {
  const names: string[] = [];
  const fallback = ingress.spec?.defaultBackend?.service?.name;
  if (fallback) names.push(fallback);
  for (const rule of ingress.spec?.rules ?? []) {
    for (const path of rule.http?.paths ?? []) {
      const name = path.backend?.service?.name;
      if (name) names.push(name);
    }
  }
  return names;
}

/**
 * Map one namespace's resources to a graph.
 *
 * Note what is NOT reused: `deriveContainment` (GP-42), whose rule table resolves a
 * Terraform resource's parent by walking references. Here containment is a fact,
 * not an inference — everything we listed is *in* the namespace, by construction —
 * so it is a direct assignment. Threading Kubernetes through that table would buy
 * nothing and cost the clarity of this line.
 */
export function mapNamespace(resources: K8sResourceSet): Graph {
  const namespaceId = nodeId("Namespace", resources.namespace);
  const nodes: GraphNode[] = [
    {
      id: namespaceId,
      name: resources.namespace,
      type: "Namespace",
      provider: "kubernetes",
      module_path: [],
      change: null,
    },
  ];

  /** Add one resource as a node inside the namespace. */
  const add = (kind: string, resource: Resource): void => {
    const name = resource.metadata?.name;
    if (!name) return; // a resource with no name is not a resource we can point at
    const labels = resource.metadata?.labels;
    nodes.push({
      id: nodeId(kind, name),
      name,
      type: kind,
      provider: "kubernetes",
      module_path: [],
      change: null, // a live read is not a plan: nothing here is changing
      parent_id: namespaceId,
      ...(labels && Object.keys(labels).length > 0 ? { labels } : {}),
    });
  };

  for (const d of resources.deployments) add("Deployment", d);
  for (const s of resources.statefulSets) add("StatefulSet", s);
  for (const d of resources.daemonSets) add("DaemonSet", d);
  for (const c of resources.cronJobs) add("CronJob", c);
  for (const j of resources.jobs) if (!ownedByCronJob(j)) add("Job", j);
  for (const s of resources.services) add("Service", s);
  for (const i of resources.ingresses) add("Ingress", i);
  for (const c of resources.configMaps) add("ConfigMap", c);
  // Name and labels. Not `data`, not `stringData` — see the header.
  for (const s of resources.secrets) add("Secret", s);
  for (const p of resources.persistentVolumeClaims) add("PersistentVolumeClaim", p);
  for (const s of resources.serviceAccounts) add("ServiceAccount", s);
  for (const h of resources.horizontalPodAutoscalers) add("HorizontalPodAutoscaler", h);
  for (const n of resources.networkPolicies) add("NetworkPolicy", n);

  const present = new Set(nodes.map((n) => n.id));
  const edges: GraphEdge[] = [];

  /** Draw an edge only when both ends are on the diagram. */
  const link = (from: string, to: string): void => {
    if (!present.has(from) || !present.has(to) || from === to) return;
    edges.push({ from, to, kind: "depends_on", inferred: true });
  };

  for (const node of nodes) {
    if (node.id !== namespaceId) {
      edges.push({ from: namespaceId, to: node.id, kind: "contains" });
    }
  }

  const pods = workloads(resources);

  for (const workload of pods) {
    const from = nodeId(workload.kind, workload.name);
    const refs = referencedNames(workload.template);
    for (const name of refs.configMaps) link(from, nodeId("ConfigMap", name));
    for (const name of refs.secrets) link(from, nodeId("Secret", name));
    for (const name of refs.claims) link(from, nodeId("PersistentVolumeClaim", name));
    if (refs.serviceAccount) {
      link(from, nodeId("ServiceAccount", refs.serviceAccount));
    }
  }

  for (const service of resources.services) {
    const name = service.metadata?.name;
    if (!name) continue;
    const from = nodeId("Service", name);
    for (const workload of pods) {
      if (selects(service.spec?.selector, workload.template)) {
        link(from, nodeId(workload.kind, workload.name));
      }
    }
  }

  for (const ingress of resources.ingresses) {
    const name = ingress.metadata?.name;
    if (!name) continue;
    for (const backend of ingressBackends(ingress)) {
      link(nodeId("Ingress", name), nodeId("Service", backend));
    }
  }

  for (const hpa of resources.horizontalPodAutoscalers) {
    const name = hpa.metadata?.name;
    const target = hpa.spec?.scaleTargetRef;
    if (!name || !target?.kind || !target.name) continue;
    link(nodeId("HorizontalPodAutoscaler", name), nodeId(target.kind, target.name));
  }

  return {
    version: 6,
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
