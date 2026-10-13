// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import React from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  apiClient,
  ApiClientError,
  type SessionDetail,
} from "../apps/web/src/api.js";
import { SessionPage } from "../apps/web/src/SessionPage.js";

vi.mock("../apps/web/src/timeline/useSessionTimeline.js", () => ({
  useSessionTimeline: () => ({
    items: [],
    blocks: [],
    todos: [],
    status: null,
    connection: "live",
  }),
}));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("history repair page", () => {
  it("keeps repair visible and provides a retry that reports a pending export without downloading", async () => {
    const detail: SessionDetail = {
      id: "session",
      title: "Task",
      status: "idle",
      error: null,
      deletionState: "none",
      archivedAt: null,
      pinnedAt: null,
      lastEventAt: null,
      createdAt: "2026-01-01",
      updatedAt: "2026-01-01",
      agent: { id: "agent", kind: "personal", name: "Agent", version: "1" },
      inputs: [],
      historyState: {
        complete: false,
        repairRequired: true,
        scannedAt: null,
        scanGeneration: 1,
        persistedSequence: "0",
      },
    };
    vi.spyOn(apiClient, "getSession").mockResolvedValue(detail);
    vi.spyOn(apiClient, "listArtifacts").mockResolvedValue({ artifacts: [] });
    const transcript = vi
      .spyOn(apiClient, "getSessionTranscript")
      .mockRejectedValue(
        new ApiClientError(
          409,
          "EVENT_HISTORY_REPAIR_PENDING",
          "会话历史正在修复，请稍后重试。",
          "request",
          true,
        ),
      );
    render(
      <MemoryRouter initialEntries={["/sessions/session"]}>
        <Routes>
          <Route
            path="/sessions/:sessionId"
            element={
              <SessionPage
                onStreamReady={vi.fn()}
                onSessionChanged={vi.fn()}
                onAuthRequired={vi.fn()}
              />
            }
          />
        </Routes>
      </MemoryRouter>,
    );
    expect(await screen.findByText("会话历史待修复")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "重试同步并导出" }));
    await waitFor(() => expect(transcript).toHaveBeenCalledOnce());
    expect(
      await screen.findByText("会话历史正在修复，请稍后重试。"),
    ).toBeInTheDocument();
    expect(screen.getByText("会话历史待修复")).toBeInTheDocument();
  });
});
