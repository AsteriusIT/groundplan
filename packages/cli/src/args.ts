/**
 * A deliberately tiny argv parser — no dependency, because the whole point of the
 * CLI (GP-110) is that `npx @asteriusit/cli` pulls nothing else into CI.
 *
 * Supports `<command>`, `--flag value`, `--flag=value`, and bare `--flag` (true).
 * A `--flag` immediately followed by another `--flag` is treated as a boolean, so
 * `--help --file x` reads `help: true, file: "x"`.
 */
export interface ParsedArgs {
  command: string | undefined;
  flags: Record<string, string | boolean>;
}

export function parseArgs(argv: string[]): ParsedArgs {
  let command: string | undefined;
  const flags: Record<string, string | boolean> = {};

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;

    if (arg.startsWith("--")) {
      const body = arg.slice(2);
      const eq = body.indexOf("=");
      if (eq !== -1) {
        flags[body.slice(0, eq)] = body.slice(eq + 1);
        continue;
      }
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[body] = next;
        i++;
      } else {
        flags[body] = true;
      }
    } else if (command === undefined) {
      command = arg;
    }
  }

  return { command, flags };
}

/** A flag's string value, or undefined if it was absent or a bare boolean. */
export function stringFlag(value: string | boolean | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}
