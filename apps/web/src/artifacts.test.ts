import { describe, expect, it } from "vitest";
import {
  DOCUMENT_PREVIEW_MAX_BYTES,
  PREVIEW_MAX_BYTES,
  artifactKind,
  canPreview,
  parseCsv,
} from "./artifacts.js";

function file(name: string, mimeType = "application/octet-stream") {
  return { name, mimeType, sizeBytes: 1024 };
}

describe("artifactKind", () => {
  it("classifies the inline text formats", () => {
    expect(artifactKind(file("notes.md", "text/markdown"))).toBe("markdown");
    expect(artifactKind(file("report.html", "text/html"))).toBe("html");
    expect(artifactKind(file("data.csv", "text/csv"))).toBe("csv");
    expect(artifactKind(file("summary.txt", "text/plain"))).toBe("text");
    expect(artifactKind(file("chart.png", "image/png"))).toBe("image");
  });

  it("classifies Office and PDF documents for the embedded renderers", () => {
    expect(artifactKind(file("plan.pdf", "application/pdf"))).toBe("pdf");
    expect(
      artifactKind(
        file(
          "brief.docx",
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        ),
      ),
    ).toBe("word");
    expect(
      artifactKind(
        file(
          "deck.pptx",
          "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        ),
      ),
    ).toBe("slides");
  });

  it("falls back to the extension when Ark reports a generic MIME type", () => {
    expect(artifactKind(file("brief.docx"))).toBe("word");
    expect(artifactKind(file("deck.pptx"))).toBe("slides");
    expect(artifactKind(file("slides.PPTX"))).toBe("slides");
  });

  it("keeps legacy binary Office formats download-only", () => {
    expect(artifactKind(file("brief.doc", "application/msword"))).toBe("other");
    expect(
      artifactKind(file("deck.ppt", "application/vnd.ms-powerpoint")),
    ).toBe("other");
  });
});

describe("canPreview", () => {
  it("caps text previews at two megabytes", () => {
    expect(
      canPreview({ ...file("notes.md", "text/markdown"), sizeBytes: 10 }),
    ).toBe(true);
    expect(
      canPreview({
        ...file("notes.md", "text/markdown"),
        sizeBytes: PREVIEW_MAX_BYTES + 1,
      }),
    ).toBe(false);
  });

  it("allows larger Office and PDF documents up to their own cap", () => {
    const deck = file(
      "deck.pptx",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    );
    expect(canPreview({ ...deck, sizeBytes: PREVIEW_MAX_BYTES + 1 })).toBe(
      true,
    );
    expect(
      canPreview({ ...deck, sizeBytes: DOCUMENT_PREVIEW_MAX_BYTES + 1 }),
    ).toBe(false);
  });

  it("never previews unknown types", () => {
    expect(canPreview(file("archive.zip", "application/zip"))).toBe(false);
    expect(canPreview(file("brief.doc", "application/msword"))).toBe(false);
  });
});

describe("parseCsv", () => {
  it("honours quoting so embedded commas and newlines survive", () => {
    expect(parseCsv('a,"b,c"\nd,"line\nbreak"')).toEqual([
      ["a", "b,c"],
      ["d", "line\nbreak"],
    ]);
  });
});
