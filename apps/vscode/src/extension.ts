/**
 * Groundplan for VS Code: "Groundplan: Open Preview" opens a webview beside
 * the editor and renders the workspace's Terraform as the same diagram the
 * web app draws — parsed locally by @groundplan/graph-parser, styled by
 * @groundplan/canvas. Everything is bundled; nothing leaves the machine.
 *
 * GP-147: one-shot render. GP-148: the preview is live — edits re-parse
 * (debounced, dirty buffers included), a failed parse keeps the last good
 * graph and marks the panel out of sync, parse errors land in the Problems
 * panel and clear when the parse heals. GP-152/154: diff mode — the live
 * graph annotated against a git baseline (HEAD or merge-base main) by
 * @groundplan/graph-differ; only the "after" side re-parses per keystroke,
 * the baseline is cached per sha and moves only when git says so.
 */
import { diff, isAllNoop } from "@groundplan/graph-differ";
import { parse, type Graph } from "@groundplan/graph-parser";
import * as vscode from "vscode";

import {
  BaselineProvider,
  findGitRoot,
  watchGitChanges,
  type GitWatcher,
} from "./git-baseline";
import {
  createDebouncer,
  hasParseErrors,
  toFileDiagnostics,
  type Debouncer,
} from "./live-core";
import { nodeAtPosition, sourceOf } from "./locate";
import type {
  BaselineMode,
  DiffState,
  HostMessage,
  WebviewMessage,
} from "./messages";
import { toPosixRelative } from "./paths";
import { gatherTfFiles } from "./workspace-files";
import { buildWebviewHtml, makeNonce } from "./webview-html";

/** How long typing may pause before the diagram catches up (GP-148). */
const REPARSE_DEBOUNCE_MS = 500;
/** Cursor movement settles before the diagram highlight follows (GP-149). */
const SELECTION_DEBOUNCE_MS = 200;
/** How long the jumped-to block stays lit in the editor (GP-149). */
const HIGHLIGHT_FADE_MS = 1000;

/** workspaceState keys for the persisted diff choices (GP-154). */
const PREF_ENABLED = "groundplan.diff.enabled";
const PREF_MODE = "groundplan.diff.mode";
const PREF_CHANGED_ONLY = "groundplan.diff.changedOnly";

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
  private readonly followCursor: Debouncer;
  private readonly disposables: vscode.Disposable[] = [];
  /** The last snapshot from a clean parse — what the panel falls back to. */
  private lastGood: Graph | null = null;
  /** The last graph actually posted (annotated in diff mode) — ghost lookups. */
  private lastPosted: Graph | null = null;
  /** The last address either side selected — the loop guard (GP-149). */
  private lastSelected: string | null = null;

  /** Diff mode (GP-152/154): the baseline provider + the git-change signal. */
  private readonly baseline: BaselineProvider;
  private readonly gitWatcher: GitWatcher | null;
  /** Every git invocation is logged here — "no git while typing" is checkable. */
  private readonly gitLog: vscode.OutputChannel;
  private readonly workspaceState: vscode.Memento;

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
    this.workspaceState = context.workspaceState;
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

    this.gitLog = vscode.window.createOutputChannel("Groundplan Git");
    this.baseline = new BaselineProvider(
      this.folder.uri.fsPath,
      undefined,
      (line) => this.gitLog.appendLine(line),
    );
    // A commit/checkout/fetch moves the baseline; a keystroke never does.
    const gitRoot = findGitRoot(this.folder.uri.fsPath);
    this.gitWatcher = gitRoot
      ? watchGitChanges(gitRoot, () => {
          this.baseline.invalidate();
          this.reparse.schedule();
        })
      : null;

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

    // Code → node (GP-149): the cursor resolves against the last good
    // snapshot's ranges; unparsed files and non-resource lines say null.
    this.followCursor = createDebouncer(
      () => void this.postCursorSelection(),
      SELECTION_DEBOUNCE_MS,
    );
    this.disposables.push(
      vscode.window.onDidChangeTextEditorSelection((e) => {
        if (e.textEditor.document.fileName.endsWith(".tf")) {
          this.followCursor.schedule();
        }
      }),
    );

    this.panel.webview.onDidReceiveMessage((message: WebviewMessage) => {
      if (message.type === "ready") void this.refresh();
      // Node → code (GP-149): a click in the diagram opens the block.
      if (message.type === "nodeSelected") {
        this.lastSelected = message.address;
        if (message.address) void this.revealOrExplain(message.address);
      }
      // Diff prefs (GP-154): persist, then re-render under the new lens.
      if (message.type === "setDiffPrefs") {
        void this.workspaceState.update(PREF_ENABLED, message.enabled);
        void this.workspaceState.update(PREF_MODE, message.mode);
        void this.workspaceState.update(PREF_CHANGED_ONLY, message.changedOnly);
        void this.refresh();
      }
    });

    this.panel.onDidDispose(() => {
      this.reparse.dispose();
      this.diagnostics.dispose();
      this.gitWatcher?.dispose();
      this.gitLog.dispose();
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

  /** The user's persisted diff choices (GP-154), with quiet defaults. */
  private prefs(): { enabled: boolean; mode: BaselineMode; changedOnly: boolean } {
    return {
      enabled: this.workspaceState.get<boolean>(PREF_ENABLED, false),
      mode: this.workspaceState.get<BaselineMode>(PREF_MODE, "head"),
      changedOnly: this.workspaceState.get<boolean>(PREF_CHANGED_ONLY, false),
    };
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
    const current = this.lastGood ?? snapshot;

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

    this.lastPosted = posted;
    await this.post({
      type: "snapshot",
      snapshot: posted,
      folder: this.folder.name,
      multiRoot: (vscode.workspace.workspaceFolders?.length ?? 0) > 1,
    });
    await this.post({ type: "diffState", state });
    await this.post({ type: "outOfSync", value: hasParseErrors(diagnostics) });
  }

  /** The snapshot of the last clean parse (GP-149 navigation works off it). */
  get lastGoodSnapshot(): Graph | null {
    return this.lastGood;
  }

  /**
   * Node → code, diff-aware (GP-154): a ghost has no block in the working
   * tree to open — say where it lived instead of navigating nowhere.
   */
  private async revealOrExplain(address: string): Promise<void> {
    const node = this.lastPosted?.nodes.find((n) => n.id === address);
    if (node?.change === "delete") {
      const where = node.source ? ` It existed in ${node.source.file}.` : "";
      void vscode.window.showInformationMessage(
        `Groundplan: “${address}” is deleted in this diff.${where}`,
      );
      return;
    }
    await this.revealInEditor(address);
  }

  /** Node → code: open the block a diagram click named, briefly highlighted. */
  private async revealInEditor(address: string): Promise<void> {
    if (!this.lastGood) return;
    const source = sourceOf(this.lastGood, address);
    if (!source) return;
    this.lastSelected = address;

    const uri = vscode.Uri.joinPath(this.folder.uri, source.file);
    const range = new vscode.Range(
      source.start_line - 1,
      0,
      source.end_line - 1,
      Number.MAX_SAFE_INTEGER,
    );
    const editor = await vscode.window.showTextDocument(uri, {
      viewColumn: vscode.ViewColumn.One,
      selection: new vscode.Selection(range.start, range.start),
    });
    editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);

    // A brief lit block says "this is what you clicked", then gets out of the
    // way — a permanent decoration would fight the editor's own selection.
    const highlight = vscode.window.createTextEditorDecorationType({
      backgroundColor: new vscode.ThemeColor("editor.findMatchHighlightBackground"),
      isWholeLine: true,
    });
    editor.setDecorations(highlight, [range]);
    setTimeout(() => highlight.dispose(), HIGHLIGHT_FADE_MS);
  }

  /** Code → node: tell the webview which resource block the cursor is in. */
  private async postCursorSelection(): Promise<void> {
    if (!this.lastGood) return;
    const editor = vscode.window.activeTextEditor;
    if (!editor || !editor.document.fileName.endsWith(".tf")) return;

    const relPath = toPosixRelative(
      this.folder.uri.fsPath,
      editor.document.uri.fsPath,
    );
    const node = nodeAtPosition(
      this.lastGood,
      relPath,
      editor.selection.active.line + 1,
    );
    const address = node?.id ?? null;
    // Same address as last time (usually the echo of our own reveal): stay
    // quiet — re-posting is how selection loops start.
    if (address === this.lastSelected) return;
    this.lastSelected = address;
    await this.post({ type: "select", address });
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
