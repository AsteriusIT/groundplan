import {
  type ReactNode,
  type SyntheticEvent,
  useEffect,
  useState,
} from "react";
import { useNavigate } from "react-router-dom";
import {
  Building2,
  KeyRound,
  LogOut,
  Mail,
  Palette,
  Sparkles,
  UserRound,
  Users,
} from "lucide-react";

import { ApiError, deleteOrganization } from "@/api/client";
import { useAuth } from "@/auth/use-auth";
import { initials } from "@/lib/format";
import { useAiStatus } from "@/lib/use-ai-status";
import { useScrollSpy } from "@/lib/use-scroll-spy";
import { cn } from "@/lib/utils";
import { useOrg } from "@/org/use-org";
import { useCan } from "@/rbac/use-can";
import { useTheme } from "@/theme/theme-provider";
import { AppIngestionSettings } from "@/components/app-ingestion-settings";
import { OrgInvites } from "@/components/org-invites";
import { OrgMembers } from "@/components/org-members";
import { Button } from "@/components/ui/button";
import { Chip } from "@/components/ui/chip";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PageHeader } from "@/components/page-header";
import { ThemeSwitcher } from "@/components/theme-switcher";
import { TourStyleSwitcher } from "@/components/tour-style-switcher";
import { useTourStyle } from "@/tour/tour-style";

const THEME_BLURB: Record<string, string> = {
  light: "Drafting paper — a light surface for bright rooms and projectors.",
  blueprint: "Cyanotype — the signature deep-blue drafting table.",
  carbon: "Carbon — near-neutral graphite, for when blue is too much.",
};

const TOUR_BLURB: Record<string, string> = {
  spotlight:
    "The diagram dims and a card is pinned to the resources each stop is about.",
  guide:
    "The whole tour lists in a rail beside the diagram — skim it, or jump to any stop.",
};

type SectionEntry = { id: string; label: string; element: ReactNode };
type SectionGroup = { label: string | null; sections: SectionEntry[] };

/**
 * Settings, grown past its GP-69 "deliberately thin" origins: identity,
 * org management (GP-118), display preferences, the app-wide CI token and
 * the AI readout. A sticky rail mirrors the sections — both render from the
 * same `groups` value, so the nav can never drift from the page. Still
 * nothing speculative: no API keys in the UI, no per-page auth checks.
 */
export function SettingsPage() {
  const { activeOrg, singleOrg } = useOrg();
  const canManage = useCan("member:manage");
  const canDelete = useCan("org:delete");
  const showInvites = !singleOrg && canManage;
  const showDanger = !singleOrg && canDelete && activeOrg !== null;

  // A hash on arrival scrolls to its section (jsdom's scrollIntoView is a
  // test-setup no-op). A hash for a hidden section simply finds no element.
  useEffect(() => {
    const hash = window.location.hash.slice(1);
    if (hash) document.getElementById(hash)?.scrollIntoView();
  }, []);

  const groups: SectionGroup[] = [
    {
      label: "Personal",
      sections: [
        { id: "account", label: "Account", element: <AccountCard /> },
        { id: "appearance", label: "Appearance", element: <AppearanceCard /> },
      ],
    },
    {
      label: "Organization",
      sections: [
        { id: "members", label: "Members", element: <MembersCard /> },
        ...(showInvites
          ? [
              {
                id: "invitations",
                label: "Invitations",
                element: <InvitesCard />,
              },
            ]
          : []),
      ],
    },
    {
      label: "Workspace",
      sections: [
        {
          id: "ci-token",
          label: "CI ingestion token",
          element: <IngestionCard />,
        },
        { id: "ai", label: "AI", element: <AiCard /> },
      ],
    },
    ...(showDanger
      ? [
          {
            label: null,
            sections: [
              { id: "danger", label: "Danger zone", element: <DangerCard /> },
            ],
          },
        ]
      : []),
  ];

  return (
    <div>
      <PageHeader
        eyebrow="Account"
        title="Settings"
        description="Your identity, the look of the canvas, and what the server has enabled."
      />
      <div className="mx-auto flex max-w-5xl items-start gap-10 px-8 py-8">
        <SettingsRail groups={groups} />
        <div className="min-w-0 max-w-3xl flex-1 space-y-8">
          {groups.map((group) => (
            <div key={group.label ?? "danger"} className="space-y-4">
              {group.label && <GroupLabel>{group.label}</GroupLabel>}
              {group.sections.map((s) => (
                <div key={s.id} id={s.id} className="scroll-mt-6">
                  {s.element}
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/** The sidebar's tiny uppercase group label, reused for settings groups. */
function GroupLabel({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <p className="text-muted-foreground font-mono text-[10px] font-medium tracking-[0.12em] uppercase">
      {children}
    </p>
  );
}

/**
 * The section rail: anchors into the page, grouped like the sidebar, the
 * active section highlighted with the sidebar's exact active treatment so
 * the two navs read as one system. Hidden below lg — the page is then just
 * the stacked scroll it always was.
 */
function SettingsRail({ groups }: Readonly<{ groups: SectionGroup[] }>) {
  const ids = groups.flatMap((g) => g.sections.map((s) => s.id));
  // A click (or an arriving #hash) pins its section: the page is short, so
  // the tail sections can never reach the spy's reading line and geometry
  // alone would contradict an explicit choice. Real scrolling unpins.
  const [pinned, setPinned] = useState<string | null>(() => {
    const hash = window.location.hash.slice(1);
    return ids.includes(hash) ? hash : null;
  });
  const spied = useScrollSpy(ids);
  const active = pinned ?? spied;

  useEffect(() => {
    if (pinned === null) return;
    const unpin = () => setPinned(null);
    window.addEventListener("wheel", unpin, { passive: true });
    window.addEventListener("touchmove", unpin, { passive: true });
    return () => {
      window.removeEventListener("wheel", unpin);
      window.removeEventListener("touchmove", unpin);
    };
  }, [pinned]);

  return (
    <nav
      aria-label="Settings sections"
      className="sticky top-8 hidden w-44 shrink-0 self-start lg:block"
    >
      <ul className="space-y-5">
        {groups.map((group) => (
          <li key={group.label ?? "danger"}>
            {group.label && (
              <div className="px-2.5 pb-1.5">
                <GroupLabel>{group.label}</GroupLabel>
              </div>
            )}
            <ul className="space-y-0.5">
              {group.sections.map((s) => (
                <li key={s.id}>
                  <a
                    href={`#${s.id}`}
                    aria-current={active === s.id ? "true" : undefined}
                    onClick={(event) => {
                      event.preventDefault();
                      setPinned(s.id);
                      document
                        .getElementById(s.id)
                        ?.scrollIntoView({ behavior: "smooth" });
                      window.history.replaceState(null, "", `#${s.id}`);
                    }}
                    className={cn(
                      "block border-l-2 px-2.5 py-1.5 text-sm transition-colors",
                      active === s.id
                        ? "border-primary text-primary font-medium"
                        : "text-muted-foreground hover:text-foreground border-transparent",
                    )}
                  >
                    {s.label}
                  </a>
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </nav>
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
  const { style } = useTourStyle();

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

      {/* GP-79. Not an AI surface — it is a display preference, and it belongs
          beside the theme for the same reason the theme does: Settings is where
          you say how the product should look, and nowhere else is. */}
      <div className="mt-5 flex items-center gap-6">
        <TourStyleSwitcher className="w-80 shrink-0" />
        <p className="text-muted-foreground text-sm">{TOUR_BLURB[style]}</p>
      </div>
    </Section>
  );
}

/**
 * CI ingestion (GP): the app-wide webhook token — a second, global token any
 * repository's push accepts, so an estate can wire one CI secret instead of one
 * per repository. Each repository still has (and can rotate) its own token on its
 * project page; this is the shared alternative, and it lives in Settings because
 * it is one global secret, not a per-repository setting.
 */
function IngestionCard() {
  return (
    <Section
      icon={<KeyRound className="size-4" />}
      title="CI ingestion token"
      description="An app-wide token your CI can use to push plans for any repository."
    >
      <AppIngestionSettings />
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

/** The org's members and their roles (GP-118). Shown to every member. */
function MembersCard() {
  const { activeOrg } = useOrg();
  return (
    <Section
      icon={<Users className="size-4" />}
      title="Members"
      description={
        activeOrg
          ? `Who belongs to ${activeOrg.name}, and their roles.`
          : "Who belongs to this organization."
      }
    >
      <OrgMembers />
    </Section>
  );
}

/** Invitations (GP-116/GP-118) — rendered only for multi-org admins (page gates). */
function InvitesCard() {
  return (
    <Section
      icon={<Mail className="size-4" />}
      title="Invitations"
      description="Invite people with a role. Copy the link and send it yourself."
    >
      <OrgInvites />
    </Section>
  );
}

/** Delete the organization (GP-118) — rendered only for multi-org owners (page gates). */
function DangerCard() {
  const { activeOrg } = useOrg();
  const { reloadUser } = useAuth();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!activeOrg) return null;

  async function handleDelete(event: SyntheticEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await deleteOrganization(confirm);
      await reloadUser();
      navigate("/", { replace: true });
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : "Could not delete the organization.",
      );
      setSubmitting(false);
    }
  }

  return (
    <Section
      icon={<Building2 className="size-4" />}
      title="Danger zone"
      description="Deleting an organization removes its projects, repositories and history. This cannot be undone."
      className="border-destructive/40"
    >
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogTrigger asChild>
          <Button variant="destructive">Delete organization</Button>
        </DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete {activeOrg.name}?</DialogTitle>
            <DialogDescription>
              This permanently deletes the organization and everything in it.
              Type <span className="font-mono">{activeOrg.name}</span> to confirm.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleDelete} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="confirm-name">Organization name</Label>
              <Input
                id="confirm-name"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                autoComplete="off"
              />
            </div>
            {error && (
              <p role="alert" className="text-destructive text-sm">
                {error}
              </p>
            )}
            <DialogFooter>
              <Button
                type="submit"
                variant="destructive"
                disabled={submitting || confirm !== activeOrg.name}
              >
                {submitting ? "Deleting…" : "Delete organization"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </Section>
  );
}

function Section({
  icon,
  title,
  description,
  className,
  children,
}: Readonly<{
  icon: ReactNode;
  title: string;
  description: string;
  className?: string;
  children: ReactNode;
}>) {
  return (
    <section
      className={cn("bg-card rounded-md border border-border", className)}
    >
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
