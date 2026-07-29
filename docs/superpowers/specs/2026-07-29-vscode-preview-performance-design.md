# VS Code preview performance — design

Date: 2026-07-29
Status: approved (design), pending implementation plan
Scope: `apps/vscode` only — `packages/canvas` and `packages/graph-parser`
are not touched.

## Problem

The live preview (GP-148) re-derives everything from scratch on every
debounced keystroke. Measured on this machine, with the `examples/terraform`
stacks fanned out into synthetic workspaces:

| Work per refresh                                       | 45 files | 900 files | 2700 files |
| ------------------------------------------------------ | -------- | --------- | ---------- |
| `parse()` (already entrypoint-scoped)                  | 0.9 ms   | 0.7 ms    | 0.8 ms     |
| `detectRootCandidates` (regex over every file's bytes) | 0.1 ms   | 1.1 ms    | 3.2 ms     |
| reading every `.tf` (raw `fs` floor)                   | 23 ms    | 114 ms    | 190 ms     |

The parse is free and flat — the parser walks the entrypoint plus the
modules it sources, so at 2700 files it reads **six**. The cost is
`gatherTfFiles`: a full-workspace `findFiles` glob plus one
`vscode.workspace.fs.readFile` per file, nothing cached between refreshes.
The 23–190 ms above is the raw-`fs` floor; the real path goes through the
extension-host file service one RPC per file, so it is worse.

Three further costs found by reading:

- `refresh()` always posts a **new** snapshot object, and
  `graph-canvas.tsx:579` re-runs `elk.layout()` on graph object identity —
  so a full ELK layout fires every 500 ms while you type, even inside a
  comment that changes nothing.
- `refresh()` awaits three times with no re-entrancy guard, so a slow
  refresh can be overtaken and post stale state; and it runs in full while
  the panel is hidden.
- `BaselineProvider.read()` spawns one `git show` child process **per
  file** — 200 `.tf` files is 200 process spawns the first time diff mode
  turns on.

And the webview bundle is 2.38 MB minified in one chunk (3.7 MB rendered):

```text
1576 KB  42.6%  elkjs
 548 KB  14.8%  react-dom
 376 KB  10.2%  @groundplan/canvas
~350 KB   9.5%  micromark / mdast / unified / hast / vfile / remark-gfm
 100 KB   2.7%  tailwind-merge
```

That Markdown block is `AiResponse`, reaching the bundle only through the
`@groundplan/canvas` barrel's `export * from "./components/ai-response"`,
which Rollup cannot shake out. The extension is offline and never renders
AI prose.

## Decision

Six changes, all inside `apps/vscode`. The first is the headline: the
typing path stops doing I/O at all.

## 1. `src/tf-files.ts` — an incremental file cache

A cache holding `fsPath → { path, content }`, primed once by `findFiles`,
then maintained by the events the extension already subscribes to. Typing
costs **zero** I/O because the changed text arrives inside the event.

- `onDidChangeTextDocument` → store `e.document.getText()` directly.
- watcher `onDidCreate` / `onDidChange` → read that one file, **unless** an
  open document owns the path (the document event already carried it —
  which also removes today's duplicate refresh on save).
- watcher `onDidDelete` → drop one entry.
- `onDidCloseTextDocument` → re-read that path from disk. A discarded dirty
  buffer changes nothing on disk, so no watcher event fires and the cache
  would otherwise keep the abandoned text.

The cache applies `TF_EXCLUDE_GLOB` to document events too, which they do
not honour today: editing under `.terraform/` currently forces a refresh
that cannot change the graph.

**Staleness.** VS Code's file watcher honours the user's
`files.watcherExclude`, so a workspace can change without an event. A full
re-prime therefore runs on panel reveal and on git-change events — the two
moments the user is already waiting.

The cache logic takes an injected reader and imports no `vscode`, so
`node:test` covers it the way it covers `live-core.ts` and `root-dir.ts`.
The thin `vscode`-facing wiring stays in `extension.ts`.

`gatherTfFiles` keeps its signature as the cache's prime step.

## 2. Memoized root-candidate detection

`detectRootCandidates` regexes every file's content on every refresh. The
cache keeps a per-file memo of that file's local module sources, so
detection recomputes only for content that actually changed. `root-dir.ts`
stays pure and unchanged; the memo lives in the cache and feeds it the same
`{ path, content }` shape.

## 3. Post nothing when nothing changed

The host keeps the serialized signature of what it last sent — the posted
(possibly diff-annotated) snapshot plus `folder`, `rootDir`, `multiRoot`,
the `DiffState` and the out-of-sync flag — and skips all three
`postMessage` calls when the signature is unchanged. This is what stops the
per-keystroke ELK re-layout, from the extension side, with `packages/canvas`
untouched. Measured stringify cost on a 42-node snapshot is under 0.1 ms.

## 4. Generation guard, and deferral while hidden

- A counter incremented at the top of `refresh()` and checked after each
  await; a superseded run returns without posting.
- While `panel.visible` is false: parse and publish Problems diagnostics
  anyway (now ~1 ms, so the Problems panel stays honest), but skip the git
  baseline, the diff and the posts. A flag makes
  `onDidChangeViewState` post once on reveal.

## 5. One git process for the baseline

`git ls-tree -r <sha>` already runs; it also emits blob shas. Feed those to
a single `git cat-file --batch`, whose `<sha> <type> <size>` framing makes
splitting the concatenated contents unambiguous. Replaces N spawns with 2.

This is not the typing path — the baseline is cached per sha and warm after
the first read — but it is the extension's worst single stall. `runGit`
stays as it is (utf8, for the existing callers); the batch reader is a
separate buffer-mode function, because `cat-file --batch` output must be
split on byte counts, not characters.

## 6. Stub the Markdown renderer out of the webview bundle

A `resolve.alias` in `apps/vscode/vite.config.ts` points `react-markdown`
and `remark-gfm` at a local stub. The stub **throws with a clear message if
it is ever rendered**, so the assumption ("this webview shows no AI prose")
fails loudly rather than silently if it stops holding. A test asserts
`micromark` does not appear in the built `dist/webview/webview.js`, and
skips itself when `dist` has not been built — `pnpm test` must stay
runnable without a prior `pnpm build`.

This is the one build-level trick in the set, and the only way to reach the
saving without editing `packages/canvas`.

## Explicitly not done

These need `packages/canvas`, which is out of scope by decision:

- lazy-loading elkjs (1.58 MB, 42.6% of the bundle, eagerly `new ELK()` at
  module scope);
- dropping the statically-imported `NodeDetailsPanel` and its radix/
  `react-remove-scroll` tail, which the preview disables at runtime
  (`detailsPanel={false}`) but still bundles;
- trimming the cyrillic/greek/vietnamese font subsets (~850 KB of `.vsix`
  install size; no runtime cost, since browsers fetch only the subsets they
  use).

Nothing here adds a network call, telemetry, or any behaviour the offline
promise would not survive.

## Testing

- `tf-files.test.ts` — priming, the five event transitions, exclusion of
  vendored dirs, dirty-document precedence over disk, the discarded-buffer
  re-read, and the module-source memo invalidating only on changed content.
- `git-baseline.test.ts` — extended against real throwaway repositories to
  assert the batch reader returns byte-identical content to the old
  per-file `git show`, including a file containing NUL and non-ASCII bytes,
  and that a warm `get()` still performs zero git invocations.
- A pure signature helper covering change/no-change so the "post nothing"
  rule is testable without a webview.
- The bundle guard from part 6.

## Acceptance

- Typing in a `.tf` file performs no file reads beyond the changed
  document, verifiable by counting reads through the injected reader.
- A keystroke that does not change the graph posts no message.
- Refresh work is skipped while the panel is hidden and posted once on
  reveal.
- First diff-mode render spawns 2 git processes, not N.
- `dist/webview/webview.js` contains no `micromark`.
