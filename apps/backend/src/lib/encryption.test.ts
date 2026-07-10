import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

import { createEncryptor } from "./encryption.js";

const key = randomBytes(32).toString("base64");

test("round-trips a secret through encrypt/decrypt", () => {
  const enc = createEncryptor(key);
  const secret = "ghp_exampleTokenValue1234567890";
  const cipher = enc.encrypt(secret);
  assert.notEqual(cipher, secret, "ciphertext must not equal plaintext");
  assert.equal(enc.decrypt(cipher), secret);
});

test("produces different ciphertext each time (random IV)", () => {
  const enc = createEncryptor(key);
  assert.notEqual(enc.encrypt("same"), enc.encrypt("same"));
});

test("rejects a tampered ciphertext (auth tag)", () => {
  const enc = createEncryptor(key);
  const cipher = enc.encrypt("secret");
  const bytes = Buffer.from(cipher, "base64");
  const last = bytes.length - 1;
  bytes[last] = (bytes[last] ?? 0) ^ 0xff; // flip a bit in the ciphertext
  assert.throws(() => enc.decrypt(bytes.toString("base64")));
});

test("cannot decrypt with a different key", () => {
  const cipher = createEncryptor(key).encrypt("secret");
  const other = createEncryptor(randomBytes(32).toString("base64"));
  assert.throws(() => other.decrypt(cipher));
});

test("rejects a key that is not 32 bytes", () => {
  assert.throws(() => createEncryptor(randomBytes(16).toString("base64")));
});
