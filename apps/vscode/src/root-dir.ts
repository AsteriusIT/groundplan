/**
 * Where does the parse start? The parser walks an *entrypoint* directory plus
 * the modules it sources (`terraform -chdir` semantics, GP-146) — so a
 * workspace keeping its stack below the root used to parse to an empty graph,
 * silently. These pure helpers pick the entrypoint: the `groundplan.rootDir`
 * setting when given, auto-detection otherwise. No `vscode` import.
 */

export type TfFileLike = { path: string; content: string };

/** A local module source: `source = "./x"` or `"../x"`. Registry/git never match. */
const LOCAL_SOURCE_RE = /\bsource\s*=\s*"(\.\.?\/[^"]*)"/g;

/** Posix-normalize a relative path: collapse `.`/`..`; "" when it escapes. */
function normalizeRelative(path: string): string {
  const out: string[] = [];
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (out.length === 0) return ""; // escapes the workspace — not ours
      out.pop();
    } else out.push(segment);
  }
  return out.join("/");
}

/** The `groundplan.rootDir` setting, worn as a workspace-relative posix dir. */
export function normalizeRootSetting(raw: string): string {
  return normalizeRelative(raw.trim().replaceAll("\\", "/"));
}

/** The directory of a repo-relative posix path ("" at the root). */
function dirOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? "" : path.slice(0, slash);
}

/** Shallowest first, then alphabetical — the deterministic candidate order. */
function byDepthThenName(a: string, b: string): number {
  const depth = a.split("/").length - b.split("/").length;
  if (depth !== 0) return depth;
  return a < b ? -1 : 1;
}

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

/** The auto-detected entrypoint: the first candidate ("" when there is none). */
export function detectRootDir(files: TfFileLike[]): string {
  return detectRootCandidates(files)[0] ?? "";
}

/**
 * The stack a file belongs to: the most specific candidate whose directory
 * contains it ("" — the workspace root — contains everything). Null when none
 * does (a shared module, a file outside every stack): following the active
 * editor must then stay where it is rather than guess.
 */
export function stackForFile(path: string, candidates: string[]): string | null {
  let best: string | null = null;
  for (const dir of candidates) {
    if (dir !== "" && !path.startsWith(`${dir}/`)) continue;
    if (best === null || dir.length > best.length) best = dir;
  }
  return best;
}

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
