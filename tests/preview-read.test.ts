import { describe, expect, it } from "vitest";
import { readPreviewResponse } from "../apps/web/src/preview-read.js";
describe("preview actual-byte limits", () => {
  it("rejects a misleading content length while streaming bounded bytes", async () => {
    const response = new Response(new Uint8Array(1025), {
      headers: { "content-length": "1" },
    });
    await expect(
      readPreviewResponse(response, 1024, new AbortController().signal),
    ).rejects.toThrow();
  });
});
