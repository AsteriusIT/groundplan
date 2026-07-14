/**
 * What a repository holds (GP-101), and how the UI says it.
 *
 * The mirror of `lib/providers.ts`, for the other question the attach form asks.
 * It is one table rather than a label scattered across three components, because
 * "Kubernetes" appears on the attach form, on the repository card, and in the
 * settings dialog, and a repository whose type reads differently in each of them
 * would be three repositories as far as the reader is concerned.
 */
import type { IacType } from "@/api/types";

export const IAC_TYPES: { id: IacType; label: string }[] = [
  { id: "terraform", label: "Terraform" },
  { id: "kubernetes", label: "Kubernetes" },
];

export const IAC_TYPE_LABELS: Record<IacType, string> = {
  terraform: "Terraform",
  kubernetes: "Kubernetes",
};

/**
 * What the repository's IaC directory is called to a human. The column behind it
 * is `terraformPath` either way (GP-101): it always meant "where the IaC lives",
 * and renaming it would have been migration churn for zero behaviour.
 */
export const IAC_PATH_LABELS: Record<IacType, string> = {
  terraform: "Terraform path",
  kubernetes: "Manifests path",
};

/**
 * Which producer documents a repository's default branch (GP-102). The docs page
 * asks for these and only these: a manifests repository has no `hcl` snapshots and
 * never will, and a Terraform one has no `k8s_manifest` ones.
 */
export function docsSourceFor(iacType: IacType): "hcl" | "k8s_manifest" {
  return iacType === "kubernetes" ? "k8s_manifest" : "hcl";
}
