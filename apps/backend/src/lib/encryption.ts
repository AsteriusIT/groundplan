import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

// AES-256-GCM: authenticated encryption for secrets at rest. Payload layout is
// base64( iv[12] || authTag[16] || ciphertext ), so it is self-describing.
const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

export type Encryptor = {
  encrypt(plaintext: string): string;
  decrypt(payload: string): string;
};

function parseKey(base64Key: string): Buffer {
  const key = Buffer.from(base64Key, "base64");
  if (key.length !== 32) {
    throw new Error(
      "ENCRYPTION_KEY must decode to 32 bytes (base64-encoded 256-bit key)",
    );
  }
  return key;
}

/** Build an AES-256-GCM encryptor from a base64-encoded 32-byte key. */
export function createEncryptor(base64Key: string): Encryptor {
  const key = parseKey(base64Key);

  return {
    encrypt(plaintext: string): string {
      const iv = randomBytes(IV_LENGTH);
      const cipher = createCipheriv(ALGORITHM, key, iv);
      const ciphertext = Buffer.concat([
        cipher.update(plaintext, "utf8"),
        cipher.final(),
      ]);
      const tag = cipher.getAuthTag();
      return Buffer.concat([iv, tag, ciphertext]).toString("base64");
    },

    decrypt(payload: string): string {
      const buf = Buffer.from(payload, "base64");
      const iv = buf.subarray(0, IV_LENGTH);
      const tag = buf.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
      const ciphertext = buf.subarray(IV_LENGTH + TAG_LENGTH);
      const decipher = createDecipheriv(ALGORITHM, key, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([
        decipher.update(ciphertext),
        decipher.final(),
      ]).toString("utf8");
    },
  };
}
