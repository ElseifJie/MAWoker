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
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { apiClient } from "../apps/web/src/api.js";
import { AppShell } from "../apps/web/src/ui/index.js";
import { TaskNotifications } from "../apps/web/src/components/TaskNotifications.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
describe("durable task notifications", () => {
  it("keeps notifications out of the sidebar flow and restores focus after Escape", async () => {
    vi.spyOn(apiClient, "listNotifications").mockResolvedValue({
      notifications: [
        {
          id: "n",
          sessionId: "s",
          turnId: "t",
          kind: "sync_failed",
          readAt: null,
          createdAt: "2026-10-13T10:29:00Z",
        },
      ],
    });
    render(
      <MemoryRouter>
        <TaskNotifications
          sessions={[{ id: "s", title: "天气任务" }] as never}
          onAuthRequired={vi.fn()}
        />
      </MemoryRouter>,
    );
    const trigger = await screen.findByRole("button", {
      name: "任务通知，1 条未读",
    });
    expect(screen.queryByText("结果同步异常")).not.toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(trigger);
    expect(
      screen.getByRole("dialog", { name: "任务通知" }),
    ).toBeInTheDocument();
    expect(screen.getByText("天气任务")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("shows offline unread results and marks the selected owned notice read", async () => {
    vi.spyOn(apiClient, "listNotifications").mockResolvedValue({
      notifications: [
        {
          id: "notice",
          sessionId: "session",
          turnId: "turn",
          kind: "completed",
          readAt: null,
          createdAt: "2026-01-01",
        },
      ],
    });
    const read = vi
      .spyOn(apiClient, "markNotificationRead")
      .mockResolvedValue();
    render(
      <MemoryRouter>
        <TaskNotifications onAuthRequired={vi.fn()} />
      </MemoryRouter>,
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "任务通知，1 条未读" }),
    );
    expect(screen.getByRole("link", { name: "任务已完成" })).toHaveAttribute(
      "href",
      "/sessions/session",
    );
    fireEvent.click(screen.getByRole("button", { name: "标为已读" }));
    await waitFor(() => expect(read).toHaveBeenCalledWith("notice"));
    expect(await screen.findByText("暂无未读通知")).toBeInTheDocument();
  });

  it("contains notification failures and retries independently", async () => {
    const list = vi
      .spyOn(apiClient, "listNotifications")
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue({ notifications: [] });
    render(
      <MemoryRouter>
        <TaskNotifications onAuthRequired={vi.fn()} />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole("button", { name: "任务通知" }));
    await screen.findByText("通知暂时不可用。");
    fireEvent.click(screen.getByRole("button", { name: "重试通知" }));
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(screen.queryByText("通知暂时不可用。")).not.toBeInTheDocument(),
    );
  });
});

it("keeps exact round records and exposes full timestamps without a guessed task title", async () => {
  vi.spyOn(apiClient, "listNotifications").mockResolvedValue({
    notifications: ["round-one", "round-two"].map((turnId) => ({
      id: turnId,
      turnId,
      sessionId: "unknown-session",
      kind: "sync_failed" as const,
      readAt: null,
      createdAt: "2026-10-13T10:29:00Z",
    })),
  });
  render(
    <MemoryRouter>
      <TaskNotifications onAuthRequired={vi.fn()} />
    </MemoryRouter>,
  );
  fireEvent.click(
    await screen.findByRole("button", { name: "任务通知，2 条未读" }),
  );
  expect(screen.getAllByRole("link", { name: "结果同步异常" })).toHaveLength(2);
  expect(screen.getByText("round-one")).toBeInTheDocument();
  expect(screen.getByText("round-two")).toBeInTheDocument();
  expect(screen.queryByText("任务 unknown-")).not.toBeInTheDocument();
  for (const time of document.querySelectorAll("time"))
    expect(time).toHaveAttribute(
      "aria-label",
      new Date("2026-10-13T10:29:00Z").toLocaleString("zh-CN"),
    );
});

it("keeps the mobile drawer open while its notification dialog handles focus and Escape", async () => {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query) => ({
      matches: true,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
  vi.spyOn(apiClient, "listNotifications").mockResolvedValue({
    notifications: [],
  });
  const user = userEvent.setup();
  render(
    <MemoryRouter>
      <AppShell
        brand="Work"
        navigationLabel="导航"
        navigation={[]}
        user={{ handle: "user" }}
        onSignOut={vi.fn()}
        brandActions={<TaskNotifications onAuthRequired={vi.fn()} />}
        openNavigationLabel="打开导航"
        closeNavigationLabel="关闭导航"
      >
        <h1>页面</h1>
      </AppShell>
    </MemoryRouter>,
  );
  expect(screen.getAllByRole("button", { name: "任务通知" })).toHaveLength(1);
  await user.click(screen.getByRole("button", { name: "打开导航" }));
  const trigger = screen.getByRole("button", { name: "任务通知" });
  await user.click(trigger);
  const close = screen.getByRole("button", { name: "关闭任务通知" });
  expect(close).toHaveFocus();
  await user.tab();
  expect(close).toHaveFocus();
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "关闭导航" })).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  expect(screen.getByRole("button", { name: "任务通知" })).toHaveFocus();
});
