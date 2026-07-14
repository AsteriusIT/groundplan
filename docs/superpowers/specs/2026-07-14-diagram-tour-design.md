# Guided tours of a diagram (GP-78 / GP-79)

_Design — 2026-07-14_

## What this is

An AI-generated **tour**: an ordered walk through a snapshot, stopping at nodes and
groups and saying, in prose, what each one is and — for a change — what happened to
it. The model produces JSON; the application plays it, flying the camera to each
step's anchors and narrating them.

Two kinds, one shape:

- **`change_tour`** — a plan snapshot. "What this PR does", stop by stop.
- **`system_tour`** — an hcl (docs) snapshot. "Meet this estate", stop by stop.

The kind is **derived from `snapshot.source`**, never named by the caller, so there
is no wrong-source case to handle.

## The contract

```jsonc
{
  "title": "Adds an ingestion queue behind the existing subnet",
  "view": "infra",                    // the lens the tour was written against
  "steps": [
    { "anchors": [],                                  // empty = frame the whole diagram
      "title": "What this PR does",
      "body": "Three resources change; none are internet-facing." },
    { "anchors": ["azurerm_servicebus_queue.ingest"],
      "title": "The new ingestion queue",
      "body": "Everything the PR adds hangs off `queue-ingest`. It sits inside
               `subnet-app`, so it inherits that NSG." }
  ]
}
```

- `view` — `infra` for a change tour. For a system tour: `adapted` when the repo has
  `group` annotations (so steps can anchor to real, human-named groups), `infra`
  otherwise. The player switches to this view on start and locks the switcher;
  exiting restores the view the user was on.
- `anchors` — 0..5 node ids. A Terraform address, a module container id, or (in an
  adapted tour) a `group:<annotationId>` id. **Empty means "frame everything"** —
  the opener and the closer.
- `body` — prose plus inline code. Rendered through the existing `AiResponse`
  (react-markdown, no `rehype-raw`); model output stays untrusted input.
- 3–8 steps.

**A snapshot is immutable, so a cached tour cannot go stale.** Unlike annotations,
nothing an anchor points at can move underneath it. There is no reconciliation story.

## Backend (GP-78)

Everything here is the GP-75 proposer's rails, reused:

- **Kinds** `change_tour` / `system_tour` added to the `ai_generation_kind` enum
  (migration = `ALTER TYPE … ADD VALUE`, as in `drizzle/0019`). **No new table** — a
  tour is a derivation of one snapshot, cached under the key the whole AI layer
  uses: `(kind, snapshot id, prompt version, model)`. Ask twice, pay once.
- **Prompts** are files — `prompts/change-tour.md`, `prompts/system-tour.md`. The
  file's content hash _is_ the cache version, so editing a prompt regenerates every
  tour with nothing to remember to bump.
- **Briefs** are two new pure builders in `services/ai-input.ts`, composed from the
  section helpers that already exist. Each ends with a **verbatim node table** (the
  trick `buildProposalInput` uses) so the model can only anchor to ids it was
  literally shown. A system tour's table is built from `projectAdapted(graph,
  annotations)` — that is how group ids become anchorable.
- **`services/tour.ts`** — `generateTour(db, provider, {...})`, shaped exactly like
  `proposeAnnotations`: `loadPrompt` → cache key → `readCached` or drain the
  provider → `parseTour` → validate → insert.
- **Validation is two-tier.**
  - The response is not JSON we can read → `MalformedTourError` → **502, and
    nothing is written, cache included.** A cached failure is a failure served
    forever.
  - One step anchors at something not in the snapshot → **that step is dropped**,
    and logged. Not fatal.
  - Caps (8 steps, 5 anchors) truncate, and say so in the log. No silent caps.
  - A tour that validates down to **zero steps is a 502**, not an empty success. An
    empty proposal set is a respectable answer; an empty tour is a failure.
- **Routes** `GET|POST /api/v1/snapshots/:id/tour`. Returns JSON, not a stream — you
  cannot play a half-parsed tour. `!app.ai.model` → 404, so the feature vanishes with
  the flag like every other AI surface. `409` when a generation for the same target
  is already in flight (the `inFlight` lock, extracted from `streamGeneration` into a
  reusable `withGenerationLock`). Share links never see a tour.

## Frontend (GP-79)

**One engine, two chromes, one setting.**

`useTourPlayer(tour)` owns the state machine: current index, `next` / `prev` /
`goTo` / `exit`, and the anchors of the current step. It is the only thing that
knows what "being on step 3" means.

`GraphCanvas` gains a `tour` prop and does two things with it:

- **Camera** — `fitView({ nodes: anchors.map(id => ({id})), duration: 600,
  maxZoom: 1.4, padding: 0.3 })`, or a whole-graph `fitView()` when `anchors` is
  empty. `fitView` already accepts a set of nodes; nothing new is needed.
- **Spotlight** — reuse the `dimmed` / `picked` flags that `elkToFlow` already
  computes: everything outside the step's anchors is dimmed, the anchors get the
  ring. **Deliberately not a dark scrim over the canvas**: React Flow paints nodes
  in one pane, so lifting the lit ones above a scrim is z-index surgery for a read
  the existing dim already gives.

The two chromes:

- **Spotlight (option A)** — `<NodeToolbar nodeId={step.anchors} isVisible>`. React
  Flow's `NodeToolbar` takes `string | string[]` and renders **one card for a
  collection of nodes**, in screen space, **not scaled by the viewport**. That is
  exactly a coach mark for a multi-anchor step: no screen-coordinate maths, no flip
  logic. An anchor-less step falls back to a centred `<Panel>`.
- **Guide (option C)** — `TourRail`, a docked `<aside>` flex sibling of the canvas,
  the same shape as `ProposalInbox`. The whole step list, current step expanded,
  click any step to jump. Replaces the AI/summary rail while a tour runs.

**The setting** — `groundplan-tour-style` (`"spotlight" | "guide"`, default
`spotlight`), a provider mirroring `theme/theme-provider.tsx` line for line, and a
switcher in **Settings → Appearance**, beside the theme switcher. CLAUDE.md already
makes Settings the only home for appearance preferences.

Keyboard in both modes: `→`/`Space` next, `←` back, `Esc` exit.

Entry point: a "Take the tour" action on the PR page and the docs page, absent
entirely when `useAiStatus()` reports the layer off.

## Testing

Backend (`node --test` + a stub provider — never a real model):

- `ai-input.test.ts` — golden briefs for both builders.
- `tour.test.ts` — parse a fenced response, a prose-padded one, garbage (throws);
  anchor drop; caps; zero-steps-after-validation throws.
- `routes/tours.test.ts` — 404 with the flag off, cache hit makes zero provider
  calls, `regenerate` re-runs, 502 on garbage (and **nothing cached**), 409 in flight.

Frontend (vitest + Testing Library + `vitest-axe`):

- The engine: step navigation, keyboard, exit restores the previous view.
- Each chrome renders the current step; the rail can jump.
- The setting persists and switches which chrome mounts.

## Out of scope (deliberately)

- **No human editing of tours, no `tours` table.** A tour is a derivation, not a
  thing you own. If curation is wanted later, that is an annotation-shaped epic.
- No autoplay or timed advance.
- No per-step view switching (an ELK re-layout mid-fly is jank with no payoff yet).
- No edge anchors — nodes and groups only.
- No tours on public share links.
