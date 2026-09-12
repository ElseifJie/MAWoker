// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ArtifactSummary } from "../api.js";

const { renderAsync, pptxToHtml } = vi.hoisted(() => ({
  renderAsync: vi.fn(async () => undefined),
  pptxToHtml: vi.fn(async () => ["<div class='slide'>slide</div>"]),
}));

vi.mock("docx-preview", () => ({ renderAsync }));
vi.mock("@jvmr/pptx-to-html", () => ({ pptxToHtml }));

const { ArtifactViewer } = await import("./ArtifactViewer.js");

function artifact(overrides: Partial<ArtifactSummary> = {}): ArtifactSummary {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    sessionId: "00000000-0000-4000-8000-000000000002",
    name: "report.pdf",
    mimeType: "application/pdf",
    sizeBytes: 2048,
    generatedAt: "2026-09-07T08:00:00.000Z",
    deletionState: "none",
    error: null,
    ...overrides,
  };
}

function stubFetch(body: BodyInit, contentType: string) {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(body, {
          status: 200,
          headers: { "content-type": contentType },
        }),
    ),
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  renderAsync.mockClear();
  pptxToHtml.mockClear();
});

describe("ArtifactViewer document previews", () => {
  it("embeds a PDF in a frame backed by an object URL", async () => {
    stubFetch("%PDF-1.7", "application/pdf");
    const createObjectURL = vi.fn(() => "blob:pdf");
    const revokeObjectURL = vi.fn();
    Object.defineProperty(URL, "createObjectURL", {
      value: createObjectURL,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      value: revokeObjectURL,
      configurable: true,
      writable: true,
    });

    render(<ArtifactViewer artifact={artifact()} onClose={() => undefined} />);

    await waitFor(() => expect(createObjectURL).toHaveBeenCalledOnce());
    const frame = await waitFor(() => {
      const found = document.querySelector('iframe[title="report.pdf"]');
      expect(found).not.toBeNull();
      return found as HTMLIFrameElement;
    });
    expect(frame).toHaveAttribute("src", "blob:pdf");
  });

  it("renders a Word document through docx-preview", async () => {
    stubFetch(
      "docx-bytes",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );

    render(
      <ArtifactViewer
        artifact={artifact({
          name: "brief.docx",
          mimeType:
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        })}
        onClose={() => undefined}
      />,
    );

    await waitFor(() => expect(renderAsync).toHaveBeenCalledOnce());
    const frame = await waitFor(() => {
      const found = document.querySelector('iframe[title="brief.docx"]');
      expect(found).not.toBeNull();
      return found as HTMLIFrameElement;
    });
    expect(frame).toHaveAttribute("sandbox", "allow-same-origin");
  });

  it("renders a presentation through pptx-to-html", async () => {
    stubFetch(
      "pptx-bytes",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    );

    render(
      <ArtifactViewer
        artifact={artifact({
          name: "deck.pptx",
          mimeType:
            "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        })}
        onClose={() => undefined}
      />,
    );

    await waitFor(() => expect(pptxToHtml).toHaveBeenCalledOnce());
    // jsdom reports no measured width, so the renderer falls back to a sane
    // canvas and subtracts the reserved scrollbar gutter.
    expect(pptxToHtml).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ width: 720 - 16, scaleToFit: true }),
    );
    const frame = await waitFor(() => {
      const found = document.querySelector('iframe[title="deck.pptx"]');
      expect(found).not.toBeNull();
      return found as HTMLIFrameElement;
    });
    expect(frame.getAttribute("srcdoc")).toContain("scrollbar-gutter:stable");
  });

  it("does not preview legacy binary Office documents", async () => {
    stubFetch("doc-bytes", "application/msword");

    render(
      <ArtifactViewer
        artifact={artifact({
          name: "brief.doc",
          mimeType: "application/msword",
        })}
        onClose={() => undefined}
      />,
    );

    expect(
      await screen.findByText("Preview unavailable. Download to open."),
    ).toBeInTheDocument();
    expect(renderAsync).not.toHaveBeenCalled();
  });
});
