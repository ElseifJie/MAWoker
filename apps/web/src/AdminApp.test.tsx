// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { StrictMode } from "react";
import { App } from "./App.js";

const adminStyles = readFileSync(
  resolve(
    process.cwd(),
    process.cwd().endsWith("apps/web")
      ? "src/styles.css"
      : "apps/web/src/styles.css",
  ),
  "utf8",
);

const agentId = "00000000-0000-4000-8000-000000000001";
const disabledAgentId = "00000000-0000-4000-8000-000000000002";
const userId = "00000000-0000-4000-8000-000000000003";
const longModelId =
  "doubao-enterprise-production-model-identifier-with-a-very-long-region-and-version-suffix";

const platformAgents = {
  agents: [
    {
      id: agentId,
      name: "Research assistant",
      description: "Company research",
      modelId: longModelId,
      systemPrompt: "Use primary sources.",
      arkVersion: "4",
      status: "active",
      lastErrorCode: null,
      arkAgentId: "must-not-render-ark-id",
      apiKey: "must-not-render-api-key",
    },
    {
      id: disabledAgentId,
      name: "Legacy assistant",
      description: "Retired workflow",
      modelId: "model-b",
      systemPrompt: "Use the old workflow.",
      arkVersion: "2",
      status: "disabled",
      lastErrorCode: null,
    },
  ],
};

const adminUsers = {
  users: [
    {
      id: userId,
      email: "user@example.com",
      role: "user",
      status: "active",
      hasPassword: true,
      defaultAgentId: agentId,
      createdAt: "2026-09-01T00:00:00.000Z",
      quota: {
        personalAgentLimit: 10,
        concurrentSessionLimit: 2,
        dailySessionLimit: 25,
        monthlyTokenLimit: 100_000,
      },
      authSubject: "must-not-render",
      sessions: [{ title: "must-not-render" }],
      artifacts: [{ name: "must-not-render.txt" }],
    },
  ],
};

const zeroUsage = {
  personalAgents: 0,
  concurrentSessions: 0,
  dailySessions: 0,
  inputTokens: 0,
  outputTokens: 0,
  tokens: 0,
  runtimeMs: 0,
  toolCalls: 0,
};

const noDimensionsExhausted = {
  personalAgents: false,
  concurrentSessions: false,
  dailySessions: false,
  monthlyTokens: false,
};

const adminUserDetail = () => ({
  id: userId,
  email: "user@example.com",
  role: "user",
  status: "active",
  hasPassword: true,
  defaultAgentId: agentId,
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
  quota: adminUsers.users[0]!.quota,
  inherited: {
    personalAgentLimit: false,
    concurrentSessionLimit: false,
    dailySessionLimit: false,
    monthlyTokenLimit: false,
  },
  usage: zeroUsage,
  exhausted: noDimensionsExhausted,
  period: {
    startsAt: "2026-09-01T00:00:00.000Z",
    endsAt: "2026-10-01T00:00:00.000Z",
  },
  authSubject: "must-not-render",
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function requestPath(input: RequestInfo | URL) {
  return new URL(String(input), "http://localhost").pathname;
}

function adminHandler() {
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = requestPath(input);
    const method = init?.method ?? "GET";
    if (path === "/api/v1/me") {
      return json({
        user: {
          userId: "admin-1",
          authSubject: "managed:admin@example.com",
          role: "admin",
        },
      });
    }
    if (path === "/api/v1/admin/platform-agents") {
      return json(platformAgents);
    }
    if (path === "/api/v1/admin/users" && method === "GET") {
      return json(adminUsers);
    }
    if (path === `/api/v1/admin/users/${userId}` && method === "GET") {
      return json(adminUserDetail());
    }
    if (path === "/api/v1/agents") {
      return json({
        agents: [
          {
            id: "00000000-0000-4000-8000-000000000010",
            name: "Research assistant",
            description: "Company research",
            modelId: "model-a",
            version: "1",
            status: "active",
            kind: "platform",
            editable: false,
          },
        ],
        selection: {
          agentId: "00000000-0000-4000-8000-000000000010",
          source: "default",
        },
        blocker: null,
      });
    }
    if (path === "/api/v1/sessions") return json({ sessions: [] });
    if (path === "/api/v1/usage") {
      return json({
        period: {
          startsAt: "2026-09-01T00:00:00.000Z",
          endsAt: "2026-10-01T00:00:00.000Z",
        },
        quota: adminUsers.users[0]!.quota,
        usage: {
          personalAgents: 0,
          concurrentSessions: 0,
          dailySessions: 0,
          inputTokens: 0,
          outputTokens: 0,
          tokens: 0,
          runtimeMs: 0,
          toolCalls: 0,
        },
        exhausted: {
          personalAgents: false,
          concurrentSessions: false,
          dailySessions: false,
          monthlyTokens: false,
        },
      });
    }
    if (path === "/api/v1/capabilities") {
      return json({
        skills: { available: false },
        mcpServers: { available: false },
        vaults: { available: false },
        memoryStores: { available: false },
        personalAgentModels: [longModelId, "model-a", "model-b", "model-c"],
      });
    }
    if (path === "/api/v1/admin/quota-policy") {
      return json({
        ...adminUsers.users[0]!.quota,
        updatedBy: null,
        updatedAt: "2026-09-01T00:00:00.000Z",
      });
    }
    if (path === "/api/v1/admin/usage/overview") {
      return json({
        period: {
          startsAt: "2026-09-01T00:00:00.000Z",
          endsAt: "2026-10-01T00:00:00.000Z",
        },
        totals: {
          inputTokens: 0,
          outputTokens: 0,
          tokens: 0,
          activeUsers: 0,
          sessions: 0,
          exhaustedUsers: 0,
        },
        users: [],
      });
    }
    if (path === "/api/v1/admin/usage/agents") {
      return json({ platform: [], personal: { personalAgents: 0, tokens: 0 } });
    }
    if (path === "/api/v1/admin/audit-logs") {
      return json({ entries: [] });
    }
    throw new Error(`Unexpected request: ${path}`);
  };
}

function userHandler() {
  return async (input: RequestInfo | URL) => {
    const url = new URL(String(input), "http://localhost");
    if (url.pathname === "/api/v1/me") {
      return json({
        user: {
          userId: userId,
          authSubject: "managed:user@example.com",
          role: "user",
        },
      });
    }
    if (url.pathname === "/api/v1/agents") {
      return json({ agents: [], selection: null, blocker: null });
    }
    if (url.pathname === "/api/v1/sessions") return json({ sessions: [] });
    if (url.pathname === "/api/v1/capabilities") {
      return json({
        skills: { available: false },
        mcpServers: { available: false },
        vaults: { available: false },
        memoryStores: { available: false },
        personalAgentModels: ["model-a"],
      });
    }
    if (url.pathname === "/api/v1/usage") {
      return json({
        period: {
          startsAt: "2026-09-01T00:00:00.000Z",
          endsAt: "2026-10-01T00:00:00.000Z",
        },
        quota: adminUsers.users[0]!.quota,
        usage: {
          personalAgents: 0,
          concurrentSessions: 0,
          dailySessions: 0,
          inputTokens: 0,
          outputTokens: 0,
          tokens: 0,
          runtimeMs: 0,
          toolCalls: 0,
        },
        exhausted: {
          personalAgents: false,
          concurrentSessions: false,
          dailySessions: false,
          monthlyTokens: false,
        },
      });
    }
    throw new Error(`Unexpected request: ${url.pathname}`);
  };
}

function renderApp(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );
}

function setMobileViewport(matches: boolean) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      matches,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  );
}

beforeEach(() => {
  setMobileViewport(false);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("administrator role routing", () => {
  it("renders an isolated admin shell and fetches no user-content resources", async () => {
    vi.stubGlobal("fetch", vi.fn(adminHandler()));

    renderApp("/admin/users");

    expect(
      await screen.findByRole("heading", { name: "用户管理" }),
    ).toBeInTheDocument();
    await screen.findByText("user@example.com");
    expect(document.querySelector(".ui-app-shell")).toBeInTheDocument();
    const navigation = screen.getByRole("navigation", {
      name: "管理工作台",
    });
    expect(
      within(navigation).getByRole("link", { name: "助手管理" }),
    ).toBeInTheDocument();
    expect(
      within(navigation).getByRole("link", { name: "用户管理" }),
    ).toBeInTheDocument();
    for (const name of ["新任务", "我的文件", "历史任务"]) {
      expect(
        within(navigation).queryByRole("link", { name }),
      ).not.toBeInTheDocument();
    }

    const requestedPaths = vi
      .mocked(fetch)
      .mock.calls.map(([input]) => requestPath(input));
    expect(requestedPaths).toEqual([
      "/api/v1/me",
      "/api/v1/admin/platform-agents",
      "/api/v1/admin/users",
    ]);
    expect(requestedPaths).not.toContain("/api/v1/sessions");
    expect(requestedPaths).not.toContain("/api/v1/artifacts");
    expect(requestedPaths).not.toContain("/api/v1/uploads");
  });

  it("keeps the personal workspace for administrators and links to the admin console", async () => {
    vi.stubGlobal("fetch", vi.fn(adminHandler()));
    renderApp("/");
    const user = userEvent.setup();

    expect(
      await screen.findByRole("heading", { name: "新任务" }),
    ).toBeInTheDocument();
    const navigation = screen.getByRole("navigation", { name: "工作区" });
    const adminLink = within(navigation).getByRole("link", {
      name: "管理后台",
    });
    expect(adminLink).toHaveAttribute("href", "/admin");

    await user.click(adminLink);

    expect(
      await screen.findByRole("heading", { name: "用户管理" }),
    ).toBeInTheDocument();
    const adminNavigation = screen.getByRole("navigation", {
      name: "管理工作台",
    });
    expect(
      within(adminNavigation).getByRole("link", { name: "个人工作区" }),
    ).toHaveAttribute("href", "/");
  });

  it("never renders or requests admin resources for an ordinary user", async () => {
    vi.stubGlobal("fetch", vi.fn(userHandler()));

    renderApp("/admin/users");

    expect(
      await screen.findByRole("heading", { name: "新任务" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("navigation", { name: "管理工作台" }),
    ).not.toBeInTheDocument();
    expect(
      vi
        .mocked(fetch)
        .mock.calls.some(([input]) =>
          requestPath(input).startsWith("/api/v1/admin/"),
        ),
    ).toBe(false);
  });

  it("renders only minimized user summaries in the admin users view", async () => {
    vi.stubGlobal("fetch", vi.fn(adminHandler()));

    renderApp("/admin/users");

    expect(
      await screen.findByRole("heading", { name: "用户管理" }),
    ).toBeInTheDocument();
    expect(await screen.findByText("user@example.com")).toBeInTheDocument();
    expect(screen.getByText("Research assistant")).toBeInTheDocument();
    expect(screen.queryByText("must-not-render")).not.toBeInTheDocument();
    expect(screen.queryByText("must-not-render.txt")).not.toBeInTheDocument();
    expect(
      screen.queryByText("must-not-render-ark-id"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("must-not-render-api-key"),
    ).not.toBeInTheDocument();
  });

  it("groups the account detail into visible management sections", async () => {
    vi.stubGlobal("fetch", vi.fn(adminHandler()));

    renderApp(`/admin/users/${userId}`);

    await screen.findByRole("heading", {
      name: "user@example.com",
      level: 1,
    });
    expect(
      screen.getByRole("region", { name: "账号信息" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("region", { name: "使用配额" }),
    ).toBeInTheDocument();
    expect(
      screen.getByLabelText("user@example.com 的默认助手"),
    ).toBeInTheDocument();
    expect(
      screen.getByLabelText("user@example.com 的每月 Token 上限"),
    ).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "任务" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "审计记录" })).toBeInTheDocument();
  });

  it("orders the account heading before its subordinate management groups", async () => {
    vi.stubGlobal("fetch", vi.fn(adminHandler()));

    renderApp(`/admin/users/${userId}`);

    await screen.findByRole("heading", {
      name: "user@example.com",
      level: 1,
    });
    const page = document.querySelector(".admin-page");
    expect(page).not.toBeNull();
    expect(
      Array.from(page!.querySelectorAll("h1, h2, h3")).map(
        (heading) => `${heading.tagName}:${heading.textContent}`,
      ),
    ).toEqual([
      "H1:user@example.com",
      "H2:账号信息",
      "H3:默认助手",
      "H2:使用配额",
      "H2:账号操作",
    ]);
  });

  it("keeps the mobile admin drawer out of the tab order while closed", async () => {
    setMobileViewport(true);
    vi.stubGlobal("fetch", vi.fn(adminHandler()));

    renderApp("/admin/platform-agents");
    const user = userEvent.setup();
    await screen.findByRole("heading", { name: "助手管理" });
    const sidebar = screen.getByRole("complementary", { hidden: true });
    const menu = screen.getByRole("button", {
      name: "打开管理导航",
    });

    expect(sidebar.id).not.toBe("");
    expect(sidebar).toHaveAttribute("aria-hidden", "true");
    expect(sidebar).toHaveAttribute("inert");
    expect(menu).toHaveAttribute("aria-controls", sidebar.id);
    expect(menu).toHaveAttribute("aria-expanded", "false");
    await user.tab();
    expect(menu).toHaveFocus();

    await user.click(menu);
    expect(sidebar).not.toHaveAttribute("aria-hidden");
    expect(sidebar).not.toHaveAttribute("inert");
    expect(menu).toHaveAttribute("aria-expanded", "true");
    await user.keyboard("{Escape}");
    expect(sidebar).toHaveAttribute("aria-hidden", "true");
    expect(menu).toHaveAttribute("aria-expanded", "false");
  });
});

describe("platform Agent administration", () => {
  it("shows multiple System Agents without mutation controls or provider secrets", async () => {
    const fetchMock = vi.fn(adminHandler());
    vi.stubGlobal("fetch", fetchMock);
    renderApp("/admin/platform-agents");
    const table = await screen.findByRole("table", { name: "平台助手列表" });
    expect(within(table).getByText("Research assistant")).toBeInTheDocument();
    expect(within(table).getByText("Legacy assistant")).toBeInTheDocument();
    expect(within(table).getByText(longModelId).closest("td")).toHaveAttribute(
      "data-label",
      "模型",
    );
    expect(
      screen.getByText(/平台助手通过 .env 中的 SYSTEM_AGENT_IDS 配置/),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "New platform Agent" }),
    ).not.toBeInTheDocument();
    expect(within(table).queryByRole("button")).not.toBeInTheDocument();
    expect(
      screen.queryByText("must-not-render-ark-id"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("must-not-render-api-key"),
    ).not.toBeInTheDocument();
    expect(
      fetchMock.mock.calls.every(
        ([, init]) => !init?.method || init.method === "GET",
      ),
    ).toBe(true);
  });

  it.each([
    "/admin/platform-agents/new",
    `/admin/platform-agents/${agentId}/edit`,
  ])(
    "redirects obsolete editor route %s to the read-only list",
    async (path) => {
      vi.stubGlobal("fetch", vi.fn(adminHandler()));
      renderApp(path);
      expect(
        await screen.findByRole("table", { name: "平台助手列表" }),
      ).toBeInTheDocument();
      expect(screen.queryByLabelText("Name")).not.toBeInTheDocument();
    },
  );

  it("shows an empty state when no System Agents are configured", async () => {
    const base = adminHandler();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
        requestPath(input) === "/api/v1/admin/platform-agents"
          ? json({ agents: [] })
          : base(input, init),
      ),
    );
    renderApp("/admin/platform-agents");
    expect(await screen.findByText("还没有配置平台助手")).toBeInTheDocument();
  });

  it("switches Platform Agents to labeled records before the 1024px table overflows", () => {
    const tableRule = adminStyles.indexOf(".admin-agent-table.ui-data-table");
    const mediaRule = adminStyles.lastIndexOf("@media", tableRule);
    expect(
      adminStyles.slice(mediaRule, adminStyles.indexOf("{", mediaRule)),
    ).toContain("max-width: 1240px");
  });
});

describe("user administration", () => {
  function detailStateHandler(
    overrides: {
      users?: typeof adminUsers.users;
      detail?: Partial<ReturnType<typeof adminUserDetail>>;
      onDefaultAgent?: (platformAgentId: string) => void;
      onQuota?: (
        body: Partial<Record<string, number | null>> | undefined,
      ) => void;
    } = {},
  ) {
    const users = overrides.users ?? structuredClone(adminUsers.users);
    const detail = {
      ...adminUserDetail(),
      ...overrides.detail,
    };
    const calls: Array<{ method: string; path: string; body: unknown }> = [];
    const base = adminHandler();
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = requestPath(input);
        const method = init?.method ?? "GET";
        const body =
          typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
        calls.push({ method, path, body });
        if (path === "/api/v1/admin/users" && method === "GET") {
          return json({ users });
        }
        if (path === `/api/v1/admin/users/${userId}` && method === "GET") {
          return json(detail);
        }
        if (
          path === `/api/v1/admin/users/${userId}/default-agent` &&
          method === "PUT"
        ) {
          const platformAgentId = (body as { platformAgentId: string })
            .platformAgentId;
          detail.defaultAgentId = platformAgentId;
          users[0]!.defaultAgentId = platformAgentId;
          overrides.onDefaultAgent?.(platformAgentId);
          return json({
            userId,
            platformAgentId,
            assignedAt: "2026-09-07T10:00:00.000Z",
          });
        }
        if (
          path === `/api/v1/admin/users/${userId}/quota` &&
          method === "PUT"
        ) {
          const values = body as Record<string, number | null>;
          detail.quota = {
            personalAgentLimit:
              values.personalAgentLimit ?? detail.quota.personalAgentLimit,
            concurrentSessionLimit:
              values.concurrentSessionLimit ??
              detail.quota.concurrentSessionLimit,
            dailySessionLimit:
              values.dailySessionLimit ?? detail.quota.dailySessionLimit,
            monthlyTokenLimit:
              values.monthlyTokenLimit ?? detail.quota.monthlyTokenLimit,
          };
          detail.inherited = {
            personalAgentLimit: values.personalAgentLimit == null,
            concurrentSessionLimit: values.concurrentSessionLimit == null,
            dailySessionLimit: values.dailySessionLimit == null,
            monthlyTokenLimit: values.monthlyTokenLimit == null,
          };
          overrides.onQuota?.(values);
          return json({ userId, ...detail.quota, inherited: detail.inherited });
        }
        return base(input, init);
      },
    );
    return { calls, fetchMock };
  }

  it("reserves both user save button loading icon slots while idle", async () => {
    vi.stubGlobal("fetch", vi.fn(adminHandler()));

    renderApp(`/admin/users/${userId}`);

    await screen.findByRole("heading", {
      name: "user@example.com",
      level: 1,
    });
    const saveButtons = [
      screen.getByRole("button", {
        name: "保存 user@example.com 的默认助手",
      }),
      screen.getByRole("button", {
        name: "保存 user@example.com 的配额",
      }),
    ];
    for (const button of saveButtons) {
      expect(button.querySelector(".admin-loading-icon-slot")).toHaveAttribute(
        "aria-hidden",
        "true",
      );
    }
  });

  it("preserves a quota draft when the Default Agent is saved", async () => {
    const { fetchMock } = detailStateHandler({
      detail: { defaultAgentId: null },
    });
    vi.stubGlobal("fetch", fetchMock);

    renderApp(`/admin/users/${userId}`);
    const user = userEvent.setup();
    const quotaInput = await screen.findByLabelText(
      "user@example.com 的个人助手上限",
    );
    await user.clear(quotaInput);
    await user.type(quotaInput, "77");
    await user.selectOptions(
      screen.getByLabelText("user@example.com 的默认助手"),
      agentId,
    );
    const saveDefaultAgent = screen.getByRole("button", {
      name: "保存 user@example.com 的默认助手",
    });
    await user.click(saveDefaultAgent);

    expect(await screen.findByText("默认助手已保存。")).toBeInTheDocument();
    expect(quotaInput).toHaveValue(77);
    expect(saveDefaultAgent).toBeDisabled();
  });

  it("preserves a Default Agent draft when quotas are saved", async () => {
    const agents = structuredClone(platformAgents.agents);
    agents[1]!.status = "active";
    const { fetchMock } = detailStateHandler();
    const base = fetchMock;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = requestPath(input);
        if (path === "/api/v1/admin/platform-agents") {
          return json({ agents });
        }
        return base(input, init);
      }),
    );

    renderApp(`/admin/users/${userId}`);
    const user = userEvent.setup();
    const agentSelect = await screen.findByLabelText(
      "user@example.com 的默认助手",
    );
    await user.selectOptions(agentSelect, disabledAgentId);
    const quotaInput = screen.getByLabelText("user@example.com 的个人助手上限");
    await user.clear(quotaInput);
    await user.type(quotaInput, "78");
    await user.click(
      screen.getByRole("button", {
        name: "保存 user@example.com 的配额",
      }),
    );

    expect(await screen.findByText("配额已保存。")).toBeInTheDocument();
    expect(agentSelect).toHaveValue(disabledAgentId);
    // The refreshed effective value replaces the saved dimension.
    expect(quotaInput).toHaveValue(78);
  });

  it("assigns only active platform Agents and sends sparse quota overrides", async () => {
    const agents = structuredClone(platformAgents.agents);
    const { calls, fetchMock } = detailStateHandler({
      detail: { defaultAgentId: null },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = requestPath(input);
        if (path === "/api/v1/admin/platform-agents") {
          return json({ agents });
        }
        return fetchMock(input, init);
      }),
    );

    renderApp(`/admin/users/${userId}`);
    const user = userEvent.setup();
    await screen.findByRole("heading", {
      name: "user@example.com",
      level: 1,
    });

    const agentSelect = screen.getByLabelText("user@example.com 的默认助手");
    expect(
      within(agentSelect).getByRole("option", { name: "Legacy assistant" }),
    ).toBeDisabled();
    await user.selectOptions(agentSelect, agentId);
    await user.click(
      screen.getByRole("button", {
        name: "保存 user@example.com 的默认助手",
      }),
    );
    expect(await screen.findByText("默认助手已保存。")).toBeInTheDocument();
    expect(
      calls.filter(
        (call) => call.method === "PUT" && call.path.endsWith("/default-agent"),
      ),
    ).toHaveLength(1);
    expect(calls.some((call) => call.path.endsWith("/quota"))).toBe(false);

    const saveQuotas = screen.getByRole("button", {
      name: "保存 user@example.com 的配额",
    });
    const quotaValues = [
      ["user@example.com 的个人助手上限", "12"],
      ["user@example.com 的同时运行任务上限", "3"],
      ["user@example.com 的每日任务上限", "30"],
      ["user@example.com 的每月 Token 上限", "200000"],
    ] as const;
    for (const [label, value] of quotaValues) {
      const input = screen.getByLabelText(label);
      await user.clear(input);
      await user.type(input, value);
    }
    await user.click(saveQuotas);
    expect(await screen.findByText("配额已保存。")).toBeInTheDocument();
    expect(
      calls.filter(
        (call) => call.method === "PUT" && call.path.endsWith("/quota"),
      ),
    ).toHaveLength(1);
    expect(
      calls.find((call) => call.path.endsWith("/default-agent"))?.body,
    ).toEqual({ platformAgentId: agentId });
    expect(calls.find((call) => call.path.endsWith("/quota"))?.body).toEqual({
      personalAgentLimit: 12,
      concurrentSessionLimit: 3,
      dailySessionLimit: 30,
      monthlyTokenLimit: 200_000,
    });

    // Clearing a dimension back to empty means "inherit the default policy".
    await user.clear(
      screen.getByLabelText("user@example.com 的每月 Token 上限"),
    );
    await user.click(saveQuotas);
    await waitFor(() =>
      expect(
        calls.filter(
          (call) => call.method === "PUT" && call.path.endsWith("/quota"),
        ),
      ).toHaveLength(2),
    );
    const quotaCalls = calls.filter(
      (call) => call.method === "PUT" && call.path.endsWith("/quota"),
    );
    expect(quotaCalls[1]!.body).toEqual({
      personalAgentLimit: 12,
      concurrentSessionLimit: 3,
      dailySessionLimit: 30,
      monthlyTokenLimit: null,
    });
  });
});

describe("user account administration", () => {
  async function createUserHandler() {
    const users = structuredClone(adminUsers.users);
    const calls: Array<{ method: string; path: string; body: unknown }> = [];
    const base = adminHandler();
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = requestPath(input);
        const method = init?.method ?? "GET";
        calls.push({
          method,
          path,
          body:
            typeof init?.body === "string"
              ? (JSON.parse(init.body) as unknown)
              : undefined,
        });
        if (path === "/api/v1/admin/users" && method === "GET") {
          return json({ users });
        }
        if (path === "/api/v1/admin/users" && method === "POST") {
          const body = JSON.parse(String(init?.body)) as {
            email: string;
            role: "user" | "admin";
          };
          users.push({
            id: "00000000-0000-4000-8000-000000000777",
            email: body.email,
            role: body.role,
            status: "active",
            hasPassword: true,
            defaultAgentId: null,
            createdAt: "2026-09-08T00:00:00.000Z",
            quota: adminUsers.users[0]!.quota,
          });
          return json(
            {
              id: "00000000-0000-4000-8000-000000000777",
              email: body.email,
              role: body.role,
              status: "active",
            },
            201,
          );
        }
        if (path.endsWith("/password") && method === "POST") {
          return new Response(null, { status: 204 });
        }
        return base(input);
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    return { calls };
  }

  it("creates an account from the New user dialog and refreshes the list", async () => {
    const { calls } = await createUserHandler();

    renderApp("/admin/users");
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "新建账号" }));

    await user.type(screen.getByLabelText("邮箱"), "Newcomer@Example.com");
    await user.type(screen.getByLabelText("密码"), "newcomer-password");
    await user.type(screen.getByLabelText("确认密码"), "newcomer-password");
    await user.click(screen.getByRole("button", { name: "创建账号" }));

    expect(await screen.findByText("newcomer@example.com")).toBeInTheDocument();
    const createCall = calls.find(
      (call) => call.path === "/api/v1/admin/users" && call.method === "POST",
    );
    expect(createCall?.body).toEqual({
      email: "newcomer@example.com",
      password: "newcomer-password",
      role: "user",
    });
  });

  it("blocks creation until the confirmation matches", async () => {
    const { calls } = await createUserHandler();

    renderApp("/admin/users");
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "新建账号" }));
    await user.type(screen.getByLabelText("邮箱"), "newcomer@example.com");
    await user.type(screen.getByLabelText("密码"), "newcomer-password");
    await user.type(screen.getByLabelText("确认密码"), "different");

    expect(screen.getByRole("button", { name: "创建账号" })).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "创建账号" }));
    expect(calls.some((call) => call.method === "POST")).toBe(false);
  });

  it("resets a password from the account detail", async () => {
    const { calls } = await createUserHandler();

    renderApp(`/admin/users/${userId}`);
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", {
        name: "重置 user@example.com 的密码",
      }),
    );
    await user.type(screen.getByLabelText("新密码"), "rotated-password");
    await user.type(screen.getByLabelText("确认密码"), "rotated-password");
    await user.click(screen.getByRole("button", { name: "重置密码" }));

    expect(await screen.findByText("密码已重置。")).toBeInTheDocument();
    const resetCall = calls.find((call) => call.path.endsWith("/password"));
    expect(resetCall?.path).toBe(`/api/v1/admin/users/${userId}/password`);
    expect(resetCall?.body).toEqual({ password: "rotated-password" });
  });
});

it("renders the real administrator entry point under StrictMode without exposing user content", async () => {
  vi.stubGlobal("fetch", vi.fn(adminHandler()));
  render(
    <StrictMode>
      <MemoryRouter initialEntries={["/admin/users"]}>
        <App />
      </MemoryRouter>
    </StrictMode>,
  );
  const table = await screen.findByRole("table", { name: "用户账号列表" });
  expect(within(table).getAllByText("user@example.com")).toHaveLength(1);
  expect(screen.queryByText("must-not-render")).not.toBeInTheDocument();
  expect(
    vi
      .mocked(fetch)
      .mock.calls.some(([input]) =>
        ["/api/v1/sessions", "/api/v1/artifacts"].includes(requestPath(input)),
      ),
  ).toBe(false);
});
