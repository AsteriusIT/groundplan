import type { ReactNode } from "react";
import { ChevronLeft } from "lucide-react";
import { Link } from "react-router-dom";

export function PageHeader({
  eyebrow,
  title,
  description,
  backTo,
  backLabel,
  actions,
}: Readonly<{
  eyebrow?: string;
  title: string;
  description?: string;
  /** Parent route. Renders a breadcrumb link above the title, where users look. */
  backTo?: string;
  backLabel?: string;
  actions?: ReactNode;
}>) {
  return (
    <header className="bg-card flex items-start justify-between gap-4 border-b border-border px-8 py-6">
      <div>
        {backTo && (
          <Link
            to={backTo}
            className="text-muted-foreground hover:text-foreground -ml-1 mb-1 inline-flex items-center gap-0.5 text-sm"
          >
            <ChevronLeft className="size-4" />
            {backLabel ?? "Back"}
          </Link>
        )}
        {eyebrow && (
          <p className="text-muted-foreground font-mono text-[11px] font-medium tracking-[0.14em] uppercase">
            {eyebrow}
          </p>
        )}
        <h1 className="font-display text-2xl font-semibold tracking-tight">
          {title}
        </h1>
        {description && (
          <p className="text-muted-foreground mt-1 text-sm">{description}</p>
        )}
      </div>
      {actions && <div className="shrink-0">{actions}</div>}
    </header>
  );
}
