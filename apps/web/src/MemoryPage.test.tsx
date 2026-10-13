// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App.js";
import { resetMemoryCacheForTest } from "./MemoryPage.js";

const capacity = {
  count: 2,
  bytes: 67,
  maxEntryBytes: 54,
  countRatio: 0.001,
  byteRatio: null,
  level: "normal",
  targetCount: 1200,
};
const state = {
  status: "active",
  protectedPaths: [],
  autoDream: true,
  run: null,
};
const queued = {
  ...state,
  run: {
    kind: "edit",
    stage: "queued",
    error: null,
    before: null,
    after: null,
  },
};
let currentState: typeof state | typeof queued;
let entries: Array<{ path: string; content: string; hash?: string }>;
let failure: { status: number; code: string; path?: string } | null;
let sessionCount = 1;
let holdMemoryList: Promise<void> | null = null;
let releaseMemoryList: (() => void) | null = null;
let currentUser = { userId: "A", authSubject: "local:a", role: "user" };
let currentStore = {
  id: "memstore-20261010143827-obuom",
  updatedAt: "2026-10-10T14:38:27Z",
};
const fetchMock = vi.fn(
  async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (path === "/api/v1/me") return Response.json({ user: currentUser });
    if (path === "/api/v1/auth/logout")
      return new Response(null, { status: 204 });
    if (path === "/api/v1/auth/login" && init?.method === "POST")
      return Response.json({});
    if (path === "/api/v1/agents")
      return Response.json({ agents: [], selection: null, blocker: null });
    if (path.startsWith("/api/v1/sessions"))
      return Response.json({ sessions: [] });
    if (path === "/api/v1/capabilities")
      return Response.json({
        memoryStores: { available: true },
        skills: { available: false },
        mcpServers: { available: false },
        vaults: { available: false },
        personalAgentModels: [],
      });
    if (path === "/api/v1/usage")
      return Response.json({
        quota: {},
        usage: {},
        exhausted: {
          monthlyTokens: false,
          dailySessions: false,
          concurrentSessions: false,
        },
      });
    if (path === "/api/v1/memory/recover" && init?.method === "POST") {
      currentState = {
        ...currentState,
        status: "applying",
        run: { ...currentState.run!, stage: "apply", error: null },
      } as typeof currentState;
      return Response.json(currentState);
    }
    if (path === "/api/v1/memory/cancel" && init?.method === "POST") {
      currentState = {
        ...state,
        run: { ...queued.run, stage: "failed" },
      };
      return Response.json(currentState);
    }
    if (
      failure &&
      path.startsWith("/api/v1/memory") &&
      (!failure.path || path === failure.path)
    )
      return Response.json(
        { error: { code: failure.code, message: "Request failed" } },
        { status: failure.status },
      );
    if (path === "/api/v1/memory") {
      if (holdMemoryList) await holdMemoryList;
      return Response.json({
        entries,
        capacity,
        state: currentState,
        store: currentStore,
        sessionCount,
      });
    }
    if (path === "/api/v1/memory/status") return Response.json(currentState);
    if (path === "/api/v1/memory/entry" && init?.method === "POST") {
      currentState = queued;
      return Response.json(queued, { status: 202 });
    }
    if (path === "/api/v1/memory/entry" && init?.method === "DELETE") {
      currentState = queued;
      return Response.json(queued, { status: 202 });
    }
    if (path === "/api/v1/memory/protect")
      return Response.json({
        ...state,
        protectedPaths: ["/memories/profile.md"],
      });
    if (path === "/api/v1/memory/settings")
      return Response.json({ ...state, autoDream: false });
    throw new Error(`Unexpected request ${path}`);
  },
);
beforeEach(() => {
  currentState = state;
  entries = [
    {
      path: "/memories/profile.md",
      content: "Profile",
      hash: "hash-profile-v1",
    },
    {
      path: "/resources/README.md",
      content: "Resources",
      hash: "hash-readme-v1",
    },
  ];
  failure = null;
  sessionCount = 1;
  holdMemoryList = null;
  releaseMemoryList = null;
  currentUser = { userId: "A", authSubject: "local:a", role: "user" };
  currentStore = {
    id: "memstore-20261010143827-obuom",
    updatedAt: "2026-10-10T14:38:27Z",
  };
  resetMemoryCacheForTest();
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
function open(initial = "/context") {
  render(
    <MemoryRouter initialEntries={[initial]}>
      <App />
    </MemoryRouter>,
  );
}
async function openDetail() {
  open();
  fireEvent.click(await screen.findByRole("button", { name: "查看记忆" }));
  await screen.findByText("路径浏览");
}

describe("MemoryPage", () => {
  it("keeps long nested filenames accessible and exposes folder and selection state", async () => {
    const name = "sesn-20261011171750-7xp6r.md";
    const path = `/episodes/digest/${name}`;
    entries.push({ path, content: "Digest", hash: "digest-hash" });
    await openDetail();
    const folder = screen.getByRole("button", { name: "digest" });
    expect(folder).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(folder);
    expect(folder).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("button", { name })).not.toBeInTheDocument();
    fireEvent.click(folder);
    const file = screen.getByRole("button", { name });
    expect(file).toHaveAttribute("title", path);
    fireEvent.click(file);
    expect(file).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByLabelText("路径")).toHaveValue(path);
    expect(screen.getByLabelText("内容")).toHaveValue("Digest");
  });

  it("lists the Memory Store with usage and opens the detail from the row", async () => {
    open();
    expect(
      await screen.findByRole("heading", { name: "个人记忆" }),
    ).toBeInTheDocument();
    expect(
      await screen.findByRole("button", { name: "查看记忆" }),
    ).toBeInTheDocument();
    expect(screen.getByText(currentStore.id)).toBeInTheDocument();
    expect(screen.getByText("67 B")).toBeInTheDocument();
    expect(screen.getByText("2026-10-10 14:38:27")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "查看记忆" }));
    expect(await screen.findByText("路径浏览")).toBeInTheDocument();
    expect(screen.getByText(currentStore.id)).toBeInTheDocument();
    expect(screen.getByText(/记忆条目：2/)).toBeInTheDocument();
    expect(screen.getByText(/关联任务：1/)).toBeInTheDocument();
  });
  it("renders the path tree and opens a memory for editing", async () => {
    await openDetail();
    expect(
      screen.getByRole("button", { name: /memories/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /resources/ }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "profile.md" }));
    expect(screen.getByLabelText("内容")).toHaveValue("Profile");
    expect(screen.getByLabelText("路径")).toBeDisabled();
    expect(screen.getByRole("button", { name: "保存" })).toBeEnabled();
    expect(
      screen.getByRole("button", { name: "README.md" }),
    ).toBeInTheDocument();
  });
  it("keeps editing read-only while an operation is running", async () => {
    currentState = queued;
    await openDetail();
    fireEvent.click(await screen.findByRole("button", { name: "profile.md" }));
    expect(screen.getByLabelText("内容")).toBeDisabled();
    expect(screen.getByRole("button", { name: "保存" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "+ 新建记忆" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "取消操作" })).toBeEnabled();
  });
  it("keeps the store readable while consolidation is running", async () => {
    currentState = {
      ...state,
      run: { ...queued.run, stage: "polling" },
    };
    await openDetail();
    // The files render and an informational banner explains the refresh;
    // only editing stays gated on the run.
    expect(screen.getByText("路径浏览")).toBeInTheDocument();
    expect(
      screen.getByText(
        "自动整理正在运行。当前内容可能包含整理中的变更，完成后会刷新并恢复编辑。",
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "+ 新建记忆" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "取消操作" })).toBeEnabled();
  });
  it("renders the remembered list immediately when reopening the store", async () => {
    await openDetail();
    cleanup();
    // Hold the next list response: the files that paint while it is pending
    // can only come from the remembered list.
    holdMemoryList = new Promise<void>((resolve) => {
      releaseMemoryList = resolve;
    });
    open("/context/store");
    expect(await screen.findByText("路径浏览")).toBeInTheDocument();
    releaseMemoryList?.();
    holdMemoryList = null;
    await screen.findByRole("button", { name: "profile.md" });
  });
  it("cancels a running operation and unlocks the page", async () => {
    currentState = queued;
    await openDetail();
    fireEvent.click(screen.getByRole("button", { name: "取消操作" }));
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/memory/cancel",
      expect.objectContaining({ method: "POST" }),
    );
    expect(await screen.findByText("操作已取消。")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "+ 新建记忆" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "取消操作" })).toBeNull();
  });
  it("queues saves and refreshes the editor after two-second polling", async () => {
    await openDetail();
    fireEvent.click(await screen.findByRole("button", { name: "profile.md" }));
    vi.useFakeTimers();
    fireEvent.change(screen.getByLabelText("内容"), {
      target: { value: "Updated" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await act(async () => {});
    expect(screen.getByText(/保存已排队，尚未保存/)).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/memory/entry",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          path: "/memories/profile.md",
          content: "Updated",
          expectedHash: "hash-profile-v1",
        }),
      }),
    );
    currentState = { ...state, run: { ...queued.run, stage: "completed" } };
    entries = [
      {
        path: "/memories/profile.md",
        content: "Updated",
        hash: "hash-profile-v2",
      },
    ];
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(screen.getByText("记忆已保存。")).toBeInTheDocument();
    expect(screen.getByLabelText("内容")).toHaveValue("Updated");
    const polls = fetchMock.mock.calls.filter(
      ([url]) => url === "/api/v1/memory/status",
    ).length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000);
    });
    expect(
      fetchMock.mock.calls.filter(([url]) => url === "/api/v1/memory/status"),
    ).toHaveLength(polls);
  });
  it("creates a new memory and sends protection and settings changes", async () => {
    await openDetail();
    fireEvent.click(await screen.findByRole("button", { name: "profile.md" }));
    fireEvent.click(screen.getByLabelText("保护（仅限制后台整理）"));
    await waitFor(() =>
      expect(screen.getByLabelText("保护（仅限制后台整理）")).toBeChecked(),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/memory/protect",
      expect.objectContaining({
        body: JSON.stringify({ path: "/memories/profile.md", protected: true }),
      }),
    );
    fireEvent.click(screen.getByLabelText("自动整理"));
    await waitFor(() =>
      expect(screen.getByLabelText("自动整理")).not.toBeChecked(),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/memory/settings",
      expect.objectContaining({ body: JSON.stringify({ autoDream: false }) }),
    );
    fireEvent.click(screen.getByRole("button", { name: "+ 新建记忆" }));
    fireEvent.change(screen.getByLabelText("路径"), {
      target: { value: "/memories/new.md" },
    });
    fireEvent.change(screen.getByLabelText("内容"), {
      target: { value: "New fact" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await screen.findByText(/保存已排队/);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/memory/entry",
      expect.objectContaining({
        body: JSON.stringify({ path: "/memories/new.md", content: "New fact" }),
      }),
    );
  });
  it("queues deletion and clears the editor after completion", async () => {
    await openDetail();
    fireEvent.click(await screen.findByRole("button", { name: "profile.md" }));
    vi.useFakeTimers();
    fireEvent.click(screen.getByRole("button", { name: "删除" }));
    await act(async () => {});
    expect(screen.getByText(/删除已排队，尚未删除/)).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/memory/entry",
      expect.objectContaining({ method: "DELETE" }),
    );
    currentState = { ...state, run: { ...queued.run, stage: "completed" } };
    entries = [{ path: "/resources/README.md", content: "Resources" }];
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(screen.getByText("记忆已删除。")).toBeInTheDocument();
    expect(screen.getByText(/选择记忆条目后查看或编辑/)).toBeInTheDocument();
  });
  it("shows a conflict without claiming that a save was accepted", async () => {
    await openDetail();
    fireEvent.click(await screen.findByRole("button", { name: "profile.md" }));
    failure = { status: 409, code: "MEMORY_CONFLICT" };
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      /已变更.*重新加载/,
    );
    expect(screen.queryByText(/保存已排队/)).not.toBeInTheDocument();
  });
  it("offers repair while memory is stuck and resumes after recovery", async () => {
    currentState = {
      ...state,
      status: "repairing",
      run: {
        kind: "dream",
        stage: "修复中",
        error: "Memory operation failed. Reload or contact support.",
        before: null,
        after: null,
      },
    };
    await openDetail();
    // The stuck store stays readable; only editing is gated on the repair.
    expect(screen.getByText("路径浏览")).toBeInTheDocument();
    expect(screen.getByText("修复中")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "修复" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "修复" }));
    expect(await screen.findByText(/已接受修复请求/)).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/memory/recover",
      expect.objectContaining({ method: "POST" }),
    );
    failure = null;
    currentState = {
      ...state,
      run: { ...queued.run, kind: "dream", stage: "completed" },
    };
    fireEvent.click(screen.getByRole("button", { name: "刷新" }));
    expect(
      await screen.findByRole("button", { name: "profile.md" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "修复" })).toBeNull();
  });
  it("reports a store that was never provisioned as unavailable", async () => {
    currentState = { ...state, status: "provisioning", run: null };
    failure = { status: 409, code: "MEMORY_BUSY", path: "/api/v1/memory" };
    open("/context/store");
    expect(
      await screen.findByText("记忆正在处理中，请等待当前操作完成。"),
    ).toBeInTheDocument();
    expect(screen.getByText("个人记忆暂不可用")).toBeInTheDocument();
  });
  it("handles initial auth failures through the existing sign-in flow", async () => {
    failure = { status: 401, code: "AUTH_REQUIRED" };
    open();
    expect(
      await screen.findByRole("heading", { name: "登录你的工作区" }),
    ).toBeInTheDocument();
  });
  it("handles polling auth failures and stops exposing the page", async () => {
    await openDetail();
    fireEvent.click(await screen.findByRole("button", { name: "profile.md" }));
    vi.useFakeTimers();
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await act(async () => {});
    failure = { status: 401, code: "AUTH_REQUIRED" };
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(
      screen.getByRole("heading", { name: "登录你的工作区" }),
    ).toBeInTheDocument();
  });
  it("waits for a delayed completion refresh before reporting saved", async () => {
    await openDetail();
    fireEvent.click(await screen.findByRole("button", { name: "profile.md" }));
    vi.useFakeTimers();
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await act(async () => {});
    currentState = { ...state, run: { ...queued.run, stage: "completed" } };
    fetchMock.mockImplementationOnce(async () => Response.json(currentState));
    let resolveList!: (response: Response) => void;
    fetchMock.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          resolveList = resolve;
        }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(screen.getByText(/尚未保存/)).toBeInTheDocument();
    await act(async () => {
      resolveList(
        Response.json({
          entries,
          capacity,
          state: currentState,
          store: currentStore,
          sessionCount,
        }),
      );
    });
    expect(screen.getByText("记忆已保存。")).toBeInTheDocument();
  });

  it("blocks an unversioned save and re-reads instead of writing", async () => {
    entries = [{ path: "/memories/profile.md", content: "Profile" }];
    await openDetail();
    fireEvent.click(await screen.findByRole("button", { name: "profile.md" }));
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    // No versioned write may leave the browser: the page re-reads instead.
    expect(await screen.findByText(/缺少版本信息/)).toBeInTheDocument();
    expect(
      fetchMock.mock.calls.filter(
        ([url, init]) =>
          url === "/api/v1/memory/entry" && init?.method === "POST",
      ),
    ).toHaveLength(0);
    // The re-read keeps the draft and, with the hash restored, saving works.
    expect(screen.getByLabelText("内容")).toHaveValue("Profile");
    entries = [
      { path: "/memories/profile.md", content: "Profile", hash: "hash-v2" },
    ];
    // Second save attempt triggers the re-read that restores the base; the
    // draft was byte-identical, so the third attempt writes with a version.
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(screen.queryByText(/缺少版本信息/)).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await screen.findByText(/保存已排队/);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/memory/entry",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          path: "/memories/profile.md",
          content: "Profile",
          expectedHash: "hash-v2",
        }),
      }),
    );
  });

  it("keeps the draft on a version conflict instead of resubmitting", async () => {
    await openDetail();
    fireEvent.click(await screen.findByRole("button", { name: "profile.md" }));
    fireEvent.change(screen.getByLabelText("内容"), {
      target: { value: "My concurrent edit" },
    });
    failure = { status: 409, code: "MEMORY_CONFLICT" };
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /已变更.*重新加载/,
    );
    // The failed save keeps the user's draft verbatim and never retries with
    // a fresh hash behind their back.
    expect(screen.getByLabelText("内容")).toHaveValue("My concurrent edit");
    expect(
      fetchMock.mock.calls.filter(
        ([url, init]) =>
          url === "/api/v1/memory/entry" && init?.method === "POST",
      ),
    ).toHaveLength(1);
  });

  it("never renders a previous account's cached memory after switching accounts", async () => {
    await openDetail();
    expect(screen.getByText(currentStore.id)).toBeInTheDocument();

    // Account A signs out; the cache entry bound to A must go with it.
    fireEvent.click(screen.getByRole("button", { name: "账号：a" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /退出登录/ }));
    expect(
      await screen.findByRole("heading", {
        name: "登录你的工作区",
      }),
    ).toBeInTheDocument();

    // Account B signs in on the same tab while B's own list request is held.
    currentUser = { userId: "B", authSubject: "local:b", role: "user" };
    currentStore = {
      id: "memstore-b-account",
      updatedAt: "2026-10-11T09:00:00Z",
    };
    entries = [
      { path: "/memories/b-note.md", content: "B note", hash: "hash-b-1" },
    ];
    holdMemoryList = new Promise<void>((resolve) => {
      releaseMemoryList = resolve;
    });
    fireEvent.change(screen.getByLabelText("邮箱"), {
      target: { value: "b@example.com" },
    });
    fireEvent.change(screen.getByLabelText("密码"), {
      target: { value: "password123" },
    });
    fireEvent.click(screen.getByRole("button", { name: "登录" }));

    // B lands on the store detail; while B's request is pending, nothing from
    // A's account may render — not A's store id, entries, or paths.
    await screen.findByRole("status", { name: "正在加载记忆" });
    expect(screen.queryByText("memstore-20261010143827-obuom")).toBeNull();
    expect(screen.queryByText("profile.md")).toBeNull();
    releaseMemoryList?.();
    holdMemoryList = null;
    expect(
      await screen.findByRole("button", { name: "b-note.md" }),
    ).toBeInTheDocument();
    expect(screen.getByText("memstore-b-account")).toBeInTheDocument();
  });
});
