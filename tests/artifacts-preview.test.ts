import { describe, expect, it } from "vitest";
import {
  PREVIEW_MAX_BYTES,
  artifactDownloadUrl,
  artifactKind,
  canPreview,
  parseCsv,
} from "../apps/web/src/artifacts.js";

function artifact(name: string, mimeType: string, sizeBytes = 1024) {
  return { name, mimeType, sizeBytes };
}

describe("artifactKind", () => {
  it.each([
    ["report.md", "text/markdown", "markdown"],
    ["notes.markdown", "application/octet-stream", "markdown"],
    ["data.csv", "text/csv", "csv"],
    ["data.tsv", "application/octet-stream", "csv"],
    ["page.html", "text/html", "html"],
    ["diagram.png", "image/png", "image"],
    ["photo.jpeg", "image/jpeg", "image"],
    ["paper.pdf", "application/pdf", "pdf"],
    ["log.txt", "text/plain", "text"],
    ["config.json", "application/octet-stream", "text"],
    ["deck.pptx", "application/octet-stream", "other"],
    ["sheet.xlsx", "application/octet-stream", "other"],
    ["document.docx", "application/octet-stream", "other"],
    ["archive.zip", "application/zip", "other"],
  ])("classifies %s as %s", (name, mimeType, expected) => {
    expect(artifactKind(artifact(name, mimeType))).toBe(expected);
  });

  it("prefers the MIME type over the extension", () => {
    // Ark reports octet-stream for files the Agent wrote itself, so the name is
    // the fallback rather than the authority.
    expect(artifactKind(artifact("notes.txt", "text/markdown"))).toBe(
      "markdown",
    );
  });

  it("is case insensitive about the extension", () => {
    expect(
      artifactKind(artifact("REPORT.MD", "application/octet-stream")),
    ).toBe("markdown");
  });
});

describe("canPreview", () => {
  it("previews the browser-native kinds", () => {
    for (const [name, mimeType] of [
      ["a.md", "text/markdown"],
      ["a.csv", "text/csv"],
      ["a.html", "text/html"],
      ["a.png", "image/png"],
      ["a.txt", "text/plain"],
    ]) {
      expect(canPreview(artifact(name, mimeType)), name).toBe(true);
    }
  });

  it("does not preview office, PDF or unknown files", () => {
    for (const [name, mimeType] of [
      ["a.pptx", "application/octet-stream"],
      ["a.xlsx", "application/octet-stream"],
      ["a.docx", "application/octet-stream"],
      ["a.pdf", "application/pdf"],
      ["a.zip", "application/zip"],
    ]) {
      expect(canPreview(artifact(name, mimeType)), name).toBe(false);
    }
  });

  it("refuses to inline a file large enough to hang the tab", () => {
    expect(
      canPreview(artifact("huge.csv", "text/csv", PREVIEW_MAX_BYTES)),
    ).toBe(true);
    expect(
      canPreview(artifact("huge.csv", "text/csv", PREVIEW_MAX_BYTES + 1)),
    ).toBe(false);
  });
});

describe("artifactDownloadUrl", () => {
  it("routes through the API and escapes the identifier", () => {
    expect(artifactDownloadUrl("abc/def 123")).toBe(
      "/api/v1/artifacts/abc%2Fdef%20123/download",
    );
  });
});

describe("parseCsv", () => {
  it("splits simple rows", () => {
    expect(parseCsv("a,b,c\n1,2,3")).toEqual([
      ["a", "b", "c"],
      ["1", "2", "3"],
    ]);
  });

  it("keeps commas and newlines inside quoted fields", () => {
    expect(parseCsv('name,note\n"Smith, Jane","line one\nline two"')).toEqual([
      ["name", "note"],
      ["Smith, Jane", "line one\nline two"],
    ]);
  });

  it("unescapes doubled quotes", () => {
    expect(parseCsv('a\n"say ""hi"""')).toEqual([["a"], ['say "hi"']]);
  });

  it("tolerates CRLF and a missing trailing newline", () => {
    expect(parseCsv("a,b\r\n1,2\r\n")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
    expect(parseCsv("a,b\r\n1,2")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("keeps empty fields rather than dropping them", () => {
    expect(parseCsv("a,,c")).toEqual([["a", "", "c"]]);
  });

  it("returns no rows for empty input", () => {
    expect(parseCsv("")).toEqual([]);
  });
});
