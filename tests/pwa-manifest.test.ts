import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function publicFile(name: string): string {
  const base = process.cwd().endsWith("apps/web")
    ? "public"
    : "apps/web/public";
  return readFileSync(resolve(process.cwd(), base, name), "utf8");
}

describe("PWA assets", () => {
  it("declares an installable manifest with 192, 512, and maskable icons", () => {
    const manifest = JSON.parse(publicFile("manifest.webmanifest")) as {
      name: string;
      start_url: string;
      display: string;
      icons: Array<{ src: string; sizes: string; purpose?: string }>;
      shortcuts: Array<{ url: string }>;
    };

    expect(manifest.name).toBe("MA Worker");
    expect(manifest.start_url).toBe("/");
    expect(manifest.display).toBe("standalone");
    expect(manifest.icons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sizes: "192x192" }),
        expect.objectContaining({ sizes: "512x512" }),
        expect.objectContaining({ purpose: "maskable" }),
      ]),
    );
    expect(manifest.shortcuts.map((shortcut) => shortcut.url)).toContain(
      "/automations",
    );
  });

  it("keeps API traffic out of the service worker cache", () => {
    const worker = publicFile("sw.js");
    expect(worker).toContain('url.pathname.startsWith("/api/")');
    expect(worker).toContain('request.mode === "navigate"');
    expect(worker).toContain('caches.match("/index.html")');
  });
});
