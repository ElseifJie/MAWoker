import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export interface CredentialCipher {
  encrypt(plaintext: string): string;
  decrypt(value: string): string;
}

const PREFIX = "v1";

/**
 * AES-256-GCM at rest. Without a configured key the cipher is the identity,
 * which keeps local development and tests readable; production should set
 * CREDENTIAL_ENCRYPTION_KEY (base64, 32 bytes).
 */
export function createCredentialCipher(keyBase64?: string): CredentialCipher {
  if (!keyBase64) {
    return {
      encrypt: (plaintext) => plaintext,
      decrypt: (value) => value,
    };
  }
  const key = Buffer.from(keyBase64, "base64");
  if (key.length !== 32) {
    throw new Error("CREDENTIAL_ENCRYPTION_KEY must decode to 32 bytes");
  }
  return {
    encrypt(plaintext) {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const ciphertext = Buffer.concat([
        cipher.update(plaintext, "utf8"),
        cipher.final(),
      ]);
      return [
        PREFIX,
        iv.toString("base64url"),
        cipher.getAuthTag().toString("base64url"),
        ciphertext.toString("base64url"),
      ].join(".");
    },
    decrypt(value) {
      if (!value.startsWith(`${PREFIX}.`)) return value;
      const [, ivPart, tagPart, dataPart] = value.split(".");
      if (!ivPart || !tagPart || !dataPart) {
        throw new Error("Malformed encrypted credential");
      }
      const decipher = createDecipheriv(
        "aes-256-gcm",
        key,
        Buffer.from(ivPart, "base64url"),
      );
      decipher.setAuthTag(Buffer.from(tagPart, "base64url"));
      return Buffer.concat([
        decipher.update(Buffer.from(dataPart, "base64url")),
        decipher.final(),
      ]).toString("utf8");
    },
  };
}
