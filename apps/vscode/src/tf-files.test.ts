/**
 * The incremental `.tf` cache: the preview used to re-glob and re-read the
 * whole workspace on every debounced keystroke to feed a parser that only
 * walks the entrypoint subtree. These tests pin the promise that replaced it —
 * typing performs no reads at all — by counting them through the injected
 * reader.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { TfFileCache, type ReadFile } from "./tf-files";

const FOLDER = "/ws";
const TF = 'resource "aws_s3_bucket" "b" {\n  bucket = "b"\n}\n';

/** A fake disk plus the read counter every test asserts against. */
function disk(initial: Record<string, string>): {
  files: Map<string, string>;
  read: ReadFile;
  reads: () => number;
  /**
   * Delay the next read of `fsPath` until the returned function is called —
   * opens a race window deterministically (a concurrent `set()`/`remove()`
   * landing mid-`prime()`) instead of guessing with a timer.
   */
  hold: (fsPath: string) => () => void;
} {
  const files = new Map(Object.entries(initial));
  let reads = 0;
  const gates = new Map<string, Promise<void>>();
  const read: ReadFile = async (fsPath) => {
    reads += 1;
    const gate = gates.get(fsPath);
    if (gate) await gate;
    const content = files.get(fsPath);
    if (content === undefined) throw new Error(`ENOENT: ${fsPath}`);
    return content;
  };
  const hold = (fsPath: string): (() => void) => {
    let release = (): void => {};
    gates.set(
      fsPath,
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    return () => {
      gates.delete(fsPath);
      release();
    };
  };
  return { files, read, reads: () => reads, hold };
}

test("prime reads every file once and yields sorted, folder-relative paths", async () => {
  const d = disk({
    "/ws/b/second.tf": TF,
    "/ws/a/first.tf": TF,
  });
  const cache = new TfFileCache(FOLDER, d.read);
  await cache.prime(["/ws/b/second.tf", "/ws/a/first.tf"]);

  assert.equal(d.reads(), 2);
  assert.deepEqual(
    cache.files().map((f) => f.path),
    ["a/first.tf", "b/second.tf"],
  );
});

test("a document's text lands with no read at all — the typing path", async () => {
  const d = disk({ "/ws/main.tf": TF });
  const cache = new TfFileCache(FOLDER, d.read);
  await cache.prime(["/ws/main.tf"]);
  const afterPrime = d.reads();

  const changed = cache.set("/ws/main.tf", TF.replace("b", "typed"));
  assert.equal(changed, true);
  assert.equal(d.reads(), afterPrime, "a keystroke must not touch the disk");
  assert.equal(cache.files()[0]?.content, TF.replace("b", "typed"));
});

test("identical content reports no change, so the caller re-parses nothing", async () => {
  const d = disk({ "/ws/main.tf": TF });
  const cache = new TfFileCache(FOLDER, d.read);
  await cache.prime(["/ws/main.tf"]);

  assert.equal(cache.set("/ws/main.tf", TF), false);
  // A save fires both a document event and a watcher event; the second is free.
  assert.equal(await cache.read("/ws/main.tf"), false);
});

test("files outside the folder, non-.tf and vendored paths are refused without I/O", async () => {
  const d = disk({});
  const cache = new TfFileCache(FOLDER, d.read);

  assert.equal(cache.set("/elsewhere/main.tf", TF), false);
  assert.equal(cache.set("/ws/readme.md", "hi"), false);
  assert.equal(cache.set("/ws/.terraform/modules/x/main.tf", TF), false);
  assert.equal(await cache.read("/ws/.terraform/modules/x/main.tf"), false);
  assert.equal(d.reads(), 0, "a refused path must never reach the disk");
  assert.deepEqual(cache.files(), []);
});

test("create, delete and a vanished file all settle to the right set", async () => {
  const d = disk({ "/ws/main.tf": TF });
  const cache = new TfFileCache(FOLDER, d.read);
  await cache.prime(["/ws/main.tf"]);

  d.files.set("/ws/extra.tf", 'resource "aws_sqs_queue" "q" {}\n');
  assert.equal(await cache.read("/ws/extra.tf"), true);
  assert.deepEqual(cache.files().map((f) => f.path), ["extra.tf", "main.tf"]);

  assert.equal(cache.remove("/ws/extra.tf"), true);
  assert.equal(cache.remove("/ws/extra.tf"), false, "removing twice changes nothing");
  assert.deepEqual(cache.files().map((f) => f.path), ["main.tf"]);

  // Gone between the watcher event and the read: treated as a delete, not a throw.
  d.files.delete("/ws/main.tf");
  assert.equal(await cache.read("/ws/main.tf"), true);
  assert.deepEqual(cache.files(), []);
});

test("candidates fold the per-file memo and follow the content that changed", async () => {
  const d = disk({
    "/ws/envs/prod/main.tf": 'module "net" {\n  source = "../../modules/net"\n}\n',
    "/ws/modules/net/net.tf": TF,
  });
  const cache = new TfFileCache(FOLDER, d.read);
  await cache.prime(["/ws/envs/prod/main.tf", "/ws/modules/net/net.tf"]);

  // A sourced directory is a module, not a stack.
  assert.deepEqual(cache.candidates(), ["envs/prod"]);
  const afterPrime = d.reads();
  assert.deepEqual(cache.candidates(), ["envs/prod"], "a second fold re-reads nothing");
  assert.equal(d.reads(), afterPrime);

  // Drop the module block: the module directory becomes a stack of its own.
  cache.set("/ws/envs/prod/main.tf", TF);
  assert.deepEqual(cache.candidates(), ["envs/prod", "modules/net"]);
});

test("prime replaces the set — a file gone from the glob is gone from the cache", async () => {
  const d = disk({ "/ws/a.tf": TF, "/ws/b.tf": TF });
  const cache = new TfFileCache(FOLDER, d.read);
  await cache.prime(["/ws/a.tf", "/ws/b.tf"]);
  assert.equal(cache.files().length, 2);

  d.files.delete("/ws/b.tf");
  await cache.prime(["/ws/a.tf"]);
  assert.deepEqual(cache.files().map((f) => f.path), ["a.tf"]);
});

test("a set() during an in-flight prime survives it", async () => {
  const d = disk({ "/ws/main.tf": TF });
  const cache = new TfFileCache(FOLDER, d.read);
  const release = d.hold("/ws/main.tf");

  // The first-ever prime is still awaiting its (gated) disk read...
  const priming = cache.prime(["/ws/main.tf"]);
  // ...when a keystroke lands, ahead of it, with the text already in hand.
  const typed = TF.replace("b", "typed");
  assert.equal(cache.set("/ws/main.tf", typed), true);

  release();
  await priming;

  // The prime's stale read must not have clobbered the keystroke on commit.
  assert.equal(cache.files().length, 1);
  assert.equal(cache.files()[0]?.content, typed);
});

test("a remove() during an in-flight prime is not resurrected", async () => {
  const d = disk({ "/ws/main.tf": TF, "/ws/extra.tf": TF });
  const cache = new TfFileCache(FOLDER, d.read);
  await cache.prime(["/ws/main.tf", "/ws/extra.tf"]);
  assert.deepEqual(cache.files().map((f) => f.path), ["extra.tf", "main.tf"]);

  const release = d.hold("/ws/extra.tf");
  // A re-glob (a reveal, a git checkout) re-reads both files...
  const priming = cache.prime(["/ws/main.tf", "/ws/extra.tf"]);
  // ...when a watcher delete for one of them lands mid-read: it is genuinely
  // gone, and the prime's own (now stale) read of it must not win on commit.
  assert.equal(cache.remove("/ws/extra.tf"), true);

  release();
  await priming;

  assert.deepEqual(cache.files().map((f) => f.path), ["main.tf"]);
});

// Two primes overlapping (a reveal() racing the panel's own first refresh is
// the reachable case): each must protect a mutation that lands during the
// overlap, independently of the other and regardless of finish order.

test("a set() landing between two overlapping primes survives both commits", async () => {
  const d = disk({ "/ws/main.tf": TF });
  const cache = new TfFileCache(FOLDER, d.read);

  // Prime A starts a first read of main.tf, held...
  const releaseA = d.hold("/ws/main.tf");
  const primingA = cache.prime(["/ws/main.tf"]);
  // ...then, before A resolves, prime B starts its own — a second, distinct
  // hold for the same path, captured by B's own (later) read.
  const releaseB = d.hold("/ws/main.tf");
  const primingB = cache.prime(["/ws/main.tf"]);

  // A keystroke lands while both are in flight.
  const typed = TF.replace("b", "typed");
  assert.equal(cache.set("/ws/main.tf", typed), true);

  // B, the second prime, finishes (and commits) first.
  releaseB();
  await primingB;
  assert.equal(
    cache.files()[0]?.content,
    typed,
    "B's commit must not clobber the edit with its own stale read",
  );

  // A, the first prime, finishes (and commits) last.
  releaseA();
  await primingA;
  assert.equal(
    cache.files()[0]?.content,
    typed,
    "A's commit, though it started before the edit, must not clobber it either",
  );
});

test("two overlapping primes, the second finishing first, still honour a remove() from the overlap", async () => {
  const d = disk({ "/ws/main.tf": TF, "/ws/extra.tf": TF });
  const cache = new TfFileCache(FOLDER, d.read);
  await cache.prime(["/ws/main.tf", "/ws/extra.tf"]);

  // Both re-globs' reads of extra.tf are held (independently); main.tf reads
  // through freely for both.
  const releaseA = d.hold("/ws/extra.tf");
  const primingA = cache.prime(["/ws/main.tf", "/ws/extra.tf"]);
  const releaseB = d.hold("/ws/extra.tf");
  const primingB = cache.prime(["/ws/main.tf", "/ws/extra.tf"]);

  // A watcher delete lands while both primes are in flight.
  assert.equal(cache.remove("/ws/extra.tf"), true);

  // B, the second prime, finishes first — its own read of extra.tf already
  // "succeeded" (the fake disk still has the bytes), but it must not
  // resurrect the file.
  releaseB();
  await primingB;
  assert.deepEqual(
    cache.files().map((f) => f.path),
    ["main.tf"],
    "B's commit must not resurrect the removed file",
  );

  // A, the first prime, finishes last — same requirement, on the commit that
  // started before the remove() ever happened.
  releaseA();
  await primingA;
  assert.deepEqual(
    cache.files().map((f) => f.path),
    ["main.tf"],
    "A's commit must not resurrect it either, despite starting first",
  );
});
