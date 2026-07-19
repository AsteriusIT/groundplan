/**
 * Groundplan for VS Code: "Groundplan: Open Preview" opens a webview beside
 * the editor and renders the workspace's Terraform as the same diagram the
 * web app draws — parsed locally by @groundplan/graph-parser, styled by
 * @groundplan/canvas. Everything is bundled; nothing leaves the machine.
 *
 * GP-147: one-shot render. GP-148: the preview is live — edits re-parse
 * (debounced, dirty buffers included), a failed parse keeps the last good
 * graph and marks the panel out of sync, parse errors land in the Problems
 * panel and clear when the parse heals.
 */
import { parse, type Graph } from "@groundplan/graph-parser";
import * as vscode from "vscode";

import {
  createDebouncer,
  hasParseErrors,
  toFileDiagnostics,
  type Debouncer,
} from "./live-core";
import type { HostMessage, WebviewMessage } from "./messages";
import { gatherTfFiles } from "./workspace-files";
import { buildWebviewHtml, makeNonce } from "./webview-html";

/** How long typing may pause before the diagram catches up (GP-148). */
const REPARSE_DEBOUNCE_MS = 500;

let preview: LivePreview | null = null;

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("groundplan.openPreview", () => {
      const folder = vscode.workspace.workspaceFolders?.[0] ?? null;
      if (!folder) {
        void vscode.window.showErrorMessage(
          "Groundplan: open a folder containing Terraform first.",
        );
        return;
      }
      if (preview) preview.reveal();
      else {
        preview = new LivePreview(context, folder, () => {
          preview = null;
        });
      }
    }),
  );
}

export function deactivate(): void {
  preview?.dispose();
  preview = null;
}

/** One preview panel and everything that keeps it honest while you type. */
class LivePreview {
  private readonly panel: vscode.WebviewPanel;
  private readonly diagnostics: vscode.DiagnosticCollection;
  private readonly reparse: Debouncer;
  private readonly disposables: vscode.Disposable[] = [];
  /** The last snapshot from a clean parse — what the panel falls back to. */
  private lastGood: Graph | null = null;

  constructor(
    context: vscode.ExtensionContext,
    private readonly folder: vscode.WorkspaceFolder,
    private readonly onDispose: () => void,
  ) {
    const distRoot = vscode.Uri.joinPath(
      context.extensionUri,
      "dist",
      "webview",
    );
    this.panel = vscode.window.createWebviewPanel(
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

    this.diagnostics = vscode.languages.createDiagnosticCollection("groundplan");
    this.reparse = createDebouncer(() => void this.refresh(), REPARSE_DEBOUNCE_MS);

    // Live while you type: in-memory edits count (dirty buffers are read by
    // gatherTfFiles), so the trigger is the text change, not the save.
    this.disposables.push(
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.document.fileName.endsWith(".tf")) this.reparse.schedule();
      }),
    );
    // Create/delete/rename arrive from the file system watcher.
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(this.folder, "**/*.tf"),
    );
    watcher.onDidCreate(() => this.reparse.schedule());
    watcher.onDidDelete(() => this.reparse.schedule());
    watcher.onDidChange(() => this.reparse.schedule());
    this.disposables.push(watcher);

    this.panel.webview.onDidReceiveMessage((message: WebviewMessage) => {
      if (message.type === "ready") void this.refresh();
    });

    this.panel.onDidDispose(() => {
      this.reparse.dispose();
      this.diagnostics.dispose();
      for (const d of this.disposables) d.dispose();
      this.onDispose();
    });

    this.panel.webview.html = buildWebviewHtml({
      cspSource: this.panel.webview.cspSource,
      nonce: makeNonce(),
      baseHref: this.panel.webview.asWebviewUri(distRoot).toString(),
    });
  }

  reveal(): void {
    this.panel.reveal(vscode.ViewColumn.Beside, true);
    void this.refresh();
  }

  dispose(): void {
    this.panel.dispose();
  }

  /** Re-parse the folder and reconcile panel + Problems with the result. */
  private async refresh(): Promise<void> {
    const files = await gatherTfFiles(this.folder);
    const { snapshot, diagnostics } = parse(files);

    this.publishProblems(toFileDiagnostics(diagnostics));

    if (hasParseErrors(diagnostics) && this.lastGood) {
      // Mid-edit broken state: the reader keeps the graph they had.
      await this.post({ type: "outOfSync", value: true });
      return;
    }
    if (!hasParseErrors(diagnostics)) this.lastGood = snapshot;
    // First-ever parse may be broken — a partial diagram beats a blank panel.
    await this.post({
      type: "snapshot",
      snapshot: this.lastGood ?? snapshot,
      folder: this.folder.name,
      multiRoot: (vscode.workspace.workspaceFolders?.length ?? 0) > 1,
    });
    await this.post({ type: "outOfSync", value: hasParseErrors(diagnostics) });
  }

  /** The snapshot of the last clean parse (GP-149 navigation works off it). */
  get lastGoodSnapshot(): Graph | null {
    return this.lastGood;
  }

  private publishProblems(
    byFile: ReadonlyMap<
      string,
      { startLine: number; endLine: number; message: string; severity: string }[]
    >,
  ): void {
    this.diagnostics.clear();
    for (const [file, entries] of byFile) {
      const uri = vscode.Uri.joinPath(this.folder.uri, file);
      this.diagnostics.set(
        uri,
        entries.map((e) => {
          const diagnostic = new vscode.Diagnostic(
            new vscode.Range(e.startLine, 0, e.endLine, Number.MAX_SAFE_INTEGER),
            e.message,
            e.severity === "error"
              ? vscode.DiagnosticSeverity.Error
              : vscode.DiagnosticSeverity.Warning,
          );
          diagnostic.source = "groundplan";
          return diagnostic;
        }),
      );
    }
  }

  private async post(message: HostMessage): Promise<void> {
    await this.panel.webview.postMessage(message);
  }
}
