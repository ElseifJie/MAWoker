import { describe, expect, it } from "vitest";
import {
  McpUrlUnsafeError,
  validateMcpUrl,
} from "../packages/domain/src/index.js";

const publicResolver = async () => [{ address: "93.184.216.34" }];

describe("MCP URL safety", () => {
  it("accepts an HTTPS public URL and strips the fragment", async () => {
    await expect(
      validateMcpUrl("https://mcp.example.com/mcp#section", {
        resolve: publicResolver,
      }),
    ).resolves.toBe("https://mcp.example.com/mcp");
  });

  it("rejects non-HTTPS, credentials, localhost, and private literals", async () => {
    for (const url of [
      "http://mcp.example.com/mcp",
      "https://user:pass@mcp.example.com/mcp",
      "https://localhost/mcp",
      "https://127.0.0.1/mcp",
      "https://10.0.0.5/mcp",
      "https://192.168.1.5/mcp",
      "https://[::1]/mcp",
      "https://metadata.google.internal/latest",
    ]) {
      await expect(
        validateMcpUrl(url, { resolve: publicResolver }),
      ).rejects.toBeInstanceOf(McpUrlUnsafeError);
    }
  });

  it("rejects a public hostname that resolves to private space", async () => {
    await expect(
      validateMcpUrl("https://mcp.example.com/mcp", {
        resolve: async () => [
          { address: "93.184.216.34" },
          { address: "10.0.0.7" },
        ],
      }),
    ).rejects.toBeInstanceOf(McpUrlUnsafeError);
  });

  it("enforces an optional host allowlist", async () => {
    await expect(
      validateMcpUrl("https://evil.example/mcp", {
        resolve: publicResolver,
        allowedHosts: ["mcp.example.com"],
      }),
    ).rejects.toBeInstanceOf(McpUrlUnsafeError);
    await expect(
      validateMcpUrl("https://mcp.example.com/mcp", {
        resolve: publicResolver,
        allowedHosts: ["example.com"],
      }),
    ).resolves.toContain("mcp.example.com");
  });
});
