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
