import { ExternalLink } from "lucide-react";

import { docsUrl, type DocPage } from "@/lib/docs";
import { cn } from "@/lib/utils";

/**
 * A link into the documentation site.
 *
 * Used at the places where somebody is *already stuck* — the CI setup panel, the
 * cluster dialog, the drift rail — rather than as a help icon in every corner.
 * Documentation nobody finds is documentation nobody reads, and a link that is
 * everywhere is a link nobody sees.
 *
 * It always opens in a new tab: these appear beside forms and pasted tokens, and
 * navigating away from a half-filled dialog to read a procedure would lose the
 * work. `rel="noreferrer"` because the docs site has no business knowing which
 * customer instance sent somebody.
 */
export function DocsLink({
  page,
  children,
  className,
  showIcon = true,
}: Readonly<{
  page: DocPage;
  children: React.ReactNode;
  className?: string;
  /** Off for links inside running prose, where the icon is noise. */
  showIcon?: boolean;
}>) {
  return (
    <a
      href={docsUrl(page)}
      target="_blank"
      rel="noreferrer"
      className={cn(
        "text-primary inline-flex items-center gap-1 hover:underline",
        className,
      )}
    >
      {children}
      {showIcon && <ExternalLink className="size-3 shrink-0" aria-hidden="true" />}
    </a>
  );
}
