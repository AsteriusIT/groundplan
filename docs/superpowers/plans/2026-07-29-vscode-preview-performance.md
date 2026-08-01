# VS Code preview performance — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the VS Code live preview cost no file I/O per keystroke, stop it re-laying out the diagram when nothing changed, and drop the dead Markdown renderer from its webview bundle.

**Architecture:** The extension host keeps the workspace's `.tf` files in an incremental cache fed by the events it already subscribes to — a document change carries its own text, so typing reads nothing from disk. Everything derived from those bytes (entrypoint candidates, the posted snapshot signature) is memoized against the same cache, and `refresh()` gains a generation guard plus deferral while the panel is hidden. Separately, the git baseline reads its file set through one `git cat-file --batch` instead of one `git show` per file, and the webview build aliases the Markdown renderer to a throwing stub.

**Tech Stack:** TypeScript (strict, `NodeNext`, `.js` extensions on relative imports), `node:test` + `node:assert/strict`, esbuild (extension host) + Vite (webview), `@groundplan/graph-parser`, `@groundplan/graph-differ`.

## Global Constraints

- **Scope is `apps/vscode` only.** `packages/canvas`, `packages/graph-parser` and `packages/graph-differ` are not modified. Any fix must land on the extension side.
- **The extension is fully offline** — never add a network call or telemetry.
- `apps/vscode` resolves with `moduleResolution: "Bundler"` — relative imports
  there are **extensionless** (`from "./paths"`). The `.js`-extension rule in
  CLAUDE.md is the backend's `NodeNext` convention and does not apply here.
- TypeScript `strict`, plus `noUncheckedIndexedAccess` and `noUnusedLocals/Parameters`. Don't loosen these — fix the code.
- Tests live beside their subject as `*.test.ts` and run with `pnpm --filter groundplan-vscode test` (`node --import tsx --test "src/**/*.test.ts"`).
- Files under `src/` that carry logic must not `import * as vscode` unless they are the wiring layer (`extension.ts`, `workspace-files.ts`) — the pure modules are what `node:test` can reach.
- Never write a test that calls a real model or network. Git tests build real throwaway repositories in temp dirs, as `git-baseline.test.ts` already does.
- Behaviour must not change: same diagram, same Problems entries, same diff semantics. This is a performance plan.

**Reference:** `docs/superpowers/specs/2026-07-29-vscode-preview-performance-design.md`

---

## File Structure

**Created:**

- `apps/vscode/src/tf-files.ts` — the incremental `.tf` cache. No `vscode` import; the reader is injected. Owns the per-file local-module-source memo.
- `apps/vscode/src/tf-files.test.ts` — every cache transition, offline.
- `apps/vscode/webview/stubs/react-markdown.ts` — throwing stand-in for the Markdown renderer.
- `apps/vscode/webview/stubs/remark-gfm.ts` — throwing stand-in for the GFM plugin.
- `apps/vscode/src/bundle.test.ts` — asserts the built webview carries no Markdown machinery.

**Modified:**

- `apps/vscode/src/paths.ts` — gains `isDiagramTf`, the one exclusion rule (today duplicated in `git-baseline.ts`).
- `apps/vscode/src/root-dir.ts` — split into memoizable pieces (`localModuleSources`, `candidatesFrom`, `resolveFromCandidates`); public API preserved.
- `apps/vscode/src/workspace-files.ts` — `gatherTfFiles` replaced by `findTfPaths` + `readTfFile` (the cache's glob and reader).
- `apps/vscode/src/live-core.ts` — gains `postSignature`, the "what the panel was last told" contract.
- `apps/vscode/src/git-baseline.ts` — one `git cat-file --batch` instead of N `git show`.
- `apps/vscode/src/extension.ts` — wires the cache, the generation guard, the hidden-panel deferral, the post dedupe.
- `apps/vscode/vite.config.ts` — the two stub aliases.

---

### Task 1: One exclusion rule, and a splittable root-dir

`isDiagramTf` exists in `git-baseline.ts` and is about to be needed by the cache; `detectRootCandidates` regexes every file's bytes on every refresh and needs to come apart so a caller holding a per-file memo can skip unchanged content. Pure refactor — no behaviour change.

**Files:**

- Modify: `apps/vscode/src/paths.ts`
- Modify: `apps/vscode/src/root-dir.ts:52-69` (`detectRootCandidates`), `:97-107` (`resolveRootDir`)
- Modify: `apps/vscode/src/git-baseline.ts:64-70` (delete the local copy)
- Test: `apps/vscode/src/paths.test.ts`, `apps/vscode/src/root-dir.test.ts`

**Interfaces:**

- Consumes: nothing from earlier tasks.
- Produces:
  - `isDiagramTf(path: string): boolean` from `./paths`
  - `localModuleSources(path: string, content: string): string[]` from `./root-dir`
  - `candidatesFrom(tfPaths: Iterable<string>, sourced: Iterable<string>): string[]` from `./root-dir`
  - `resolveFromCandidates(configured: string, preferred: string | null, candidates: string[]): string` from `./root-dir`

- [ ] **Step 1: Write the failing tests**

Append to `apps/vscode/src/paths.test.ts`:

```ts
test("isDiagramTf mirrors TF_EXCLUDE_GLOB for paths that never pass a glob", () => {
  assert.equal(isDiagramTf("main.tf"), true);
  assert.equal(isDiagramTf("envs/prod/main.tf"), true);
  assert.equal(isDiagramTf("readme.md"), false);
  assert.equal(isDiagramTf(".terraform/modules/x/main.tf"), false);
  assert.equal(isDiagramTf("modules/node_modules/pkg/main.tf"), false);
  // A directory merely *named* like one is still ours.
  assert.equal(isDiagramTf("terraform/main.tf"), true);
});
```

and add `isDiagramTf` to that file's import from `./paths`.

Append to `apps/vscode/src/root-dir.test.ts`:

```ts
test("localModuleSources resolves local sources against the file's own directory", () => {
  assert.deepEqual(
    localModuleSources("envs/prod/main.tf", 'module "net" {\n  source = "../../modules/net"\n}\n'),
    ["modules/net"],
  );
  assert.deepEqual(
    localModuleSources("main.tf", 'module "a" {\n  source = "./mod/a"\n}\n'),
    ["mod/a"],
  );
  // Registry and git sources are not local directories.
  assert.deepEqual(
    localModuleSources("main.tf", 'module "r" {\n  source = "hashicorp/consul/aws"\n}\n'),
    [],
  );
  // A source pointing at its own directory names no other candidate.
  assert.deepEqual(localModuleSources("infra/main.tf", 'source = "./"\n'), []);
});

test("candidatesFrom folds paths + sourced dirs exactly as detectRootCandidates does", () => {
  const files = [
    tf("envs/prod/main.tf", 'module "net" {\n  source = "../../modules/net"\n}\n'),
    tf("modules/net/net.tf"),
  ];
  const sourced = files.flatMap((f) => localModuleSources(f.path, f.content));
  assert.deepEqual(
    candidatesFrom(files.map((f) => f.path), sourced),
    detectRootCandidates(files),
  );
});

test("resolveFromCandidates honours setting, then pick, then the first candidate", () => {
  assert.equal(resolveFromCandidates("infra", "envs/dev", ["envs/dev", "envs/prod"]), "infra");
  assert.equal(resolveFromCandidates("", "envs/prod", ["envs/dev", "envs/prod"]), "envs/prod");
  // A pick that is no longer a candidate falls back to detection, never a blank.
  assert.equal(resolveFromCandidates("", "gone", ["envs/dev", "envs/prod"]), "envs/dev");
  assert.equal(resolveFromCandidates("", null, []), "");
});
```

and add `candidatesFrom`, `localModuleSources`, `resolveFromCandidates` to that file's import from `./root-dir`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter groundplan-vscode test`
Expected: FAIL — `isDiagramTf is not a function`, `localModuleSources is not a function`, etc.

- [ ] **Step 3: Add `isDiagramTf` to `paths.ts`**

Append to `apps/vscode/src/paths.ts`:

```ts
/** The directory names `TF_EXCLUDE_GLOB` hides — the same list, as a predicate. */
const EXCLUDED_SEGMENTS = new Set([".terraform", "node_modules"]);

/**
 * Is this folder-relative posix path a `.tf` file the diagram should read?
 * The glob covers `findFiles`; this covers everything that never passes a
 * glob — git's `ls-tree` output and VS Code's document events.
 */
export function isDiagramTf(path: string): boolean {
  if (!path.endsWith(".tf")) return false;
  return !path.split("/").some((segment) => EXCLUDED_SEGMENTS.has(segment));
}
```

- [ ] **Step 4: Delete the duplicate in `git-baseline.ts`**

Remove lines 64–70 (the `EXCLUDED_SEGMENTS` const, the `isDiagramTf` function and their comment) and take it from `paths.js` instead — change the existing import:

```ts
import { isDiagramTf, toPosixRelative } from "./paths";
```

- [ ] **Step 5: Split `root-dir.ts`**

Replace `detectRootCandidates` (lines 45–69) with:

```ts
/**
 * The directories a file sources as a *local* module. Split out of
 * `detectRootCandidates` so a caller holding a per-file memo of this (the
 * file cache) never re-scans bytes that did not change.
 */
export function localModuleSources(path: string, content: string): string[] {
  const dir = dirOf(path);
  const out: string[] = [];
  for (const match of content.matchAll(LOCAL_SOURCE_RE)) {
    const target = normalizeRelative(`${dir}/${match[1]}`);
    if (target && target !== dir) out.push(target);
  }
  return out;
}

/**
 * Every plausible entrypoint, shallowest (then alphabetical) first, given the
 * `.tf` paths and the directories some *other* directory sources as a module
 * — a module is part of a stack, not a stack. The workspace root, when it
 * holds `.tf`, is simply the first candidate. Deterministic, so a multi-stack
 * workspace gets a predictable default and a stable list to switch between.
 */
export function candidatesFrom(
  tfPaths: Iterable<string>,
  sourced: Iterable<string>,
): string[] {
  const dirs = new Set<string>();
  for (const path of tfPaths) dirs.add(dirOf(path));
  const sourcedSet = new Set(sourced);
  const unsourced = [...dirs].filter((dir) => !sourcedSet.has(dir));
  const pool = unsourced.length > 0 ? unsourced : [...dirs];
  return pool.sort(byDepthThenName);
}

/** The same candidates, computed from scratch over a whole file set. */
export function detectRootCandidates(files: TfFileLike[]): string[] {
  const tfFiles = files.filter((file) => file.path.endsWith(".tf"));
  const sourced: string[] = [];
  for (const file of tfFiles) {
    sourced.push(...localModuleSources(file.path, file.content));
  }
  return candidatesFrom(
    tfFiles.map((file) => file.path),
    sourced,
  );
}
```

Replace `resolveRootDir` (lines 91–107) with:

```ts
/**
 * The effective entrypoint given candidates already in hand, in order of
 * authority: the `groundplan.rootDir` setting; the stack the user last picked
 * in the panel — honoured only while it still exists as a candidate, so a
 * deleted directory falls back to detection instead of a blank; the detected
 * default.
 */
export function resolveFromCandidates(
  configured: string,
  preferred: string | null,
  candidates: string[],
): string {
  const explicit = normalizeRootSetting(configured);
  if (explicit) return explicit;
  if (preferred !== null && candidates.includes(preferred)) return preferred;
  return candidates[0] ?? "";
}

/** The same rule, detecting the candidates from a whole file set. */
export function resolveRootDir(
  configured: string,
  preferred: string | null,
  files: TfFileLike[],
): string {
  // An explicit setting wins without scanning a single file's bytes.
  const explicit = normalizeRootSetting(configured);
  if (explicit) return explicit;
  return resolveFromCandidates("", preferred, detectRootCandidates(files));
}
```

- [ ] **Step 6: Run the whole suite**

Run: `pnpm --filter groundplan-vscode test && pnpm --filter groundplan-vscode typecheck`
Expected: PASS — including every pre-existing `root-dir.test.ts` and `git-baseline.test.ts` case, which is the point: this task changed no behaviour.

- [ ] **Step 7: Commit**

```bash
git add apps/vscode/src/paths.ts apps/vscode/src/paths.test.ts \
        apps/vscode/src/root-dir.ts apps/vscode/src/root-dir.test.ts \
        apps/vscode/src/git-baseline.ts
git commit -m "refactor(vscode): one exclusion rule, and a splittable root-dir"
```

---

### Task 2: The incremental `.tf` cache

The heart of the plan. Pure enough for `node:test`: the reader is injected, so every transition is driven offline and the read count is assertable.

**Files:**

- Create: `apps/vscode/src/tf-files.ts`
- Test: `apps/vscode/src/tf-files.test.ts`

**Interfaces:**

- Consumes: `isDiagramTf`, `toPosixRelative` from `./paths`; `candidatesFrom`, `localModuleSources` from `./root-dir` (Task 1).
- Produces:
  - `type TfFile = { path: string; content: string }`
  - `type ReadFile = (fsPath: string) => Promise<string>`
  - `class TfFileCache` with `constructor(folder: string, readFile: ReadFile)`, `prime(fsPaths: string[]): Promise<void>`, `set(fsPath: string, content: string): boolean`, `read(fsPath: string): Promise<boolean>`, `remove(fsPath: string): boolean`, `files(): TfFile[]`, `candidates(): string[]`

- [ ] **Step 1: Write the failing test**

Create `apps/vscode/src/tf-files.test.ts`:

```ts
/**
 * The incremental `.tf` cache: the preview used to re-glob and re-read the
 * whole workspace on every debounced keystroke to feed a parser that only
 * walks the entrypoint subtree. These tests pin the promise that replaced it —
 * typing performs no reads at all — by counting them through the injected
 * reader.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { TfFileCache, type ReadFile } from "./tf-files";

const FOLDER = "/ws";
const TF = 'resource "aws_s3_bucket" "b" {\n  bucket = "b"\n}\n';

/** A fake disk plus the read counter every test asserts against. */
function disk(initial: Record<string, string>): {
  files: Map<string, string>;
  read: ReadFile;
  reads: () => number;
} {
  const files = new Map(Object.entries(initial));
  let reads = 0;
  const read: ReadFile = async (fsPath) => {
    reads += 1;
    const content = files.get(fsPath);
    if (content === undefined) throw new Error(`ENOENT: ${fsPath}`);
    return content;
  };
  return { files, read, reads: () => reads };
}

test("prime reads every file once and yields sorted, folder-relative paths", async () => {
  const d = disk({
    "/ws/b/second.tf": TF,
    "/ws/a/first.tf": TF,
  });
  const cache = new TfFileCache(FOLDER, d.read);
  await cache.prime(["/ws/b/second.tf", "/ws/a/first.tf"]);

  assert.equal(d.reads(), 2);
  assert.deepEqual(
    cache.files().map((f) => f.path),
    ["a/first.tf", "b/second.tf"],
  );
});

test("a document's text lands with no read at all — the typing path", async () => {
  const d = disk({ "/ws/main.tf": TF });
  const cache = new TfFileCache(FOLDER, d.read);
  await cache.prime(["/ws/main.tf"]);
  const afterPrime = d.reads();

  const changed = cache.set("/ws/main.tf", TF.replace("b", "typed"));
  assert.equal(changed, true);
  assert.equal(d.reads(), afterPrime, "a keystroke must not touch the disk");
  assert.equal(cache.files()[0]?.content, TF.replace("b", "typed"));
});

test("identical content reports no change, so the caller re-parses nothing", async () => {
  const d = disk({ "/ws/main.tf": TF });
  const cache = new TfFileCache(FOLDER, d.read);
  await cache.prime(["/ws/main.tf"]);

  assert.equal(cache.set("/ws/main.tf", TF), false);
  // A save fires both a document event and a watcher event; the second is free.
  assert.equal(await cache.read("/ws/main.tf"), false);
});

test("files outside the folder, non-.tf and vendored paths are refused without I/O", async () => {
  const d = disk({});
  const cache = new TfFileCache(FOLDER, d.read);

  assert.equal(cache.set("/elsewhere/main.tf", TF), false);
  assert.equal(cache.set("/ws/readme.md", "hi"), false);
  assert.equal(cache.set("/ws/.terraform/modules/x/main.tf", TF), false);
  assert.equal(await cache.read("/ws/.terraform/modules/x/main.tf"), false);
  assert.equal(d.reads(), 0, "a refused path must never reach the disk");
  assert.deepEqual(cache.files(), []);
});

test("create, delete and a vanished file all settle to the right set", async () => {
  const d = disk({ "/ws/main.tf": TF });
  const cache = new TfFileCache(FOLDER, d.read);
  await cache.prime(["/ws/main.tf"]);

  d.files.set("/ws/extra.tf", 'resource "aws_sqs_queue" "q" {}\n');
  assert.equal(await cache.read("/ws/extra.tf"), true);
  assert.deepEqual(cache.files().map((f) => f.path), ["extra.tf", "main.tf"]);

  assert.equal(cache.remove("/ws/extra.tf"), true);
  assert.equal(cache.remove("/ws/extra.tf"), false, "removing twice changes nothing");
  assert.deepEqual(cache.files().map((f) => f.path), ["main.tf"]);

  // Gone between the watcher event and the read: treated as a delete, not a throw.
  d.files.delete("/ws/main.tf");
  assert.equal(await cache.read("/ws/main.tf"), true);
  assert.deepEqual(cache.files(), []);
});

test("candidates fold the per-file memo and follow the content that changed", async () => {
  const d = disk({
    "/ws/envs/prod/main.tf": 'module "net" {\n  source = "../../modules/net"\n}\n',
    "/ws/modules/net/net.tf": TF,
  });
  const cache = new TfFileCache(FOLDER, d.read);
  await cache.prime(["/ws/envs/prod/main.tf", "/ws/modules/net/net.tf"]);

  // A sourced directory is a module, not a stack.
  assert.deepEqual(cache.candidates(), ["envs/prod"]);
  const afterPrime = d.reads();
  assert.deepEqual(cache.candidates(), ["envs/prod"], "a second fold re-reads nothing");
  assert.equal(d.reads(), afterPrime);

  // Drop the module block: the module directory becomes a stack of its own.
  cache.set("/ws/envs/prod/main.tf", TF);
  assert.deepEqual(cache.candidates(), ["envs/prod", "modules/net"]);
});

test("prime replaces the set — a file gone from the glob is gone from the cache", async () => {
  const d = disk({ "/ws/a.tf": TF, "/ws/b.tf": TF });
  const cache = new TfFileCache(FOLDER, d.read);
  await cache.prime(["/ws/a.tf", "/ws/b.tf"]);
  assert.equal(cache.files().length, 2);

  d.files.delete("/ws/b.tf");
  await cache.prime(["/ws/a.tf"]);
  assert.deepEqual(cache.files().map((f) => f.path), ["a.tf"]);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter groundplan-vscode test`
Expected: FAIL — `Cannot find module './tf-files'`.

- [ ] **Step 3: Write the cache**

Create `apps/vscode/src/tf-files.ts`:

```ts
/**
 * The workspace's `.tf` files, kept warm. The preview used to re-glob and
 * re-read the whole workspace on every debounced keystroke — measured at 23 ms
 * for 45 files and 190 ms for 2700 — to feed a parser that only walks the
 * entrypoint subtree (six files, ~1 ms). This cache is primed once and then
 * kept honest by the events the extension already subscribes to, so typing
 * costs no I/O at all: the changed text arrives inside the document event.
 *
 * Every mutator answers "could the graph have changed?", so the caller
 * schedules a re-parse only when it actually could — which is also how a
 * save's watcher event, arriving behind the document event that already
 * carried the same text, costs nothing.
 *
 * No `vscode` import: the reader is injected, so `node:test` drives every
 * transition offline and can count the reads.
 */
import { isDiagramTf, toPosixRelative } from "./paths";
import { candidatesFrom, localModuleSources } from "./root-dir";

/** One file as the parser wants it: a folder-relative posix path and bytes. */
export type TfFile = { path: string; content: string };

/** Reads a file's text. Rejects when it is gone. */
export type ReadFile = (fsPath: string) => Promise<string>;

type Entry = {
  path: string;
  content: string;
  /** The directories this file sources as a local module — the memo that
   * keeps entrypoint detection off the whole-workspace regex scan. */
  sources: string[];
};

export class TfFileCache {
  private readonly entries = new Map<string, Entry>();
  /** Derived views, dropped whenever the set or any content moves. */
  private sorted: TfFile[] | null = null;
  private candidateList: string[] | null = null;

  constructor(
    private readonly folder: string,
    private readonly readFile: ReadFile,
  ) {}

  /**
   * Replace the whole set from a fresh glob — the only full read. Runs on the
   * first refresh, and again whenever the watcher may have missed something
   * (VS Code honours the user's `files.watcherExclude`).
   */
  async prime(fsPaths: string[]): Promise<void> {
    const next = await Promise.all(fsPaths.map((fsPath) => this.entryOf(fsPath)));
    this.entries.clear();
    for (const [index, entry] of next.entries()) {
      const fsPath = fsPaths[index];
      if (entry && fsPath) this.entries.set(fsPath, entry);
    }
    this.invalidate();
  }

  /** Content already in hand (a document event) — no I/O. */
  set(fsPath: string, content: string): boolean {
    const path = this.relative(fsPath);
    if (!path) return false;
    if (this.entries.get(fsPath)?.content === content) return false;
    this.entries.set(fsPath, {
      path,
      content,
      sources: localModuleSources(path, content),
    });
    this.invalidate();
    return true;
  }

  /** Read one file (a watcher create/change); a vanished file is a delete. */
  async read(fsPath: string): Promise<boolean> {
    const path = this.relative(fsPath);
    if (!path) return false;
    let content: string;
    try {
      content = await this.readFile(fsPath);
    } catch {
      return this.remove(fsPath);
    }
    return this.set(fsPath, content);
  }

  /** Forget one file (a watcher delete). */
  remove(fsPath: string): boolean {
    if (!this.entries.delete(fsPath)) return false;
    this.invalidate();
    return true;
  }

  /** The parser's input, sorted by path — a repo clone parses the same way. */
  files(): TfFile[] {
    this.sorted ??= [...this.entries.values()]
      .map(({ path, content }) => ({ path, content }))
      .sort((a, b) => (a.path < b.path ? -1 : 1));
    return this.sorted;
  }

  /** The entrypoint candidates, folded from the memo — no bytes re-scanned. */
  candidates(): string[] {
    if (this.candidateList) return this.candidateList;
    const paths: string[] = [];
    const sourced: string[] = [];
    for (const entry of this.entries.values()) {
      paths.push(entry.path);
      sourced.push(...entry.sources);
    }
    this.candidateList = candidatesFrom(paths, sourced);
    return this.candidateList;
  }

  private async entryOf(fsPath: string): Promise<Entry | null> {
    const path = this.relative(fsPath);
    if (!path) return null;
    try {
      const content = await this.readFile(fsPath);
      return { path, content, sources: localModuleSources(path, content) };
    } catch {
      return null;
    }
  }

  /** The folder-relative posix path, or null when the file is not ours. */
  private relative(fsPath: string): string | null {
    const path = toPosixRelative(this.folder, fsPath);
    // toPosixRelative echoes paths outside the folder — they stay absolute.
    if (/^([A-Za-z]:)?\//.test(path)) return null;
    return isDiagramTf(path) ? path : null;
  }

  private invalidate(): void {
    this.sorted = null;
    this.candidateList = null;
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter groundplan-vscode test && pnpm --filter groundplan-vscode typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/vscode/src/tf-files.ts apps/vscode/src/tf-files.test.ts
git commit -m "perf(vscode): keep the workspace's .tf files warm in an incremental cache"
```

---

### Task 3: Wire the cache into the preview

`gatherTfFiles` goes away; the extension's existing listeners feed the cache and schedule a re-parse only when the cache actually moved.

**Files:**

- Modify: `apps/vscode/src/workspace-files.ts` (rewritten)
- Modify: `apps/vscode/src/extension.ts:41` (import), `:135-267` (constructor), `:269-272` (`reveal`), `:320-392` (`refresh`)

**Interfaces:**

- Consumes: `TfFileCache`, `ReadFile` (Task 2); `resolveFromCandidates` (Task 1).
- Produces:
  - `findTfPaths(folder: vscode.WorkspaceFolder): Promise<string[]>` from `./workspace-files`
  - `readTfFile: ReadFile` from `./workspace-files`

- [ ] **Step 1: Rewrite `workspace-files.ts`**

Replace the whole file:

```ts
/**
 * The `vscode` side of the file cache: where the `.tf` files are, and how to
 * read one. Open documents win over disk — the preview reflects what the
 * author sees, not what they last saved (the GP-148 "live while you type"
 * promise) — which also makes a save's watcher event free, because the text
 * is already in memory.
 */
import * as vscode from "vscode";

import { TF_EXCLUDE_GLOB } from "./paths";
import type { ReadFile } from "./tf-files";

/** Every `.tf` under the folder (vendored dirs excluded), as fs paths. */
export async function findTfPaths(
  folder: vscode.WorkspaceFolder,
): Promise<string[]> {
  const uris = await vscode.workspace.findFiles(
    new vscode.RelativePattern(folder, "**/*.tf"),
    TF_EXCLUDE_GLOB,
  );
  return uris.map((uri) => uri.fsPath);
}

const decoder = new TextDecoder();

/**
 * One file's text, preferring an open document's (possibly dirty) buffer.
 * A *closing* document is skipped on purpose: the close handler re-reads to
 * pick up the disk copy a discarded buffer left behind, and the document is
 * still listed while its close event runs.
 */
export const readTfFile: ReadFile = async (fsPath) => {
  for (const doc of vscode.workspace.textDocuments) {
    if (doc.isClosed) continue;
    if (doc.uri.scheme === "file" && doc.uri.fsPath === fsPath) return doc.getText();
  }
  return decoder.decode(
    await vscode.workspace.fs.readFile(vscode.Uri.file(fsPath)),
  );
};
```

- [ ] **Step 2: Swap the imports in `extension.ts`**

Replace line 40–41:

```ts
import { detectRootCandidates, resolveFromCandidates, stackForFile } from "./root-dir";
import { TfFileCache } from "./tf-files";
import { findTfPaths, readTfFile } from "./workspace-files";
```

`resolveRootDir` is still needed for the `BaselineProvider` callback (it receives the *baseline's* file set, not the cache's), so keep it in the same import:

```ts
import {
  detectRootCandidates,
  resolveFromCandidates,
  resolveRootDir,
  stackForFile,
} from "./root-dir";
```

- [ ] **Step 3: Add the cache fields**

After line 126 (`private initialFollowDone = false;`) add:

```ts
  /** The workspace's `.tf` files, kept warm — typing must not re-read them. */
  private readonly cache: TfFileCache;
  /** False until the first glob, and again when the watcher may have missed
   * events (a reveal, a git change): the next refresh re-globs. */
  private primed = false;
```

and in the constructor, immediately after `this.workspaceState = context.workspaceState;`:

```ts
    this.cache = new TfFileCache(this.folder.uri.fsPath, readTfFile);
```

- [ ] **Step 4: Feed the cache from the listeners**

Replace the document listener (lines 182–186) with:

```ts
    // Live while you type: in-memory edits count, and the text arrives inside
    // the event — a keystroke performs no file read at all. Nothing is
    // scheduled unless the bytes actually moved.
    this.disposables.push(
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.document.uri.scheme !== "file") return;
        if (this.cache.set(e.document.uri.fsPath, e.document.getText())) {
          this.reparse.schedule();
        }
      }),
    );
    // A discarded dirty buffer leaves the disk untouched, so no watcher event
    // fires — the cache would otherwise keep text that was never saved.
    this.disposables.push(
      vscode.workspace.onDidCloseTextDocument((doc) => {
        if (doc.uri.scheme !== "file") return;
        void this.cache.read(doc.uri.fsPath).then((changed) => {
          if (changed) this.reparse.schedule();
        });
      }),
    );
```

Replace the watcher wiring (lines 187–194) with:

```ts
    // Create/delete/rename arrive from the file system watcher.
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(this.folder, "**/*.tf"),
    );
    const onTouched = (uri: vscode.Uri): void => {
      void this.cache.read(uri.fsPath).then((changed) => {
        if (changed) this.reparse.schedule();
      });
    };
    watcher.onDidCreate(onTouched);
    watcher.onDidChange(onTouched);
    watcher.onDidDelete((uri) => {
      if (this.cache.remove(uri.fsPath)) this.reparse.schedule();
    });
    this.disposables.push(watcher);
```

In the git watcher callback (lines 173–177), re-glob as well — a checkout moves files the watcher may not have reported:

```ts
    this.gitWatcher = gitRoot
      ? watchGitChanges(gitRoot, () => {
          this.baseline.invalidate();
          // A checkout can add and remove files wholesale: re-glob, don't trust
          // the incremental events to have covered it.
          this.primed = false;
          this.reparse.schedule();
        })
      : null;
```

- [ ] **Step 5: Prime lazily, and re-glob on reveal**

Replace `reveal()` (lines 269–272):

```ts
  reveal(): void {
    this.panel.reveal(vscode.ViewColumn.Beside, true);
    // The user is already waiting: take the chance to re-glob, since a
    // workspace can change without an event (`files.watcherExclude`).
    this.primed = false;
    void this.refresh();
  }
```

Replace the first four statements of `refresh()` (lines 321–331):

```ts
  private async refresh(): Promise<void> {
    if (!this.primed) {
      await this.cache.prime(await findTfPaths(this.folder));
      this.primed = true;
    }
    const files = this.cache.files();
    // The entrypoint (`terraform -chdir` semantics): setting > panel pick >
    // detection — a stack below the folder root used to parse silently empty.
    const candidates = this.cache.candidates();
    const rootDir = resolveFromCandidates(
      rootDirSetting(),
      this.pickedRootDir(),
      candidates,
    );
    const { snapshot, diagnostics } = parse(files, { rootDir });
    this.lastRootDir = rootDir;
    // The switcher offers every stack unless the setting has pinned one.
    this.lastCandidates = rootDirSetting() ? [rootDir] : candidates;
```

`detectRootCandidates` is now unused in `extension.ts` — drop it from the import (`noUnusedLocals` will say so).

- [ ] **Step 6: Verify**

Run: `pnpm --filter groundplan-vscode typecheck && pnpm --filter groundplan-vscode test && pnpm --filter groundplan-vscode build`
Expected: PASS, and the build produces `dist/extension.cjs`.

- [ ] **Step 7: Verify by hand in the Extension Development Host**

Press F5 in `apps/vscode`, open a folder with Terraform, run **Groundplan: Open Preview**, and confirm:
- the diagram appears and matches what it drew before;
- typing in a `.tf` updates the diagram after the pause;
- saving does not visibly re-render a second time;
- creating, deleting and reverting a `.tf` all land;
- editing a file under `.terraform/` changes nothing.

- [ ] **Step 8: Commit**

```bash
git add apps/vscode/src/workspace-files.ts apps/vscode/src/extension.ts
git commit -m "perf(vscode): the typing path reads no files"
```

---

### Task 4: Post nothing when nothing changed; guard the refresh

Three defects in one function: an unchanged snapshot is re-posted (and `graph-canvas.tsx:579` re-runs ELK on graph object identity, so that is a full re-layout for nothing); overlapping refreshes can post out of order; a hidden panel does the whole job for nobody.

**Files:**

- Modify: `apps/vscode/src/live-core.ts`
- Modify: `apps/vscode/src/extension.ts` (`refresh`, constructor)
- Test: `apps/vscode/src/live-core.test.ts`

**Interfaces:**

- Consumes: nothing from earlier tasks.
- Produces:
  - `type PostPayload = { snapshot: unknown; folder: string; multiRoot: boolean; rootDir: string; diff: unknown; outOfSync: boolean }`
  - `postSignature(payload: PostPayload): string` from `./live-core`

- [ ] **Step 1: Write the failing test**

Append to `apps/vscode/src/live-core.test.ts`:

```ts
const payload = (): PostPayload => ({
  snapshot: { nodes: [{ id: "aws_s3_bucket.b" }], edges: [] },
  folder: "ws",
  multiRoot: false,
  rootDir: "infra",
  diff: { enabled: false, available: false, ref: null, clean: false },
  outOfSync: false,
});

test("an unchanged payload keeps its signature — the panel is told nothing", () => {
  assert.equal(postSignature(payload()), postSignature(payload()));
});

test("every field the panel is told about moves the signature", () => {
  const base = postSignature(payload());
  const moved: PostPayload[] = [
    { ...payload(), snapshot: { nodes: [], edges: [] } },
    { ...payload(), folder: "other" },
    { ...payload(), multiRoot: true },
    { ...payload(), rootDir: "envs/prod" },
    { ...payload(), diff: { enabled: true, available: true, ref: "HEAD", clean: true } },
    { ...payload(), outOfSync: true },
  ];
  for (const [index, next] of moved.entries()) {
    assert.notEqual(postSignature(next), base, `field ${index} was dropped`);
  }
});
```

and extend the file's imports:

```ts
import {
  createDebouncer,
  hasParseErrors,
  postSignature,
  toFileDiagnostics,
  type PostPayload,
} from "./live-core";
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter groundplan-vscode test`
Expected: FAIL — `postSignature is not a function`.

- [ ] **Step 3: Add `postSignature` to `live-core.ts`**

Append:

```ts
/**
 * Everything the panel is told in one refresh. Anything the webview renders
 * must appear here: a field left out is a change the panel will never hear
 * about, because an unchanged signature suppresses the post.
 */
export type PostPayload = {
  snapshot: unknown;
  folder: string;
  multiRoot: boolean;
  rootDir: string;
  diff: unknown;
  outOfSync: boolean;
};

/**
 * The comparable form of that payload. Re-posting a snapshot the webview
 * already has is not free: the canvas re-runs its ELK layout on graph *object
 * identity*, so an unchanged re-post is a full re-layout for nothing — once
 * per debounced keystroke, including keystrokes inside a comment.
 */
export function postSignature(payload: PostPayload): string {
  return JSON.stringify(payload);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter groundplan-vscode test`
Expected: PASS.

- [ ] **Step 5: Add the guard fields to `LivePreview`**

Beside the `primed` field added in Task 3:

```ts
  /** Bumped per refresh; a run overtaken by a newer one drops its result. */
  private generation = 0;
  /** The signature of what the panel was last told (live-core.postSignature). */
  private lastSignature: string | null = null;
  /** A refresh landed while the panel was hidden — post it on reveal. */
  private pendingWhileHidden = false;
```

- [ ] **Step 6: Guard, defer and dedupe in `refresh()`**

Take the generation at the top of `refresh()` — the line before `if (!this.primed)`:

```ts
    const generation = ++this.generation;
```

After the prime await (which is the first await in the function), and after each later await, drop a superseded run. Immediately after `this.primed = true;`:

```ts
      if (generation !== this.generation) return;
```

Replace the diff-mode block and the posts (lines 344–384 of the original) with:

```ts
    // Hidden panel: the parse and the Problems entries above still stand
    // (they are ~1 ms and the Problems panel must stay honest), but the git
    // baseline, the diff and the posts would be work for nobody.
    if (!this.panel.visible) {
      this.pendingWhileHidden = true;
      return;
    }

    // Diff mode (GP-154): annotate against the cached baseline. Only the
    // "after" side was re-parsed above; the baseline never re-reads on edits.
    const prefs = this.prefs();
    let posted = current;
    let state: DiffState = {
      ...prefs,
      available: false,
      ref: null,
      reason: null,
      clean: false,
    };
    if (prefs.enabled) {
      const result = await this.baseline.get(prefs.mode);
      if (generation !== this.generation) return;
      if (result.ok) {
        posted = diff(result.baseline.snapshot, current);
        state = {
          ...state,
          available: true,
          ref: result.baseline.ref,
          clean: isAllNoop(posted),
        };
      } else {
        // No baseline: the normal live view keeps working, and says why.
        state = { ...state, reason: result.reason };
      }
    }

    const folder = this.folder.name;
    const multiRoot = (vscode.workspace.workspaceFolders?.length ?? 0) > 1;
    const outOfSync = hasParseErrors(diagnostics);
    const signature = postSignature({
      snapshot: posted,
      folder,
      multiRoot,
      rootDir,
      diff: state,
      outOfSync,
    });

    this.lastPosted = posted;
    // The tab names the stack being previewed — the only place it is said.
    this.panel.title = rootDir
      ? `Groundplan — ${rootDir}`
      : "Groundplan Preview";

    // Nothing the panel renders moved: stay quiet. A re-post would cost a
    // full ELK re-layout to draw exactly what is already on screen.
    if (signature !== this.lastSignature) {
      this.lastSignature = signature;
      await this.post({ type: "snapshot", snapshot: posted, folder, multiRoot, rootDir });
      await this.post({ type: "diffState", state });
      await this.post({ type: "outOfSync", value: outOfSync });
    }
    this.pendingWhileHidden = false;
```

The early return for the broken-parse case (lines 335–339) keeps the panel's last good graph but must not leave a stale signature behind — replace it with:

```ts
    if (hasParseErrors(diagnostics) && this.lastGood) {
      // Mid-edit broken state: the reader keeps the graph they had.
      if (this.panel.visible) await this.post({ type: "outOfSync", value: true });
      else this.pendingWhileHidden = true;
      // The panel now shows something the signature does not describe.
      this.lastSignature = null;
      return;
    }
```

- [ ] **Step 7: Post once on reveal**

In the constructor, beside the other `this.disposables.push(...)` calls:

```ts
    // Coming back into view: deliver whatever the hidden panel missed, and
    // re-glob, since a workspace can change without a watcher event.
    this.disposables.push(
      this.panel.onDidChangeViewState(() => {
        if (!this.panel.visible || !this.pendingWhileHidden) return;
        this.primed = false;
        void this.refresh();
      }),
    );
```

- [ ] **Step 8: Verify**

Run: `pnpm --filter groundplan-vscode typecheck && pnpm --filter groundplan-vscode test && pnpm --filter groundplan-vscode build`
Expected: PASS.

- [ ] **Step 9: Verify by hand in the Extension Development Host**

- Type a character inside a comment, pause: the diagram must **not** flicker or re-fit — before this task it re-laid out every 500 ms.
- Type a real change: the diagram updates.
- Break the syntax: the out-of-sync chip appears and the last good graph stays; fix it and the chip clears.
- Switch to another editor tab, edit Terraform, switch back: the diagram is correct on return.
- Toggle diff mode on and off; toggle "changed only".

- [ ] **Step 10: Commit**

```bash
git add apps/vscode/src/live-core.ts apps/vscode/src/live-core.test.ts apps/vscode/src/extension.ts
git commit -m "perf(vscode): stop re-posting a diagram the panel already has"
```

---

### Task 5: One git process for the baseline file set

`BaselineProvider.read()` spawns a `git show` per file — 200 `.tf` files is 200 process spawns the first time diff mode turns on. `ls-tree` already knows every blob's sha; feeding those to a single `git cat-file --batch` replaces N spawns with 2.

Framing is `<sha> <type> <size>\n<size bytes>\n`, and **the size is bytes, not characters** — the splitter works on a `Buffer` and only decodes once the payload is sliced out. Splitting on a string would corrupt every file after the first one containing non-ASCII.

**Files:**

- Modify: `apps/vscode/src/git-baseline.ts:18` (imports), `:30-47` (runners), `:82-88` (constructor), `:167-196` (`read`)
- Test: `apps/vscode/src/git-baseline.test.ts`

**Interfaces:**

- Consumes: `isDiagramTf` from `./paths` (Task 1).
- Produces:
  - `type GitBatchRunner = (shas: string[], cwd: string) => Promise<Buffer[]>`
  - `runGitBatch: GitBatchRunner`
  - `splitBatch(out: Buffer, expected: number): Buffer[]`
  - `parseLsTreeEntry(record: string): { type: string; sha: string; path: string } | null`
  - `BaselineProvider` constructor gains a fifth parameter: `batch: GitBatchRunner = runGitBatch`

- [ ] **Step 1: Write the failing tests**

Append to `apps/vscode/src/git-baseline.test.ts`:

```ts
test("splitBatch frames on bytes, so multi-byte content cannot shift the next file", () => {
  // "é" is two bytes and one character: a character-based split loses a byte
  // per accent and every following object lands askew.
  const first = Buffer.from('resource "a" "é" {}\n', "utf8");
  const second = Buffer.from('resource "b" "c" {}\n', "utf8");
  const out = Buffer.concat([
    Buffer.from(`aaa blob ${first.length}\n`, "utf8"),
    first,
    Buffer.from("\n", "utf8"),
    Buffer.from(`bbb blob ${second.length}\n`, "utf8"),
    second,
    Buffer.from("\n", "utf8"),
  ]);

  const objects = splitBatch(out, 2);
  assert.equal(objects.length, 2);
  assert.equal(objects[0]?.toString("utf8"), first.toString("utf8"));
  assert.equal(objects[1]?.toString("utf8"), second.toString("utf8"));
});

test("splitBatch refuses a missing object rather than returning nonsense", () => {
  const out = Buffer.from("deadbeef missing\n", "utf8");
  assert.throws(() => splitBatch(out, 1), /missing/);
});

test("parseLsTreeEntry reads mode/type/sha/path, including paths with spaces", () => {
  assert.deepEqual(parseLsTreeEntry("100644 blob abc123\tenvs/my stack/main.tf"), {
    type: "blob",
    sha: "abc123",
    path: "envs/my stack/main.tf",
  });
  assert.equal(parseLsTreeEntry("not a tree record"), null);
});

test("baseline content survives non-ASCII and CRLF byte-for-byte", async () => {
  const dir = makeRepo();
  // Two files: the first is multi-byte, so a character-based split would
  // corrupt the second.
  writeFileSync(join(dir, "a.tf"), 'resource "aws_s3_bucket" "é" {\r\n  bucket = "café"\r\n}\r\n');
  writeFileSync(join(dir, "b.tf"), MAIN_TF);
  g(dir, "add", "-A");
  g(dir, "commit", "-m", "one");

  const result = await new BaselineProvider(dir).get("head");
  assert.ok(result.ok, !result.ok ? result.reason : "");
  assert.deepEqual(result.baseline.files.map((f) => f.path), ["a.tf", "b.tf"]);
  assert.equal(
    result.baseline.files[0]?.content,
    'resource "aws_s3_bucket" "é" {\r\n  bucket = "café"\r\n}\r\n',
  );
  assert.equal(result.baseline.files[1]?.content, MAIN_TF);
});

test("reading a baseline spawns two git processes, not one per file", async () => {
  const dir = makeRepo();
  for (const name of ["a.tf", "b.tf", "c.tf", "d.tf", "e.tf"]) {
    writeFileSync(join(dir, name), MAIN_TF.replace('"b"', `"${name[0]}"`));
  }
  g(dir, "add", "-A");
  g(dir, "commit", "-m", "one");

  let plain = 0;
  let batches = 0;
  const provider = new BaselineProvider(
    dir,
    (args, cwd) => {
      plain++;
      return runGit(args, cwd);
    },
    undefined,
    undefined,
    (shas, cwd) => {
      batches++;
      return runGitBatch(shas, cwd);
    },
  );

  const result = await provider.get("head");
  assert.ok(result.ok, !result.ok ? result.reason : "");
  assert.equal(result.baseline.files.length, 5);
  // rev-parse --show-toplevel, rev-parse HEAD, ls-tree — and one batch.
  assert.equal(plain, 3);
  assert.equal(batches, 1, "one cat-file --batch, whatever the file count");
});

test("an empty baseline runs no batch at all", async () => {
  const dir = makeRepo();
  writeFileSync(join(dir, "readme.md"), "no terraform here");
  g(dir, "add", "-A");
  g(dir, "commit", "-m", "one");

  let batches = 0;
  const provider = new BaselineProvider(dir, undefined, undefined, undefined, (shas, cwd) => {
    batches++;
    return runGitBatch(shas, cwd);
  });
  const result = await provider.get("head");
  assert.ok(result.ok, !result.ok ? result.reason : "");
  assert.deepEqual(result.baseline.files, []);
  assert.equal(batches, 0);
});
```

Extend that file's import from `./git-baseline`:

```ts
import {
  BaselineProvider,
  findGitRoot,
  parseLsTreeEntry,
  runGit,
  runGitBatch,
  splitBatch,
  watchGitChanges,
  type GitRunner,
} from "./git-baseline";
```

Also update the existing test `"a cached baseline runs no git at all; a re-resolved same sha reparses nothing"` so its counter covers the batch runner too — otherwise it stops proving "a warm `get()` must not shell out":

```ts
  let calls = 0;
  const counted: GitRunner = (args, cwd) => {
    calls++;
    return runGit(args, cwd);
  };
  const provider = new BaselineProvider(dir, counted, undefined, undefined, (shas, cwd) => {
    calls++;
    return runGitBatch(shas, cwd);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter groundplan-vscode test`
Expected: FAIL — `splitBatch is not a function`, `parseLsTreeEntry is not a function`.

- [ ] **Step 3: Add the batch runner and its pure parsers**

In `apps/vscode/src/git-baseline.ts`, extend the child-process import:

```ts
import { execFile, spawn } from "node:child_process";
```

and add after `runGit` (line 47):

```ts
/** Read many blobs by sha in one process. Buffers, because sizes are bytes. */
export type GitBatchRunner = (shas: string[], cwd: string) => Promise<Buffer[]>;

/**
 * `git cat-file --batch`: one process for the whole baseline instead of a
 * `git show` per file (200 `.tf` files used to mean 200 spawns the first time
 * diff mode turned on). stdin takes one sha per line; stdout frames each
 * object as `<sha> <type> <size>\n<size bytes>\n`.
 */
export const runGitBatch: GitBatchRunner = (shas, cwd) =>
  new Promise((resolve, reject) => {
    const child = spawn("git", ["cat-file", "--batch"], { cwd });
    const chunks: Buffer[] = [];
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || `git cat-file exited ${code ?? "?"}`));
        return;
      }
      try {
        resolve(splitBatch(Buffer.concat(chunks), shas.length));
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
    child.stdin.end(shas.map((sha) => `${sha}\n`).join(""));
  });

/**
 * Split `cat-file --batch` output into one buffer per requested object. The
 * header's size is a **byte** count, so this stays on the Buffer until the
 * payload is sliced: splitting a decoded string would shift every object after
 * the first one holding non-ASCII.
 */
export function splitBatch(out: Buffer, expected: number): Buffer[] {
  const objects: Buffer[] = [];
  let at = 0;
  for (let index = 0; index < expected; index++) {
    const newline = out.indexOf(0x0a, at);
    if (newline === -1) throw new Error("git cat-file: truncated output");
    const header = out.toString("utf8", at, newline);
    const size = Number(header.split(" ")[2]);
    // "<sha> missing" — a sha we listed is not readable; never guess past it.
    if (!Number.isFinite(size)) throw new Error(`git cat-file: ${header}`);
    const start = newline + 1;
    objects.push(out.subarray(start, start + size));
    at = start + size + 1; // the object's trailing newline
  }
  return objects;
}

/** One `git ls-tree -r -z` record: `<mode> <type> <sha>\t<path>`. */
export function parseLsTreeEntry(
  record: string,
): { type: string; sha: string; path: string } | null {
  const tab = record.indexOf("\t");
  if (tab === -1) return null;
  const fields = record.slice(0, tab).split(" ");
  const type = fields[1];
  const sha = fields[2];
  if (!type || !sha) return null;
  // -z means paths arrive verbatim — never quoted, spaces and all.
  return { type, sha, path: record.slice(tab + 1) };
}
```

- [ ] **Step 4: Take the batch runner in the constructor**

Extend the constructor (lines 82–88) with a fifth parameter:

```ts
  constructor(
    private readonly folder: string,
    private readonly git: GitRunner = runGit,
    private readonly log: (line: string) => void = () => {},
    /** The entrypoint a baseline file set parses from — mirrors the live side. */
    private readonly rootDirOf: (files: HclFile[]) => string = detectRootDir,
    private readonly gitBatch: GitBatchRunner = runGitBatch,
  ) {}
```

and add beside the private `run` helper:

```ts
  private batch(shas: string[], cwd: string): Promise<Buffer[]> {
    this.log(`git cat-file --batch (${shas.length} objects)`);
    return this.gitBatch(shas, cwd);
  }
```

- [ ] **Step 5: Rewrite `read()`**

Replace the body of `read()` (lines 167–196) from the `ls-tree` call to the `files.sort(...)` line:

```ts
    const listed = await this.run(
      ["ls-tree", "-r", "-z", sha, ...(inFolder ? ["--", inFolder] : [])],
      cwd,
    );
    const entries = listed
      .split("\0")
      .filter(Boolean)
      .map(parseLsTreeEntry)
      .filter(
        (entry): entry is { type: string; sha: string; path: string } =>
          entry !== null && entry.type === "blob" && isDiagramTf(entry.path),
      );

    // One process for the lot; a baseline with no Terraform runs none.
    const contents = entries.length
      ? await this.batch(
          entries.map((entry) => entry.sha),
          cwd,
        )
      : [];
    const files = entries.map((entry, index) => ({
      path: inFolder ? entry.path.slice(inFolder.length + 1) : entry.path,
      content: contents[index]?.toString("utf8") ?? "",
    }));
    files.sort((a, b) => (a.path < b.path ? -1 : 1));
```

`MAX_GIT_OUTPUT` still guards `runGit`, which no longer carries file contents — leave it; `rev-parse`, `merge-base` and `ls-tree` all still flow through it.

- [ ] **Step 6: Run the tests**

Run: `pnpm --filter groundplan-vscode test && pnpm --filter groundplan-vscode typecheck`
Expected: PASS — including every pre-existing `git-baseline.test.ts` case (vendored exclusion, folder-relative paths, `reset()`, merge-base), which is what proves the swap is behaviour-preserving.

- [ ] **Step 7: Commit**

```bash
git add apps/vscode/src/git-baseline.ts apps/vscode/src/git-baseline.test.ts
git commit -m "perf(vscode): read the git baseline in one process, not one per file"
```

---

### Task 6: Drop the Markdown renderer from the webview bundle

~350 KB of `micromark`/`mdast`/`unified`/`remark-gfm` (9.5% of a 2.38 MB bundle) reaches the preview only through the `@groundplan/canvas` barrel's `export * from "./components/ai-response"`, which Rollup cannot tree-shake. The preview is offline and renders no AI prose. Aliasing is the only way to reach this without editing `packages/canvas`, which is out of scope — so the stubs **throw**, and the day the assumption stops holding it stops holding loudly.

**Files:**

- Create: `apps/vscode/webview/stubs/react-markdown.ts`
- Create: `apps/vscode/webview/stubs/remark-gfm.ts`
- Create: `apps/vscode/src/bundle.test.ts`
- Modify: `apps/vscode/vite.config.ts`

**Interfaces:**

- Consumes: nothing from earlier tasks.
- Produces: no runtime API — a build configuration and its guard.

- [ ] **Step 1: Write the failing test**

Create `apps/vscode/src/bundle.test.ts`:

```ts
/**
 * The preview's bundle must carry no Markdown renderer. `AiResponse` reaches
 * it only through the `@groundplan/canvas` barrel — which Rollup cannot shake
 * out — and drags ~350 KB of micromark/mdast/unified into a webview that is
 * offline and renders no AI prose. vite.config.ts aliases it away; this is the
 * guard that says so.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const bundle = fileURLToPath(
  new URL("../dist/webview/webview.js", import.meta.url),
);

// `pnpm test` must stay runnable without a prior `pnpm build`.
test(
  "the webview bundle carries no Markdown renderer",
  { skip: existsSync(bundle) ? false : "no dist/webview — run pnpm build first" },
  () => {
    const js = readFileSync(bundle, "utf8");
    assert.ok(
      js.includes("bundles no Markdown renderer"),
      "the react-markdown stub did not replace the real renderer",
    );
    assert.ok(
      !js.includes("micromark"),
      "micromark leaked into the webview bundle — check the vite.config alias",
    );
  },
);
```

- [ ] **Step 2: Run it against the current bundle to verify it fails**

Run: `pnpm --filter groundplan-vscode build && pnpm --filter groundplan-vscode test`
Expected: FAIL — "the react-markdown stub did not replace the real renderer" (and `micromark` is present).

- [ ] **Step 3: Write the stubs**

Create `apps/vscode/webview/stubs/react-markdown.ts`:

```ts
/**
 * The VS Code preview renders no AI prose — it is offline by design, and the
 * webview never mounts `AiResponse`. The canvas barrel re-exports it anyway,
 * dragging ~350 KB of micromark/mdast/unified into a bundle that never runs
 * it, and a barrel re-export is exactly what Rollup cannot shake out.
 *
 * `vite.config.ts` points `react-markdown` here for the VS Code build only.
 * This throws rather than rendering nothing: if the preview ever does grow a
 * reason to render Markdown, it must fail loudly instead of silently blank.
 */
export type Components = Record<string, unknown>;

export default function Markdown(): never {
  throw new Error(
    "groundplan: the VS Code preview bundles no Markdown renderer (offline by design)",
  );
}
```

Create `apps/vscode/webview/stubs/remark-gfm.ts`:

```ts
/** The GFM plugin's other half of the react-markdown stub — see it for why. */
export default function remarkGfm(): never {
  throw new Error(
    "groundplan: the VS Code preview bundles no Markdown renderer (offline by design)",
  );
}
```

- [ ] **Step 4: Alias them in the webview build**

In `apps/vscode/vite.config.ts`, add a `resolve` block between `plugins` and `build`:

```ts
  // The preview renders no AI prose, but the canvas barrel re-exports
  // AiResponse and Rollup cannot shake a barrel re-export out — so ~350 KB of
  // micromark/mdast/unified rode along in a bundle that never ran it. The
  // stubs throw, so the assumption fails loudly if it ever stops holding.
  // Guarded by src/bundle.test.ts.
  resolve: {
    alias: {
      "react-markdown": fileURLToPath(
        new URL("./webview/stubs/react-markdown.ts", import.meta.url),
      ),
      "remark-gfm": fileURLToPath(
        new URL("./webview/stubs/remark-gfm.ts", import.meta.url),
      ),
    },
  },
```

- [ ] **Step 5: Rebuild and verify the test passes**

Run: `pnpm --filter groundplan-vscode build && pnpm --filter groundplan-vscode test && pnpm --filter groundplan-vscode typecheck`
Expected: PASS.

- [ ] **Step 6: Record the saving**

Run: `ls -l apps/vscode/dist/webview/webview.js`
Expected: meaningfully smaller than the 2,383,587 bytes measured before this task. Note the new figure — it goes in the final report.

- [ ] **Step 7: Verify by hand in the Extension Development Host**

Press F5, open the preview, and confirm the diagram, the toolbar, diff mode and the IAM view all render — the stub must never be reached.

- [ ] **Step 8: Commit**

```bash
git add apps/vscode/webview/stubs apps/vscode/vite.config.ts apps/vscode/src/bundle.test.ts
git commit -m "perf(vscode): drop the unused Markdown renderer from the webview bundle"
```

---

### Task 7: Measure the result and land the docs

The plan claims specific numbers. Confirm them, and commit the spec + plan alongside the work.

**Files:**

- Create: `apps/vscode/bench-preview.mts` (temporary — deleted in this task)
- Modify: none

- [ ] **Step 1: Write the measurement**

Create `apps/vscode/bench-preview.mts` — the same probe the design was measured with, now driving the cache instead of a whole-workspace read:

```ts
// TEMPORARY — verifies the plan's claims. Deleted in step 4.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

import { TfFileCache, type ReadFile } from "./src/tf-files.js";

const EX = "../../examples/terraform";

function walk(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === ".terraform" || entry === "node_modules") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full, base));
    else if (entry.endsWith(".tf")) out.push(full);
  }
  return out;
}

const real = walk(EX);
let reads = 0;
const read: ReadFile = async (fsPath) => {
  reads += 1;
  return readFileSync(fsPath.replace(/^\/ws\/stack-\d+\//, `${EX}/`), "utf8");
};

for (const copies of [1, 20, 60]) {
  const paths: string[] = [];
  for (let i = 0; i < copies; i++) {
    for (const f of real) paths.push(`/ws/stack-${i}/${f.slice(EX.length + 1)}`);
  }
  const cache = new TfFileCache("/ws", read);

  reads = 0;
  let t = performance.now();
  await cache.prime(paths);
  const primeMs = performance.now() - t;
  const primeReads = reads;

  // One keystroke: the document's text, already in hand.
  const first = paths[0] ?? "";
  reads = 0;
  t = performance.now();
  for (let i = 0; i < 100; i++) {
    cache.set(first, `# edit ${i}\nresource "aws_s3_bucket" "b" {}\n`);
    cache.files();
    cache.candidates();
  }
  const perKeystrokeMs = (performance.now() - t) / 100;

  console.log(
    `${String(paths.length).padStart(5)} files — prime ${primeMs.toFixed(0)} ms (${primeReads} reads); ` +
      `keystroke ${perKeystrokeMs.toFixed(2)} ms (${reads} reads)`,
  );
}
```

- [ ] **Step 2: Run it**

Run: `cd apps/vscode && node --import tsx bench-preview.mts`
Expected: `reads` after the prime is **0** at every size, and the per-keystroke figure is well under a millisecond — against the 23/114/190 ms of whole-workspace reads the design measured.

- [ ] **Step 3: Run everything one last time**

Run:

```bash
pnpm --filter groundplan-vscode typecheck
pnpm --filter groundplan-vscode test
pnpm --filter groundplan-vscode build
pnpm --filter groundplan-vscode package
```

Expected: all pass; `groundplan.vsix` is produced and smaller than before.

- [ ] **Step 4: Delete the probe and commit the docs**

```bash
rm apps/vscode/bench-preview.mts
git add docs/superpowers/specs/2026-07-29-vscode-preview-performance-design.md \
        docs/superpowers/plans/2026-07-29-vscode-preview-performance.md
git commit -m "docs: the VS Code preview performance spec and plan"
```

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
| --- | --- |
| 1. `src/tf-files.ts` incremental cache | 2 (cache), 3 (wiring, all five event transitions) |
| 1. `TF_EXCLUDE_GLOB` applied to document events | 1 (`isDiagramTf`), 2 (`relative()` refuses) |
| 1. Re-prime on reveal and git change | 3 (`reveal`, git watcher), 4 (`onDidChangeViewState`) |
| 2. Memoized root-candidate detection | 1 (split), 2 (`sources` memo + `candidates()`) |
| 3. Post nothing when nothing changed | 4 |
| 4. Generation guard + hidden deferral | 4 |
| 5. One git process for the baseline | 5 |
| 6. Markdown stub + bundle guard | 6 |
| Acceptance: no reads while typing | 2 (read counter), 7 (measured) |
| Acceptance: 2 git processes not N | 5 (counted in the test) |
| Acceptance: no `micromark` in the bundle | 6 |

**Placeholder scan:** none — every step carries the code it asks for.

**Type consistency:** `ReadFile` is defined in Task 2 and consumed by name in Tasks 3 and 7. `TfFileCache` method names (`prime`/`set`/`read`/`remove`/`files`/`candidates`) are used identically in Tasks 3 and 7. `candidatesFrom(tfPaths, sourced)` takes file paths (not directories) in Task 1 and is called with `entry.path` in Task 2. `resolveFromCandidates` replaces `resolveRootDir` in `extension.ts` only; `resolveRootDir` survives for the `BaselineProvider` callback, which is why Task 3 keeps both in the import. `PostPayload`/`postSignature` are defined in Task 4 and used only there. The `BaselineProvider` fifth constructor parameter added in Task 5 is passed positionally in that task's tests, consistent with the existing `new BaselineProvider(dir, undefined, undefined, () => root)` style.

**One deliberate trade-off, flagged:** re-priming whenever the panel becomes visible costs a full re-glob and re-read (190 ms on a 2700-file workspace) per tab switch back to the preview. It buys the only honest answer to `files.watcherExclude` — VS Code will not report changes under an excluded path, and the old code self-healed by re-globbing every refresh. If tab-switching latency turns out to bite, the fix is to re-prime on a timer or on window focus instead, not to drop it.

## Deviations during implementation

Two mechanisms shipped that are absent from this plan's code blocks — a
reader following the steps above would wrongly conclude they do not exist:

- **`TfFileCache` gained `activePrimes`** (`src/tf-files.ts`): per-`prime()`-call
  tracking (one `Set<string>` per in-flight call, not a single shared field),
  so overlapping `prime()` calls — a `reveal()` racing the panel's own first
  refresh, say — cannot discard a concurrent `set()`/`remove()`'s decision
  about a path either of them also touched. Covered by
  `tf-files.test.ts`'s overlap cases ("a set() during an in-flight prime
  survives it", "a set() landing between two overlapping primes survives
  both commits", and the equivalent `remove()` cases).
- **The `onDidChangeTextDocument` handler gained a path guard that runs
  *before* `e.document.getText()`** (`src/extension.ts`): the plan's Task 3
  Step 4 code block calls `getText()` unconditionally and only checks
  `cache.set()`'s own return value. Shipped code rejects on `scheme`,
  folder-membership and `isDiagramTf` first — a keystroke in a large
  non-`.tf` open file (a lockfile, a rendered `.tfstate`) never materializes
  its text, which is the exact per-keystroke cost this cache exists to
  remove, just relocated to that call site if left unguarded.

### Final review fix wave (2026-08-01)

A whole-branch review after Task 7 found five issues, all fixed in one
follow-up commit, scope limited to `apps/vscode/` and `docs/`:

- **Critical — the `ready` handshake was defeated by the post-suppression
  from Task 4.** The webview's `message` listener only exists after its
  ~2.2 MB bundle mounts (a React `useEffect`); anything posted before that is
  dropped, which is why the webview posts `ready` on mount. But a refresh
  landing before the mount (a `.tf` touched on disk, or a git ref moved, in
  the same second as "Groundplan: Open Preview") posted into an empty
  listener and still recorded the signature as sent — so when the webview
  then mounted and asked again via `ready`, the suppression check saw an
  "unchanged" signature and stayed quiet, leaving the panel stuck on
  "Reading Terraform…" until a content-changing edit or a reopen. Same
  failure on any webview reload (dragging the panel to another editor group,
  `Developer: Reload Webviews`). Fixed by extracting the signature-tracking
  state out of a raw `lastSignature` field into `live-core.ts`'s
  `createSignatureTracker()` (`shouldPost` / `markSent` / `reset`), so the
  `ready` handler's `reset()` — "the webview holds nothing" — is a rule
  `node:test` can pin without a `vscode` stub; the `ready` handler also
  clears `lastPosted`. Regression tests in `live-core.test.ts`.
- **Minor — `primed` was a boolean written after two awaits**
  (`findTfPaths` then `cache.prime`), so a git-watcher invalidation landing
  mid-prime could be overwritten by the in-flight prime's own completion,
  silently dropping the re-glob request (two ref movements in quick
  succession, as a `git pull` or a rebase produces). Replaced with a
  request/done counter pair (`primeWanted` / `primeDone`): the value being
  serviced is captured before the await, and `primeDone` only ever advances
  to what was actually serviced, so a bump arriving mid-await is never lost.
- **Minor — the broken-parse branch never cleared `pendingWhileHidden`**,
  so once a hidden refresh set it, an outstanding syntax error kept it set
  (that branch returns early). Since `onDidChangeViewState` also fires on
  `active` changes, every editor↔panel focus click then re-triggered a full
  workspace re-glob for as long as the error stood. Fixed by clearing the
  flag on the visible broken-parse path too, matching the normal path.
- **Minor — `lastSignature` (now the signature tracker) was marked sent
  before the messages were actually posted.** If a run was superseded
  between message 1 and message 2, the tracker claimed a payload the panel
  only half-received; a later run recomputing the identical signature would
  then wrongly stay quiet, leaving `diffState`/`outOfSync` stale. Fixed by
  calling `markSent` only after `postWhileCurrent` completes *and* the
  run is still current — a superseded run leaves the signature available so
  the run that follows still posts.
- **Record — this plan's cache section doesn't state its memory cost.** The
  design spec (`docs/superpowers/specs/2026-07-29-vscode-preview-performance-design.md`)
  now says so where the cache is introduced: every `.tf` body stays resident
  for the panel's lifetime, roughly 11 MB at 2700 files — the deliberate
  trade for zero I/O per keystroke.
