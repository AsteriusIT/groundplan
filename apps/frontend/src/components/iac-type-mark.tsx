import type { IacType } from "@/api/types";
import kubernetesLogo from "@/icons/kubernetes-logo.svg";
import terraformLogo from "@/icons/terraform-logo.svg";

const LOGO: Record<IacType, string> = {
  terraform: terraformLogo,
  kubernetes: kubernetesLogo,
};

/**
 * The official Terraform / Kubernetes logomark for what a repository holds
 * (GP-101), chosen by its `iacType`. Rendered **unmodified** via `<img>`, never
 * recoloured — the vendored-icon rule the whole project follows (see
 * apps/frontend/ICONS.md), the same one `KubernetesMark` follows in the sidebar.
 * These are logos, not kinds, so they live at `src/icons/`, not in the kind-keyed
 * glob folders.
 *
 * Decorative by default: a text label sits beside it in the type chip, so it is
 * `aria-hidden`. If it ever stands alone, pass a real `alt`.
 */
export function IacTypeMark({
  iacType,
  className,
  alt = "",
}: Readonly<{
  iacType: IacType;
  className?: string;
  alt?: string;
}>) {
  return (
    <img
      src={LOGO[iacType]}
      alt={alt}
      aria-hidden={alt === "" ? true : undefined}
      className={className}
    />
  );
}
