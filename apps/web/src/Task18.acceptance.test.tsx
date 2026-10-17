// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { App } from "./App.js";
import {
  AcceptanceEventSource,
  createTask18BrowserBackend,
} from "./task-18-browser-harness.js";

function renderApp(path = "/") {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );
}

async function signIn(email: string) {
  const user = userEvent.setup();
  await screen.findByRole("heading", { name: "登录你的工作区" });
  await user.type(screen.getByLabelText("邮箱"), email);
  await user.type(screen.getByLabelText("密码"), "acceptance-password");
  await user.click(screen.getByRole("button", { name: "登录" }));
  return user;
}

beforeEach(() => {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  );
  AcceptanceEventSource.instances = [];
  vi.stubGlobal("EventSource", AcceptanceEventSource);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Task 18 browser acceptance", () => {
  it("completes the ordinary-user workflow through real React DOM interactions", async () => {
    const backend = createTask18BrowserBackend();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input, init) => {
        const response = await backend.fetch(input, init);
        const path = new URL(String(input), "http://localhost").pathname;
        if (
          path === `/api/v1/sessions/${backend.sessionId}` &&
          (!init?.method || init.method === "GET") &&
          response.ok
        ) {
          return new Response(
            JSON.stringify({ ...(await response.json()), upstreamReady: true }),
            { status: response.status, headers: response.headers },
          );
        }
        return response;
      }),
    );
    renderApp();
    const user = await signIn("user-a@example.com");

    expect(
      await screen.findByRole("heading", { name: "新任务" }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("助手")).toHaveValue(backend.platformAgentId);

    await user.upload(
      screen.getByLabelText("材料文件"),
      new File(["acceptance input"], "brief.txt", { type: "text/plain" }),
    );
    expect(await screen.findByText("已就绪")).toBeInTheDocument();
    await user.type(
      screen.getByLabelText("任务要求"),
      "Prepare an acceptance report",
    );
    await user.click(screen.getByRole("button", { name: "开始任务" }));

    expect(
      await screen.findByRole("heading", {
        name: "Prepare an acceptance report",
      }),
    ).toBeInTheDocument();
    expect(screen.getByText("brief.txt")).toBeInTheDocument();
    const stream = await waitFor(() => {
      const instance = AcceptanceEventSource.instances.at(-1);
      if (!instance) throw new Error("event stream not opened yet");
      return instance;
    });
    act(() => stream.emitOpen());
    const [creation] = backend.callsFor("POST", "/sessions");
    expect(creation?.body).toMatchObject({
      content: "Prepare an acceptance report",
      submissionId: expect.any(String),
    });
    expect(backend.callsFor("POST", "/messages")).toHaveLength(0);
    const sessionHeading = screen.getByRole("heading", {
      name: "Prepare an acceptance report",
    });
    const sessionMeta = sessionHeading
      .closest(".session-page")!
      .querySelector<HTMLElement>(".session-meta")!;
    expect(
      within(sessionMeta).getByText("待开始").closest(".ui-badge"),
    ).toHaveClass("ui-badge");
    expect(within(sessionMeta).getByText("已连接")).toHaveClass(
      "session-connection--success",
    );
    expect(screen.getByRole("button", { name: "发送消息" })).toHaveClass(
      "ui-icon-button",
    );

    act(() => {
      stream.emit("user.message", {
        id: "event-user",
        sourceType: "user.message",
        type: "message",
        createdAt: "2026-09-07T08:00:00.000Z",
        payload: { content: "Prepare an acceptance report" },
      });
      stream.emit("agent.thinking", {
        id: "event-thinking",
        sourceType: "agent.thinking",
        type: "thinking",
        createdAt: "2026-09-07T08:00:01.000Z",
        payload: { content: "must remain private" },
      });
      stream.emit("agent.tool_use", {
        id: "call_write_1",
        sourceType: "agent.tool_use",
        type: "tool_use",
        createdAt: "2026-09-07T08:00:02.000Z",
        payload: {
          callId: "call_write_1",
          name: "write",
          argsSummary: "/workspace/acceptance-report.md",
        },
      });
    });
    const toolRow = () =>
      document.querySelector('[data-event-id="call_write_1"]')!;
    expect(toolRow().textContent).toContain("正在写入");
    expect(toolRow().textContent).toContain("acceptance-report.md");

    act(() => {
      stream.emit("agent.tool_result", {
        id: "event-tool-result",
        sourceType: "agent.tool_result",
        type: "tool_result",
        createdAt: "2026-09-07T08:00:02.500Z",
        payload: {
          callId: "call_write_1",
          status: "ok",
          preview: "Wrote /workspace/acceptance-report.md",
        },
      });
      stream.emit("agent.message", {
        id: "event-agent",
        sourceType: "agent.message",
        type: "message",
        createdAt: "2026-09-07T08:00:03.000Z",
        payload: { content: "Acceptance report ready." },
      });
      stream.emit("session.status", {
        id: "event-running",
        sourceType: "session.status",
        type: "status",
        createdAt: "2026-09-07T08:00:04.000Z",
        payload: { status: "running" },
      });
    });
    expect(await screen.findByText("Acceptance report ready.")).toBeVisible();
    expect(screen.queryByText("must remain private")).not.toBeInTheDocument();
    // The result folded into the same row rather than adding a second one.
    expect(toolRow().textContent).toContain("已写入");
    expect(toolRow().textContent).not.toContain("正在写入");
    expect(toolRow().textContent).toContain("500ms");
    const preview = screen.getByText("Wrote /workspace/acceptance-report.md");
    expect(preview).toBeInTheDocument();
    expect(preview).not.toBeVisible();

    act(() => stream.emitError());
    expect(screen.getByText("连接重试中")).toBeVisible();
    act(() => {
      stream.emitOpen();
      stream.emit("agent.message", {
        id: "event-agent",
        sourceType: "agent.message",
        type: "message",
        createdAt: "2026-09-07T08:00:03.000Z",
        payload: { content: "Acceptance report ready." },
      });
    });
    expect(screen.getAllByText("Acceptance report ready.")).toHaveLength(1);

    await user.type(screen.getByLabelText("补充要求"), "Add the risk section");
    await user.click(screen.getByRole("button", { name: "发送消息" }));
    expect(
      await screen.findByText("消息已排队，后台将继续发送。"),
    ).toBeVisible();
    await user.click(screen.getByRole("button", { name: "停止任务" }));
    expect(
      await screen.findByText("已请求停止，等待任务状态确认。"),
    ).toBeVisible();

    await user.click(screen.getByRole("link", { name: "设置" }));
    await screen.findByRole("heading", { name: "设置" });
    await user.click(screen.getByRole("link", { name: "助手配置" }));
    await screen.findByRole("heading", { name: "助手配置" });
    await user.click(screen.getByRole("button", { name: "创建个人助手" }));
    await screen.findByRole("heading", { name: "创建个人助手" });
    await user.type(screen.getByLabelText("名称"), "Private reviewer");
    await user.type(screen.getByLabelText("描述"), "Checks reports");
    await user.selectOptions(screen.getByLabelText("模型"), "model-a");
    await user.type(screen.getByLabelText("系统提示词"), "Review safely.");
    await user.click(screen.getByRole("button", { name: "创建助手" }));
    await screen.findByRole("heading", { name: "助手配置" });
    expect(await screen.findByText("Private reviewer")).toBeVisible();

    await user.click(
      screen.getByRole("button", { name: "编辑 Private reviewer" }),
    );
    const agentName = await screen.findByLabelText("名称");
    await user.clear(agentName);
    await user.type(agentName, "Private editor");
    await user.click(screen.getByRole("button", { name: "保存修改" }));
    await screen.findByRole("heading", { name: "助手配置" });
    expect(await screen.findByText("Private editor")).toBeVisible();
    await user.click(
      screen.getByRole("button", { name: "删除 Private editor" }),
    );
    await user.click(
      within(screen.getByRole("dialog", { name: "删除个人助手？" })).getByRole(
        "button",
        { name: "删除助手" },
      ),
    );
    await waitFor(() =>
      expect(screen.queryByText("Private editor")).not.toBeInTheDocument(),
    );

    await user.click(screen.getByRole("link", { name: "我的文件" }));
    expect(
      await screen.findByRole("heading", { name: "我的文件" }),
    ).toBeVisible();
    const download = screen.getByRole("link", {
      name: "下载 acceptance-report.txt",
    });
    expect(download).toHaveAttribute(
      "href",
      `/api/v1/artifacts/${backend.artifactId}/download`,
    );
    await expect(
      (await backend.fetch(download.getAttribute("href")!)).text(),
    ).resolves.toBe("acceptance artifact");

    await user.click(
      screen.getByRole("link", { name: /Prepare an acceptance report/ }),
    );
    await screen.findByRole("heading", {
      name: "Prepare an acceptance report",
    });
    await user.click(screen.getByRole("button", { name: "任务操作" }));
    await user.click(screen.getByRole("button", { name: "归档任务" }));
    expect(
      await screen.findByRole("button", { name: "恢复任务" }),
    ).toBeVisible();
    await user.click(screen.getByRole("button", { name: "恢复任务" }));
    await user.click(screen.getByRole("button", { name: "任务操作" }));
    await user.click(screen.getByRole("button", { name: "永久删除任务" }));
    const dialog = screen.getByRole("dialog", {
      name: "永久删除任务？",
    });
    await user.type(
      within(dialog).getByLabelText("输入 DELETE 确认"),
      "DELETE",
    );
    await user.click(within(dialog).getByRole("button", { name: "永久删除" }));

    expect(await screen.findByText("正在永久删除")).toBeVisible();
    expect(backend.callsFor("POST", "/messages")).toHaveLength(1);
    expect(backend.callsFor("POST", "/interrupt")).toHaveLength(1);
    expect(
      backend.callsFor("DELETE", `/sessions/${backend.sessionId}`),
    ).toHaveLength(1);
  });

  it("completes the administrator lifecycle without exposing user content", async () => {
    const backend = createTask18BrowserBackend();
    vi.stubGlobal("fetch", vi.fn(backend.fetch));
    renderApp("/admin/platform-agents");
    const user = await signIn("admin@example.com");

    expect(
      await screen.findByRole("heading", { name: "助手管理" }),
    ).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "New platform Agent" }),
    ).not.toBeInTheDocument();
    expect(await screen.findByText("Research assistant")).toBeVisible();

    await user.click(screen.getByRole("link", { name: "用户管理" }));
    await screen.findByRole("heading", { name: "用户管理" });
    // Account management lives on the detail page.
    await user.click(
      await screen.findByRole("link", { name: "user-a@example.com" }),
    );
    expect(
      await screen.findByRole("heading", {
        name: "user-a@example.com",
        level: 1,
      }),
    ).toBeVisible();
    await user.selectOptions(
      screen.getByLabelText("user-a@example.com 的默认助手"),
      backend.createdPlatformAgentId,
    );
    await user.click(
      screen.getByRole("button", {
        name: "保存 user-a@example.com 的默认助手",
      }),
    );
    expect(await screen.findByText("默认助手已保存。")).toBeVisible();

    const quotaValues = [
      ["user-a@example.com 的个人助手上限", "12"],
      ["user-a@example.com 的同时运行任务上限", "3"],
      ["user-a@example.com 的每日任务上限", "30"],
      ["user-a@example.com 的每月 Token 上限", "2000"],
    ] as const;
    for (const [label, value] of quotaValues) {
      const input = screen.getByLabelText(label);
      await user.clear(input);
      await user.type(input, value);
    }
    await user.click(
      screen.getByRole("button", {
        name: "保存 user-a@example.com 的配额",
      }),
    );
    expect(await screen.findByText("配额已保存。")).toBeVisible();

    await user.click(screen.getByRole("link", { name: "助手管理" }));
    expect(await screen.findByText("Research assistant")).toBeVisible();
    expect(
      screen.queryByRole("button", { name: /账号操作：/ }),
    ).not.toBeInTheDocument();
    expect(
      backend.calls.some(
        ({ method, path }) =>
          path.startsWith("/api/v1/admin/platform-agents") && method !== "GET",
      ),
    ).toBe(false);
    expect(backend.userQuota()).toEqual({
      personalAgentLimit: 12,
      concurrentSessionLimit: 3,
      dailySessionLimit: 30,
      monthlyTokenLimit: 2000,
    });
    expect(
      backend.calls.some(({ path }) => path.startsWith("/api/v1/sessions")),
    ).toBe(false);
    expect(
      backend.calls.some(({ path }) => path.startsWith("/api/v1/artifacts")),
    ).toBe(false);
  });
});
