# VS Code diff mode — compare against any branch

Design for removing the hardcoded `main` from the extension's diff baseline:
detect the repository's actual default branch, and let the reader compare
against any branch through a native QuickPick.

Scope: `apps/vscode` only (host + webview). Not in scope: the backend, the web
frontend, `@groundplan/graph-differ` (the differ never learns about refs), and
the extension's offline guarantee, which is unchanged — every new call is a
local `git` invocation.

## 1. The problem

Diff mode offers two baselines: `HEAD` and "main". The second is a lie on any
repository whose trunk is not called `main`. Three layers bake the name in:

- resolution — `git-baseline.ts` tries `origin/main`, then `main`, then throws
  `no origin/main or main branch to compare against`;
- the wire type — `BaselineMode = "head" | "merge-base"`, where `"merge-base"`
  silently means *merge-base with main*;
- the copy — `strings.diff.base` maps `"merge-base"` to the literal `"main"`,
  and the popover row reads `main — everything on this branch`.

A team on `master` gets `No baseline` and no way to fix it. A team that reviews
against a release branch has no way to ask for it at all.

## 2. Shape

Three baselines instead of two, and the second one stops naming a branch:

```text
Compare against
  (●) HEAD — what you have not committed yet
  ( ) master — everything on this branch          ← the detected default branch
  ( ) release/2.4                                  ← only while it is the mode
                                       [ Branch… ]  ← opens a native QuickPick

  [ ] Changed only
```

The semantics of the second and third rows are identical — `git merge-base HEAD
<ref>` — and identical to what `"merge-base"` already meant. They differ only in
which ref is named, and by whom.

## 3. The model

`BaselineMode` widens to a tagged string:

```ts
export type BaselineMode = "head" | "merge-base" | `branch:${string}`;
```

The suffix is a **full** ref name (`branch:refs/remotes/origin/master`), never a
short one. Full names disambiguate the local `master` from `origin/master`, and
they cannot be mistaken for a `git` option, which a user-supplied short name
beginning with `-` could be.

A tagged string rather than a discriminated union or a parallel `branch` field,
because three call sites depend on `mode` comparing by `===`:

- `samePrefs` in `webview/state/panel-state.ts`, whose identity result decides
  whether the panel re-renders — a deep compare there would remount the canvas
  on every keystroke;
- `BaselineProvider.refByMode`, a `Map` keyed by mode;
- the prefs document, which is flat JSON in `workspaceState`.

`"merge-base"` keeps its key and changes its meaning: from *merge-base with
main* to *merge-base with this repository's default branch*. Existing stored
preferences therefore need no migration, and a user on a `master` repository is
fixed without touching anything.

Three helpers live beside the type in `src/messages.ts`, which both bundles
import:

| Helper | Behaviour |
| --- | --- |
| `branchMode(ref)` | `` `branch:${ref}` `` |
| `branchRefOf(mode)` | the full ref, or `null` for `head`/`merge-base` |
| `shortRef(ref)` | `refs/heads/x` → `x`; `refs/remotes/origin/x` → `origin/x`; otherwise verbatim |

`parsePanelPrefs` replaces its `MODES.find` membership test with a predicate
that also validates the ref: it must start with `refs/`, contain no whitespace
or control characters, contain no `..`, and be at most 255 characters. Anything
else falls back to `"head"`, keeping that file's existing posture — a stored
document is untyped input and every field falls back on its own.

## 4. Resolution

`BaselineProvider` gains one private step, `defaultBranch()`, memoised beside
`refByMode` and cleared by the same `invalidate()` — so a checkout, a fetch or a
branch rename re-resolves it, and nothing else does.

1. `git symbolic-ref --quiet refs/remotes/origin/HEAD` — authoritative when the
   clone has it (`git clone` sets it; `git remote set-head -a` restores it).
   Verified rather than trusted: `origin/HEAD` can outlive the branch it names,
   and a dangling pointer falls through to the candidates instead of becoming a
   baseline that cannot be read.
2. Otherwise the first ref that `git rev-parse --verify` resolves, in order:
   `refs/remotes/origin/{main,master,trunk}`, then `refs/heads/{main,master,trunk}`.
   Remote-tracking first: it is what the team shares.
3. Neither → the baseline is unavailable, with the reason `no default branch
   found — pick one to compare against`.

The memoisation holds the *outcome*, absence included — an outer null means
"not looked yet", an inner one means "looked, found nothing". Without that
distinction a repository with no trunk would re-detect on every refresh, and
the panel asks for this name even with diff mode off. Because detection only
ever returns a ref that resolves, `resolve()` re-checks existence for a
**named** branch only, keeping the common path at one `git` invocation.

`resolve(mode)` then reads:

| Mode | Baseline | `ref` caption |
| --- | --- | --- |
| `head` | `git rev-parse HEAD` | `HEAD` |
| `merge-base` | `git merge-base HEAD <default>` | `merge-base origin/master` |
| `branch:<ref>` | `git merge-base HEAD <ref>` | `merge-base origin/release/2.4` |

Failures stay in the existing `{ ok: false, reason }` channel — the panel keeps
drawing the live view and says why it is not drawing a diff — and are told
apart, because they mean different things to a reader:

- `git rev-parse --verify <ref>` fails → `branch "origin/release/2.4" not found`;
- `git merge-base` fails → `no common commit with "origin/release/2.4"`.

The chosen mode is **kept** across either failure. A branch that is missing
because nobody has fetched it yet heals by itself: the existing `.git` watcher
fires on the fetch, `invalidate()` clears the resolution, and the next refresh
resolves it. Falling back to another baseline was considered and rejected — a
diagram that silently answers a question the reader did not ask is the one
failure mode this feature cannot afford.

`DiffState` gains `defaultBranch: string | null` (short form, via `shortRef`) so
the popover can print the real name rather than the word "main". `DiffFacts` in
`webview/state/panel-state.ts` is a `Pick` of `DiffState` and adds the field to
its key list — it belongs there and not in `DiffPrefs`, because which branch the
repository calls its default is something the host observed, not something the
reader chose.

One deliberate cost: `defaultBranch()` resolves even when diff mode is **off**,
because the base can be chosen before the diff is enabled. A workspace that
makes zero `git` calls with diff off will now make one `symbolic-ref` per
checkout or fetch. It is memoised and invalidated only by the ref watcher, so
the GP-152 guarantee that stands — keystrokes cause no `git` invocation, and a
warm `get()` causes none either — is unaffected.

## 5. The picker

One new webview → host message, `{ type: "pickDiffBase" }`. Everything else
happens in the host:

1. list refs — `git for-each-ref --sort=-committerdate refs/heads refs/remotes`,
   dropping `refs/remotes/*/HEAD`, most recently committed first. This lives in
   a new `src/branches.ts` (`listBranches(git, cwd)` over the injected
   `GitRunner`, plus a pure `parseBranchRefs(output)`), for the same reason
   `git-baseline.ts` exists as its own module: it imports no `vscode` and can
   be exercised against real throwaway repositories;
2. `vscode.window.showQuickPick` — label is the short name, description is the
   relative commit date, and the current baseline is flagged in its description;
3. on a pick, write `mode: branch:<full ref>` into the prefs document and call
   `refresh()`;
4. on cancel, change nothing;
5. on a `git` failure, `showWarningMessage` with the reason and change nothing.

No new host → webview message is required. `diffState` accompanies every
snapshot and already carries `enabled`, `mode` and `changedOnly`;
`webview/app.tsx` already dispatches `hostDiffPrefs` from it, and that action
preserves identity when the preferences have not moved. The webview therefore
learns the new mode through the path it already uses, and never receives a
branch list — it cannot leak one and it cannot hold a stale one.

A native QuickPick rather than a list inside the popover: it brings fuzzy
matching, scrolling and keyboard handling that a repository with hundreds of
branches needs, and none of it has to be built or tested.

## 6. Chrome

`webview/components/diff-popover.tsx` replaces its fixed two-entry `BASES` array
with rows derived from state:

- `HEAD`, always;
- the default branch, always, labelled with `facts.defaultBranch` when it
  resolved and `Default branch` when it did not;
- the chosen branch, **only while a branch is the active mode**, labelled with
  `shortRef`;
- a `Branch…` button, wired through its own `onPickBranch` prop rather than a
  `PanelAction`. Asking the host to open a picker is a request, not a state
  change, and the reducer stays about state; `app.tsx` closes the popover and
  posts `pickDiffBase`.

`parseBranchRefs` puts every candidate through the same `isBaselineMode` gate
the stored preference passes: a ref the extension would refuse to resolve has
no business being offered as a choice.

The third row is deliberately not sticky, and no last-branch-picked field is
stored. The frequent toggle is HEAD ↔ default branch, which rows one and two
serve; choosing a release branch is a once-per-task action, and the QuickPick's
most-recent-first ordering makes re-choosing one keystroke. A remembered branch
would be state that can disagree with `mode` for no proportionate gain.

`webview/strings.ts` turns two constants into functions: the `base` lookup table
becomes `baseLabel(mode, defaultBranch)`, used by the toolbar button and its
accessible name, and `baseMergeBase` becomes a function of the detected name.
The status bar is unchanged in structure — it already prints the resolved `ref`
and `sha`, which now read `merge-base origin/master` instead of a hardcoded
`main`.

## 7. Testing

Following the repository's TDD convention, tests sit beside their subject.

`src/git-baseline.test.ts`, against throwaway repositories as the file already
does:

- `origin/HEAD` wins over the candidate list;
- an `origin/HEAD` pointing at a deleted branch falls through to the candidates;
- a repository with no remote falls back to `refs/heads/master`;
- a repository with neither reports `no default branch found`;
- `branch:refs/heads/x` resolves and captions `merge-base x`;
- an absent ref reports `branch "…" not found`;
- unrelated histories report `no common commit with "…"`;
- the existing assertion that a warm `get()` performs **zero** `git`
  invocations still passes with `defaultBranch()` memoised.

`src/panel-prefs.test.ts`: `branch:refs/heads/x` round-trips; refs that are
malformed, leading-`-`, whitespace-bearing or over-long fall back to `"head"`;
stored `"head"` and `"merge-base"` still parse.

`webview/state/panel-state.test.ts` and
`webview/components/diff-popover.test.tsx`: the third row renders only in branch
mode; the default row prints the detected name and degrades to `Default branch`;
`Branch…` posts `pickDiffBase`; `setBase` with a branch mode moves state.

`src/branches.test.ts`: `parseBranchRefs` reads the `for-each-ref` records and
drops `refs/remotes/*/HEAD`; ordering is most-recent-first; a repository with
one branch and no remote yields one entry; a `git` failure propagates rather
than yielding an empty list, so the picker can warn instead of offering nothing.

What is *not* unit-tested, and why: the `showQuickPick` call itself and the
prefs write live in `extension.ts`, which imports `vscode` and has no test file
in this extension — every testable seam is extracted out of it by convention,
which is what `src/branches.ts` is for here. Cancel-changes-nothing and
warn-on-failure are verified by hand against a real workspace.

## 8. Out of scope

- No `groundplan.diff.baseBranch` setting — the picker already persists per
  workspace, and a second source of truth would have to be reconciled with it.
- No tags, no arbitrary revisions, no detached commits: branches only.
- No branch-tip baseline — merge-base is what "everything on this branch" means,
  and a tip baseline would make a colleague's push change your diagram.
- No command-palette entry for the picker.
- No network access and no telemetry, per the extension's standing rule.

## 9. Delivery

One commit, `feat(vscode): …`. No Jira key: this was implemented directly at the
author's request rather than filed as a story under the VS Code diff-mode line
(GP-151/GP-152/GP-154). Files touched:

- new: `src/branches.ts`, `src/branches.test.ts`, `src/messages.test.ts`;
- changed: `src/messages.ts`, `src/git-baseline.ts`, `src/panel-prefs.ts`,
  `src/extension.ts`, `webview/app.tsx`, `webview/strings.ts`,
  `webview/components/diff-popover.tsx`, `webview/components/toolbar.tsx`,
  `webview/state/panel-state.ts`;
- changed tests: `src/git-baseline.test.ts`, `src/panel-prefs.test.ts`,
  `webview/components/diff-popover.test.tsx`,
  `webview/components/toolbar.test.tsx` (the base label became a function),
  `webview/app.test.tsx` and `webview/state/status-notice.test.ts` (fixtures);
- docs: `apps/docs/src/content/docs/use/vscode.md` and the VS Code paragraph in
  `CLAUDE.md`. The website copy needs no change — it says "git HEAD or your
  branch's merge-base", which stays true.

No `package.json` contribution changes: no new setting and no new command.
