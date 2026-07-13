/** Thrown when a repository-relative path escapes the repository or is absolute. */
export class InvalidRepoPathError extends Error {
  constructor(message = "path must be relative to the repository root") {
    super(message);
    this.name = "InvalidRepoPathError";
  }
}

/**
 * Normalize the subdirectory a repository's Terraform lives in (`terraformPath`).
 *
 * The empty string is the repository root — the default, and what every existing
 * repository has. Everything else is stored as a clean posix relative path
 * (`infra/azure`), so the value can be joined onto a clone directory and
 * compared against parsed file paths without re-normalizing at every use.
 *
 * A path that climbs out of the repository is a hard error, not something to
 * clamp: the clone directory is a temp dir and `../..` out of it is exactly the
 * traversal we refuse everywhere else (see repo-files).
 */
export function normalizeTerraformPath(input: string | null | undefined): string {
  if (input == null) return "";
  if (input.includes("\0")) throw new InvalidRepoPathError();

  const raw = input.trim().replaceAll("\\", "/");
  if (raw === "") return "";
  // `/infra` is a user saying "the infra directory", not the filesystem root, so
  // a leading slash is stripped rather than rejected. A drive letter is not.
  if (/^[a-zA-Z]:/.test(raw)) throw new InvalidRepoPathError();

  const parts: string[] = [];
  for (const segment of raw.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      // Only a `..` that stays inside the repository is a path we can resolve.
      if (parts.length === 0) throw new InvalidRepoPathError();
      parts.pop();
      continue;
    }
    parts.push(segment);
  }
  return parts.join("/");
}
