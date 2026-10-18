// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClientError, type ArtifactSummary } from "../api.js";
import type { PanelDescriptor } from "../shell/shell-state.js";
import { ArtifactPanel } from "./ArtifactPanel.js";

const artifact: ArtifactSummary = {
  id: "artifact-1",
  sessionId: "session-1",
  name: "report.zip",
  mimeType: "application/zip",
  sizeBytes: 128,
  generatedAt: "2026-10-18T00:00:00.000Z",
  deletionState: "none",
  error: null,
};

const panel: PanelDescriptor = {
  id: "artifact:artifact-1",
  type: "artifact",
  title: "report.zip",
  resourceRef: "artifact-1",
  conversationId: "session-1",
};

afterEach(cleanup);

describe("ArtifactPanel", () => {
  it("loads the artifact list and renders the preview", async () => {
    const listArtifacts = vi.fn().mockResolvedValue({ artifacts: [artifact] });
    render(
      <ArtifactPanel
        panel={panel}
        onClose={vi.fn()}
        listArtifacts={listArtifacts}
      />,
    );

    expect(
      await screen.findByRole("region", { name: "Preview of report.zip" }),
    ).toBeInTheDocument();
    expect(listArtifacts).toHaveBeenCalledWith("session-1");
  });

  it("reports a deleted or missing artifact", async () => {
    render(
      <ArtifactPanel
        panel={panel}
        onClose={vi.fn()}
        listArtifacts={vi.fn().mockResolvedValue({ artifacts: [] })}
      />,
    );

    expect(
      await screen.findByText("文件不存在或已被删除。"),
    ).toBeInTheDocument();
  });

  it("recovers from a list failure with an explicit retry", async () => {
    const listArtifacts = vi
      .fn()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce({ artifacts: [artifact] });
    render(
      <ArtifactPanel
        panel={panel}
        onClose={vi.fn()}
        listArtifacts={listArtifacts}
      />,
    );
    const user = userEvent.setup();

    expect(
      await screen.findByText("文件预览加载失败，请重试。"),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "重试" }));
    expect(
      await screen.findByRole("region", { name: "Preview of report.zip" }),
    ).toBeInTheDocument();
    expect(listArtifacts).toHaveBeenCalledTimes(2);
  });

  it("asks the shell to leave when the session expired", async () => {
    const onAuthRequired = vi.fn();
    render(
      <ArtifactPanel
        panel={panel}
        onClose={vi.fn()}
        onAuthRequired={onAuthRequired}
        listArtifacts={vi
          .fn()
          .mockRejectedValue(
            new ApiClientError(401, "UNAUTHENTICATED", "expired"),
          )}
      />,
    );

    await vi.waitFor(() => expect(onAuthRequired).toHaveBeenCalledTimes(1));
  });

  it("shares one in-flight list request across StrictMode remounts", async () => {
    let resolveList!: (value: { artifacts: ArtifactSummary[] }) => void;
    const listArtifacts = vi.fn().mockReturnValue(
      new Promise<{ artifacts: ArtifactSummary[] }>((resolve) => {
        resolveList = resolve;
      }),
    );
    render(
      <StrictMode>
        <ArtifactPanel
          panel={panel}
          onClose={vi.fn()}
          listArtifacts={listArtifacts}
        />
      </StrictMode>,
    );

    await vi.waitFor(() => expect(listArtifacts).toHaveBeenCalledTimes(1));
    resolveList({ artifacts: [artifact] });
    expect(
      await screen.findByRole("region", { name: "Preview of report.zip" }),
    ).toBeInTheDocument();
  });
});
