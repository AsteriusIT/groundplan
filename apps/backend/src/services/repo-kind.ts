/**
 * Detecting what a repository holds (GP-228) — a *default*, never a decision.
 *
 * The kind of a repository is immutable after attachment and exclusive (GP-100):
 * a repo is `terraform` or `kubernetes`, and a monorepo is attached twice with
 * different paths. Asking someone to make that irreversible choice forty times
 * in a row with no help is an excellent way to collect forty wrong answers — so
 * the import screen pre-selects, and the human still validates.
 *
 * Which is exactly why this function is allowed to say **nothing**. Three of its
 * answers are refusals:
 *
 *  - both families of signal present  → `null` / `low`, evidence from both sides
 *    (the monorepo: two imports with two paths, never a "mixed" kind);
 *  - a tree GitHub truncated          → at most `low`, because the file that
 *    would have decided it may be the one we did not receive;
 *  - nothing recognisable             → `null`.
 *
 * A wrong `high` is worse than an honest `null`: the first is silently accepted
 * and permanent, the second costs one click.
 *
 * Pure and offline: it reads paths, and for candidate YAML the caller may hand
 * it the first lines of the file. No network, no clone, no parse.
 */

/** One entry of a repository tree, as any provider can describe it. */
export type FileEntry = {
  /** Repository-relative posix path, no leading slash. */
  path: string;
  type: "file" | "dir";
  /**
   * Head of the file's content, when the caller cheaply had it. Only consulted
   * for YAML — the difference between a Kubernetes manifest and a CI config is
   * `apiVersion` + `kind`, and no file name will ever tell you that.
   */
  head?: string;
};

export type RepoKind = "terraform" | "kubernetes";

export type RepoKindDetection = {
  /** The kind to pre-select, or null when we will not guess. */
  kind: RepoKind | null;
  /** `high` only when one family of signals is present and the tree is whole. */
  confidence: "high" | "low";
  /** What was seen, in the order it was found — shown to the user verbatim. */
  evidence: string[];
  /**
   * A first-level directory every relevant file sits under (`infra`,
   * `manifests`), or null. Pre-fills the path field; it is never applied
   * without the user seeing it.
   */
  suggestedPath: string | null;
};

/** Terraform is unambiguous from paths alone. */
const TERRAFORM_FILE = /\.tf(\.json)?$/i;
const TERRAFORM_MARKERS = new Set([
  ".terraform.lock.hcl",
  "terragrunt.hcl",
]);

const YAML_FILE = /\.ya?ml$/i;
/** Kubernetes markers that need no content to be conclusive. */
const K8S_MARKERS = new Set([
  "chart.yaml",
  "kustomization.yaml",
  "kustomization.yml",
]);

/**
 * `apiVersion:` and `kind:` at the head of a document — the manifest tell.
 * Indentation is spaces and tabs only, deliberately not `\s`: a newline is a
 * new line, not leading whitespace, and letting it be one would both match the
 * wrong thing and make the pattern backtrack.
 */
const HAS_API_VERSION = /^[ \t]*apiVersion[ \t]*:/m;
const HAS_KIND = /^[ \t]*kind[ \t]*:/m;

/** Does this YAML head look like a Kubernetes object? */
export function looksLikeK8sManifest(head: string | undefined): boolean {
  if (!head) return false;
  return HAS_API_VERSION.test(head) && HAS_KIND.test(head);
}

const basename = (path: string): string => path.split("/").pop() ?? path;

/** The first path segment, or null for a file at the root. */
function firstSegment(path: string): string | null {
  const index = path.indexOf("/");
  return index > 0 ? path.slice(0, index) : null;
}

/** `/infra/` and `infra` name the same directory. */
export function trimSlashes(path: string): string {
  let start = 0;
  let end = path.length;
  while (start < end && path[start] === "/") start += 1;
  while (end > start && path[end - 1] === "/") end -= 1;
  return path.slice(start, end);
}

/** Only files matter; a directory entry proves nothing about its contents. */
function withinPath(entries: FileEntry[], path: string | undefined): FileEntry[] {
  const prefix = trimSlashes(path ?? "");
  const files = entries.filter((entry) => entry.type === "file");
  if (prefix === "") return files;
  return files
    .filter((entry) => entry.path.startsWith(`${prefix}/`))
    .map((entry) => ({ ...entry, path: entry.path.slice(prefix.length + 1) }));
}

/**
 * The single directory every path sits under, or null when they disagree (or
 * when any of them is at the repository root — then the root *is* the answer).
 */
function commonFirstSegment(paths: string[]): string | null {
  if (paths.length === 0) return null;
  const segments = new Set<string | null>(paths.map(firstSegment));
  if (segments.size !== 1) return null;
  const [only] = segments;
  return only ?? null;
}

/**
 * What a repository (or a subdirectory of it) holds, from its file tree.
 *
 * `truncated` is the provider saying "there was more" — it caps confidence at
 * `low` without changing the verdict, because the evidence we did see is still
 * evidence; it is only no longer the whole story.
 */
export function detectRepoKind(
  tree: FileEntry[],
  options: { path?: string; truncated?: boolean } = {},
): RepoKindDetection {
  const files = withinPath(tree, options.path);

  const terraform = signalsFor(files, isTerraformFile);
  const kubernetes = signalsFor(files, isKubernetesFile);

  // A kustomize layout is conclusive on its own: `base/` beside `overlays/` is
  // not a shape anything else produces.
  const kustomizeLayout = hasKustomizeLayout(files);
  if (kustomizeLayout) kubernetes.push(kustomizeLayout);

  const truncated = options.truncated === true;
  // Truncation never changes the verdict, only how sure we are of it: what we
  // saw is still evidence, it is simply no longer the whole story.
  const confidence = truncated ? "low" : "high";

  // Both families: the monorepo. Not a kind — an invitation to import twice.
  if (terraform.length > 0 && kubernetes.length > 0) {
    return {
      kind: null,
      confidence: "low",
      evidence: [...examples(terraform), ...examples(kubernetes)],
      suggestedPath: null,
    };
  }

  if (terraform.length > 0) {
    return {
      kind: "terraform",
      confidence,
      evidence: examples(terraform),
      suggestedPath: commonFirstSegment(terraform),
    };
  }

  if (kubernetes.length > 0) {
    return {
      kind: "kubernetes",
      confidence,
      evidence: examples(kubernetes),
      suggestedPath: commonFirstSegment(kubernetes),
    };
  }

  return { kind: null, confidence: "low", evidence: [], suggestedPath: null };
}

/** Terraform is unambiguous from the file name alone. */
function isTerraformFile(name: string): boolean {
  return TERRAFORM_FILE.test(name) || TERRAFORM_MARKERS.has(name);
}

function isKubernetesFile(name: string, file: FileEntry): boolean {
  if (K8S_MARKERS.has(name)) return true;
  // A YAML file's name proves nothing — every repository has CI YAML. Only the
  // head keys separate a manifest from a workflow.
  return YAML_FILE.test(name) && looksLikeK8sManifest(file.head);
}

/** The paths matching one family of signals. */
function signalsFor(
  files: FileEntry[],
  matches: (lowercaseName: string, file: FileEntry) => boolean,
): string[] {
  return files
    .filter((file) => matches(basename(file.path).toLowerCase(), file))
    .map((file) => file.path);
}

/** A few example paths for the UI — it shows evidence, not a file tree. */
const examples = (paths: string[]): string[] => paths.slice(0, EVIDENCE_CAP);

/** How many example paths we keep per family — the UI shows a few, not a tree. */
const EVIDENCE_CAP = 5;

/** `base/` and `overlays/` under the same parent: a kustomize repository. */
function hasKustomizeLayout(files: FileEntry[]): string | null {
  const parents = new Map<string, Set<string>>();
  for (const file of files) {
    const segments = file.path.split("/");
    for (let i = 0; i < segments.length; i += 1) {
      const segment = segments[i]!.toLowerCase();
      if (segment !== "base" && segment !== "overlays") continue;
      const parent = segments.slice(0, i).join("/");
      const seen = parents.get(parent) ?? new Set<string>();
      seen.add(segment);
      parents.set(parent, seen);
    }
  }
  for (const [parent, seen] of parents) {
    if (seen.size === 2) return parent === "" ? "base/ + overlays/" : `${parent}/`;
  }
  return null;
}
