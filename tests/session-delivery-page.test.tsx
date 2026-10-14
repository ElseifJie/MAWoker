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
import { apiClient, type SessionDetail } from "../apps/web/src/api.js";
import { SessionPage } from "../apps/web/src/SessionPage.js";

const savedTimeline = vi.hoisted(() => ({
  items: [] as unknown[],
  blocks: [] as unknown[],
}));

vi.mock("../apps/web/src/timeline/useSessionTimeline.js", () => ({
  useSessionTimeline: () => ({
    items: savedTimeline.items,
    blocks: savedTimeline.blocks,
    todos: [],
    status: null,
    connection: "live",
  }),
}));
afterEach(() => {
  cleanup();
  savedTimeline.items = [];
  savedTimeline.blocks = [];
  vi.restoreAllMocks();
});

describe("background delivery page", () => {
  it("does not label a new queued turn with the preceding completion", async () => {
    vi.spyOn(apiClient, "getSession").mockResolvedValue({
      id: "session",
      title: "Task",
      status: "idle",
      error: null,
      deletionState: "none",
      archivedAt: null,
      pinnedAt: null,
      lastEventAt: null,
      createdAt: "2026-01-01",
      updatedAt: "2026-01-02",
      agent: { id: "agent", kind: "personal", name: "Agent", version: "1" },
      inputs: [],
      submissions: [
        {
          submissionId: "next",
          status: "queued",
          content: "Continue",
          createdAt: "2026-01-02",
          upstreamEventId: null,
          errorCode: null,
        },
      ],
    });
    vi.spyOn(apiClient, "listArtifacts").mockResolvedValue({ artifacts: [] });
    vi.spyOn(apiClient, "listSessionTurns").mockResolvedValue({
      turns: [
        {
          id: "old",
          outcome: "completed",
          artifactState: "synced",
          artifactIds: [],
          summary: "Previous result",
          usageState: "pending",
          errorCode: null,
          endedAt: "2026-01-01",
        },
      ],
    });
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
    await screen.findByText("Task");
    expect(screen.queryByText("本轮完成")).not.toBeInTheDocument();
  });

  it("shows a recoverable synchronization failure and queues owned round recovery", async () => {
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
    };
    vi.spyOn(apiClient, "getSession").mockResolvedValue(detail);
    vi.spyOn(apiClient, "listArtifacts").mockResolvedValue({ artifacts: [] });
    vi.spyOn(apiClient, "listSessionTurns").mockResolvedValue({
      turns: [
        {
          id: "turn",
          outcome: "completed",
          artifactState: "failed",
          artifactIds: [],
          summary: "Result ready",
          usageState: "pending",
          errorCode: "ARTIFACTS_NOT_VISIBLE",
          endedAt: "2026-01-01",
        },
      ],
    });
    const retry = vi
      .spyOn(apiClient, "retrySessionTurn")
      .mockResolvedValue({ status: "queued" });
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
    expect(await screen.findByText("结果同步异常")).toBeInTheDocument();
    expect(screen.queryByText("用量统计中")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "重试同步" }));
    await waitFor(() => expect(retry).toHaveBeenCalledWith("session", "turn"));
    expect(
      await screen.findByText("已安排后台恢复结果同步。"),
    ).toBeInTheDocument();
  });
});

const endedAt = "2026-10-13T10:00:00Z";
const savedTurn = {
  id: "current-round",
  inputEventId: "current-input",
  boundaryEventId: "current-boundary",
  startedAt: "2026-10-13T09:00:00Z",
  endedAt,
  outcome: "completed" as const,
  artifactState: "failed" as const,
  artifactIds: [],
  summary: "当前独有摘要",
  usageState: "pending" as const,
  errorCode: "ARTIFACTS_NOT_VISIBLE",
};

it.each([
  {
    name: "older same-text answer",
    answerText: "当前独有摘要",
    answerAt: "2026-10-13T08:00:00Z",
    inputId: "old-input",
    keepSummary: true,
  },
  {
    name: "older answer sharing terminal timestamp",
    answerText: "旧答案",
    answerAt: endedAt,
    inputId: "old-input",
    keepSummary: true,
  },
  {
    name: "actual current input answer before terminal event",
    answerText: "当前独有摘要",
    answerAt: "2026-10-13T09:30:00Z",
    inputId: "current-input",
    keepSummary: false,
  },
  {
    name: "missing identity preserves result",
    answerText: "当前独有摘要",
    answerAt: endedAt,
    inputId: "missing",
    keepSummary: true,
  },
])(
  "scopes saved-answer evidence: $name",
  async ({ answerText, answerAt, inputId, keepSummary }) => {
    const input = {
      kind: "user",
      id: inputId,
      ts: "2026-10-13T08:00:00Z",
      text: "要求",
    };
    const answer = {
      kind: "assistant",
      id: "answer",
      ts: answerAt,
      text: answerText,
    };
    savedTimeline.items = [input, answer];
    savedTimeline.blocks = [
      { kind: "user", id: input.id, item: input },
      {
        kind: "turn",
        id: "transcript-turn",
        items: [],
        answer,
        live: false,
        stepCount: 0,
      },
    ];
    vi.spyOn(apiClient, "getSession").mockResolvedValue({
      id: "session",
      title: "身份验证任务",
      status: "idle",
      error: null,
      deletionState: "none",
      archivedAt: null,
      pinnedAt: null,
      lastEventAt: null,
      createdAt: endedAt,
      updatedAt: endedAt,
      agent: { id: "agent", kind: "personal", name: "助手", version: "1" },
      inputs: [],
    });
    vi.spyOn(apiClient, "listArtifacts").mockResolvedValue({ artifacts: [] });
    vi.spyOn(apiClient, "listSessionTurns").mockResolvedValue({
      turns: [savedTurn],
    });
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
    await screen.findByText("结果同步异常");
    if (keepSummary)
      expect(
        screen.getByRole("region", { name: "结果摘要" }),
      ).toHaveTextContent("当前独有摘要");
    else
      expect(
        screen.queryByRole("region", { name: "结果摘要" }),
      ).not.toBeInTheDocument();
  },
);
