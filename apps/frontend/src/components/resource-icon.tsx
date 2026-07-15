/**
 * ResourceIcon (GP-29, extended GP-91 AWS / GP-92 GCP / GP-93 Kubernetes) —
 * renders the icon for a resource type via the resolution chain: an official
 * vendor icon (Azure / AWS / GCP / Kubernetes, rendered as-is via <img>, never
 * recoloured), else the lucide category icon, else a generic cube. Vendor icons
 * are colour by design and sit in a
 * neutral zone of the node; the `className` sizes them (a `text-*` colour passed
 * for the fallbacks is simply ignored by the <img>).
 */
import { Box } from "lucide-react";

import { awsIconUrl } from "@/icons/aws-icons";
import { azureIconUrl } from "@/icons/azure-icons";
import { gcpIconUrl } from "@/icons/gcp-icons";
import { kubernetesIconUrl } from "@/icons/kubernetes-icons";
import {
  resolveResourceIcon,
  type IconResolution,
} from "@/icons/resource-icon";
import { CATEGORY_META } from "@/lib/resource-category";
import { cn } from "@/lib/utils";

/** The bundled asset URL for a vendor-icon resolution, else undefined. */
function vendorIconUrl(res: IconResolution): string | undefined {
  switch (res.kind) {
    case "azure":
      return azureIconUrl(res.icon);
    case "aws":
      return awsIconUrl(res.icon);
    case "gcp":
      return gcpIconUrl(res.icon);
    case "kubernetes":
      return kubernetesIconUrl(res.icon);
    default:
      return undefined;
  }
}

export function ResourceIcon({
  type,
  className,
}: Readonly<{
  type: string;
  className?: string;
}>) {
  const res = resolveResourceIcon(type);

  const url = vendorIconUrl(res);
  if (url) {
    return (
      <img
        src={url}
        alt=""
        aria-hidden="true"
        draggable={false}
        className={cn("size-4 shrink-0 object-contain", className)}
      />
    );
  }
  // A vendored file resolved but is missing (shouldn't happen) — fall through.

  if (res.kind === "category") {
    const Icon = CATEGORY_META[res.category].icon;
    return <Icon className={className} aria-hidden="true" />;
  }

  return <Box className={className} aria-hidden="true" />;
}
