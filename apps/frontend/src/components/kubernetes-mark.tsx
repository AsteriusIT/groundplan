import kubernetesLogo from "@/icons/kubernetes-logo.svg";

/**
 * The official Kubernetes mark, used **unmodified** (rendered as-is via `<img>`,
 * never recoloured) — the rule the vendored provider icon sets follow, see
 * apps/frontend/ICONS.md.
 *
 * It therefore does *not* inherit `currentColor` the way the lucide icons beside
 * it in the sidebar do: it stays its brand blue whether its nav item is active or
 * not. Nothing is lost — the nav already says "active" three other ways (the left
 * border, the background tint, the label weight) — and a recoloured trademark
 * would be a worse trade than an icon that does not dim.
 *
 * It lives outside `src/icons/kubernetes/`, which is glob-keyed by Kubernetes
 * *kind* (pod, deployment, …). A logo is not a kind.
 */
export function KubernetesMark({ className }: { className?: string }) {
  return (
    <img src={kubernetesLogo} alt="" aria-hidden="true" className={className} />
  );
}
