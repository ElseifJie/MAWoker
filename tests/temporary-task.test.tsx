// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import React from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionIntro } from "../apps/web/src/components/SessionIntro.js";
import { apiClient } from "../apps/web/src/api.js";
import { readDraft } from "../apps/web/src/submission-drafts.js";

function taskPage(draftKey: string, onSessionCreated = vi.fn()) {
  return (
    <MemoryRouter initialEntries={["/?artifactId=file"]}>
      <SessionIntro
        draftKey={draftKey}
        agents={
          {
            agents: [
              { id: "agent", name: "A", kind: "platform" },
              { id: "other", name: "B", kind: "platform" },
            ],
            selection: { agentId: "agent" },
            blocker: null,
          } as never
        }
        usage={
          {
            exhausted: {
              monthlyTokens: false,
              dailySessions: false,
              concurrentSessions: false,
            },
          } as never
        }
        onAuthRequired={vi.fn()}
        onSessionCreated={onSessionCreated}
      />
    </MemoryRouter>
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  sessionStorage.clear();
});
describe("personal memory task choice", () => {
  it("cancels unfinished reuse on unmount and never starts a task afterward", async () => {
    vi.spyOn(apiClient, "listArtifacts").mockResolvedValue({ artifacts: [] });
    let resolve!: (value: never) => void;
    const reuse = vi.spyOn(apiClient, "reuseArtifact").mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const create = vi.spyOn(apiClient, "createSession");
    const page = render(taskPage("cancel-prepare"));
    fireEvent.change(screen.getByLabelText("任务要求"), {
      target: { value: "修改报告" },
    });
    fireEvent.click(screen.getByRole("button", { name: "开始任务" }));
    await waitFor(() => expect(reuse).toHaveBeenCalledTimes(1));
    const signal = reuse.mock.calls[0]![1]!;
    page.unmount();
    expect(signal.aborted).toBe(true);
    await act(async () => resolve({ id: "late-input" } as never));
    expect(create).not.toHaveBeenCalled();
  });

  it("preserves a newer draft when an obsolete create response arrives", async () => {
    vi.spyOn(apiClient, "listArtifacts").mockResolvedValue({ artifacts: [] });
    vi.spyOn(apiClient, "reuseArtifact").mockResolvedValue({
      id: "input",
    } as never);
    let resolve!: (value: never) => void;
    const create = vi.spyOn(apiClient, "createSession").mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const oldNavigation = vi.fn();
    const old = render(taskPage("late-create", oldNavigation));
    fireEvent.change(screen.getByLabelText("任务要求"), {
      target: { value: "任务A" },
    });
    fireEvent.click(screen.getByRole("button", { name: "开始任务" }));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    old.unmount();
    render(taskPage("late-create"));
    fireEvent.change(screen.getByLabelText("任务要求"), {
      target: { value: "任务B" },
    });
    const newer = readDraft("late-create");
    await act(async () => resolve({ id: "A" } as never));
    expect(oldNavigation).not.toHaveBeenCalled();
    expect(readDraft("late-create")).toEqual(newer);
    expect(screen.getByLabelText("任务要求")).toHaveValue("任务B");
  });

  it.each(["memory", "assistant", "file"] as const)(
    "assigns a new submission identity when %s changes after remount",
    async (change) => {
      vi.spyOn(apiClient, "listArtifacts").mockResolvedValue({
        artifacts: [
          {
            id: "file",
            name: "报告.txt",
            sizeBytes: 1,
            deletionState: "none",
          } as never,
        ],
      });
      vi.spyOn(apiClient, "reuseArtifact").mockResolvedValue({
        id: "input",
      } as never);
      const create = vi
        .spyOn(apiClient, "createSession")
        .mockRejectedValueOnce(new Error("response lost"))
        .mockResolvedValue({ id: "new" } as never);
      const first = render(taskPage("edited-replay"));
      fireEvent.change(screen.getByLabelText("任务要求"), {
        target: { value: "修改报告" },
      });
      fireEvent.click(screen.getByRole("button", { name: "开始任务" }));
      await screen.findByText("任务无法启动，请重试。");
      const original = create.mock.calls[0]![0];
      first.unmount();
      const second = render(taskPage("edited-replay"));
      await screen.findByRole("button", { name: "移除材料 报告.txt · file" });
      if (change === "memory")
        fireEvent.click(screen.getByLabelText("使用个人记忆"));
      else if (change === "assistant")
        fireEvent.change(screen.getByLabelText("助手"), {
          target: { value: "other" },
        });
      else
        fireEvent.click(
          screen.getByRole("button", { name: "移除材料 报告.txt · file" }),
        );
      expect(readDraft("edited-replay").submissionId).not.toBe(
        original.submissionId,
      );
      expect(readDraft("edited-replay").attempt).toBeUndefined();
      second.unmount();
      render(taskPage("edited-replay"));
      fireEvent.click(screen.getByRole("button", { name: "开始任务" }));
      await waitFor(() => expect(create).toHaveBeenCalledTimes(2));
      expect(create.mock.calls[1]![0].submissionId).not.toBe(
        original.submissionId,
      );
    },
  );

  it("maps disabled memory to temporary without deleting the conversation", async () => {
    vi.spyOn(apiClient, "listArtifacts").mockResolvedValue({ artifacts: [] });
    const create = vi
      .spyOn(apiClient, "createSession")
      .mockResolvedValue({ id: "new" } as never);
    render(
      <MemoryRouter initialEntries={["/?temporary=true"]}>
        <SessionIntro
          draftKey="test"
          agents={
            {
              agents: [{ id: "agent", name: "A", kind: "platform" }],
              selection: { agentId: "agent" },
              blocker: null,
            } as never
          }
          usage={
            {
              exhausted: {
                monthlyTokens: false,
                dailySessions: false,
                concurrentSessions: false,
              },
            } as never
          }
          onAuthRequired={vi.fn()}
          onSessionCreated={vi.fn()}
        />
      </MemoryRouter>,
    );
    expect(screen.getByLabelText("使用个人记忆")).not.toBeChecked();
    fireEvent.change(screen.getByLabelText("任务要求"), {
      target: { value: "临时任务" },
    });
    fireEvent.click(screen.getByRole("button", { name: "开始任务" }));
    await waitFor(() =>
      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({ temporary: true, content: "临时任务" }),
      ),
    );
  });
  it("does not replace user edits or memory choice with a delayed source summary", async () => {
    let resolve!: (value: unknown) => void;
    vi.spyOn(apiClient, "listArtifacts").mockResolvedValue({ artifacts: [] });
    vi.spyOn(apiClient, "listSessionTurns").mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }) as never,
    );
    render(
      <MemoryRouter initialEntries={["/?sourceSessionId=source"]}>
        <SessionIntro
          draftKey="delayed"
          agents={
            {
              agents: [{ id: "agent", name: "A", kind: "platform" }],
              selection: { agentId: "agent" },
              blocker: null,
            } as never
          }
          usage={
            {
              exhausted: {
                monthlyTokens: false,
                dailySessions: false,
                concurrentSessions: false,
              },
            } as never
          }
          onAuthRequired={vi.fn()}
          onSessionCreated={vi.fn()}
        />
      </MemoryRouter>,
    );
    fireEvent.change(screen.getByLabelText("任务要求"), {
      target: { value: "我自己编辑" },
    });
    fireEvent.click(screen.getByLabelText("使用个人记忆"));
    resolve({ turns: [{ summary: "迟到摘要" }] });
    await waitFor(() =>
      expect(screen.getByLabelText("任务要求")).toHaveValue("我自己编辑"),
    );
    expect(screen.getByLabelText("使用个人记忆")).not.toBeChecked();
  });
  it("replays prepared file IDs after a lost response and remount", async () => {
    vi.spyOn(apiClient, "listArtifacts").mockResolvedValue({ artifacts: [] });
    const reuse = vi
      .spyOn(apiClient, "reuseArtifact")
      .mockResolvedValue({ id: "prepared" } as never);
    const create = vi
      .spyOn(apiClient, "createSession")
      .mockRejectedValueOnce(new Error("response lost"))
      .mockResolvedValue({ id: "task" } as never);
    const page = () => (
      <MemoryRouter initialEntries={["/?artifactId=file"]}>
        <SessionIntro
          draftKey="replay"
          agents={
            {
              agents: [{ id: "agent", name: "A", kind: "platform" }],
              selection: { agentId: "agent" },
              blocker: null,
            } as never
          }
          usage={
            {
              exhausted: {
                monthlyTokens: false,
                dailySessions: false,
                concurrentSessions: false,
              },
            } as never
          }
          onAuthRequired={vi.fn()}
          onSessionCreated={vi.fn()}
        />
      </MemoryRouter>
    );
    const first = render(page());
    fireEvent.change(screen.getByLabelText("任务要求"), {
      target: { value: "修改报告" },
    });
    fireEvent.click(screen.getByRole("button", { name: "开始任务" }));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    await screen.findByText("任务无法启动，请重试。");
    first.unmount();
    render(page());
    fireEvent.click(screen.getByRole("button", { name: "开始任务" }));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(2));
    expect(create.mock.calls[1]![0]).toEqual(create.mock.calls[0]![0]);
    expect(reuse).toHaveBeenCalledTimes(1);
  });
});
