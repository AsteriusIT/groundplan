/**
 * A four-role HCL tokenizer for the Source section of the detail panel (GP-121).
 *
 * Deliberately not a syntax-highlighting library. Shiki ships a WASM grammar and
 * prism-react-renderer ships its own hardcoded theme palettes — both are large,
 * and both would fight the blueprint themes the design system owns (GP-28). What
 * a reader needs from a snippet in a 320px panel is orientation, not study: which
 * lines are prose, which values are literal, where the block starts. Four roles
 * answers that; more hues would be noise.
 *
 * The one hard rule: tokenizing never alters the text. Concatenating every
 * token's `text` returns the input exactly, so what renders is what the file
 * says — the same promise the backend snippet makes (GP-120).
 */
export type CodeTokenKind = "comment" | "string" | "number" | "keyword" | "plain";

export type CodeToken = {
  text: string;
  kind: CodeTokenKind;
};

/** HCL words worth marking: block types, and the literals that read as values. */
const KEYWORDS = [
  "resource",
  "data",
  "module",
  "variable",
  "output",
  "locals",
  "provider",
  "terraform",
  "true",
  "false",
  "null",
  "for",
  "in",
  "if",
].join("|");

/**
 * One pass, alternatives in precedence order. Order only decides ties at the same
 * start index, which is what makes `"a#b"` a string and `# say "hi"` a comment:
 * the scanner reaches whichever opener comes first in the text.
 */
const TOKEN_RE = new RegExp(
  [
    // # line, // line, /* block */
    String.raw`(?<comment>#[^\n]*|\/\/[^\n]*|\/\*[\s\S]*?\*\/)`,
    // Heredoc: everything through the closing tag on its own line.
    String.raw`(?<heredoc><<-?(?<tag>[A-Za-z_]\w*)[\s\S]*?^[ \t]*\k<tag>)`,
    // Quoted string; an escaped quote does not close it.
    String.raw`(?<string>"(?:[^"\\\n]|\\.)*")`,
    String.raw`(?<number>\b\d+(?:\.\d+)?\b)`,
    String.raw`(?<keyword>\b(?:${KEYWORDS})\b)`,
  ].join("|"),
  "gm",
);

/** Split HCL into coloured spans. The concatenated text is always the input. */
export function tokenizeHcl(code: string): CodeToken[] {
  const tokens: CodeToken[] = [];
  let last = 0;

  const pushPlain = (upTo: number) => {
    if (upTo > last) tokens.push({ text: code.slice(last, upTo), kind: "plain" });
  };

  TOKEN_RE.lastIndex = 0;
  for (const match of code.matchAll(TOKEN_RE)) {
    const start = match.index;
    const text = match[0];
    pushPlain(start);
    const groups = match.groups ?? {};
    // A heredoc is a string that happens to span lines — same role to the reader.
    const kind: CodeTokenKind = groups["comment"]
      ? "comment"
      : groups["heredoc"] || groups["string"]
        ? "string"
        : groups["number"]
          ? "number"
          : "keyword";
    tokens.push({ text, kind });
    last = start + text.length;
  }
  pushPlain(code.length);

  return tokens;
}
