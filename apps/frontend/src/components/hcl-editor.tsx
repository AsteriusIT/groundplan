import { useEffect, useRef } from "react";
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
} from "@codemirror/commands";
import { indentUnit } from "@codemirror/language";
import { Compartment, EditorState, RangeSetBuilder } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  keymap,
  lineNumbers,
  ViewPlugin,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";

import { tokenizeHcl, type CodeTokenKind } from "@/lib/hcl-highlight";
import { cn } from "@/lib/utils";

/**
 * The playground's HCL editor (GP-127): CodeMirror 6 with line numbers, the
 * shared four-role highlighting (GP-121's tokenizer — one grammar, one palette,
 * both surfaces), word-wrap off (columns survive, scroll horizontally), and an
 * optional parse-error line mark. Deliberately no LSP, no autocompletion, no
 * live linting — parsing stays a button, never a keystroke.
 */

/** Same roles → classes as the detail panel's Source section, on purpose. */
const TOKEN_CLASS: Record<Exclude<CodeTokenKind, "plain">, string> = {
  comment: "text-code-comment italic",
  string: "text-code-string",
  number: "text-code-number",
  keyword: "text-code-keyword",
};

function highlightDecorations(doc: string): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  let pos = 0;
  for (const token of tokenizeHcl(doc)) {
    const end = pos + token.text.length;
    if (token.kind !== "plain") {
      builder.add(pos, end, Decoration.mark({ class: TOKEN_CLASS[token.kind] }));
    }
    pos = end;
  }
  return builder.finish();
}

const hclHighlighter = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = highlightDecorations(view.state.doc.toString());
    }
    update(update: ViewUpdate) {
      if (update.docChanged) {
        this.decorations = highlightDecorations(update.state.doc.toString());
      }
    }
  },
  { decorations: (v) => v.decorations },
);

/**
 * A line decoration for the parse error, recomputed with the doc so an edit
 * that removes lines never leaves the mark pointing past the end.
 */
function errorLineDecoration(line: number | null | undefined) {
  return EditorView.decorations.compute(["doc"], (state) => {
    if (!line || line < 1 || line > state.doc.lines) return Decoration.none;
    return Decoration.set([
      Decoration.line({ class: "cm-error-line" }).range(state.doc.line(line).from),
    ]);
  });
}

/** Chrome-free theme: the design tokens own every colour (GP-9/GP-28). */
const editorTheme = EditorView.theme({
  "&": { height: "100%", fontSize: "12px", backgroundColor: "transparent" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": {
    fontFamily: "var(--font-mono)",
    lineHeight: "1.7",
    overflow: "auto",
  },
  ".cm-content": { padding: "8px 0" },
  ".cm-gutters": {
    // Opaque on purpose: the gutter is position:sticky and long lines scroll
    // horizontally beneath it — transparent would let code bleed through.
    backgroundColor: "var(--card)",
    borderRight: "1px solid var(--border)",
    color: "var(--muted-foreground)",
    fontSize: "10px",
  },
  ".cm-lineNumbers .cm-gutterElement": { padding: "0 8px 0 12px" },
  ".cm-activeLine": { backgroundColor: "transparent" },
  ".cm-error-line": { backgroundColor: "var(--delete-soft)" },
  ".cm-cursor": { borderLeftColor: "var(--foreground)" },
});

export function HclEditor({
  value,
  onChange,
  ariaLabel,
  errorLine = null,
  className,
}: Readonly<{
  value: string;
  onChange: (content: string) => void;
  ariaLabel: string;
  /** 1-based line to mark as the parse error, when the server named one. */
  errorLine?: number | null;
  className?: string;
}>) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  // The latest onChange without rebuilding the editor around it.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const errorCompartment = useRef(new Compartment());

  // One EditorView per mount; the page keys this component by file path, so a
  // file switch is a fresh editor (and a fresh undo history — per file, as it
  // should be).
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const view = new EditorView({
      state: EditorState.create({
        doc: value,
        extensions: [
          lineNumbers(),
          history(),
          keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
          indentUnit.of("  "),
          EditorState.tabSize.of(2),
          hclHighlighter,
          errorCompartment.current.of(errorLineDecoration(errorLine)),
          EditorView.contentAttributes.of({ "aria-label": ariaLabel }),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) {
              onChangeRef.current(update.state.doc.toString());
            }
          }),
          editorTheme,
        ],
      }),
      parent: host,
    });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // Mount-only: `value` seeds the doc, later values sync below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // External content changes (an upload replacing the open file) reset the
  // doc; self-originated edits already match and dispatch nothing.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (value !== current) {
      view.dispatch({ changes: { from: 0, to: current.length, insert: value } });
    }
  }, [value]);

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: errorCompartment.current.reconfigure(errorLineDecoration(errorLine)),
    });
  }, [errorLine]);

  return <div ref={hostRef} className={cn("min-h-0 flex-1 overflow-hidden", className)} />;
}
