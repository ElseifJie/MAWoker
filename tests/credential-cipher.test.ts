import { describe, expect, it } from "vitest";
import { createCredentialCipher } from "../packages/domain/src/index.js";

const key = Buffer.alloc(32, 7).toString("base64");

describe("credential cipher", () => {
  it("is the identity without a configured key", () => {
    const cipher = createCredentialCipher();
    expect(cipher.encrypt("https://example.com/hook")).toBe(
      "https://example.com/hook",
    );
    expect(cipher.decrypt("https://example.com/hook")).toBe(
      "https://example.com/hook",
    );
  });

  it("round-trips AES-256-GCM ciphertext without leaking plaintext", () => {
    const cipher = createCredentialCipher(key);
    const encrypted = cipher.encrypt(
      "https://open.feishu.cn/open-apis/bot/v2/hook/secret",
    );
    expect(encrypted).toMatch(/^v1\./);
    expect(encrypted).not.toContain("secret");
    expect(cipher.decrypt(encrypted)).toBe(
      "https://open.feishu.cn/open-apis/bot/v2/hook/secret",
    );
  });

  it("rejects tampered ciphertext and bad keys", () => {
    const cipher = createCredentialCipher(key);
    const encrypted = cipher.encrypt("hello");
    expect(() => cipher.decrypt(`${encrypted}x`)).toThrow();
    expect(() => createCredentialCipher("short")).toThrow();
  });
});
