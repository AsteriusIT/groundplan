/**
 * Gather the workspace's Terraform as parser input (GP-147). The parser wants
 * `{ path, content }` with repository-relative posix paths — exactly what the
 * backend feeds it from a clone, so a workspace folder and a repo parse the
 * same way.
 */
import * as vscode from "vscode";

import { TF_EXCLUDE_GLOB, toPosixRelative } from "./paths";

export type WorkspaceTfFile = { path: string; content: string };

/**
 * Read every `.tf` under the folder (excluding vendored dirs). Open dirty
 * editors take precedence over disk — the preview reflects what the author
 * sees, not what they last saved (the GP-148 "live while you type" promise).
 */
export async function gatherTfFiles(
  folder: vscode.WorkspaceFolder,
): Promise<WorkspaceTfFile[]> {
  const uris = await vscode.workspace.findFiles(
    new vscode.RelativePattern(folder, "**/*.tf"),
    TF_EXCLUDE_GLOB,
  );

  // Dirty (and simply open) documents override the on-disk bytes.
  const openDocs = new Map<string, string>();
  for (const doc of vscode.workspace.textDocuments) {
    if (doc.uri.scheme === "file" && doc.fileName.endsWith(".tf")) {
      openDocs.set(doc.uri.fsPath, doc.getText());
    }
  }

  const decoder = new TextDecoder();
  const files = await Promise.all(
    uris.map(async (uri) => {
      const open = openDocs.get(uri.fsPath);
      const content =
        open ?? decoder.decode(await vscode.workspace.fs.readFile(uri));
      return { path: toPosixRelative(folder.uri.fsPath, uri.fsPath), content };
    }),
  );
  return files.sort((a, b) => (a.path < b.path ? -1 : 1));
}
