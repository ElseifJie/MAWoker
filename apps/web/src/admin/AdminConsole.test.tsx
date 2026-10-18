// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  act,
  fireEvent,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { AdminWorkspace } from "./AdminWorkspace.js";

const stylesCss = readFileSync(
  resolve(
    process.cwd(),
    process.cwd().endsWith("apps/web")
      ? "src/styles.css"
      : "apps/web/src/styles.css",
  ),
  "utf8",
);

const adminId = "00000000-0000-4000-8000-0000000000aa";
const userId = "00000000-0000-4000-8000-0000000000bb";
const agentId = "00000000-0000-4000-8000-0000000000cc";

const quota = {
  personalAgentLimit: 10,
  concurrentSessionLimit: 2,
  dailySessionLimit: 25,
  monthlyTokenLimit: 100_000,
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function errorBody(code: string, status: number) {
  return json(
    {
      error: {
        code,
        message: "Upstream failure",
        requestId: "req-1",
        retryable: false,
      },
    },
    status,
  );
}

function requestUrl(input: RequestInfo | URL) {
  return new URL(String(input), "http://localhost");
}

const usersFixture = [
  {
    id: adminId,
    email: "admin@example.com",
    role: "admin",
    status: "active",
    hasPassword: true,
    defaultAgentId: null,
    createdAt: "2026-09-01T00:00:00.000Z",
    quota,
  },
  {
    id: userId,
    email: "user@example.com",
    role: "user",
    status: "active",
    hasPassword: true,
    defaultAgentId: agentId,
    createdAt: "2026-09-02T00:00:00.000Z",
    quota,
  },
];

const detailFixture = () => ({
  id: userId,
  email: "user@example.com",
  role: "user",
  status: "active",
  hasPassword: true,
  defaultAgentId: agentId,
  createdAt: "2026-09-02T00:00:00.000Z",
  updatedAt: "2026-09-02T00:00:00.000Z",
  quota,
  inherited: {
    personalAgentLimit: false,
    concurrentSessionLimit: false,
    dailySessionLimit: false,
    monthlyTokenLimit: false,
  },
  usage: {
    personalAgents: 3,
    concurrentSessions: 1,
    dailySessions: 5,
    inputTokens: 40_000,
    outputTokens: 35_000,
    tokens: 75_000,
    runtimeMs: 120_000,
    toolCalls: 26,
  },
  exhausted: {
    personalAgents: false,
    concurrentSessions: false,
    dailySessions: false,
    monthlyTokens: false,
  },
  period: {
    startsAt: "2026-09-01T00:00:00.000Z",
    endsAt: "2026-10-01T00:00:00.000Z",
  },
});

const overviewFixture = () => ({
  period: {
    startsAt: "2026-09-01T00:00:00.000Z",
    endsAt: "2026-10-01T00:00:00.000Z",
  },
  totals: {
    inputTokens: 40_000,
    outputTokens: 35_000,
    tokens: 75_000,
    activeUsers: 1,
    sessions: 6,
    exhaustedUsers: 1,
  },
  users: [
    {
      userId,
      email: "user@example.com",
      role: "user",
      status: "active",
      quota,
      usage: {
        personalAgents: 3,
        concurrentSessions: 1,
        dailySessions: 5,
        inputTokens: 40_000,
        outputTokens: 35_000,
        tokens: 75_000,
        toolCalls: 26,
      },
      dimensionStatus: {
        personalAgents: "near",
        concurrentSessions: "ok",
        dailySessions: "ok",
        monthlyTokens: "exhausted",
      },
    },
  ],
});

const agentsUsageFixture = {
  platform: [
    {
      platformAgentId: agentId,
      name: "Research assistant",
      status: "active",
      defaultAssignments: 1,
      inputTokens: 40_000,
      outputTokens: 35_000,
      tokens: 75_000,
    },
  ],
  personal: { personalAgents: 3, tokens: 75_000 },
};

const auditFixture = {
  entries: [
    {
      id: "00000000-0000-4000-8000-0000000000d1",
      actorUserId: adminId,
      actorEmail: "admin@example.com",
      ownerUserId: userId,
      ownerEmail: "user@example.com",
      action: "user.status.update",
      resourceType: "user",
      resourceId: userId,
      result: "succeeded",
      errorCode: null,
      requestId: "req-9",
      arkRequestId: null,
      metadata: { from: "active", to: "disabled" },
      createdAt: "2026-09-10T08:00:00.000Z",
    },
  ],
};

const sessionsFixture = {
  sessions: [
    {
      id: "00000000-0000-4000-8000-0000000000e1",
      title: "Quarterly report",
      status: "idle",
      agentKind: "platform",
      agentName: "Research assistant",
      agentVersion: "3",
      createdAt: "2026-09-09T10:00:00.000Z",
      lastEventAt: "2026-09-09T11:00:00.000Z",
      archivedAt: null,
      deletionState: "none",
      tokens: 75_000,
    },
  ],
};

function createBackend() {
  const users = structuredClone(usersFixture);
  const calls: Array<{ method: string; url: string; body: unknown }> = [];
  const fetchMock = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestUrl(input);
      const path = url.pathname;
      const method = init?.method ?? "GET";
      const body =
        typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      calls.push({ method, url: `${path}${url.search}`, body });
      if (path === "/api/v1/me") {
        return json({
          user: { userId: adminId, authSubject: "local:admin", role: "admin" },
        });
      }
      if (path === "/api/v1/auth/logout")
        return new Response(null, { status: 204 });
      if (path === "/api/v1/admin/platform-agents") {
        return json({
          agents: [
            {
              id: agentId,
              name: "Research assistant",
              description: "",
              modelId: "model-a",
              systemPrompt: "",
              arkVersion: "3",
              status: "active",
              lastErrorCode: null,
            },
          ],
        });
      }
      if (path === "/api/v1/capabilities") {
        return json({
          skills: false,
          mcpServers: false,
          vaults: false,
          memoryStores: false,
          personalAgentModels: ["model-a"],
        });
      }
      if (path === "/api/v1/admin/users" && method === "GET") {
        return json({ users });
      }
      if (path === `/api/v1/admin/users/${userId}` && method === "GET") {
        return json(detailFixture());
      }
      if (path.endsWith("/status") && method === "PATCH") {
        if ((body as { status: string }).status === "disabled") {
          const target = users.find((entry) => entry.id === userId)!;
          target.status = "disabled";
        } else {
          users.find((entry) => entry.id === userId)!.status = "active";
        }
        return json({
          status: (body as { status: string }).status,
          revokedSessions: 2,
        });
      }
      if (path.endsWith("/role") && method === "PATCH") {
        return json({
          role: (body as { role: string }).role,
          revokedSessions: 0,
        });
      }
      if (path.endsWith("/sessions/revoke") && method === "POST") {
        return json({ revokedSessions: 3 });
      }
      if (
        path === `/api/v1/admin/users/${userId}/sessions` &&
        method === "GET"
      ) {
        return json(sessionsFixture);
      }
      if (path === `/api/v1/admin/users/${userId}/audit` && method === "GET") {
        return json(auditFixture);
      }
      if (path === "/api/v1/admin/audit-logs") {
        return json(auditFixture);
      }
      if (path === "/api/v1/admin/usage/overview") {
        return json(overviewFixture());
      }
      if (path === "/api/v1/admin/usage/agents") {
        return json(agentsUsageFixture);
      }
      if (path === "/api/v1/admin/quota-policy" && method === "GET") {
        return json({
          ...quota,
          updatedBy: adminId,
          updatedAt: "2026-09-05T00:00:00.000Z",
        });
      }
      if (path === "/api/v1/admin/quota-policy" && method === "PUT") {
        return json({
          ...(body as typeof quota),
          updatedBy: adminId,
          updatedAt: "2026-09-12T00:00:00.000Z",
        });
      }
      throw new Error(`Unexpected request: ${method} ${path}`);
    },
  );
  return { calls, fetchMock, users };
}

function renderWorkspace(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AdminWorkspace
        user={{ userId: adminId, authSubject: "local:admin", role: "admin" }}
        onSignedOut={() => undefined}
        onAuthRequired={() => undefined}
      />
    </MemoryRouter>,
  );
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
});

afterEach(() => {
  cleanup();
  delete (URL as { createObjectURL?: unknown }).createObjectURL;
  delete (URL as { revokeObjectURL?: unknown }).revokeObjectURL;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("admin console walkthrough", () => {
  it("guides a self-hosted administrator to a personal account and back to login", async () => {
    const { fetchMock } = createBackend();
    vi.stubGlobal("fetch", fetchMock);
    const signedOut = vi.fn();
    render(
      <MemoryRouter initialEntries={["/admin/users"]}>
        <AdminWorkspace
          user={{ userId: adminId, authSubject: "local:admin", role: "admin" }}
          onSignedOut={signedOut}
          onAuthRequired={vi.fn()}
        />
      </MemoryRouter>,
    );
    const guide = await screen.findByRole("region", {
      name: "个人工作区使用指引",
    });
    expect(
      within(guide).getByRole("link", { name: "进入个人工作区" }),
    ).toHaveAttribute("href", "/");
    expect(
      within(guide).getByRole("link", { name: "配置平台助手" }),
    ).toHaveAttribute("href", "/admin/platform-agents");
    expect(
      within(guide).getByRole("link", { name: "管理邀请" }),
    ).toHaveAttribute("href", "/admin/invites");
    expect(
      within(guide).getByText(/管理员账户同样可以使用个人工作区/),
    ).toBeInTheDocument();
    await userEvent
      .setup()
      .click(within(guide).getByRole("button", { name: "退出登录" }));
    await waitFor(() => expect(signedOut).toHaveBeenCalledOnce());
  });

  // The dense row actions live behind the "…" overflow menu.
  async function openRowMenu(
    user: ReturnType<typeof userEvent.setup>,
    rowName: string,
  ) {
    await user.click(
      await screen.findByRole("button", { name: `账号操作：${rowName}` }),
    );
    return screen.getByRole("menu");
  }

  it("confirms account disable and force sign-out before mutating", async () => {
    const { calls, fetchMock } = createBackend();
    vi.stubGlobal("fetch", fetchMock);
    renderWorkspace("/admin/users");
    const user = userEvent.setup();
    await screen.findByText("user@example.com");

    // Force sign-out is only offered while the account is active; it goes
    // through its own confirmation dialog.
    await openRowMenu(user, "user@example.com");
    await user.click(screen.getByRole("menuitem", { name: "强制退出登录" }));
    const signoutDialog = screen.getByRole("dialog", {
      name: "强制退出登录",
    });
    expect(calls.some((call) => call.url.endsWith("/sessions/revoke"))).toBe(
      false,
    );
    await user.click(
      within(signoutDialog).getByRole("button", { name: "强制退出登录" }),
    );
    await waitFor(() =>
      expect(
        calls.filter(
          (call) =>
            call.method === "POST" && call.url.endsWith("/sessions/revoke"),
        ),
      ).toHaveLength(1),
    );

    // Cancel the disable confirmation first — nothing must be sent.
    await openRowMenu(user, "user@example.com");
    await user.click(screen.getByRole("menuitem", { name: "停用" }));
    const dialog = screen.getByRole("dialog", { name: "停用账号" });
    expect(
      within(dialog).getByText(/立即退出该账号的所有登录/),
    ).toBeInTheDocument();
    expect(calls.some((call) => call.url.endsWith("/status"))).toBe(false);
    await user.click(within(dialog).getByRole("button", { name: "取消" }));

    // Confirm — the PATCH lands and the row flips to Enable.
    await openRowMenu(user, "user@example.com");
    await user.click(screen.getByRole("menuitem", { name: "停用" }));
    const confirmDialog = screen.getByRole("dialog", {
      name: "停用账号",
    });
    await user.click(
      within(confirmDialog).getByRole("button", { name: "停用账号" }),
    );
    await waitFor(() =>
      expect(
        calls.find(
          (call) => call.method === "PATCH" && call.url.endsWith("/status"),
        ),
      ).toMatchObject({ body: { status: "disabled" } }),
    );

    // The now-disabled account offers Enable instead.
    await openRowMenu(user, "user@example.com");
    expect(screen.getByRole("menuitem", { name: "启用" })).toBeInTheDocument();
  });

  it("surfaces lifecycle guard errors from the API", async () => {
    const backend = createBackend();
    const original = backend.fetchMock;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = requestUrl(input);
        if (url.pathname.endsWith("/role") && init?.method === "PATCH") {
          return errorBody("LAST_ACTIVE_ADMIN", 409);
        }
        return original(input, init);
      }),
    );
    renderWorkspace("/admin/users");
    const user = userEvent.setup();
    await screen.findByText("user@example.com");
    await openRowMenu(user, "user@example.com");
    await user.click(screen.getByRole("menuitem", { name: /管理员/ }));
    const dialog = screen.getByRole("dialog", { name: "更改角色" });
    await user.click(
      within(dialog).getByRole("button", { name: "授予管理员权限" }),
    );
    expect(
      await within(dialog).findByText(/不能停用或降级最后一位已启用的管理员/),
    ).toBeInTheDocument();
  });

  it("renders the usage overview with statuses, agents, and CSV export", async () => {
    const { fetchMock } = createBackend();
    vi.stubGlobal("fetch", fetchMock);
    const blobs: Blob[] = [];
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: (blob: Blob) => {
        blobs.push(blob);
        return "blob:usage";
      },
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: () => undefined,
    });
    renderWorkspace("/admin/usage");
    const user = userEvent.setup();

    expect(await screen.findByText("本月 Token")).toBeInTheDocument();
    // The stat card and the per-user row agree on the monthly total.
    expect(screen.getAllByText("75K").length).toBeGreaterThanOrEqual(2);
    // Active users and users-at-limit stat cards both read 1.
    expect(screen.getAllByText("1").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText(/2026年9月 \(UTC\)/)).toBeInTheDocument();
    expect(screen.getByText("user@example.com")).toBeInTheDocument();
    expect(screen.getByText("已用尽")).toBeInTheDocument();
    expect(screen.getByText("接近上限")).toBeInTheDocument();
    expect(await screen.findByText("按助手汇总")).toBeInTheDocument();
    expect(screen.getByText("Research assistant")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "导出已加载数据" }));
    expect(blobs).toHaveLength(1);
    const csv = await blobs[0]!.text();
    expect(csv.split("\n")[0]).toBe(
      "email,role,status,personal_agents,personal_agent_limit,concurrent_sessions,concurrent_session_limit,daily_sessions,daily_session_limit,input_tokens,output_tokens,tokens,monthly_token_limit,tool_calls,token_dimension_status",
    );
    expect(csv).toContain(
      "user@example.com,user,active,3,10,1,2,5,25,40000,35000,75000,100000,26,exhausted",
    );
  });

  it("sends audit filters and renders entries", async () => {
    const { calls, fetchMock } = createBackend();
    vi.stubGlobal("fetch", fetchMock);
    renderWorkspace("/admin/audit");
    const user = userEvent.setup();

    // The action name also appears in the filter options, so anchor on the
    // table itself once entries have loaded.
    const auditTable = await screen.findByRole("table", {
      name: "操作审计记录",
    });
    expect(
      within(auditTable).getByText("user.status.update"),
    ).toBeInTheDocument();
    expect(
      within(auditTable).getByText("admin@example.com"),
    ).toBeInTheDocument();
    expect(
      within(auditTable).getByText("→ user@example.com"),
    ).toBeInTheDocument();
    expect(within(auditTable).getByText("成功")).toBeInTheDocument();

    await user.selectOptions(
      screen.getByLabelText("操作类型"),
      "user_quota.update",
    );
    await user.selectOptions(screen.getByLabelText("结果"), "failed");
    await waitFor(() => {
      const auditCalls = calls.filter((call) =>
        call.url.startsWith("/api/v1/admin/audit-logs"),
      );
      const last = auditCalls.at(-1)!.url;
      expect(last).toContain("action=user_quota.update");
      expect(last).toContain("result=failed");
      expect(last).toContain("since=");
    });
  });

  it("edits the default quota policy from Settings", async () => {
    const { calls, fetchMock } = createBackend();
    vi.stubGlobal("fetch", fetchMock);
    renderWorkspace("/admin/settings");
    const user = userEvent.setup();

    const monthly = await screen.findByLabelText("每月 Token 上限");
    expect(monthly).toHaveValue(100000);
    await user.clear(monthly);
    await user.type(monthly, "200000");
    await user.click(screen.getByRole("button", { name: "保存默认配额" }));

    expect(await screen.findByText("平台默认配额已保存。")).toBeInTheDocument();
    expect(
      calls.find(
        (call) =>
          call.method === "PUT" && call.url === "/api/v1/admin/quota-policy",
      )?.body,
    ).toEqual({
      personalAgentLimit: 10,
      concurrentSessionLimit: 2,
      dailySessionLimit: 25,
      monthlyTokenLimit: 200_000,
    });
  });

  it("navigates account detail tabs and fetches only on demand", async () => {
    const { calls, fetchMock } = createBackend();
    vi.stubGlobal("fetch", fetchMock);
    renderWorkspace(`/admin/users/${userId}`);
    const user = userEvent.setup();

    expect(
      await screen.findByRole("heading", {
        name: "user@example.com",
        level: 1,
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("region", { name: "使用配额" }),
    ).toBeInTheDocument();
    expect(
      calls.some(
        (call) => call.url.includes("/sessions") || call.url.includes("/audit"),
      ),
    ).toBe(false);

    await user.click(screen.getByRole("tab", { name: "用量" }));
    expect(await screen.findByText("Token 用量")).toBeInTheDocument();
    expect(screen.getByText("75K")).toBeInTheDocument();
    expect(screen.getByText("40K")).toBeInTheDocument(); // input tokens
    expect(screen.getByText("26")).toBeInTheDocument(); // tool calls

    await user.click(screen.getByRole("tab", { name: "任务" }));
    expect(await screen.findByText("Quarterly report")).toBeInTheDocument();
    expect(screen.getByText(/仅展示任务元信息/)).toBeInTheDocument();
    expect(
      screen.queryByText("must-not-render-transcript"),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "审计记录" }));
    expect(await screen.findByText("更改账号状态")).toBeInTheDocument();
  });

  it("keeps stat cards responsive and monospace numbers technical", () => {
    // CSS contract: 4 → 2 → 1 column collapse for the stat grid (spec §9.4).
    expect(stylesCss).toMatch(
      /\.admin-stat-grid\s*\{[^}]*grid-template-columns:\s*repeat\(4,\s*minmax\(0,\s*1fr\)\)/,
    );
    expect(stylesCss).toMatch(
      /@media \(max-width: 900px\)\s*\{\s*\.admin-stat-grid\s*\{/,
    );
    expect(
      (stylesCss.match(/\.admin-stat-grid\s*\{/g) ?? []).length,
    ).toBeGreaterThanOrEqual(3);
    expect(stylesCss).toMatch(
      /\.admin-mono\s*\{[^}]*font-family:\s*var\(--ui-font-mono\)/,
    );
  });
});

describe("admin workbench resilience", () => {
  it("keeps account navigation available when platform agents fail", async () => {
    const { fetchMock } = createBackend();
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) =>
        requestUrl(input).pathname === "/api/v1/admin/platform-agents"
          ? Promise.resolve(errorBody("UPSTREAM_UNAVAILABLE", 503))
          : fetchMock(input, init),
      ),
    );
    renderWorkspace("/admin/users");
    expect(await screen.findByText("user@example.com")).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole("link", { name: "设置" }));
    expect(await screen.findByLabelText("每月 Token 上限")).toHaveValue(100000);
  });

  it("clears a status-only account filter from the no-match state", async () => {
    const { fetchMock } = createBackend();
    vi.stubGlobal("fetch", fetchMock);
    renderWorkspace("/admin/users");
    const user = userEvent.setup();
    await screen.findByText("user@example.com");
    await user.selectOptions(screen.getByLabelText("账号状态"), "disabled");
    expect(await screen.findByText("没有匹配的账号")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "清除筛选" }));
    expect(await screen.findByText("user@example.com")).toBeInTheDocument();
  });

  it("retries failed account pagination without losing loaded rows", async () => {
    const { fetchMock } = createBackend();
    let pageAttempts = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = requestUrl(input);
        if (url.pathname === "/api/v1/admin/users") {
          if (!url.searchParams.has("cursor"))
            return Promise.resolve(
              json({ users: usersFixture, nextCursor: "page-2" }),
            );
          pageAttempts++;
          return Promise.resolve(
            pageAttempts === 1
              ? errorBody("UPSTREAM_UNAVAILABLE", 503)
              : json({
                  users: [
                    {
                      ...usersFixture[1],
                      id: "next-user",
                      email: "next@example.com",
                    },
                  ],
                }),
          );
        }
        return fetchMock(input, init);
      }),
    );
    renderWorkspace("/admin/users");
    const user = userEvent.setup();
    await screen.findByText("user@example.com");
    await user.click(screen.getByRole("button", { name: "加载更多" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("加载失败");
    expect(screen.getByText("user@example.com")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "重试加载" }));
    expect(await screen.findByText("next@example.com")).toBeInTheDocument();
    expect(screen.getAllByText("user@example.com")).toHaveLength(1);
  });

  it("switches account tabs with arrow keys and links the active panel", async () => {
    const { fetchMock } = createBackend();
    vi.stubGlobal("fetch", fetchMock);
    renderWorkspace(`/admin/users/${userId}`);
    const user = userEvent.setup();
    const overview = await screen.findByRole("tab", { name: "概览" });
    overview.focus();
    await user.keyboard("{ArrowRight}");
    const usage = screen.getByRole("tab", { name: "用量" });
    expect(usage).toHaveFocus();
    expect(usage).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tabpanel")).toHaveAttribute(
      "aria-labelledby",
      usage.id,
    );
  });

  it("distinguishes temporary account failures from missing accounts and retries", async () => {
    const { fetchMock } = createBackend();
    let attempts = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        if (
          requestUrl(input).pathname === `/api/v1/admin/users/${userId}` &&
          ++attempts === 1
        )
          return Promise.resolve(errorBody("UPSTREAM_UNAVAILABLE", 503));
        return fetchMock(input, init);
      }),
    );
    renderWorkspace(`/admin/users/${userId}`);
    expect(await screen.findByText("账号暂时无法加载")).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole("button", { name: "重试" }));
    expect(
      await screen.findByRole("heading", { name: "user@example.com" }),
    ).toBeInTheDocument();
  });
});

it("does not expire the current page after an abandoned account mutation", async () => {
  const { fetchMock } = createBackend();
  const authRequired = vi.fn();
  let finish!: (response: Response) => void;
  const pending = new Promise<Response>((resolve) => {
    finish = resolve;
  });
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) =>
      requestUrl(input).pathname.endsWith("/sessions/revoke")
        ? pending
        : fetchMock(input, init),
    ),
  );
  render(
    <MemoryRouter initialEntries={["/admin/users"]}>
      <AdminWorkspace
        user={{ userId: adminId, authSubject: "local:admin", role: "admin" }}
        onSignedOut={vi.fn()}
        onAuthRequired={authRequired}
      />
    </MemoryRouter>,
  );
  const user = userEvent.setup();
  await user.click(
    await screen.findByRole("button", { name: "账号操作：user@example.com" }),
  );
  await user.click(screen.getByRole("menuitem", { name: "强制退出登录" }));
  await user.click(
    within(screen.getByRole("dialog")).getByRole("button", {
      name: "强制退出登录",
    }),
  );
  await user.click(screen.getByRole("link", { name: "设置" }));
  await screen.findByLabelText("每月 Token 上限");
  await act(async () => {
    finish(errorBody("AUTH_REQUIRED", 401));
    await pending;
  });
  expect(authRequired).not.toHaveBeenCalled();
  expect(screen.getByLabelText("每月 Token 上限")).toHaveValue(100000);
});

it("restores quota policy inputs without submitting invalid or discarded edits", async () => {
  const { calls, fetchMock } = createBackend();
  vi.stubGlobal("fetch", fetchMock);
  renderWorkspace("/admin/settings");
  const user = userEvent.setup();
  const monthly = await screen.findByLabelText("每月 Token 上限");
  await user.clear(monthly);
  expect(monthly).toHaveAttribute("aria-invalid", "true");
  expect(screen.getByRole("button", { name: "保存默认配额" })).toBeDisabled();
  await user.click(screen.getByRole("button", { name: "撤销修改" }));
  expect(monthly).toHaveValue(100000);
  expect(monthly).not.toHaveAttribute("aria-invalid", "true");
  expect(calls.filter((call) => call.method === "PUT")).toHaveLength(0);
});

it("rejects inverted audit date ranges and recovers after resetting filters", async () => {
  const { calls, fetchMock } = createBackend();
  vi.stubGlobal("fetch", fetchMock);
  renderWorkspace("/admin/audit");
  await screen.findByRole("table", { name: "操作审计记录" });
  act(() => {
    fireEvent.change(screen.getByLabelText("开始日期"), {
      target: { value: "2026-09-14" },
    });
    fireEvent.change(screen.getByLabelText("结束日期"), {
      target: { value: "2026-09-01" },
    });
  });
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "结束日期不能早于开始日期",
  );
  expect(calls.some((call) => call.url.includes("until=2026-09-01"))).toBe(
    false,
  );
  await userEvent
    .setup()
    .click(screen.getByRole("button", { name: "重置筛选" }));
  expect(
    await screen.findByRole("table", { name: "操作审计记录" }),
  ).toBeInTheDocument();
});
