# Settings Section Rail Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild `/settings` as a centered two-column page — a sticky, grouped, scroll-spied section rail beside the existing settings cards.

**Architecture:** The page computes one `groups` array (visibility conditions lifted out of the cards) and renders both the rail and the content column from it, so the nav can never drift from the page. A new `useScrollSpy` hook (IntersectionObserver, jsdom-safe) drives the active highlight. All section content components are untouched.

**Tech Stack:** React 19, Tailwind v4 semantic tokens, vitest + Testing Library + vitest-axe.

Spec: `docs/superpowers/specs/2026-07-18-settings-section-rail-design.md`

## Global Constraints

- No hardcoded colours — semantic token utilities only (`design-tokens.test.ts` guard).
- TS strict + `noUncheckedIndexedAccess` + `noUnusedLocals/Parameters` — fix code, never loosen.
- Frontend imports via the `@/` alias; `cn()` from `@/lib/utils` for conditional classes.
- All existing `settings-page.test.tsx` assertions keep passing.
- **One implementation commit** at the end (user-chosen), not one per task.
- Run tests with `pnpm --filter @groundplan/frontend test <file>` (the script is already `vitest run`).

---

### Task 1: `useScrollSpy` hook

**Files:**
- Create: `apps/frontend/src/lib/use-scroll-spy.ts`
- Test: `apps/frontend/src/lib/use-scroll-spy.test.ts`

**Interfaces:**
- Consumes: nothing project-specific.
- Produces: `useScrollSpy(ids: readonly string[]): string | null` — the id of the section currently crossing the top 40% of the viewport; the first id where IntersectionObserver is unavailable (jsdom) or before any callback fires; `null` for an empty list.

- [ ] **Step 1: Write the failing test**

`apps/frontend/src/lib/use-scroll-spy.test.ts`:

```ts
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";

import { useScrollSpy } from "./use-scroll-spy";

/** Captures constructed observers so tests can drive the callback by hand. */
class MockIntersectionObserver {
  static instances: MockIntersectionObserver[] = [];
  callback: IntersectionObserverCallback;
  observed: Element[] = [];
  disconnected = false;

  constructor(callback: IntersectionObserverCallback) {
    this.callback = callback;
    MockIntersectionObserver.instances.push(this);
  }

  observe(el: Element) {
    this.observed.push(el);
  }

  disconnect() {
    this.disconnected = true;
  }

  unobserve() {}
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
}

function addSection(id: string): Element {
  const el = document.createElement("div");
  el.id = id;
  document.body.append(el);
  return el;
}

/** Only the fields the hook reads. */
function entry(
  target: Element,
  top: number,
  isIntersecting: boolean,
): IntersectionObserverEntry {
  return {
    target,
    isIntersecting,
    boundingClientRect: { top } as DOMRectReadOnly,
  } as IntersectionObserverEntry;
}

function fire(entries: IntersectionObserverEntry[]) {
  const observer = MockIntersectionObserver.instances[0];
  if (!observer) throw new Error("no observer constructed");
  act(() =>
    observer.callback(entries, observer as unknown as IntersectionObserver),
  );
}

beforeEach(() => {
  MockIntersectionObserver.instances = [];
  vi.stubGlobal("IntersectionObserver", MockIntersectionObserver);
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

it("starts on the first section", () => {
  addSection("a");
  addSection("b");
  const { result } = renderHook(() => useScrollSpy(["a", "b"]));
  expect(result.current).toBe("a");
});

it("is null for no sections", () => {
  const { result } = renderHook(() => useScrollSpy([]));
  expect(result.current).toBeNull();
});

it("stays on the first section where IntersectionObserver does not exist", () => {
  vi.unstubAllGlobals(); // back to bare jsdom
  addSection("a");
  addSection("b");
  const { result } = renderHook(() => useScrollSpy(["a", "b"]));
  expect(result.current).toBe("a");
});

it("observes each section element", () => {
  const a = addSection("a");
  const b = addSection("b");
  renderHook(() => useScrollSpy(["a", "b"]));
  expect(MockIntersectionObserver.instances[0]?.observed).toEqual([a, b]);
});

it("follows the section crossing the reading line", () => {
  addSection("a");
  const b = addSection("b");
  const { result } = renderHook(() => useScrollSpy(["a", "b"]));
  fire([entry(b, 12, true)]);
  expect(result.current).toBe("b");
});

it("gives ties to the section highest on screen", () => {
  const a = addSection("a");
  const b = addSection("b");
  const { result } = renderHook(() => useScrollSpy(["a", "b"]));
  fire([entry(b, 140, true), entry(a, 16, true)]);
  expect(result.current).toBe("a");
});

it("keeps the last section while none intersect", () => {
  addSection("a");
  const b = addSection("b");
  const { result } = renderHook(() => useScrollSpy(["a", "b"]));
  fire([entry(b, 12, true)]);
  fire([entry(b, -400, false)]);
  expect(result.current).toBe("b");
});

it("disconnects on unmount", () => {
  addSection("a");
  const { unmount } = renderHook(() => useScrollSpy(["a"]));
  unmount();
  expect(MockIntersectionObserver.instances[0]?.disconnected).toBe(true);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @groundplan/frontend test src/lib/use-scroll-spy.test.ts`
Expected: FAIL — cannot resolve `./use-scroll-spy`.

- [ ] **Step 3: Write the implementation**

`apps/frontend/src/lib/use-scroll-spy.ts`:

```ts
import { useEffect, useState } from "react";

/**
 * Which of the given section ids is nearest the top of the scroll viewport.
 * The "reading line" is the top 40% of the screen (rootMargin trims the
 * bottom 60%); among sections crossing it, the highest on screen wins, and
 * when none do — between sections, or past the end — the last answer holds.
 *
 * jsdom has no IntersectionObserver: the hook then reports the first id and
 * never updates, so component tests exercise the markup, not the browser.
 */
export function useScrollSpy(ids: readonly string[]): string | null {
  const [active, setActive] = useState<string | null>(ids[0] ?? null);
  const key = ids.join("|");

  useEffect(() => {
    const sections = key === "" ? [] : key.split("|");
    setActive(sections[0] ?? null);
    if (sections.length === 0 || typeof IntersectionObserver === "undefined") {
      return;
    }

    const tops = new Map<string, number>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            tops.set(entry.target.id, entry.boundingClientRect.top);
          } else {
            tops.delete(entry.target.id);
          }
        }
        const highest = [...tops.entries()].sort((a, b) => a[1] - b[1])[0];
        if (highest) setActive(highest[0]);
      },
      { rootMargin: "0px 0px -60% 0px" },
    );

    for (const id of sections) {
      const el = document.getElementById(id);
      if (el) observer.observe(el);
    }
    return () => observer.disconnect();
  }, [key]);

  return active;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @groundplan/frontend test src/lib/use-scroll-spy.test.ts`
Expected: PASS, 8 tests.

*(No commit — single implementation commit in Task 3.)*

---

### Task 2: Settings page — rail, groups, centered layout

**Files:**
- Modify: `apps/frontend/src/pages/settings-page.tsx`
- Test: `apps/frontend/src/pages/settings-page.test.tsx`

**Interfaces:**
- Consumes: `useScrollSpy(ids)` from Task 1; existing cards/components unchanged.
- Produces: `/settings` markup — `<nav aria-label="Settings sections">` with anchor links `#account #appearance #members #invitations #ci-token #ai #danger`; each section wrapped in `<div id="…" class="scroll-mt-6">`; active link carries `aria-current="true"`.

- [ ] **Step 1: Extend the tests (failing first)**

In `apps/frontend/src/pages/settings-page.test.tsx`:

1. Add `listInvitations` to the client mock (the invitations section now renders for multi-org admins and must not fall into its error state):

```ts
vi.mock("@/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/client")>();
  return {
    ...actual,
    getAiStatus: vi.fn(),
    listMembers: vi.fn(),
    listInvitations: vi.fn(),
  };
});
```

```ts
import { getAiStatus, listInvitations, listMembers } from "@/api/client";
```

```ts
const listInvitationsMock = vi.mocked(listInvitations);
```

and in `beforeEach`, beside the `listMembers` lines:

```ts
listInvitationsMock.mockReset();
listInvitationsMock.mockResolvedValue([]);
```

2. Let `renderPage` take an org-context override, keeping today's single-org default:

```ts
function renderPage(org: Partial<OrgContextValue> = {}) {
  return render(
    <MemoryRouter>
      <ThemeProvider>
        <TourStyleProvider>
          <OrgContext.Provider value={{ ...orgValue, ...org }}>
            <SettingsPage />
          </OrgContext.Provider>
        </TourStyleProvider>
      </ThemeProvider>
    </MemoryRouter>,
  );
}
```

3. Append the new tests (add `within` to the `@testing-library/react` import):

```tsx
function rail() {
  return screen.getByRole("navigation", { name: /settings sections/i });
}

it("lists exactly the rendered sections in the rail", () => {
  renderPage(); // single-org member: no invitations, no danger zone
  const links = within(rail())
    .getAllByRole("link")
    .map((a) => a.textContent);
  expect(links).toEqual([
    "Account",
    "Appearance",
    "Members",
    "CI ingestion token",
    "AI",
  ]);
});

it("adds invitations and the danger zone for a multi-org owner", () => {
  renderPage({
    singleOrg: false,
    activeOrg: { id: "o1", name: "Asterius", slug: "asterius", role: "owner" },
  });
  const links = within(rail())
    .getAllByRole("link")
    .map((a) => a.textContent);
  expect(links).toEqual([
    "Account",
    "Appearance",
    "Members",
    "Invitations",
    "CI ingestion token",
    "AI",
    "Danger zone",
  ]);
  // …and the sections themselves render.
  expect(
    screen.getByRole("button", { name: /delete organization/i }),
  ).toBeInTheDocument();
  expect(screen.getByLabelText(/email \(optional\)/i)).toBeInTheDocument();
});

it("anchors rail links to their sections", () => {
  renderPage();
  const account = within(rail()).getByRole("link", { name: "Account" });
  expect(account).toHaveAttribute("href", "#account");
  expect(document.getElementById("account")).not.toBeNull();
});

it("marks the first section as current where nothing has scrolled", () => {
  renderPage(); // jsdom: no IntersectionObserver, spy stays on the first id
  expect(within(rail()).getByRole("link", { name: "Account" })).toHaveAttribute(
    "aria-current",
    "true",
  );
  expect(
    within(rail()).getByRole("link", { name: "Members" }),
  ).not.toHaveAttribute("aria-current");
});

it("groups the page under You / Organization / Workspace labels", () => {
  renderPage();
  // Once in the rail, once above the cards.
  expect(screen.getAllByText("You").length).toBeGreaterThanOrEqual(2);
  expect(screen.getAllByText("Organization").length).toBeGreaterThanOrEqual(2);
  expect(screen.getAllByText("Workspace").length).toBeGreaterThanOrEqual(2);
});

it("tints the danger zone card destructive", () => {
  renderPage({
    singleOrg: false,
    activeOrg: { id: "o1", name: "Asterius", slug: "asterius", role: "owner" },
  });
  const section = document
    .getElementById("danger")
    ?.querySelector("section");
  expect(section?.className).toContain("border-destructive/40");
});
```

- [ ] **Step 2: Run the tests to verify the new ones fail**

Run: `pnpm --filter @groundplan/frontend test src/pages/settings-page.test.tsx`
Expected: existing 7 tests PASS; the 6 new ones FAIL (no `navigation` role found).

- [ ] **Step 3: Restructure the page**

In `apps/frontend/src/pages/settings-page.tsx`:

1. Adjust imports — add `Fragment` off, add `useEffect`, `cn`, and the hook (keep everything already imported that's still used):

```tsx
import {
  type ReactNode,
  type SyntheticEvent,
  useEffect,
  useState,
} from "react";
```

```tsx
import { cn } from "@/lib/utils";
import { useScrollSpy } from "@/lib/use-scroll-spy";
```

2. Replace `SettingsPage`, lifting the visibility conditions out of the cards so rail and page can never disagree:

```tsx
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
      label: "You",
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
  const active = useScrollSpy(
    groups.flatMap((g) => g.sections.map((s) => s.id)),
  );

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
```

3. Simplify the two cards whose gating moved up. `InvitesCard` loses its hooks and early return:

```tsx
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
```

`DangerCard` drops `singleOrg`/`useCan` (the page gates) but keeps its
null-guard for types, and its `Section` gains the destructive tint:

```tsx
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
```

…body unchanged, and:

```tsx
    <Section
      icon={<Building2 className="size-4" />}
      title="Danger zone"
      description="Deleting an organization removes its projects, repositories and history. This cannot be undone."
      className="border-destructive/40"
    >
```

4. `Section` accepts the optional class:

```tsx
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
```

(header/body unchanged.)

- [ ] **Step 4: Run the settings tests**

Run: `pnpm --filter @groundplan/frontend test src/pages/settings-page.test.tsx`
Expected: PASS, 13 tests (7 existing + 6 new), including axe.

*(No commit yet — Task 3 verifies the whole surface first.)*

---

### Task 3: Full verification + the one commit

**Files:**
- No new files; commits Tasks 1–2 plus the plan document.

- [ ] **Step 1: Type-check and run the full frontend suite**

Run: `pnpm --filter @groundplan/frontend typecheck && pnpm --filter @groundplan/frontend test`
Expected: clean typecheck; every suite PASS (design-tokens guard included).

- [ ] **Step 2: See it working in the real app**

Use the project `verify` skill (Postgres + Keycloak + backend + frontend, real browser): open `/settings`, confirm the centered layout, sticky rail, active-section highlight while scrolling, anchor jump on click, and the three themes (Light/Blueprint/Carbon) rendering the rail correctly.

- [ ] **Step 3: Commit (the single implementation commit)**

```bash
git add apps/frontend/src/lib/use-scroll-spy.ts \
        apps/frontend/src/lib/use-scroll-spy.test.ts \
        apps/frontend/src/pages/settings-page.tsx \
        apps/frontend/src/pages/settings-page.test.tsx \
        docs/superpowers/plans/2026-07-18-settings-section-rail.md
git commit -m "feat(frontend): settings section rail — grouped sticky nav, centered two-column layout

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```
