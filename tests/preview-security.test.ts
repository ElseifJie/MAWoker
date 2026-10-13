// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { buildStaticPreview } from "../apps/web/src/static-preview.js";
describe("static preview isolation", () => {
  it("removes executable and external markup while retaining safe inline formatting", () => {
    const html = buildStaticPreview(
      '<script>fetch("/api")</script><img src="https://evil.test/spy"><p onclick="alert(1)" style="color:red">safe</p><a href="/api/v1/me">steal</a>',
    );
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("onclick");
    expect(html).not.toContain("evil.test");
    expect(html).not.toContain('href="/api');
    expect(html).toContain('style="color:red"');
    expect(html).toContain("script-src &#39;none&#39;");
  });
});
