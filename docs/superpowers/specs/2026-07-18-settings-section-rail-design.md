# Settings section rail — design

Date: 2026-07-18
Status: approved (design), pending implementation plan

## Problem

The Settings page (GP-69, grown through GP-116/GP-118) is a single
left-hugging `max-w-3xl` stack of seven cards: Account, Members,
Invitations, Appearance, CI ingestion token, AI, Danger zone. On a wide
viewport most of the screen is empty, there is no way to see what the page
contains without scrolling it end to end, and the Danger zone card looks
exactly like every other card until you reach its red button.

## Decision (user-validated)

GitHub/Stripe-style **section rail + scroll** — one route, one scroll, a
sticky secondary nav. Tabs and a mere single-column polish were considered
and rejected: tabs hide settings behind clicks; polish alone leaves the
page unscannable.

## Layout

- `PageHeader` stays as is.
- Below it, the body centers in the viewport: `mx-auto max-w-5xl` holding a
  flex row — a slim sticky rail (~176px wide, `sticky` below the header,
  `self-start`, hidden below `lg`) and the existing `max-w-3xl` content
  column (`min-w-0 flex-1`).
- Below `lg` the rail disappears entirely and the page is today's stacked
  scroll, centered.

## Rail

A `<nav aria-label="Settings sections">` listing only the sections that
actually render — Invitations (admin+, multi-org) and Danger zone (owner,
multi-org) drop from the rail exactly when their sections drop from the
page. Entries are grouped under the tiny uppercase mono labels the app
sidebar already uses:

- **You** — Account, Appearance
- **Organization** — Members, Invitations
- **Workspace** — CI ingestion token, AI
- **Danger zone** — last, ungrouped

This reorders the page: Appearance moves up beside Account (your things
first, org things second, server config third, destructive last).

Each entry is an `<a href="#account">`-style anchor. Clicking
smooth-scrolls (sections carry `id` + `scroll-mt`); a hash in the URL on
load scrolls to its section. A small `useScrollSpy` hook
(IntersectionObserver) tracks the section nearest the top and the rail
highlights it with the sidebar's exact active treatment
(`border-l-2 border-primary text-primary`, inactive
`text-muted-foreground` + hover) so the two navs read as one system.
Active entry sets `aria-current="true"`.

## Sections

The `Section` card component and every content component stay:
`OrgMembers`, `OrgInvites`, `AppIngestionSettings`, `ThemeSwitcher`,
`TourStyleSwitcher`, the delete-org dialog. This is a navigation and
layout redesign, not a rewrite. Two polish touches:

- Each rail group's label also renders once above its run of cards in the
  content column (same uppercase mono style), giving the scroll the same
  hierarchy the rail has.
- The Danger zone card gets a destructive-tinted border
  (`border-destructive/40`) so it reads as dangerous before the button.

All colours via semantic tokens; the `design-tokens.test.ts` guard
applies.

## Error handling / edge cases

- Single-org mode: Invitations and Danger zone vanish (unchanged); their
  rail entries and, when a group empties, the group label vanish with
  them. The Organization group never empties (Members always renders).
- jsdom has no IntersectionObserver: the hook guards for its absence
  (no-op, first section active) so existing tests keep running.
- A hash pointing at a hidden section (e.g. `#danger` as a member) simply
  does not scroll — no error.

## Testing

TDD; frontend vitest + Testing Library + vitest-axe.

- All existing `settings-page.test.tsx` assertions keep passing (same
  headings, same components, same conditional rendering).
- New: rail lists exactly the rendered sections (single-org hides
  Invitations/Danger in both places); entries link to the section ids;
  active entry carries `aria-current`; `useScrollSpy` unit test with a
  mocked IntersectionObserver; axe stays clean with the new nav.

## Addendum (found in browser verification)

- **Click/hash pins the highlight.** The page is short: the tail sections can
  never reach the spy's reading line, so geometry alone contradicted an
  explicit click (clicking "AI" left "Members" highlighted). A click — or an
  arriving `#hash` — pins its section as active; real scrolling
  (wheel/touchmove) unpins and hands back to the spy.
- **The auth flow dropped URL hashes.** `RequireAuth` stored
  `pathname + search` as the OIDC return target, so a fresh arrival at
  `/settings#ci-token` came back from Keycloak as `/settings`. It now
  preserves the hash too — a one-line fix in `require-auth.tsx`, with a test.

## Out of scope

- No route changes (`/settings` remains one page), no new backend calls,
  no changes to members/invites/token component internals, no mobile
  drawer for the rail.
