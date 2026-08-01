/**
 * The extraction worker (GP-236). Two kinds of test live here.
 *
 * The **security** tests run with a `run` that records rather than spawns, and
 * assert on what never happened: an un-allowlisted provider must not produce a
 * command, a version that is not a plain semver must not reach a command line,
 * and no secret of the app's may appear in the child environment.
 *
 * The **end-to-end** test really runs `terraform` against `hashicorp/random` —
 * a provider of eight tiny resources — and is skipped unless
 * `CATALOG_E2E=1`, because the default suite must stay offline and hermetic.
 * CI opts in; a laptop does not have to.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  extractionConfig,
  extractionEnv,
  ProviderNotAllowlistedError,
  runCommand,
  terraformExtractor,
  type RunCommand,
} from "./extract.js";
import { parseAllowlist } from "./providers.js";

const ALLOWLIST = parseAllowlist("hashicorp/azurerm,hashicorp/random");
const AZURERM = { namespace: "hashicorp", name: "azurerm" };

/** A `run` that records its calls and answers with a canned schema payload. */
function recordingRun(stdout = "{}") {
  const calls: {
    command: string;
    args: readonly string[];
    cwd: string;
    env: NodeJS.ProcessEnv;
  }[] = [];
  const run: RunCommand = async (command, args, opts) => {
    calls.push({ command, args, cwd: opts.cwd, env: opts.env });
    return args[0] === "init" ? "" : stdout;
  };
  return { run, calls };
}

/** A minimal but real `providers schema -json` payload for one fake provider. */
const SCHEMA_JSON = JSON.stringify({
  format_version: "1.0",
  provider_schemas: {
    "registry.terraform.io/hashicorp/azurerm": {
      resource_schemas: {
        azurerm_resource_group: {
          block: {
            description: "Manages a resource group.",
            attributes: {
              name: { type: "string", required: true },
              location: { type: "string", required: true },
            },
          },
        },
      },
    },
  },
});

describe("the generated config (GP-236)", () => {
  test("pins one provider and describes no infrastructure", () => {
    const config = extractionConfig(AZURERM, "4.81.0");
    assert.match(config, /source\s+=\s+"hashicorp\/azurerm"/);
    assert.match(config, /version\s+=\s+"4\.81\.0"/);
    // The three things whose absence *is* the trust model.
    assert.equal(/\bresource\b/.test(config), false);
    assert.equal(/\bbackend\b/.test(config), false);
    assert.equal(/^provider\b/m.test(config), false);
  });
});

describe("the child environment (GP-236)", () => {
  test("carries what Terraform needs and nothing that could authenticate", () => {
    const env = extractionEnv({ home: "/tmp/x", pluginCacheDir: "/cache" });
    assert.equal(env.TF_IN_AUTOMATION, "1");
    assert.equal(env.TF_INPUT, "0");
    assert.equal(env.TF_PLUGIN_CACHE_DIR, "/cache");
    assert.equal(env.HOME, "/tmp/x");
    // Nothing of the app's, and no cloud credential an operator may have
    // exported into the worker for some unrelated reason.
    for (const forbidden of [
      "DATABASE_URL",
      "ENCRYPTION_KEY",
      "AI_API_KEY",
      "ARM_CLIENT_SECRET",
      "AWS_SECRET_ACCESS_KEY",
      "GOOGLE_CREDENTIALS",
    ]) {
      assert.equal(env[forbidden], undefined, `${forbidden} must not be passed`);
    }
  });
});

describe("terraformExtractor (GP-236)", () => {
  test("a provider outside the allowlist is refused with no process spawned", async () => {
    const { run, calls } = recordingRun();
    const extractor = terraformExtractor({ allowlist: ALLOWLIST, run });

    await assert.rejects(
      () => extractor.extract({ namespace: "evil", name: "provider" }, "1.0.0"),
      ProviderNotAllowlistedError,
    );
    assert.deepEqual(calls, [], "nothing may be executed for a refused provider");
  });

  test("a version that is not a released version never reaches a command line", async () => {
    const { run, calls } = recordingRun();
    const extractor = terraformExtractor({ allowlist: ALLOWLIST, run });

    for (const version of [
      '4.81.0"\ninjected {}',
      "4.81.0; rm -rf /",
      "latest",
      "~> 4.0",
      "../../etc",
    ]) {
      await assert.rejects(
        () => extractor.extract(AZURERM, version),
        /not a released provider version/,
      );
    }
    assert.deepEqual(calls, []);
  });

  test("runs init then providers schema, in a directory of its own", async () => {
    const { run, calls } = recordingRun(SCHEMA_JSON);
    const extractor = terraformExtractor({
      allowlist: ALLOWLIST,
      terraformBin: "/usr/bin/terraform",
      pluginCacheDir: "/cache",
      run,
    });

    const schemas = await extractor.extract(AZURERM, "4.81.0");
    assert.deepEqual(
      calls.map((c) => `${c.command} ${c.args.join(" ")}`),
      [
        "/usr/bin/terraform init -input=false -no-color",
        "/usr/bin/terraform providers schema -json",
      ],
    );
    assert.equal(calls[0]?.cwd, calls[1]?.cwd);
    assert.match(calls[0]!.cwd, /groundplan-catalog-/);

    assert.equal(schemas.length, 1);
    assert.equal(schemas[0]?.type, "azurerm_resource_group");
    assert.equal(schemas[0]?.provider, "hashicorp/azurerm");
    assert.equal(schemas[0]?.version, "4.81.0");
  });

  test("the temp directory is removed — on success and on failure alike", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "catalog-workdir-"));
    try {
      const ok = terraformExtractor({
        allowlist: ALLOWLIST,
        workDir,
        run: recordingRun(SCHEMA_JSON).run,
      });
      await ok.extract(AZURERM, "4.81.0");
      assert.deepEqual(await readdir(workDir), []);

      const failing = terraformExtractor({
        allowlist: ALLOWLIST,
        workDir,
        run: async () => {
          throw new Error("terraform timed out after 600000ms");
        },
      });
      await assert.rejects(() => failing.extract(AZURERM, "4.81.0"), /timed out/);
      // The timeout kill path leaves nothing behind either: an orphan azurerm
      // directory is hundreds of megabytes of nothing.
      assert.deepEqual(await readdir(workDir), []);
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });

  test("a provider that describes no resource types is a failure, not an empty catalog", async () => {
    const extractor = terraformExtractor({
      allowlist: ALLOWLIST,
      run: recordingRun('{"format_version":"1.0","provider_schemas":{}}').run,
    });
    await assert.rejects(
      () => extractor.extract(AZURERM, "4.81.0"),
      /described no resource types/,
    );
  });

});

describe("the wall clock (GP-236)", () => {
  test("a command that outstays its timeout is killed, with its children", async () => {
    // A shell that spawns a background sleep and waits on it — the shape of
    // `terraform init`, which runs provider binaries of its own. Killing only
    // the parent would leave the grandchild eating the container; the process
    // group is what makes "timed out" mean stopped.
    const started = Date.now();
    await assert.rejects(
      () =>
        runCommand("sh", ["-c", "sleep 30 & echo $! > pid; wait"], {
          cwd: tmpdir(),
          env: { PATH: process.env.PATH ?? "/bin:/usr/bin" },
          timeoutMs: 200,
        }),
      /timed out/,
    );
    assert.ok(
      Date.now() - started < 5_000,
      "the wall clock, not the command, must be what ends it",
    );
  });

  test("a command that fails reports the tail of what it said", async () => {
    await assert.rejects(
      () =>
        runCommand("sh", ["-c", "echo boom >&2; exit 3"], {
          cwd: tmpdir(),
          env: { PATH: process.env.PATH ?? "/bin:/usr/bin" },
          timeoutMs: 5_000,
        }),
      /exited 3: boom/,
    );
  });

  test("a command that succeeds gives back its stdout", async () => {
    const out = await runCommand("sh", ["-c", "printf hello"], {
      cwd: tmpdir(),
      env: { PATH: process.env.PATH ?? "/bin:/usr/bin" },
      timeoutMs: 5_000,
    });
    assert.equal(out, "hello");
  });
});

describe("end to end against a real provider (GP-236)", { skip: process.env.CATALOG_E2E !== "1" }, () => {
  test("extracts hashicorp/random for real", async () => {
    const extractor = terraformExtractor({
      allowlist: parseAllowlist("hashicorp/random"),
      terraformBin: process.env.TERRAFORM_BIN ?? "terraform",
      ...(process.env.TF_PLUGIN_CACHE_DIR
        ? { pluginCacheDir: process.env.TF_PLUGIN_CACHE_DIR }
        : {}),
    });
    const schemas = await extractor.extract(
      { namespace: "hashicorp", name: "random" },
      "3.7.2",
    );
    const types = schemas.filter((s) => s.kind === "resource").map((s) => s.type);
    assert.ok(types.includes("random_password"));
    const password = schemas.find((s) => s.type === "random_password");
    assert.equal(
      password?.attributes.find((a) => a.name === "result")?.sensitive,
      true,
    );
  });
});
