/**
 * Schema extraction (GP-236): the one place in this product that runs the
 * `terraform` binary.
 *
 * What it runs it against is the whole point, and the sentence has to be exact:
 * **an empty, generated config that pins one allowlisted public provider**. No
 * customer code, no state, no backend, no variables, no credentials of any
 * kind — the directory holds a `main.tf` this file wrote, containing a
 * `required_providers` block and nothing else. `terraform init` downloads the
 * provider, `terraform providers schema -json` asks it to describe itself, and
 * the directory is deleted. The trust model is untouched: we still never run
 * `terraform` against anyone's infrastructure, state or code (GP-240).
 *
 * A provider is an executable that `init` downloads and `providers schema` runs,
 * so this module treats every input as hostile:
 *
 * - the **allowlist is checked before anything is spawned**, and the check is
 *   the first statement of `extract` — not a validation somewhere upstream that
 *   a future caller could forget;
 * - the version must be a plain semver, so nothing can escape the string
 *   interpolation into `main.tf`;
 * - both commands run with a wall clock, a killed process group, an output cap
 *   and a scrubbed environment;
 * - the temp directory is removed on every path, success or failure.
 *
 * Everything else — non-root, memory and disk limits, egress restricted to the
 * registry and the release host — is the worker container's job, because those
 * are guarantees a process cannot honestly make about itself. See
 * `apps/backend/Dockerfile.catalog-worker` and the chart's worker values.
 */
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  parseProviderSchema,
  type ProviderResourceSchema,
  type RawProvidersSchema,
} from "@groundplan/builder";

import {
  isAllowlisted,
  providerId,
  type ProviderRef,
} from "./providers.js";
import type { SchemaExtractor } from "./refresh.js";

/** Exactly a released version. Anything else never reaches a command line. */
const VERSION = /^\d+\.\d+\.\d+$/;

/** Wall clock for one command. `terraform init` downloads ~300 MB for azurerm. */
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Cap on a command's captured output. `providers schema -json` for azurerm is
 * about 3 MB; the cap is generous but finite, because a provider that decides
 * to print forever must not become the worker's memory profile.
 */
const MAX_OUTPUT_BYTES = 256 * 1024 * 1024;

export type TerraformExtractorOptions = {
  allowlist: readonly ProviderRef[];
  /** The binary to run. A path, never something a caller composes. */
  terraformBin?: string;
  /**
   * Shared plugin cache. Without it every extraction re-downloads hundreds of
   * megabytes; with it, a second provider version reuses what it can.
   */
  pluginCacheDir?: string;
  timeoutMs?: number;
  /** Where the throwaway config is written. Defaults to the OS temp dir. */
  workDir?: string;
  log?: {
    info(obj: unknown, msg?: string): void;
    warn(obj: unknown, msg?: string): void;
  };
  /** Test seam: run a command and return its stdout. Defaults to a real spawn. */
  run?: RunCommand;
};

export type RunCommand = (
  command: string,
  args: readonly string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number },
) => Promise<string>;

/** The error a caller can tell apart from "the provider was broken". */
export class ProviderNotAllowlistedError extends Error {
  constructor(id: string) {
    super(`provider ${id} is not allowlisted for schema extraction`);
    this.name = "ProviderNotAllowlistedError";
  }
}

/**
 * The `main.tf` an extraction runs against, in full. It is worth reading as the
 * literal answer to "what do you run Terraform on": a `required_providers`
 * block pinned to one exact version, and no `provider` block at all — an empty
 * provider block is where credentials would go, and there are none to give.
 */
export function extractionConfig(ref: ProviderRef, version: string): string {
  return [
    "# Generated to extract a provider's schema. It describes no infrastructure,",
    "# holds no credentials and is deleted as soon as the schema is read.",
    "terraform {",
    "  required_providers {",
    `    ${ref.name} = {`,
    `      source  = "${ref.namespace}/${ref.name}"`,
    `      version = "${version}"`,
    "    }",
    "  }",
    "}",
    "",
  ].join("\n");
}

/**
 * Run a command with a wall clock, killing the whole process group on timeout.
 * `terraform init` spawns provider binaries; killing only the parent leaves
 * them running, which is how a "timed out" extraction keeps eating a container.
 */
export const runCommand: RunCommand = (command, args, opts) =>
  new Promise<string>((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd: opts.cwd,
      env: opts.env,
      // Its own process group, so a timeout can take the children with it.
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const out: Buffer[] = [];
    let outBytes = 0;
    let errTail = "";
    let settled = false;
    let timedOut = false;

    const kill = (): void => {
      try {
        // Negative pid = the process group.
        process.kill(-child.pid!, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, opts.timeoutMs);
    timer.unref?.();

    const finish = (err: Error | null, value?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve(value ?? "");
    };

    child.stdout.on("data", (chunk: Buffer) => {
      outBytes += chunk.length;
      if (outBytes > MAX_OUTPUT_BYTES) {
        kill();
        finish(new Error(`${command} produced more output than allowed`));
        return;
      }
      out.push(chunk);
    });
    // Only the tail of stderr: it becomes a one-line status field, and
    // Terraform's failure output is long and mostly decoration.
    child.stderr.on("data", (chunk: Buffer) => {
      errTail = (errTail + chunk.toString("utf8")).slice(-2000);
    });

    child.on("error", (err) => finish(err));
    child.on("close", (code) => {
      if (timedOut) {
        finish(new Error(`${command} timed out after ${opts.timeoutMs}ms`));
        return;
      }
      if (code !== 0) {
        finish(
          new Error(
            `${command} ${args[0] ?? ""} exited ${code}: ${errTail.trim().split("\n").slice(-3).join(" ") || "no output"}`,
          ),
        );
        return;
      }
      finish(null, Buffer.concat(out).toString("utf8"));
    });
  });

/**
 * The environment the commands run in: deliberately almost empty.
 *
 * Nothing from the worker's own environment is passed through — not the
 * database URL, not the encryption key, not an `ARM_*` or `AWS_*` credential an
 * operator may have exported for some other reason. What is left is what
 * Terraform needs to download a provider and nothing that could authenticate to
 * anything.
 */
export function extractionEnv(opts: {
  home: string;
  pluginCacheDir?: string;
}): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: opts.home,
    // Terraform's own "I am not a human at a terminal" switches.
    TF_IN_AUTOMATION: "1",
    TF_INPUT: "0",
    CHECKPOINT_DISABLE: "1",
    ...(opts.pluginCacheDir ? { TF_PLUGIN_CACHE_DIR: opts.pluginCacheDir } : {}),
    ...(process.env.SSL_CERT_FILE ? { SSL_CERT_FILE: process.env.SSL_CERT_FILE } : {}),
    ...(process.env.SSL_CERT_DIR ? { SSL_CERT_DIR: process.env.SSL_CERT_DIR } : {}),
  };
}

/**
 * The real extractor. One provider version in, its narrowed schemas out; a temp
 * directory that exists for the duration and never outlives it.
 */
export function terraformExtractor(
  opts: TerraformExtractorOptions,
): SchemaExtractor {
  const bin = opts.terraformBin ?? "terraform";
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const run = opts.run ?? runCommand;

  return {
    async extract(ref, version) {
      // First statement, before a directory exists and long before a process
      // could: a provider is an executable, and this is the line that decides
      // whether one is ever downloaded.
      if (!isAllowlisted(ref, opts.allowlist)) {
        throw new ProviderNotAllowlistedError(providerId(ref));
      }
      if (!VERSION.test(version)) {
        throw new Error(`"${version}" is not a released provider version`);
      }

      const dir = await mkdtemp(
        join(opts.workDir ?? tmpdir(), "groundplan-catalog-"),
      );
      try {
        await writeFile(
          join(dir, "main.tf"),
          extractionConfig(ref, version),
          "utf8",
        );
        const env = extractionEnv({
          home: dir,
          ...(opts.pluginCacheDir ? { pluginCacheDir: opts.pluginCacheDir } : {}),
        });

        opts.log?.info(
          { provider: providerId(ref), version },
          "catalog: initialising an empty config to read a provider schema",
        );
        await run(bin, ["init", "-input=false", "-no-color"], {
          cwd: dir,
          env,
          timeoutMs,
        });

        const stdout = await run(
          bin,
          ["providers", "schema", "-json"],
          { cwd: dir, env, timeoutMs },
        );

        const schemas = parseProviderSchema(
          JSON.parse(stdout) as RawProvidersSchema,
          { provider: providerId(ref), version },
        );
        if (schemas.length === 0) {
          throw new Error(
            `${providerId(ref)} ${version} described no resource types`,
          );
        }
        return schemas satisfies readonly ProviderResourceSchema[];
      } finally {
        // Every path, including the timeout kill: an orphan temp directory of a
        // failed azurerm extraction is hundreds of megabytes of nothing.
        await rm(dir, { recursive: true, force: true }).catch((err: unknown) => {
          opts.log?.warn({ dir, err }, "catalog: could not remove temp dir");
        });
      }
    },
  };
}
