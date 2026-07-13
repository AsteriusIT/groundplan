import type { ReactNode } from "react";
import { LogOut, Palette, Sparkles, UserRound } from "lucide-react";

import { useAuth } from "@/auth/use-auth";
import { initials } from "@/lib/format";
import { useAiStatus } from "@/lib/use-ai-status";
import { useTheme } from "@/theme/theme-provider";
import { Button } from "@/components/ui/button";
import { Chip } from "@/components/ui/chip";
import { PageHeader } from "@/components/page-header";
import { ThemeSwitcher } from "@/components/theme-switcher";

const THEME_BLURB: Record<string, string> = {
  light: "Drafting paper — a light surface for bright rooms and projectors.",
  blueprint: "Cyanotype — the signature deep-blue drafting table.",
  carbon: "Carbon — near-neutral graphite, for when blue is too much.",
};

/**
 * Settings (GP-69): the three things that actually have content today —
 * who you are, how it looks, and whether the AI layer is on. Nothing
 * speculative: no team management, no roles, no API keys in the UI.
 */
export function SettingsPage() {
  return (
    <div>
      <PageHeader
        eyebrow="Account"
        title="Settings"
        description="Your identity, the look of the canvas, and what the server has enabled."
      />
      <div className="max-w-3xl space-y-6 p-8">
        <AccountCard />
        <AppearanceCard />
        <AiCard />
      </div>
    </div>
  );
}

function AccountCard() {
  const { user, logout } = useAuth();

  return (
    <Section
      icon={<UserRound className="size-4" />}
      title="Account"
      description="Your identity comes from the token — it is managed by your identity provider, not here."
    >
      <div className="flex items-center gap-4">
        <div
          className="bg-primary text-primary-foreground grid size-12 shrink-0 place-items-center rounded-sm font-mono text-sm font-semibold"
          aria-hidden="true"
        >
          {initials(user?.display_name ?? null, user?.email ?? null)}
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">
            {user?.display_name ?? "Signed in"}
          </p>
          <p className="text-muted-foreground truncate font-mono text-xs">
            {user?.email ?? "no email in the token"}
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void logout()}>
          <LogOut />
          Sign out
        </Button>
      </div>
    </Section>
  );
}

function AppearanceCard() {
  const { theme } = useTheme();

  return (
    <Section
      icon={<Palette className="size-4" />}
      title="Appearance"
      description="Applies immediately and is remembered on this device."
    >
      <div className="flex items-center gap-6">
        <ThemeSwitcher className="w-80 shrink-0" />
        <p className="text-muted-foreground text-sm">{THEME_BLURB[theme]}</p>
      </div>
    </Section>
  );
}

/**
 * A read-only status card. Unlike every other AI surface — which vanishes when
 * the layer is off (GP-62) — this one still renders: it is a readout of server
 * config, not AI content, and "why do I see no AI anywhere?" is exactly the
 * question Settings should answer. The key is configured server-side by design,
 * so there is nothing to type here.
 */
function AiCard() {
  return (
    <Section
      icon={<Sparkles className="size-4" />}
      title="AI"
      description="Prose about a snapshot — change summaries on pull requests, explanations on docs."
    >
      <AiState />
    </Section>
  );
}

function AiState() {
  const status = useAiStatus();

  if (status === null) {
    return (
      <p className="text-muted-foreground text-sm" aria-busy="true">
        Checking…
      </p>
    );
  }

  if (!status.enabled) {
    return (
      <div className="flex items-center gap-3">
        <Chip variant="neutral">Disabled</Chip>
        <p className="text-muted-foreground text-sm">
          AI features are configured server-side, with the{" "}
          <span className="font-mono text-xs">AI_MODEL</span> and{" "}
          <span className="font-mono text-xs">AI_API_KEY</span> environment
          variables.
        </p>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-3">
      <Chip variant="create">Enabled</Chip>
      <p className="text-muted-foreground text-sm">
        Generating with{" "}
        <span className="text-foreground font-mono text-xs">{status.model}</span>
      </p>
    </div>
  );
}

function Section({
  icon,
  title,
  description,
  children,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <section className="bg-card rounded-md border border-border">
      <header className="border-b border-border px-5 py-3.5">
        <div className="text-muted-foreground flex items-center gap-2">
          {icon}
          <h2 className="font-display text-foreground text-sm font-semibold tracking-tight">
            {title}
          </h2>
        </div>
        <p className="text-muted-foreground mt-1 text-xs">{description}</p>
      </header>
      <div className="px-5 py-4">{children}</div>
    </section>
  );
}
