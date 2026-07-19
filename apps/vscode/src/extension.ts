/**
 * Groundplan for VS Code (GP-147): "Groundplan: Open Preview" opens a webview
 * beside the editor and renders the workspace's Terraform as the same diagram
 * the web app draws — parsed locally by @groundplan/graph-parser, styled by
 * @groundplan/canvas. Everything is bundled; nothing leaves the machine.
 */
import { parse } from "@groundplan/graph-parser";
import * as vscode from "vscode";

import type { HostMessage, WebviewMessage } from "./messages";
import { gatherTfFiles } from "./workspace-files";
import { buildWebviewHtml, makeNonce } from "./webview-html";

let panel: vscode.WebviewPanel | null = null;

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("groundplan.openPreview", () =>
      openPreview(context),
    ),
  );
}

export function deactivate(): void {
  panel?.dispose();
  panel = null;
}

/** The folder we preview: v1 uses the first one and says so (multi-root). */
function previewFolder(): vscode.WorkspaceFolder | null {
  return vscode.workspace.workspaceFolders?.[0] ?? null;
}

async function openPreview(context: vscode.ExtensionContext): Promise<void> {
  const folder = previewFolder();
  if (!folder) {
    void vscode.window.showErrorMessage(
      "Groundplan: open a folder containing Terraform first.",
    );
    return;
  }

  if (panel) {
    panel.reveal(vscode.ViewColumn.Beside, true);
    await postSnapshot(folder);
    return;
  }

  const distRoot = vscode.Uri.joinPath(context.extensionUri, "dist", "webview");
  panel = vscode.window.createWebviewPanel(
    "groundplan.preview",
    "Groundplan Preview",
    { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
    {
      enableScripts: true,
      localResourceRoots: [distRoot],
      // Small graphs; keeping the context avoids a full re-layout flicker
      // every time the tab is revisited.
      retainContextWhenHidden: true,
    },
  );
  panel.onDidDispose(() => {
    panel = null;
  });

  panel.webview.onDidReceiveMessage(async (message: WebviewMessage) => {
    if (message.type === "ready") {
      const f = previewFolder();
      if (f) await postSnapshot(f);
    }
  });

  panel.webview.html = buildWebviewHtml({
    cspSource: panel.webview.cspSource,
    nonce: makeNonce(),
    baseHref: panel.webview.asWebviewUri(distRoot).toString(),
  });
}

/** Parse the folder's Terraform and hand the snapshot to the webview. */
async function postSnapshot(folder: vscode.WorkspaceFolder): Promise<void> {
  if (!panel) return;
  const files = await gatherTfFiles(folder);
  const { snapshot } = parse(files);
  await post({
    type: "snapshot",
    snapshot,
    folder: folder.name,
    multiRoot: (vscode.workspace.workspaceFolders?.length ?? 0) > 1,
  });
}

async function post(message: HostMessage): Promise<void> {
  await panel?.webview.postMessage(message);
}
