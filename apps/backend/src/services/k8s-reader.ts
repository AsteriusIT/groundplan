/**
 * The cluster read (GP-97): the I/O shell around the pure mapper (GP-96).
 *
 * It does exactly two things — list a cluster's namespaces, and list the
 * resources of one namespace — with the official Node client and no kubectl
 * binary. Everything it touches is a LIST; there is no `get secret` anywhere in
 * this file, and there never will be: we map a Secret's name so the diagram can
 * show that one exists, and its value is none of our business.
 *
 * The whole reader is injectable (`buildApp(env, { k8s })`), which is what keeps
 * the epic's tests offline — CI never reaches a cluster.
 *
 * **RBAC honesty.** A kubeconfig scoped to less than everything is the kubeconfig
 * we *ask* people for (GP-98). So a 403 on one kind is not a failure: that kind is
 * skipped, a warning names it, and the snapshot says out loud that it is partial.
 * A partial diagram that admits it beats a hard error that explains nothing.
 */
import {
  AppsV1Api,
  AutoscalingV1Api,
  BatchV1Api,
  CoreV1Api,
  NetworkingV1Api,
  type KubeConfig,
} from "@kubernetes/client-node";

import type { K8sResourceSet } from "../graph/k8s-mapper.js";
import { classifyK8sError, clientFor, type K8sErrorKind } from "./k8s-verify.js";

/** A cluster we could not read. Carries a kind, never a message from the cluster. */
export class K8sUnreachableError extends Error {
  readonly kind: K8sErrorKind;
  constructor(kind: K8sErrorKind) {
    super(`could not read the cluster (${kind})`);
    this.name = "K8sUnreachableError";
    this.kind = kind;
  }
}

export type K8sReadResult = {
  resources: K8sResourceSet;
  /** Kinds we were not allowed to list, named so the diagram can say so. */
  warnings: string[];
};

export type K8sReader = {
  listNamespaces(kubeconfig: string): Promise<string[]>;
  readNamespace(kubeconfig: string, namespace: string): Promise<K8sReadResult>;
};

/** A namespace read that outruns this is a cluster we cannot use (→ 502). */
const READ_TIMEOUT_MS = 20_000;

function withTimeout<T>(work: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new K8sUnreachableError("network")),
      READ_TIMEOUT_MS,
    );
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new K8sUnreachableError("network"));
      },
    );
  });
}

/** Is this the cluster telling us "you may not"? (As opposed to "I am not here".) */
function isForbidden(err: unknown): boolean {
  return classifyK8sError(err) === "auth_failed";
}

/**
 * List one kind. A 403 yields an empty list and a warning; anything else is a
 * cluster we could not read, which is the caller's 502.
 */
async function listKind<T>(
  kind: string,
  namespace: string,
  call: () => Promise<{ items: T[] }>,
  warnings: string[],
): Promise<T[]> {
  try {
    return (await call()).items;
  } catch (err) {
    if (isForbidden(err)) {
      warnings.push(
        `not allowed to list ${kind} in namespace ${namespace} — skipped`,
      );
      return [];
    }
    throw new K8sUnreachableError(classifyK8sError(err));
  }
}

async function readWith(
  kc: KubeConfig,
  namespace: string,
): Promise<K8sReadResult> {
  const core = kc.makeApiClient(CoreV1Api);
  const apps = kc.makeApiClient(AppsV1Api);
  const batch = kc.makeApiClient(BatchV1Api);
  const networking = kc.makeApiClient(NetworkingV1Api);
  const autoscaling = kc.makeApiClient(AutoscalingV1Api);

  const warnings: string[] = [];
  const param = { namespace };

  // One round trip per kind, all in flight at once: the namespace is read as of
  // roughly one moment rather than over the course of a slow walk through it.
  const [
    deployments,
    statefulSets,
    daemonSets,
    cronJobs,
    jobs,
    services,
    ingresses,
    configMaps,
    secrets,
    persistentVolumeClaims,
    serviceAccounts,
    horizontalPodAutoscalers,
    networkPolicies,
  ] = await Promise.all([
    listKind("Deployment", namespace, () => apps.listNamespacedDeployment(param), warnings),
    listKind("StatefulSet", namespace, () => apps.listNamespacedStatefulSet(param), warnings),
    listKind("DaemonSet", namespace, () => apps.listNamespacedDaemonSet(param), warnings),
    listKind("CronJob", namespace, () => batch.listNamespacedCronJob(param), warnings),
    listKind("Job", namespace, () => batch.listNamespacedJob(param), warnings),
    listKind("Service", namespace, () => core.listNamespacedService(param), warnings),
    listKind("Ingress", namespace, () => networking.listNamespacedIngress(param), warnings),
    listKind("ConfigMap", namespace, () => core.listNamespacedConfigMap(param), warnings),
    // LIST, never GET: this returns each Secret's metadata. We keep the name.
    listKind("Secret", namespace, () => core.listNamespacedSecret(param), warnings),
    listKind(
      "PersistentVolumeClaim",
      namespace,
      () => core.listNamespacedPersistentVolumeClaim(param),
      warnings,
    ),
    listKind(
      "ServiceAccount",
      namespace,
      () => core.listNamespacedServiceAccount(param),
      warnings,
    ),
    listKind(
      "HorizontalPodAutoscaler",
      namespace,
      () => autoscaling.listNamespacedHorizontalPodAutoscaler(param),
      warnings,
    ),
    listKind(
      "NetworkPolicy",
      namespace,
      () => networking.listNamespacedNetworkPolicy(param),
      warnings,
    ),
  ]);

  return {
    resources: {
      namespace,
      deployments,
      statefulSets,
      daemonSets,
      cronJobs,
      jobs,
      services,
      ingresses,
      configMaps,
      secrets,
      persistentVolumeClaims,
      serviceAccounts,
      horizontalPodAutoscalers,
      networkPolicies,
    },
    warnings,
  };
}

/** The real reader. Builds a client from the kubeconfig's current context. */
export const realK8sReader: K8sReader = {
  async listNamespaces(kubeconfig) {
    try {
      const core = clientFor(kubeconfig).makeApiClient(CoreV1Api);
      const list = await withTimeout(core.listNamespace());
      return list.items
        .map((ns) => ns.metadata?.name)
        .filter((name): name is string => Boolean(name))
        .sort();
    } catch (err) {
      if (err instanceof K8sUnreachableError) throw err;
      throw new K8sUnreachableError(classifyK8sError(err));
    }
  },

  async readNamespace(kubeconfig, namespace) {
    try {
      return await withTimeout(readWith(clientFor(kubeconfig), namespace));
    } catch (err) {
      if (err instanceof K8sUnreachableError) throw err;
      throw new K8sUnreachableError(classifyK8sError(err));
    }
  },
};
