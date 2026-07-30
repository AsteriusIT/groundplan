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
