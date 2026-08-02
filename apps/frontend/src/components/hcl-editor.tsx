import { useEffect, useRef } from "react";
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
} from "@codemirror/commands";
import { indentUnit } from "@codemirror/language";
import {
  Compartment,
  EditorState,
  RangeSetBuilder,
  type Extension,
} from "@codemirror/state";
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
 * optional parse-error line mark. Deliberately no LSP and no autocompletion.
 *
 * It edits one file at a time but remembers the others (GP-245). Given a
 * `docId`, switching documents swaps CodeMirror's state rather than rebuilding
 * the editor, so a tab you come back to has the cursor, the selection, the
 * scroll position and the undo history you left it with — which is the whole
 * difference between tabs and a file picker.
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
 * A line decoration, recomputed with the doc so an edit that removes lines
 * never leaves the mark pointing past the end.
 */
function lineDecoration(line: number | null | undefined, className: string) {
  return EditorView.decorations.compute(["doc"], (state) => {
    if (!line || line < 1 || line > state.doc.lines) return Decoration.none;
    return Decoration.set([
      Decoration.line({ class: className }).range(state.doc.line(line).from),
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
  ".cm-located-line": { backgroundColor: "var(--accent)" },
  ".cm-cursor": { borderLeftColor: "var(--foreground)" },
});

/**
 * The caret follows the text, in every theme.
 *
 * There is no `drawSelection` here, so the cursor is the browser's own and its
 * colour comes from `caret-color` — which CodeMirror's base theme sets to
 * *black* on any editor not registered as dark. This editor is neither: the app
 * has three themes and the token already knows which one is on, so the honest
 * rule is "the same colour as the text". It has to be a **base** theme to say
 * it: `&light`/`&dark` mean nothing in `EditorView.theme`, and beating a rule
 * of the library's own base theme means matching its specificity from a sheet
 * mounted after it.
 */
const caretTheme = EditorView.baseTheme({
  "&light .cm-content": { caretColor: "var(--foreground)" },
  "&dark .cm-content": { caretColor: "var(--foreground)" },
});

export function HclEditor({
  value,
  onChange,
  ariaLabel,
  errorLine = null,
  locatedLine = null,
  docId,
  className,
  readOnly = false,
}: Readonly<{
  value: string;
  onChange: (content: string) => void;
  ariaLabel: string;
  /** 1-based line to mark as the parse error, when the server named one. */
  errorLine?: number | null;
  /**
   * 1-based line to reveal and mark — the diagram's node→code jump (GP-245).
   * Neutral, not a status colour: it says "here", not "wrong".
   */
  locatedLine?: number | null;
  /**
   * Which document is being edited. When it changes the editor swaps state
   * instead of remounting, keeping each document's cursor, scroll and undo
   * history (GP-245). Omit for a single-document editor.
   */
  docId?: string;
  className?: string;
  /** Read the code, do not write it — the builder's generation preview (GP-135). */
  readOnly?: boolean;
}>) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  // The latest onChange without rebuilding the editor around it.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const errorCompartment = useRef(new Compartment());
  const locatedCompartment = useRef(new Compartment());
  // Per-document state, so a tab remembers where you were in it.
  const states = useRef(new Map<string, { state: EditorState; scrollTop: number }>());
  const openDoc = useRef<string>(docId ?? "");
  // Read by the mount effect only; a ref keeps it out of the dependency list.
  const initial = useRef({ value, errorLine, locatedLine, readOnly });

  /** Everything a document's state is built from — one list, one place. */
  const extensions = (
    error: number | null,
    located: number | null,
  ): Extension[] => [
    lineNumbers(),
    history(),
    keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
    indentUnit.of("  "),
    EditorState.tabSize.of(2),
    hclHighlighter,
    // Mount-time only, like the doc itself: the preview is a fresh editor
    // per file, never a live one that turns read-only mid-session.
    ...(initial.current.readOnly
      ? [EditorState.readOnly.of(true), EditorView.editable.of(false)]
      : []),
    errorCompartment.current.of(lineDecoration(error, "cm-error-line")),
    locatedCompartment.current.of(lineDecoration(located, "cm-located-line")),
    EditorView.contentAttributes.of({ "aria-label": ariaLabel }),
    EditorView.updateListener.of((update) => {
      if (update.docChanged) {
        onChangeRef.current(update.state.doc.toString());
      }
    }),
    editorTheme,
    caretTheme,
  ];

  // One EditorView per mount. Documents come and go through `docId`.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const start = initial.current;
    const view = new EditorView({
      state: EditorState.create({
        doc: start.value,
        extensions: extensions(start.errorLine ?? null, start.locatedLine ?? null),
      }),
      parent: host,
    });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
      states.current.clear();
    };
    // Mount-only: `value` seeds the doc, later values sync below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Switching documents: park the one leaving, restore the one arriving.
  useEffect(() => {
    const view = viewRef.current;
    const next = docId ?? "";
    if (!view || next === openDoc.current) return;
    states.current.set(openDoc.current, {
      state: view.state,
      scrollTop: view.scrollDOM.scrollTop,
    });
    const parked = states.current.get(next);
    view.setState(
      parked?.state ??
        EditorState.create({
          doc: value,
          extensions: extensions(errorLine ?? null, locatedLine ?? null),
        }),
    );
    if (parked) view.scrollDOM.scrollTop = parked.scrollTop;
    openDoc.current = next;
    // The document is the dependency; the rest is read at swap time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docId]);

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
      effects: errorCompartment.current.reconfigure(
        lineDecoration(errorLine, "cm-error-line"),
      ),
    });
  }, [errorLine]);

  // The located line is also scrolled to: being told where something is and
  // then having to find it would be half an answer.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: locatedCompartment.current.reconfigure(
        lineDecoration(locatedLine, "cm-located-line"),
      ),
    });
    if (locatedLine && locatedLine >= 1 && locatedLine <= view.state.doc.lines) {
      const { from } = view.state.doc.line(locatedLine);
      view.dispatch({
        selection: { anchor: from },
        effects: EditorView.scrollIntoView(from, { y: "center" }),
      });
    }
  }, [locatedLine]);

  return (
    <div
      ref={hostRef}
      className={cn("min-h-0 flex-1 overflow-hidden", className)}
    />
  );
}
