/**
 * ResourceIcon (GP-29, extended GP-91 AWS) — renders the icon for a resource type
 * via the resolution chain: an official vendor icon (Azure / AWS, rendered as-is
 * via <img>, never recoloured), else the lucide category icon, else a generic
 * cube. Vendor icons are colour by design and sit in a neutral zone of the node;
 * the `className` sizes them (a `text-*` colour passed for the fallbacks is simply
 * ignored by the <img>).
 */
import { Box } from "lucide-react";

import { awsIconUrl } from "@/icons/aws-icons";
import { azureIconUrl } from "@/icons/azure-icons";
import { resolveResourceIcon } from "@/icons/resource-icon";
import { CATEGORY_META } from "@/lib/resource-category";
import { cn } from "@/lib/utils";

export function ResourceIcon({
  type,
  className,
}: {
  type: string;
  className?: string;
}) {
  const res = resolveResourceIcon(type);

  if (res.kind === "azure" || res.kind === "aws") {
    const url =
      res.kind === "azure" ? azureIconUrl(res.icon) : awsIconUrl(res.icon);
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
  }

  if (res.kind === "category") {
    const Icon = CATEGORY_META[res.category].icon;
    return <Icon className={className} aria-hidden="true" />;
  }

  return <Box className={className} aria-hidden="true" />;
}
