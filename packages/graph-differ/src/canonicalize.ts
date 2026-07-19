/**
 * The canonical attribute form a static diff compares by (GP-153): a node's
 * HCL block body (`source.code`, GP-120) flattened to `path → normalized
 * expression text`. Two blocks that differ only in formatting — indentation,
 * attribute order, bracket spacing, comments, comma-vs-newline separators —
 * canonicalize to the same map, so a reformat is a `noop` by construction.
 * Positional metadata (file, line) never participates.
 *
 * The scanner mirrors graph-parser's philosophy: a small, focused, comment-,
 * string- and heredoc-aware walk, not an HCL grammar. Quoted strings and
 * heredoc bodies are preserved verbatim (whitespace inside them is meaning);
 * everything else is whitespace-insensitive.
 */
import type { GraphNode } from "@groundplan/graph-parser";

const isIdentChar = (c: string): boolean => /[A-Za-z0-9_.-]/.test(c);

/** Chars whose surrounding whitespace carries no meaning in an expression. */
const PUNCT_RE = /[ \t]*([[\](){}<>=!?:.+\-*/%&|^])[ \t]*/g;

/**
 * Normalize a comment-free, string-free stretch of expression text: comma and
 * newline separators become one space (HCL treats them alike in collections),
 * whitespace runs collapse, and spacing around operators/brackets is dropped.
 */
function normalizeBare(text: string): string {
  return text.replaceAll(",", " ").replace(/\s+/g, " ").replace(PUNCT_RE, "$1");
}

/** One scanned body entry: an attribute's expression, or a nested block. */
type Entry =
  | { kind: "attr"; key: string; value: string }
  | { kind: "block"; path: string; body: string };

/**
 * A character scanner over a block body. Shared cursor logic for both the
 * entry scan and expression reading; strings and heredocs are copied verbatim
 * into `protected` segments, comments vanish.
 */
class BodyScanner {
  private i = 0;
  constructor(private readonly src: string) {}

  private get n(): number {
    return this.src.length;
  }

  private at(offset = 0): string | undefined {
    return this.src[this.i + offset];
  }

  /** Skip whitespace and comments. */
  skipTrivia(): void {
    while (this.i < this.n) {
      const c = this.at()!;
      if (c === " " || c === "\t" || c === "\r" || c === "\n") this.i++;
      else if (c === "#") this.skipLineComment();
      else if (c === "/" && this.at(1) === "/") this.skipLineComment();
      else if (c === "/" && this.at(1) === "*") this.skipBlockComment();
      else break;
    }
  }

  private skipLineComment(): void {
    while (this.i < this.n && this.at() !== "\n") this.i++;
  }

  private skipBlockComment(): void {
    this.i += 2;
    while (this.i < this.n && !(this.at() === "*" && this.at(1) === "/")) this.i++;
    this.i += 2;
  }

  private readIdent(): string {
    const start = this.i;
    while (this.i < this.n && isIdentChar(this.at()!)) this.i++;
    return this.src.slice(start, this.i);
  }

  /** Consume a quoted string (cursor on the opening quote), verbatim. */
  private readString(): string {
    const start = this.i;
    this.i++;
    while (this.i < this.n) {
      const c = this.at()!;
      if (c === "\\") this.i += 2;
      else if (c === '"') {
        this.i++;
        break;
      } else this.i++;
    }
    return this.src.slice(start, this.i);
  }

  /** Consume a heredoc (cursor on `<<`), verbatim including its body. */
  private readHeredoc(): string {
    const start = this.i;
    this.i += 2;
    if (this.at() === "-") this.i++;
    const tagStart = this.i;
    while (this.i < this.n && /[A-Za-z0-9_]/.test(this.at()!)) this.i++;
    const tag = this.src.slice(tagStart, this.i);
    while (this.i < this.n && this.at() !== "\n") this.i++;
    this.i++;
    while (this.i < this.n) {
      let j = this.i;
      while (j < this.n && (this.src[j] === " " || this.src[j] === "\t")) j++;
      if (this.src.startsWith(tag, j)) {
        const after = this.src[j + tag.length];
        if (after === undefined || after === "\n" || after === "\r") {
          this.i = j + tag.length;
          break;
        }
      }
      while (this.i < this.n && this.at() !== "\n") this.i++;
      this.i++;
    }
    return this.src.slice(start, this.i);
  }

  /** Consume a `{ … }` body (cursor on the `{`); returns the inner text. */
  private readBraced(): string {
    const start = this.i + 1;
    this.i++;
    let depth = 1;
    while (this.i < this.n && depth > 0) {
      const c = this.at()!;
      if (c === "#") this.skipLineComment();
      else if (c === "/" && this.at(1) === "/") this.skipLineComment();
      else if (c === "/" && this.at(1) === "*") this.skipBlockComment();
      else if (c === '"') this.readString();
      else if (c === "<" && this.at(1) === "<") this.readHeredoc();
      else if (c === "{") {
        depth++;
        this.i++;
      } else if (c === "}") {
        depth--;
        this.i++;
      } else this.i++;
    }
    return this.src.slice(start, Math.max(start, this.i - 1));
  }

  /**
   * Read the expression after `=`: to end-of-line at bracket depth zero (or
   * EOF), already normalized. Strings/heredocs are protected segments.
   */
  private readExpression(): string {
    const parts: string[] = [];
    let bare = "";
    const flush = (): void => {
      parts.push(normalizeBare(bare));
      bare = "";
    };
    let depth = 0;
    while (this.i < this.n) {
      const c = this.at()!;
      if (c === "\n" && depth === 0) break;
      if (c === "#" || (c === "/" && this.at(1) === "/")) this.skipLineComment();
      else if (c === "/" && this.at(1) === "*") this.skipBlockComment();
      else if (c === '"') {
        flush();
        parts.push(this.readString());
      } else if (c === "<" && this.at(1) === "<") {
        flush();
        parts.push(this.readHeredoc());
      } else {
        if (c === "(" || c === "[" || c === "{") depth++;
        else if (c === ")" || c === "]" || c === "}") depth--;
        bare += c;
        this.i++;
      }
    }
    flush();
    return parts.join("").trim();
  }

  /** Scan the body into its ordered attribute / nested-block entries. */
  scanEntries(): Entry[] {
    const entries: Entry[] = [];
    while (this.i < this.n) {
      this.skipTrivia();
      if (this.i >= this.n) break;
      if (!isIdentChar(this.at()!)) {
        this.i++;
        continue;
      }
      const ident = this.readIdent();
      const labels: string[] = [];
      let handled = false;
      while (!handled && this.i <= this.n) {
        this.skipTrivia();
        const c = this.at();
        if (c === "=") {
          this.i++;
          this.skipTrivia();
          entries.push({ kind: "attr", key: ident, value: this.readExpression() });
          handled = true;
        } else if (c === "{") {
          entries.push({
            kind: "block",
            path: [ident, ...labels].join("."),
            body: this.readBraced(),
          });
          handled = true;
        } else if (c === '"') {
          labels.push(this.readString().slice(1, -1));
        } else if (c !== undefined && isIdentChar(c)) {
          labels.push(this.readIdent());
        } else {
          // Stray token — skip it rather than loop forever.
          if (c !== undefined) this.i++;
          handled = true;
        }
      }
    }
    return entries;
  }
}

/** Flatten a body's entries into `out`, indexing repeated nested blocks. */
function flattenBody(body: string, prefix: string, out: Record<string, string>): void {
  const entries = new BodyScanner(body).scanEntries();
  const blockCounts = new Map<string, number>();
  for (const e of entries) {
    if (e.kind === "block") blockCounts.set(e.path, (blockCounts.get(e.path) ?? 0) + 1);
  }
  const blockSeen = new Map<string, number>();
  for (const e of entries) {
    if (e.kind === "attr") {
      out[prefix + e.key] = e.value;
      continue;
    }
    let path = e.path;
    if ((blockCounts.get(e.path) ?? 0) > 1) {
      const index = blockSeen.get(e.path) ?? 0;
      blockSeen.set(e.path, index + 1);
      path = `${e.path}[${index}]`;
    }
    flattenBody(e.body, `${prefix}${path}.`, out);
  }
}

/**
 * The canonical `path → value` form of a node's own content. HCL nodes are
 * read from their block source; nodes without one (a Kubernetes object) fall
 * back to the `attributes` bag they already carry; anything else is empty —
 * comparable by existence only.
 */
export function canonicalAttributes(node: GraphNode): Record<string, string> {
  if (node.source) {
    const code = node.source.code;
    const open = code.indexOf("{");
    const close = code.lastIndexOf("}");
    if (open === -1 || close <= open) return {};
    const out: Record<string, string> = {};
    flattenBody(code.slice(open + 1, close), "", out);
    return out;
  }
  return node.attributes ? { ...node.attributes } : {};
}
