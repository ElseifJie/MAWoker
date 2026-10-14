// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiClient, type SessionDetail } from "./api.js";
import { SessionPage } from "./SessionPage.js";
import type { SessionSummary, SessionTurn, SubmissionReceipt } from "./api.js";

const task: SessionSummary = {
  id: "task",
  title: "Research",
  status: "idle",
  upstreamReady: true,
  error: null,
  deletionState: "none",
  archivedAt: null,
  pinnedAt: null,
  lastEventAt: null,
  createdAt: "2026-10-13T10:00:00Z",
  updatedAt: "2026-10-13T10:00:00Z",
  agent: { id: "agent", name: "Helper", kind: "personal", version: "1" },
};
const turn: SessionTurn = {
  id: "turn",
  outcome: "completed",
  artifactState: "synced",
  artifactIds: [],
  summary: "Result",
  usageState: "complete",
  errorCode: null,
  endedAt: "2026-10-13T11:00:00Z",
};
function receipt(status: SubmissionReceipt["status"]): SubmissionReceipt {
  return {
    submissionId: "request",
    status,
    content: "Continue",
    createdAt: "2026-10-13T12:00:00Z",
    upstreamEventId: null,
    errorCode: null,
  };
}

const live = vi.hoisted(() => ({
  items: [],
  blocks: [],
  todos: [],
  status: undefined,
  connection: "reconnecting",
}));
vi.mock("./timeline/useSessionTimeline.js", () => ({
  useSessionTimeline: () => live,
}));
vi.mock("./components/WorkspaceRail.js", () => ({
  RAIL_DEFAULT_WIDTH: 340,
  WorkspaceRail: () => null,
}));
function Probe() {
  const location = useLocation();
  return (
    <output aria-label="location">
      {location.pathname}
      {location.search}
    </output>
  );
}
function mount() {
  render(
    <MemoryRouter initialEntries={["/sessions/task"]}>
      <Routes>
        <Route
          path="/sessions/:sessionId"
          element={
            <SessionPage
              userId="u"
              onStreamReady={vi.fn()}
              onSessionChanged={vi.fn()}
              onAuthRequired={vi.fn()}
            />
          }
        />
        <Route path="/" element={<h1>后续任务</h1>} />
      </Routes>
      <Probe />
    </MemoryRouter>,
  );
}
beforeEach(() => {
  vi.spyOn(apiClient, "getSession").mockResolvedValue({ ...task, inputs: [] });
  vi.spyOn(apiClient, "listSessionTurns").mockResolvedValue({ turns: [turn] });
  vi.spyOn(apiClient, "listArtifacts").mockResolvedValue({ artifacts: [] });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  sessionStorage.clear();
});
describe("B1 task page", () => {
  it("separates connection recovery from persisted task completion", async () => {
    mount();
    await screen.findByRole("heading", { name: task.title });
    expect(document.querySelector(".session-meta")).toHaveTextContent(
      "本轮完成",
    );
    expect(screen.getByText("连接重试中")).toBeInTheDocument();
    expect(screen.queryByText("执行失败")).toBeNull();
  });
  it.each(["initializing", "upgrading", "running", "rescheduled"] as const)(
    "requests interrupt for permitted %s without claiming it stopped",
    async (status) => {
      vi.mocked(apiClient.getSession).mockResolvedValue({
        ...task,
        status,
        inputs: [],
      });
      const interrupt = vi
        .spyOn(apiClient, "interruptSession")
        .mockResolvedValue({ eventId: "stop", delivery: "accepted" });
      mount();
      fireEvent.click(await screen.findByRole("button", { name: "停止任务" }));
      await waitFor(() => expect(interrupt).toHaveBeenCalledWith("task"));
      expect(
        await screen.findByText("已请求停止，等待任务状态确认。"),
      ).toBeInTheDocument();
      expect(document.querySelector(".session-meta")).not.toHaveTextContent(
        "已停止",
      );
    },
  );
  it.each([
    { upstreamReady: false },
    { upstreamReady: undefined },
    { deletionState: "pending" },
    { deletionState: "deletion_failed" },
  ] as Partial<SessionDetail>[])(
    "keeps stop unavailable for guarded record %j",
    async (guard) => {
      vi.mocked(apiClient.getSession).mockResolvedValue({
        ...task,
        status: "running",
        inputs: [],
        ...guard,
      });
      mount();
      await screen.findByRole("heading", { name: task.title });
      expect(screen.queryByRole("button", { name: "停止任务" })).toBeNull();
    },
  );
  it.each(["新建后续任务", "添加材料，创建后续任务"])(
    "navigates %s to the source-session fallback without runtime mutation",
    async (name) => {
      const send = vi.spyOn(apiClient, "sendMessage");
      mount();
      fireEvent.click(await screen.findByRole("button", { name }));
      expect(screen.getByLabelText("location")).toHaveTextContent(
        "/?sourceSessionId=task",
      );
      expect(send).not.toHaveBeenCalled();
    },
  );
  it("retains unknown receipt and recovery protections", async () => {
    vi.mocked(apiClient.getSession).mockResolvedValue({
      ...task,
      inputs: [],
      submissions: [receipt("unknown")],
    });
    mount();
    await screen.findByRole("heading", { name: task.title });
    expect(document.querySelector(".session-meta")).not.toHaveTextContent(
      "确认中",
    );
    expect(screen.queryByText("任务信息")).toBeNull();
    expect(
      screen.getByText("正在核实消息发送结果，请勿重复发送。"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Continue").closest(".transcript__row--user"),
    ).not.toBeNull();
    expect(
      screen
        .getByText("正在核实消息发送结果，请勿重复发送。")
        .closest(".transcript__bubble"),
    ).toBeNull();
    expect(screen.queryByText("等待任务开始…")).toBeNull();
    expect(screen.getByText("request")).toBeInTheDocument();
    expect(screen.queryByText("本轮完成")).toBeNull();
  });
  it("shows failure evidence and a next step without implying an idle task succeeded", async () => {
    vi.mocked(apiClient.listSessionTurns).mockResolvedValue({
      turns: [
        {
          ...turn,
          outcome: "failed",
          summary: "",
          errorCode: "EXECUTION_FAILED",
        },
      ],
    });
    mount();
    expect(await screen.findByText("EXECUTION_FAILED")).toBeInTheDocument();
    expect(screen.getByText(/补充要求后重试/)).toBeInTheDocument();
  });
  it("does not show the old completion banner after a newer timeline message", async () => {
    const snapshot = { ...live };
    Object.assign(live, {
      items: [
        {
          kind: "user",
          id: "new",
          ts: "2026-10-13T12:00:00Z",
          text: "New request",
        },
      ],
    });
    try {
      mount();
      await screen.findByRole("heading", { name: task.title });
      expect(screen.queryByText("本轮完成")).toBeNull();
    } finally {
      Object.assign(live, snapshot);
    }
  });
});
