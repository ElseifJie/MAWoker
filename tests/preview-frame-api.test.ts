import { describe, expect, it } from "vitest";
import { buildApp } from "../apps/api/src/app.js";
describe("separate static preview response", () => {
  it("permits only frame-owned inline styles while main app remains strict", async () => {
    const app = buildApp();
    try {
      const frame = await app.inject({ url: "/preview-frame" });
      expect(frame.statusCode).toBe(200);
      expect(frame.headers["content-security-policy"]).toContain(
        "script-src 'none'",
      );
      expect(frame.headers["content-security-policy"]).toContain(
        "style-src 'unsafe-inline'",
      );
      expect(frame.headers["content-security-policy"]).toContain(
        "frame-ancestors 'self'",
      );
      const main = await app.inject({ url: "/health" });
      expect(main.headers["content-security-policy"]).not.toContain(
        "unsafe-inline",
      );
    } finally {
      await app.close();
    }
  });
});
