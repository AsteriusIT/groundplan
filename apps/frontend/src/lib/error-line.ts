/**
 * The line a parse-error message points at, when it names one (GP-127). The
 * 422 from `POST /playground/parse` names files; the message itself sometimes
 * carries a position — either prose ("… at line 12") or a `path:line[:col]`
 * suffix. Extract it so the editor can mark the offending line; a message with
 * no line is still a valid error, it just marks nothing.
 */
export function errorLineOf(message: string): number | null {
  const prose = /\bline (\d+)/i.exec(message);
  if (prose?.[1]) return Number(prose[1]);
  const suffix = /:(\d+)(?::\d+)?(?!\d)/.exec(message);
  if (suffix?.[1]) return Number(suffix[1]);
  return null;
}
