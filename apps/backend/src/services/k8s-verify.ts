/**
 * Cluster reachability check (GP-95) — the `git ls-remote` of the Kubernetes
 * epic (GP-11), and shaped like it on purpose.
 *
 * It calls the cluster's **version endpoint**: the cheapest call that proves
 * three things at once — the server is reachable, TLS agrees, and the credential
 * in the kubeconfig is accepted. It deliberately does NOT list namespaces: a
 * kubeconfig bound to a single namespace (which is exactly the least-privilege
 * kubeconfig we ask people to give us, GP-98) cannot list them cluster-wide, and
 * "connected" must not mean "over-privileged".
 *
 * Nothing here ever logs or returns the kubeconfig, and no error from the client
 * is passed through: failures are mapped to a small, closed set of kinds, and the
 * caller renders its own message from those.
 */
import { KubeConfig, VersionApi } from "@kubernetes/client-node";

import { InvalidKubeconfigError, parseKubeconfig } from "../lib/kubeconfig.js";

/** Why a cluster check failed. Mirrors the repository verifier's kinds (GP-11). */
export type K8sErrorKind = "auth_failed" | "not_found" | "network" | "invalid_config";

export type K8sVerifyResult =
  | { ok: true; /** The API server version, when the cluster reported one. */ version: string | null }
  | { ok: false; error: K8sErrorKind };

/** Checks a cluster is reachable with the credentials in its kubeconfig. */
export type K8sVerify = (kubeconfig: string) => Promise<K8sVerifyResult>;

/** Build a client for the kubeconfig's current context (and only that context). */
export function clientFor(kubeconfig: string): KubeConfig {
  parseKubeconfig(kubeconfig); // shape first — a garbage file never reaches the client
  const kc = new KubeConfig();
  kc.loadFromString(kubeconfig);
  return kc;
}

/**
 * Map a cluster-side failure onto a kind. HTTP status is the only thing we read:
 * the body of a Kubernetes error can echo back request details, so it is never
 * surfaced.
 */
export function classifyK8sError(err: unknown): K8sErrorKind {
  if (err instanceof InvalidKubeconfigError) return "invalid_config";
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === "number") {
    if (code === 401 || code === 403) return "auth_failed";
    if (code === 404) return "not_found";
  }
  return "network";
}

/** The real verifier: GET /version against the kubeconfig's current context. */
export const realK8sVerify: K8sVerify = async (kubeconfig) => {
  try {
    const version = await clientFor(kubeconfig)
      .makeApiClient(VersionApi)
      .getCode();
    return { ok: true, version: version.gitVersion ?? null };
  } catch (err) {
    return { ok: false, error: classifyK8sError(err) };
  }
};
