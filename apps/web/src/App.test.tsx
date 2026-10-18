// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, useLocation } from "react-router-dom";
import { App } from "./App.js";

function readCss(path: string): string {
  return readFileSync(
    resolve(
      process.cwd(),
      process.cwd().endsWith("apps/web") ? path : `apps/web/${path}`,
    ),
    "utf8",
  );
}

const cssFiles = [
  "src/ui/tokens.css",
  "src/ui/components.css",
  "src/ui/layouts.css",
  "src/styles.css",
] as const;

const pageStyles = readCss("src/styles.css");
const tokensCss = readCss("src/ui/tokens.css");
const componentCss = cssFiles
  .filter((path) => path !== "src/ui/tokens.css")
  .map(readCss)
  .join("\n");
const migratedCss = cssFiles.map(readCss).join("\n");

const agentId = "00000000-0000-4000-8000-000000000001";
const uploadId = "00000000-0000-4000-8000-000000000002";
const sessionId = "00000000-0000-4000-8000-000000000003";
const createdSessionId = "00000000-0000-4000-8000-000000000004";
const personalAgentId = "00000000-0000-4000-8000-000000000005";
const artifactId = "00000000-0000-4000-8000-000000000006";
const archivedSessionId = "00000000-0000-4000-8000-000000000009";
const longDocumentMimeType =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

const agentResponse = {
  agents: [
    {
      id: agentId,
      name: "Research assistant",
      description: "Company research",
      modelId: "model-a",
      version: "4",
      status: "active",
      kind: "platform",
      editable: false,
    },
    {
      id: personalAgentId,
      name: "Writing assistant",
      description: "Drafts concise updates",
      modelId: "model-b",
      version: "2",
      status: "active",
      kind: "personal",
      editable: true,
    },
  ],
  selection: { agentId, source: "default" },
  blocker: null,
};

const artifactsResponse = {
  artifacts: [
    {
      id: artifactId,
      sessionId,
      name: "quarterly-plan.pdf",
      mimeType: longDocumentMimeType,
      sizeBytes: 1536,
      generatedAt: "2026-09-07T08:05:00.000Z",
      deletionState: "none",
      error: null,
    },
    {
      id: "00000000-0000-4000-8000-000000000007",
      sessionId: createdSessionId,
      name: "failed-export.csv",
      mimeType: "text/csv",
      sizeBytes: 400,
      generatedAt: "2026-09-07T08:06:00.000Z",
      deletionState: "deletion_failed",
      error: { code: "STORAGE_UNAVAILABLE", retryable: true },
    },
  ],
};

class MockEventSource {
  static instances: MockEventSource[] = [];
  readonly listeners = new Map<string, Set<EventListener>>();
  readonly url: string;
  readonly withCredentials: boolean;
  closed = false;
  onopen: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;

  constructor(url: string | URL, options?: EventSourceInit) {
    this.url = String(url);
    this.withCredentials = options?.withCredentials ?? false;
    MockEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
    const callback =
      typeof listener === "function"
        ? listener
        : (event: Event) => listener.handleEvent(event);
    const listeners = this.listeners.get(type) ?? new Set<EventListener>();
    listeners.add(callback);
    this.listeners.set(type, listeners);
  }

  removeEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
  ) {
    if (typeof listener === "function") {
      this.listeners.get(type)?.delete(listener);
    }
  }

  close() {
    this.closed = true;
  }

  emitOpen() {
    this.onopen?.(new Event("open"));
  }

  emitError() {
    this.onerror?.(new Event("error"));
  }

  emit(type: string, data: unknown, lastEventId = "") {
    const event = new MessageEvent(type, {
      data: JSON.stringify(data),
      lastEventId,
    });
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

const sessionsResponse = {
  sessions: [
    {
      id: sessionId,
      title: "Quarterly plan",
      status: "running",
      error: null,
      deletionState: "none",
      archivedAt: null,
      lastEventAt: "2026-09-07T08:00:00.000Z",
      createdAt: "2026-09-07T07:00:00.000Z",
      updatedAt: "2026-09-07T08:00:00.000Z",
      agent: {
        id: agentId,
        kind: "platform",
        name: "Research assistant",
        version: "4",
      },
    },
  ],
};

const sessionDetail = {
  ...sessionsResponse.sessions[0],
  upstreamReady: true,
  inputs: [
    {
      id: uploadId,
      name: "brief.txt",
      mimeType: "text/plain",
      sizeBytes: 5,
      mountPath: `/mnt/session/inputs/${uploadId}-brief.txt`,
    },
  ],
};

const usageResponse = {
  period: {
    startsAt: "2026-09-01T00:00:00.000Z",
    endsAt: "2026-10-01T00:00:00.000Z",
  },
  quota: {
    personalAgentLimit: 10,
    concurrentSessionLimit: 2,
    dailySessionLimit: 25,
    monthlyTokenLimit: 1000,
  },
  usage: {
    personalAgents: 0,
    concurrentSessions: 1,
    dailySessions: 3,
    inputTokens: 100,
    outputTokens: 50,
    tokens: 150,
    runtimeMs: 5000,
    toolCalls: 2,
  },
  exhausted: {
    personalAgents: false,
    concurrentSessions: false,
    dailySessions: false,
    monthlyTokens: false,
  },
};

const capabilitiesResponse = {
  skills: { available: false },
  mcpServers: { available: false },
  vaults: { available: false },
  memoryStores: { available: false },
  personalAgentModels: ["model-a", "model-b"],
};

const archivedSessionsResponse = {
  sessions: [
    {
      ...sessionsResponse.sessions[0],
      id: archivedSessionId,
      title: "Archived research",
      status: "idle",
      archivedAt: "2026-09-06T08:00:00.000Z",
    },
  ],
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function noContent() {
  return new Response(null, { status: 204 });
}

function findStyleRules(selector: string) {
  const style = document.createElement("style");
  style.textContent = pageStyles;
  document.head.append(style);

  const matches: CSSStyleRule[] = [];
  const collect = (rules: CSSRuleList) => {
    for (const rule of Array.from(rules)) {
      if (
        "selectorText" in rule &&
        (rule as CSSStyleRule).selectorText === selector
      ) {
        matches.push(rule as CSSStyleRule);
      }
      if ("cssRules" in rule) {
        collect((rule as CSSGroupingRule).cssRules);
      }
    }
  };

  collect(style.sheet?.cssRules ?? ({} as CSSRuleList));
  style.remove();
  return matches;
}

function apiError(code: string, status: number, retryable = false) {
  return json(
    {
      error: {
        code,
        message: "Authentication required",
        requestId: "request-1",
        retryable,
      },
    },
    status,
  );
}

interface FetchCall {
  path: string;
  method: string;
  body: BodyInit | null | undefined;
}

function authenticatedHandler(
  overrides: {
    agents?: unknown;
    sessions?: unknown;
    archivedSessions?: unknown;
    usage?: unknown;
    artifacts?: unknown;
    capabilities?: unknown;
  } = {},
) {
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    const path = url.pathname;
    const method = init?.method ?? "GET";

    if (path === "/api/v1/me") {
      return json({
        user: {
          userId: "user-1",
          authSubject: "managed:user@example.com",
          role: "user",
        },
      });
    }
    if (path === "/api/v1/agents" && method === "GET") {
      return json(overrides.agents ?? agentResponse);
    }
    if (path === "/api/v1/sessions" && method === "GET") {
      return json(
        url.searchParams.get("archived") === "true"
          ? (overrides.archivedSessions ?? archivedSessionsResponse)
          : (overrides.sessions ?? sessionsResponse),
      );
    }
    if (path === `/api/v1/sessions/${sessionId}` && method === "GET") {
      return json(sessionDetail);
    }
    if (path === `/api/v1/sessions/${createdSessionId}` && method === "GET") {
      return json({
        ...sessionDetail,
        id: createdSessionId,
        title: "Summarize the attached brief",
        status: "idle",
      });
    }
    if (path === `/api/v1/sessions/${archivedSessionId}` && method === "GET") {
      return json({
        ...sessionDetail,
        ...archivedSessionsResponse.sessions[0],
      });
    }
    if (path === "/api/v1/artifacts" && method === "GET") {
      return json(overrides.artifacts ?? artifactsResponse);
    }
    if (path === "/api/v1/usage") {
      return json(overrides.usage ?? usageResponse);
    }
    if (path === "/api/v1/capabilities") {
      return json(overrides.capabilities ?? capabilitiesResponse);
    }
    if (path === "/api/v1/account/consents" && method === "GET") {
      return json({
        consents: [],
        currentVersion: "2026-10-18",
        documents: ["terms", "privacy"],
      });
    }
    if (path === "/api/v1/account/consents" && method === "POST") {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        document?: string;
        version?: string;
      };
      return json({
        consent: {
          document: body.document ?? "privacy",
          version: body.version ?? "2026-10-18",
          acceptedAt: "2026-10-18T00:00:00.000Z",
        },
      });
    }
    if (path === "/api/v1/auth/logout") return noContent();
    throw new Error(`Unexpected request: ${method} ${path}`);
  };
}

function LocationProbe() {
  const location = useLocation();
  return <output aria-label="Current location">{location.pathname}</output>;
}

function renderApp(path = "/") {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <App />
      <LocationProbe />
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

function setViewportWidth(width: number) {
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    value: width,
  });
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
  MockEventSource.instances = [];
  vi.stubGlobal("EventSource", MockEventSource);
  setMobileViewport(false);
  setViewportWidth(1024);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("authentication", () => {
  it("routes unauthenticated users through password login and reports rejected credentials", async () => {
    let authenticated = false;
    let loginAttempts = 0;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const path = new URL(String(input), "http://localhost").pathname;
      if (path === "/api/v1/me") {
        return authenticated
          ? json({
              user: {
                userId: "user-1",
                authSubject: "local:user@example.com",
                role: "user",
              },
            })
          : apiError("AUTH_REQUIRED", 401);
      }
      if (path === "/api/v1/auth/login") {
        loginAttempts += 1;
        if (loginAttempts === 1) {
          return apiError("AUTH_REQUIRED", 401);
        }
        authenticated = true;
        return noContent();
      }
      return authenticatedHandler()(input, init);
    });

    renderApp("/sessions/private");
    const user = userEvent.setup();

    expect(
      await screen.findByRole("heading", { name: "登录你的工作区" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "Quarterly plan" }),
    ).not.toBeInTheDocument();

    const email = screen.getByLabelText("邮箱");
    const password = screen.getByLabelText("密码");
    await user.type(email, "User@Example.com");
    await user.type(password, "wrong-password");
    await user.click(screen.getByRole("button", { name: "登录" }));

    expect(await screen.findByText("邮箱或密码不正确。")).toBeInTheDocument();
    expect(password).toHaveAccessibleDescription("邮箱或密码不正确。");
    expect(password).toHaveAttribute("aria-invalid", "true");

    await user.clear(password);
    await user.type(password, "correct-password");
    await user.click(screen.getByRole("button", { name: "登录" }));

    expect(
      await screen.findByRole("heading", { name: "任务" }),
    ).toBeInTheDocument();
    expect(loginAttempts).toBe(2);
  });

  it("logs out and returns to the unauthenticated route", async () => {
    let authenticated = true;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const path = new URL(String(input), "http://localhost").pathname;
      if (path === "/api/v1/me" && !authenticated) {
        return apiError("AUTH_REQUIRED", 401);
      }
      if (path === "/api/v1/auth/logout") {
        authenticated = false;
        return noContent();
      }
      return authenticatedHandler()(input, init);
    });

    renderApp();
    const user = userEvent.setup();

    const account = await screen.findByRole("button", {
      name: "账号：user@example.com",
    });
    await user.click(account);
    await user.click(screen.getByRole("menuitem", { name: "退出登录" }));
    expect(
      await screen.findByRole("heading", { name: "登录你的工作区" }),
    ).toBeInTheDocument();
  });

  it.each([401, 403])(
    "treats a %i /me response as unauthenticated",
    async (status) => {
      vi.mocked(fetch).mockResolvedValue(apiError("AUTH_REQUIRED", status));

      renderApp();

      expect(
        await screen.findByRole("heading", {
          name: "登录你的工作区",
        }),
      ).toBeInTheDocument();
    },
  );

  it.each([
    ["network failure", new TypeError("Network unavailable")],
    ["server failure", apiError("INTERNAL_ERROR", 503, true)],
  ])("shows a retryable bootstrap fault after a %s", async (_name, failure) => {
    let attempts = 0;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const path = new URL(String(input), "http://localhost").pathname;
      if (path === "/api/v1/me" && attempts++ === 0) {
        if (failure instanceof Error) throw failure;
        return failure;
      }
      return authenticatedHandler()(input, init);
    });

    renderApp();
    const user = userEvent.setup();

    expect(
      await screen.findByRole("heading", { name: "工作区暂不可用" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "登录你的工作区" }),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "重试" }));
    expect(
      await screen.findByRole("heading", { name: "新任务" }),
    ).toBeInTheDocument();
  });
});

describe("workspace shell", () => {
  it("shows compact navigation, active Sessions, and the workspace frame", async () => {
    vi.mocked(fetch).mockImplementation(authenticatedHandler());
    renderApp();

    expect(
      await screen.findByRole("heading", { name: "新任务" }),
    ).toBeInTheDocument();
    const navigation = screen.getByRole("navigation", { name: "工作区" });
    expect(navigation).toHaveClass("ui-app-shell__navigation");
    for (const name of ["新任务", "历史任务", "我的文件", "设置"]) {
      expect(
        within(navigation).getByRole("link", { name }),
      ).toBeInTheDocument();
    }

    const reserved = Array.from(
      navigation.querySelectorAll<HTMLElement>('[aria-disabled="true"]'),
    );
    expect(reserved).toHaveLength(0);
    expect(
      within(navigation).queryByRole("link", {
        name: /助手配置|记忆|技能|MCP|凭据/,
      }),
    ).toBeNull();

    expect(within(navigation).getByText("Quarterly plan")).toBeInTheDocument();
    expect(within(navigation).getByText("执行中")).toBeInTheDocument();

    expect(document.querySelector(".ui-app-frame")).toHaveAttribute(
      "data-left-mode",
      "expanded",
    );
    expect(
      screen.getByRole("complementary", { name: "工作区导航" }),
    ).toContainElement(navigation);
    expect(screen.queryByRole("button", { name: "打开导航" })).toBeNull();
  });

  it("opens task search from the sidebar and opens a chosen task", async () => {
    vi.mocked(fetch).mockImplementation(authenticatedHandler());
    renderApp();
    const user = userEvent.setup();

    await screen.findByRole("heading", { name: "新任务" });
    const navigation = screen.getByRole("navigation", { name: "工作区" });

    // The placeholder search field is gone from the sidebar.
    expect(within(navigation).queryByRole("searchbox")).not.toBeInTheDocument();

    await user.click(within(navigation).getByRole("button", { name: "搜索" }));
    const search = await screen.findByRole("combobox", {
      name: "搜索任务",
    });
    expect(search).toHaveFocus();

    await user.type(search, "quarterly");
    expect(
      screen.getByRole("option", { name: /Quarterly plan/ }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("option", { name: /Quarterly plan/ }));
    expect(
      await screen.findByRole("heading", { name: "Quarterly plan" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "搜索任务" })).toBeNull();
  });

  it("[shell.narrow] opens and closes the navigation drawer with focus return", async () => {
    setViewportWidth(600);
    vi.mocked(fetch).mockImplementation(authenticatedHandler());
    renderApp();
    const user = userEvent.setup();

    await screen.findByRole("heading", { name: "新任务" });
    const frame = document.querySelector(".ui-app-frame");
    expect(frame).toHaveAttribute("data-left-mode", "collapsed");

    const sidebar = screen.getByRole("complementary", {
      name: "工作区导航",
    });
    const navigation = within(sidebar).getByRole("navigation", {
      name: "工作区",
    });
    expect(
      within(navigation).getByRole("link", { name: "新任务" }),
    ).toBeInTheDocument();
    expect(
      within(navigation).getByRole("link", { name: "历史任务" }),
    ).toBeInTheDocument();
    // The session list belongs to the expanded rail.
    expect(within(navigation).queryByText("Quarterly plan")).toBeNull();

    const open = screen.getByRole("button", { name: "打开导航" });
    await user.click(open);
    expect(frame).toHaveAttribute("data-drawer", "open");
    expect(document.body.style.overflow).toBe("hidden");
    expect(within(sidebar).getByText("Work Agent")).toBeInTheDocument();
    expect(within(sidebar).getByText("Quarterly plan")).toBeInTheDocument();

    await user.click(within(sidebar).getByRole("button", { name: "关闭导航" }));
    expect(frame).not.toHaveAttribute("data-drawer");
    expect(document.body.style.overflow).toBe("");
    expect(screen.getByRole("button", { name: "打开导航" })).toHaveFocus();

    await user.click(screen.getByRole("button", { name: "打开导航" }));
    await user.keyboard("{Escape}");
    expect(frame).not.toHaveAttribute("data-drawer");
    expect(document.body.style.overflow).toBe("");
    expect(screen.getByRole("button", { name: "打开导航" })).toHaveFocus();

    await user.click(screen.getByRole("button", { name: "打开导航" }));
    await user.click(within(sidebar).getByRole("link", { name: "历史任务" }));
    expect(frame).not.toHaveAttribute("data-drawer");
    expect(
      await screen.findByRole("heading", { name: "历史任务" }),
    ).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("main")).toHaveFocus());
  });

  it("[panel.overlay] closes the artifact overlay on narrow screens", async () => {
    setViewportWidth(600);
    vi.mocked(fetch).mockImplementation(authenticatedHandler());
    renderApp(`/sessions/${sessionId}?artifact=${artifactId}`);
    const user = userEvent.setup();

    await screen.findByRole("heading", { name: "Quarterly plan" });
    const panel = await screen.findByRole("complementary", {
      name: "Workspace panel",
    });
    expect(panel).toHaveClass("ui-app-frame__right--overlay");

    await user.click(screen.getByRole("button", { name: "关闭面板" }));
    await waitFor(() =>
      expect(
        screen.queryByRole("complementary", { name: "Workspace panel" }),
      ).toBeNull(),
    );
  });

  it("blocks task creation when no default Agent is available", async () => {
    vi.mocked(fetch).mockImplementation(
      authenticatedHandler({
        agents: {
          agents: [],
          selection: null,
          blocker: {
            code: "NO_DEFAULT_AGENT",
            message: "Contact an administrator to assign a default Agent",
          },
        },
      }),
    );
    renderApp();

    expect(
      await screen.findByText("暂无默认助手，请联系管理员配置可用助手。"),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "开始任务" })).toBeDisabled();
  });

  it("blocks task creation when execution quota is exhausted", async () => {
    vi.mocked(fetch).mockImplementation(
      authenticatedHandler({
        usage: {
          ...usageResponse,
          exhausted: {
            ...usageResponse.exhausted,
            monthlyTokens: true,
          },
        },
      }),
    );
    renderApp();

    expect(
      await screen.findByText("本月额度已用完，已有结果仍可查看。"),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "开始任务" })).toBeDisabled();
  });

  it("refreshes the quota snapshot on window focus and on returning home", async () => {
    vi.mocked(fetch).mockImplementation(authenticatedHandler());
    renderApp();
    await screen.findByRole("heading", { name: "新任务" });

    const usageCalls = () =>
      vi
        .mocked(fetch)
        .mock.calls.filter(([input]) => String(input).endsWith("/api/v1/usage"))
        .length;
    expect(usageCalls()).toBe(1);

    // Regaining focus refetches the authoritative snapshot instead of leaving
    // a stale exhausted-quota blocker on the intro page.
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await waitFor(() => expect(usageCalls()).toBe(2));

    // Returning home from another page refetches as well; the initial mount
    // of the workspace does not double-fetch.
    fireEvent.click(screen.getByRole("link", { name: "设置" }));
    await screen.findByRole("heading", { name: "设置" });
    expect(usageCalls()).toBe(2);
    fireEvent.click(screen.getByRole("link", { name: "新任务" }));
    await screen.findByRole("heading", { name: "新任务" });
    await waitFor(() => expect(usageCalls()).toBe(3));
  });
});

describe("Agent management", () => {
  it("uses shared page primitives and compact typed Agent records", async () => {
    vi.mocked(fetch).mockImplementation(authenticatedHandler());

    renderApp("/agents");
    const user = userEvent.setup();

    const heading = await screen.findByRole("heading", { name: "助手配置" });
    expect(screen.getAllByRole("main")).toHaveLength(1);
    expect(heading.closest("header")).toHaveClass("ui-page-header");

    const platformSection = screen.getByRole("region", {
      name: "平台助手",
    });
    const personalSection = screen.getByRole("region", {
      name: "我的助手",
    });
    expect(
      within(platformSection)
        .getByRole("heading", { name: "平台助手" })
        .closest("header"),
    ).toHaveClass("ui-section-header");
    expect(
      within(personalSection)
        .getByRole("heading", { name: "我的助手" })
        .closest("header"),
    ).toHaveClass("ui-section-header");
    expect(
      within(platformSection).getByRole("list", {
        name: "平台助手",
      }),
    ).toHaveClass("agent-records");
    expect(
      within(personalSection).getByRole("list", {
        name: "个人助手",
      }),
    ).toHaveClass("agent-records");
    expect(
      within(platformSection).getByText("平台").closest(".ui-badge"),
    ).toHaveClass("ui-badge");
    expect(
      within(personalSection).getByText("个人").closest(".ui-badge"),
    ).toHaveClass("ui-badge");

    const newAgent = screen.getByRole("button", {
      name: "创建个人助手",
    });
    expect(newAgent).toHaveClass("ui-button", "ui-button--primary");
    expect(
      within(personalSection).getByRole("button", {
        name: "编辑 Writing assistant",
      }),
    ).toHaveClass("ui-button", "ui-button--secondary");
    expect(
      within(personalSection).getByRole("button", {
        name: "删除 Writing assistant",
      }),
    ).toHaveClass("ui-button", "ui-button--text");

    await user.click(newAgent);
    const editorHeading = await screen.findByRole("heading", {
      name: "创建个人助手",
    });
    expect(editorHeading).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "创建助手" })).toBeDisabled();
  });

  it("uses only the server capability allowlist for personal Agent models", async () => {
    vi.mocked(fetch).mockImplementation(
      authenticatedHandler({
        capabilities: {
          ...capabilitiesResponse,
          personalAgentModels: ["model-c"],
        },
      }),
    );

    renderApp("/agents");
    const user = userEvent.setup();
    const trigger = await screen.findByRole("button", {
      name: "创建个人助手",
    });
    await user.click(trigger);

    const model = screen.getByLabelText("模型");
    expect(within(model).getAllByRole("option")).toHaveLength(1);
    expect(within(model).getByRole("option", { name: "model-c" })).toHaveValue(
      "model-c",
    );
    expect(
      within(model).queryByRole("option", { name: "model-a" }),
    ).not.toBeInTheDocument();
    expect(
      within(model).queryByRole("option", { name: "model-b" }),
    ).not.toBeInTheDocument();
  });

  it("separates platform Agents and creates, edits, and deletes personal Agents", async () => {
    let agents = structuredClone(agentResponse.agents);
    const calls: FetchCall[] = [];
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const path = new URL(String(input), "http://localhost").pathname;
      const method = init?.method ?? "GET";
      calls.push({ path, method, body: init?.body });

      if (path === "/api/v1/agents" && method === "GET") {
        return json({ ...agentResponse, agents });
      }
      if (path === `/api/v1/agents/${personalAgentId}` && method === "GET") {
        return json({
          ...agents.find((agent) => agent.id === personalAgentId),
          systemPrompt: "Write clearly.",
        });
      }
      if (path === "/api/v1/agents" && method === "POST") {
        const created = {
          id: "00000000-0000-4000-8000-000000000008",
          name: "Code reviewer",
          description: "Reviews changes",
          modelId: "model-a",
          version: "1",
          status: "active",
          kind: "personal",
          editable: true,
          systemPrompt: "Review carefully.",
        };
        agents = [...agents, created];
        return json(created, 201);
      }
      if (path === `/api/v1/agents/${personalAgentId}` && method === "PATCH") {
        const updated = {
          ...agents.find((agent) => agent.id === personalAgentId)!,
          name: "Editorial assistant",
          version: "3",
          systemPrompt: "Write clearly.",
        };
        agents = agents.map((agent) =>
          agent.id === personalAgentId ? updated : agent,
        );
        return json(updated);
      }
      if (path === `/api/v1/agents/${personalAgentId}` && method === "DELETE") {
        agents = agents.filter((agent) => agent.id !== personalAgentId);
        return noContent();
      }
      return authenticatedHandler({ agents: { ...agentResponse, agents } })(
        input,
        init,
      );
    });

    renderApp("/agents");
    const user = userEvent.setup();

    expect(
      await screen.findByRole("heading", { name: "平台助手" }),
    ).toBeInTheDocument();
    const platformSection = screen.getByRole("region", {
      name: "平台助手",
    });
    expect(
      within(platformSection).getByText("Research assistant"),
    ).toBeVisible();
    expect(
      within(platformSection).queryByRole("button", { name: /编辑/ }),
    ).not.toBeInTheDocument();

    const newAgentTrigger = screen.getByRole("button", {
      name: "创建个人助手",
    });
    await user.click(newAgentTrigger);
    await screen.findByRole("heading", { name: "创建个人助手" });
    await user.type(screen.getByLabelText("名称"), "Code reviewer");
    await user.type(screen.getByLabelText("描述"), "Reviews changes");
    await user.selectOptions(screen.getByLabelText("模型"), "model-a");
    await user.type(screen.getByLabelText("系统提示词"), "Review carefully.");
    await user.click(screen.getByRole("button", { name: "创建助手" }));
    await screen.findByRole("heading", { name: "助手配置" });
    expect(await screen.findByText("Code reviewer")).toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: "编辑 Writing assistant" }),
    );
    const name = await screen.findByLabelText("名称");
    await user.clear(name);
    await user.type(name, "Editorial assistant");
    await user.click(screen.getByRole("button", { name: "保存修改" }));
    await screen.findByRole("heading", { name: "助手配置" });
    expect(await screen.findByText("Editorial assistant")).toBeInTheDocument();

    const deleteAgentTrigger = screen.getByRole("button", {
      name: "删除 Editorial assistant",
    });
    await user.click(deleteAgentTrigger);
    const dialog = screen.getByRole("dialog", {
      name: "删除个人助手？",
    });
    await waitFor(() => {
      expect(
        within(dialog).getByRole("button", { name: "取消" }),
      ).toHaveFocus();
    });
    await user.tab({ shift: true });
    expect(
      within(dialog).getByRole("button", { name: "删除助手" }),
    ).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(deleteAgentTrigger).toHaveFocus();
    await user.click(deleteAgentTrigger);
    const reopenedDeleteDialog = screen.getByRole("dialog", {
      name: "删除个人助手？",
    });
    await user.click(
      within(reopenedDeleteDialog).getByRole("button", {
        name: "删除助手",
      }),
    );
    await waitFor(() => {
      expect(screen.queryByText("Editorial assistant")).not.toBeInTheDocument();
    });
    expect(screen.getByRole("heading", { name: "助手配置" })).toHaveFocus();

    expect(
      JSON.parse(
        String(
          calls.find(
            (call) => call.path === "/api/v1/agents" && call.method === "POST",
          )?.body,
        ),
      ),
    ).toEqual({
      name: "Code reviewer",
      description: "Reviews changes",
      modelId: "model-a",
      systemPrompt: "Review carefully.",
      skillIds: [],
    });
    expect(
      JSON.parse(String(calls.find((call) => call.method === "PATCH")?.body)),
    ).toMatchObject({
      name: "Editorial assistant",
      arkVersion: "2",
    });
  });

  it("keeps the personal Agent editor open with a retryable conflict message", async () => {
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const path = new URL(String(input), "http://localhost").pathname;
      const method = init?.method ?? "GET";
      if (path === `/api/v1/agents/${personalAgentId}` && method === "GET") {
        return json({
          ...agentResponse.agents[1],
          systemPrompt: "Write clearly.",
        });
      }
      if (path === `/api/v1/agents/${personalAgentId}` && method === "PATCH") {
        return apiError("ARK_CONFLICT", 409);
      }
      return authenticatedHandler()(input, init);
    });

    renderApp("/agents");
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", { name: "编辑 Writing assistant" }),
    );
    await user.click(await screen.findByRole("button", { name: "保存修改" }));

    expect(
      await screen.findByText(
        "助手配置已在其他位置变更，请返回并重新打开编辑页。",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "编辑助手" }),
    ).toBeInTheDocument();
  });
});

describe("Session page", () => {
  it("uses shared primitives for Session status, actions, composer, and deletion", async () => {
    vi.mocked(fetch).mockImplementation(authenticatedHandler());

    renderApp(`/sessions/${sessionId}`);
    const user = userEvent.setup();
    const heading = await screen.findByRole("heading", {
      name: "Quarterly plan",
    });
    const sessionPage = heading.closest(".session-page")!;
    const sessionMeta =
      sessionPage.querySelector<HTMLElement>(".session-meta")!;

    expect(screen.getAllByRole("main")).toHaveLength(1);
    expect(
      within(sessionMeta).getByText("执行中").closest(".ui-badge"),
    ).toHaveClass("ui-badge", "ui-badge--success");
    expect(within(sessionMeta).getByText("连接中")).toHaveClass(
      "session-connection",
    );

    const interrupt = screen.getByRole("button", {
      name: "停止任务",
    });
    expect(interrupt).toHaveClass(
      "ui-button",
      "ui-button--secondary",
      "ui-button--compact",
    );
    expect(screen.getByLabelText("补充要求")).toHaveClass("ui-textarea");
    expect(screen.getByRole("button", { name: "发送消息" })).toHaveClass(
      "ui-icon-button",
      "ui-icon-button--small",
      "send-button",
    );

    await waitFor(() => expect(MockEventSource.instances).toHaveLength(1));
    const source = MockEventSource.instances[0]!;
    act(() => source.emitOpen());
    expect(within(sessionMeta).getByText("已连接")).toHaveClass(
      "session-connection--success",
    );

    const actions = screen.getByRole("button", { name: "任务操作" });
    expect(actions).toHaveClass("ui-icon-button", "ui-icon-button--default");
    await user.click(actions);
    expect(screen.getByRole("button", { name: "归档任务" })).toHaveClass(
      "ui-button",
      "ui-button--text",
      "ui-button--compact",
    );
    const deleteAction = screen.getByRole("button", {
      name: "永久删除任务",
    });
    expect(deleteAction).toHaveClass(
      "ui-button",
      "ui-button--text",
      "ui-button--compact",
    );

    await user.click(deleteAction);
    const dialog = screen.getByRole("dialog", {
      name: "永久删除任务？",
    });
    expect(dialog).toHaveClass("ui-dialog");
    expect(
      within(dialog).getByRole("button", {
        name: "关闭删除确认",
      }),
    ).toHaveClass("ui-icon-button", "ui-icon-button--small");
    expect(within(dialog).getByLabelText("输入 DELETE 确认")).toHaveClass(
      "ui-input",
    );
    expect(within(dialog).getByRole("button", { name: "取消" })).toHaveClass(
      "ui-button",
      "ui-button--secondary",
    );
    expect(
      within(dialog).getByRole("button", { name: "永久删除" }),
    ).toHaveClass("ui-button", "ui-button--danger");

    const [transcriptRule] = findStyleRules(".transcript");
    const [composerRule] = findStyleRules(".session-composer");
    expect(transcriptRule?.style.width).toBe("100%");
    expect(transcriptRule?.style.maxWidth).toBe(
      "var(--ui-transcript-max-width)",
    );
    expect(transcriptRule?.style.marginInline).toBe("auto");
    expect(composerRule?.style.borderRadius).toBe("var(--ui-radius-composer)");
  });

  it("restores an artifact panel from the URL and closes it", async () => {
    vi.mocked(fetch).mockImplementation(authenticatedHandler());
    renderApp(`/sessions/${sessionId}?artifact=${artifactId}`);
    await screen.findByRole("heading", { name: "Quarterly plan" });

    const panel = await screen.findByRole("complementary", {
      name: "Workspace panel",
    });
    const tab = within(panel).getByRole("tab", {
      name: "quarterly-plan.pdf",
    });
    expect(tab).toHaveAttribute("aria-selected", "true");

    await userEvent.setup().click(
      within(panel).getByRole("button", {
        name: "Close quarterly-plan.pdf",
      }),
    );
    expect(
      screen.queryByRole("complementary", { name: "Workspace panel" }),
    ).toBeNull();
  });

  it("shows composer focus on the card instead of a clipped textarea outline", () => {
    for (const card of [".composer", ".session-composer"]) {
      const [focusRule] = findStyleRules(
        `${card}:has(.ui-textarea:focus-visible)`,
      );
      expect(focusRule?.style.borderColor, card).toBe("var(--ui-color-accent)");
      expect(focusRule?.style.boxShadow, card).toBe(
        "0 0 0 1px var(--ui-color-accent)",
      );
    }
    for (const area of [
      ".composer .ui-textarea",
      ".session-composer .ui-textarea",
    ]) {
      const rule = findStyleRules(`${area}:focus-visible`)[0];
      expect(rule?.style.outline, area).toBe("none");
    }
  });

  it("keeps pending Session action labels exposed while showing shared loading state", async () => {
    const neverCompletes = new Promise<Response>(() => undefined);
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const url = new URL(String(input), "http://localhost");
      if (
        url.pathname === `/api/v1/sessions/${sessionId}/interrupt` &&
        init?.method === "POST"
      ) {
        return neverCompletes;
      }
      return authenticatedHandler()(input, init);
    });

    renderApp(`/sessions/${sessionId}`);
    const user = userEvent.setup();
    const interrupt = await screen.findByRole("button", {
      name: "停止任务",
    });
    await user.click(interrupt);

    const pendingInterrupt = screen.getByRole("button", {
      name: "停止任务",
    });
    expect(pendingInterrupt).toBeDisabled();
    expect(pendingInterrupt).toHaveAttribute("aria-busy", "true");
    expect(within(pendingInterrupt).getByText("停止")).toBeVisible();
    expect(
      within(pendingInterrupt).getByRole("status", { hidden: true }),
    ).toHaveClass("ui-spinner");
  });

  it.each([
    ["SESSION_BUSY", 409, "任务正忙，本条消息未被接受，请稍后重试。"],
    ["SESSION_TERMINATED", 409, "此任务已结束，无法继续发送消息。"],
    ["ARK_UNAVAILABLE", 503, "发送消息未完成，请重试。"],
  ])(
    "renders %s message failures as danger alerts",
    async (code, status, expectedMessage) => {
      vi.mocked(fetch).mockImplementation(async (input, init) => {
        const url = new URL(String(input), "http://localhost");
        if (
          url.pathname === `/api/v1/sessions/${sessionId}/messages` &&
          init?.method === "POST"
        ) {
          return apiError(code, status, true);
        }
        return authenticatedHandler()(input, init);
      });

      renderApp(`/sessions/${sessionId}`);
      const user = userEvent.setup();
      await screen.findByRole("heading", { name: "Quarterly plan" });
      await user.type(screen.getByLabelText("补充要求"), "Add risks");
      await user.click(screen.getByRole("button", { name: "发送消息" }));

      const alert = await screen.findByRole("alert");
      expect(alert).toHaveTextContent(expectedMessage);
      expect(alert).toHaveClass("ui-alert--danger");
      expect(alert.closest(".session-page")).toHaveClass(
        "session-page--composer-error",
      );
    },
  );

  it("renders failed permanent deletion as a danger alert", async () => {
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const url = new URL(String(input), "http://localhost");
      if (
        url.pathname === `/api/v1/sessions/${sessionId}` &&
        init?.method === "DELETE"
      ) {
        return apiError("DELETION_FAILED", 500);
      }
      return authenticatedHandler()(input, init);
    });

    renderApp(`/sessions/${sessionId}`);
    const user = userEvent.setup();
    await screen.findByRole("heading", { name: "Quarterly plan" });
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

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("永久删除失败，后台将继续重试。");
    expect(alert).toHaveClass("ui-alert--danger");
  });

  it("gives composer feedback a growing layout at every width", () => {
    const [pageRule] = findStyleRules(".session-page");
    const [composerRule] = findStyleRules(".session-composer");
    const [footerRule] = findStyleRules(".session-composer-footer");
    const [feedbackRule] = findStyleRules(".session-composer-feedback");

    expect(pageRule?.style.gridTemplateRows).toBe(
      "auto minmax(8rem, 1fr) auto",
    );
    expect(composerRule?.style.gridTemplateRows).toBe(
      "minmax(4.5rem, auto) auto",
    );
    expect(footerRule?.style.flexWrap).toBe("wrap");
    expect(feedbackRule?.style.overflowWrap).toBe("anywhere");
  });

  it("keeps a fixed icon slot in the permanent-delete button while loading", async () => {
    const neverCompletes = new Promise<Response>(() => undefined);
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const url = new URL(String(input), "http://localhost");
      if (
        url.pathname === `/api/v1/sessions/${sessionId}` &&
        init?.method === "DELETE"
      ) {
        return neverCompletes;
      }
      return authenticatedHandler()(input, init);
    });

    renderApp(`/sessions/${sessionId}`);
    const user = userEvent.setup();
    await screen.findByRole("heading", { name: "Quarterly plan" });
    await user.click(screen.getByRole("button", { name: "任务操作" }));
    await user.click(screen.getByRole("button", { name: "永久删除任务" }));
    const dialog = screen.getByRole("dialog", {
      name: "永久删除任务？",
    });
    await user.type(
      within(dialog).getByLabelText("输入 DELETE 确认"),
      "DELETE",
    );
    const deleteButton = within(dialog).getByRole("button", {
      name: "永久删除",
    });
    const idleSlot = deleteButton.querySelector(".session-delete-button__icon");
    expect(idleSlot).toBeInTheDocument();
    expect(idleSlot?.querySelector(".ui-spinner")).not.toBeInTheDocument();

    await user.click(deleteButton);

    const pendingButton = within(dialog).getByRole("button", {
      name: "永久删除",
    });
    expect(pendingButton).toHaveAttribute("aria-busy", "true");
    expect(
      pendingButton.querySelector(".session-delete-button__icon .ui-spinner"),
    ).toBeInTheDocument();
    const [iconSlotRule] = findStyleRules(".session-delete-button__icon");
    expect(iconSlotRule?.style.width).toBe("15px");
  });

  it("clears the previous Session state immediately when the route parameter changes", async () => {
    let resolveNextSession!: (response: Response) => void;
    const nextSessionResponse = new Promise<Response>((resolve) => {
      resolveNextSession = resolve;
    });
    const neverCompletes = new Promise<Response>(() => undefined);
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const url = new URL(String(input), "http://localhost");
      const method = init?.method ?? "GET";
      if (url.pathname === "/api/v1/sessions" && method === "GET") {
        return url.searchParams.get("archived") === "true"
          ? json(archivedSessionsResponse)
          : json({
              sessions: [
                sessionsResponse.sessions[0],
                {
                  ...sessionsResponse.sessions[0],
                  id: createdSessionId,
                  title: "Second Session",
                  status: "idle",
                },
              ],
            });
      }
      if (
        url.pathname === `/api/v1/sessions/${sessionId}/messages` &&
        method === "POST"
      ) {
        return neverCompletes;
      }
      if (
        url.pathname === `/api/v1/sessions/${createdSessionId}` &&
        method === "GET"
      ) {
        return nextSessionResponse;
      }
      return authenticatedHandler()(input, init);
    });

    renderApp(`/sessions/${sessionId}`);
    const user = userEvent.setup();
    await screen.findByRole("heading", { name: "Quarterly plan" });
    await waitFor(() => {
      expect(MockEventSource.instances).toHaveLength(1);
    });
    const source = MockEventSource.instances[0]!;
    act(() => {
      source.emit("agent.message", {
        id: "old-event",
        sourceType: "agent.message",
        type: "message",
        createdAt: "2026-09-07T08:04:00.000Z",
        payload: { content: "Old Session response" },
      });
    });
    await user.type(screen.getByLabelText("补充要求"), "Pending old action");
    await user.click(screen.getByRole("button", { name: "发送消息" }));

    await user.click(screen.getByRole("link", { name: /Second Session/ }));

    expect(
      screen.queryByRole("heading", { name: "Quarterly plan" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Old Session response")).not.toBeInTheDocument();
    expect(screen.getByText("正在加载任务...")).toBeInTheDocument();
    expect(source.closed).toBe(true);

    resolveNextSession(
      json({
        ...sessionDetail,
        id: createdSessionId,
        title: "Second Session",
        status: "idle",
      }),
    );
    expect(
      await screen.findByRole("heading", { name: "Second Session" }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("补充要求")).toBeEnabled();
    expect(screen.getByLabelText("补充要求")).toHaveValue("");
  });

  it("lists archived Sessions from the archived API and restores them", async () => {
    const calls: string[] = [];
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const url = new URL(String(input), "http://localhost");
      const method = init?.method ?? "GET";
      calls.push(`${method} ${url.pathname}${url.search}`);
      if (
        url.pathname === `/api/v1/sessions/${archivedSessionId}/archive` &&
        method === "DELETE"
      ) {
        return json({
          ...archivedSessionsResponse.sessions[0],
          archivedAt: null,
        });
      }
      return authenticatedHandler()(input, init);
    });

    renderApp();
    const user = userEvent.setup();
    const sidebar = await screen.findByRole("navigation", {
      name: "工作区",
    });
    expect(calls).toContain("GET /api/v1/sessions?archived=true");

    // Archived Sessions stay collapsed until they are asked for.
    const archivedRegion = within(sidebar).getByRole("region", {
      name: "已归档任务",
    });
    expect(
      within(archivedRegion).queryByRole("link", { name: /Archived research/ }),
    ).not.toBeInTheDocument();
    await user.click(
      within(archivedRegion).getByRole("button", { name: /已归档/ }),
    );
    const archivedLink = within(archivedRegion).getByRole("link", {
      name: /Archived research/,
    });
    expect(archivedLink).toBeInTheDocument();

    await user.click(archivedLink);
    await user.click(await screen.findByRole("button", { name: "恢复任务" }));

    expect(
      within(sidebar).getByRole("link", { name: /Archived research/ }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "已归档任务" })).toBeNull();
  });

  it("renders ordered deduplicated events without exposing reasoning text and closes SSE", async () => {
    vi.mocked(fetch).mockImplementation(authenticatedHandler());
    const rendered = renderApp(`/sessions/${sessionId}`);

    expect(
      await screen.findByRole("heading", { name: "Quarterly plan" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Research assistant")).toBeInTheDocument();
    expect(screen.queryByText("助手版本 4")).toBeNull();
    expect(screen.getByText("brief.txt")).toBeInTheDocument();

    const source = MockEventSource.instances[0]!;
    expect(source.url).toBe(`/api/v1/sessions/${sessionId}/events`);
    expect(source.withCredentials).toBe(true);
    act(() => {
      source.emitOpen();
      source.emit("user.message", {
        id: "event-1",
        sourceType: "user.message",
        type: "message",
        createdAt: "2026-09-07T08:01:00.000Z",
        payload: { content: "Prepare the plan" },
      });
      source.emit("agent.thinking", {
        id: "event-2",
        sourceType: "agent.thinking",
        type: "thinking",
        createdAt: "2026-09-07T08:02:00.000Z",
        payload: { content: "private chain of thought" },
      });
      source.emit("agent.tool_use", {
        id: "call_search_1",
        sourceType: "agent.tool_use",
        type: "tool_use",
        createdAt: "2026-09-07T08:03:00.000Z",
        payload: {
          callId: "call_search_1",
          name: "web_search",
          argsSummary: "doubao pricing",
        },
      });
      source.emit("agent.tool_result", {
        id: "event-3r",
        sourceType: "agent.tool_result",
        type: "tool_result",
        createdAt: "2026-09-07T08:03:01.000Z",
        payload: {
          callId: "call_search_1",
          status: "ok",
          preview: "3 results",
        },
      });
      source.emit("agent.message", {
        id: "event-4",
        sourceType: "agent.message",
        type: "message",
        createdAt: "2026-09-07T08:04:00.000Z",
        payload: { content: "The plan is ready." },
      });
      source.emit("agent.message", {
        id: "event-4",
        sourceType: "agent.message",
        type: "message",
        createdAt: "2026-09-07T08:04:00.000Z",
        payload: { content: "The plan is ready." },
      });
      source.emit("session.error", {
        id: "event-5",
        sourceType: "session.error",
        type: "error",
        createdAt: "2026-09-07T08:05:00.000Z",
        payload: {
          code: "TEMPORARY",
          message: "Retrying upstream",
          recoverable: true,
        },
      });
    });

    act(() => source.emitError());
    expect(screen.getByText("连接重试中")).toBeInTheDocument();
    act(() => {
      source.emitOpen();
      source.emit("session.error", {
        id: "event-6",
        sourceType: "session.error",
        type: "error",
        createdAt: "2026-09-07T08:06:00.000Z",
        payload: {
          code: "FAILED",
          message: "Execution stopped",
          recoverable: false,
        },
      });
    });

    const timeline = screen.getByLabelText("任务消息");
    // The tool result folds into its call, so it has no row of its own.
    expect(
      Array.from(timeline.querySelectorAll("[data-event-id]")).map((item) =>
        item.getAttribute("data-event-id"),
      ),
    ).toEqual([
      "event-1",
      "event-2",
      "call_search_1",
      "event-4",
      "event-5",
      "event-6",
    ]);
    expect(screen.getByText("Prepare the plan")).toBeInTheDocument();
    expect(screen.getByText("The plan is ready.")).toBeInTheDocument();
    // The speakers are identified by avatar icon alone; the old "You"/"Agent"
    // word labels are gone.
    expect(screen.queryByText("You")).not.toBeInTheDocument();
    expect(screen.queryByText("Agent")).not.toBeInTheDocument();
    expect(
      timeline.querySelector(".transcript__row--user .lucide-user-round"),
    ).not.toBeNull();
    expect(
      timeline.querySelector(".transcript__answer .lucide-bot"),
    ).not.toBeNull();
    expect(screen.getByText("思考中…")).toBeInTheDocument();
    expect(
      screen.queryByText("private chain of thought"),
    ).not.toBeInTheDocument();
    const toolRow = timeline.querySelector('[data-event-id="call_search_1"]')!;
    expect(toolRow.textContent).toContain("已搜索网页");
    expect(toolRow.textContent).toContain("doubao pricing");
    expect(toolRow.textContent).toContain("1.0s");
    expect(screen.getByText("3 results")).toBeInTheDocument();
    expect(screen.getByText("可恢复的异常")).toBeInTheDocument();
    expect(screen.getByText("任务已停止")).toBeInTheDocument();
    expect(screen.getByText("任务已结束")).toBeInTheDocument();
    expect(screen.getByText("已结束")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "发送消息" })).toBeDisabled();
    expect(screen.getByText("连接已结束")).toBeInTheDocument();
    expect(source.closed).toBe(true);
    rendered.unmount();
    expect(source.closed).toBe(true);
  });

  it("sends follow-ups, interrupts, archives, restores, and confirms permanent deletion", async () => {
    const calls: FetchCall[] = [];
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const url = new URL(String(input), "http://localhost");
      const method = init?.method ?? "GET";
      calls.push({ path: url.pathname, method, body: init?.body });
      if (
        url.pathname === `/api/v1/sessions/${sessionId}/messages` &&
        method === "POST"
      ) {
        return json({ eventId: "message-event", delivery: "queued" }, 202);
      }
      if (
        url.pathname === `/api/v1/sessions/${sessionId}/interrupt` &&
        method === "POST"
      ) {
        return json({ eventId: "interrupt-event", delivery: "accepted" }, 202);
      }
      if (
        url.pathname === `/api/v1/sessions/${sessionId}/archive` &&
        method === "POST"
      ) {
        return json({
          ...sessionDetail,
          archivedAt: "2026-09-07T09:00:00.000Z",
        });
      }
      if (
        url.pathname === `/api/v1/sessions/${sessionId}/archive` &&
        method === "DELETE"
      ) {
        return json({ ...sessionDetail, archivedAt: null });
      }
      if (
        url.pathname === `/api/v1/sessions/${sessionId}` &&
        method === "DELETE"
      ) {
        return json({ id: sessionId, deletionState: "pending" }, 202);
      }
      return authenticatedHandler()(input, init);
    });

    renderApp(`/sessions/${sessionId}`);
    const user = userEvent.setup();
    await screen.findByRole("heading", { name: "Quarterly plan" });

    await user.type(screen.getByLabelText("补充要求"), "Add risks");
    await user.click(screen.getByRole("button", { name: "发送消息" }));
    expect(
      await screen.findByText("消息已排队，后台将继续发送。"),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "停止任务" }));
    expect(
      await screen.findByText("已请求停止，等待任务状态确认。"),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "任务操作" }));
    await user.click(screen.getByRole("button", { name: "归档任务" }));
    expect(
      await screen.findByRole("button", { name: "恢复任务" }),
    ).toBeInTheDocument();
    const sidebar = screen.getByRole("navigation", { name: "工作区" });
    const archivedRegion = within(sidebar).getByRole("region", {
      name: "已归档任务",
    });
    await user.click(
      within(archivedRegion).getByRole("button", { name: /已归档/ }),
    );
    expect(
      within(archivedRegion).getByRole("link", { name: /Quarterly plan/ }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "恢复任务" }));
    expect(
      within(sidebar).getByRole("link", { name: /Quarterly plan/ }),
    ).toBeInTheDocument();
    expect(
      within(archivedRegion).queryByRole("link", { name: /Quarterly plan/ }),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "任务操作" }));
    await user.click(screen.getByRole("button", { name: "永久删除任务" }));
    const firstDialog = screen.getByRole("dialog", {
      name: "永久删除任务？",
    });
    await waitFor(() => {
      expect(
        within(firstDialog).getByLabelText("输入 DELETE 确认"),
      ).toHaveFocus();
    });
    await user.type(
      within(firstDialog).getByLabelText("输入 DELETE 确认"),
      "DELETE",
    );
    expect(
      within(firstDialog).getByRole("button", { name: "永久删除" }),
    ).toBeEnabled();
    within(firstDialog).getByRole("button", { name: "关闭删除确认" }).focus();
    await user.tab({ shift: true });
    expect(
      within(firstDialog).getByRole("button", { name: "永久删除" }),
    ).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "任务操作" })).toHaveFocus();
    await user.click(screen.getByRole("button", { name: "任务操作" }));
    await user.click(screen.getByRole("button", { name: "永久删除任务" }));
    const reopenedDialog = screen.getByRole("dialog", {
      name: "永久删除任务？",
    });
    const confirmDelete = within(reopenedDialog).getByRole("button", {
      name: "永久删除",
    });
    expect(confirmDelete).toBeDisabled();
    await user.type(
      within(reopenedDialog).getByLabelText("输入 DELETE 确认"),
      "DELETE",
    );
    await user.click(confirmDelete);

    expect(await screen.findByText("正在永久删除")).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Quarterly plan" }),
    ).toHaveFocus();
    expect(screen.getByLabelText("Current location")).toHaveTextContent(
      `/sessions/${sessionId}`,
    );
    expect(screen.getByLabelText("补充要求")).toBeDisabled();
    expect(
      calls.filter((call) => call.path.endsWith("/messages")),
    ).toHaveLength(1);
    expect(
      JSON.parse(
        String(
          calls.find(
            (call) =>
              call.method === "DELETE" &&
              call.path === `/api/v1/sessions/${sessionId}`,
          )?.body,
        ),
      ),
    ).toEqual({
      confirmation: "DELETE",
    });
  });

  it("requires DELETE to be re-entered after every deletion dialog close path", async () => {
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const url = new URL(String(input), "http://localhost");
      if (
        url.pathname === `/api/v1/sessions/${sessionId}` &&
        init?.method === "DELETE"
      ) {
        return json({ id: sessionId, deletionState: "none" }, 202);
      }
      return authenticatedHandler()(input, init);
    });

    renderApp(`/sessions/${sessionId}`);
    const user = userEvent.setup();
    await screen.findByRole("heading", { name: "Quarterly plan" });

    const openDeletionDialog = async () => {
      await user.click(screen.getByRole("button", { name: "任务操作" }));
      await user.click(screen.getByRole("button", { name: "永久删除任务" }));
      return screen.getByRole("dialog", {
        name: "永久删除任务？",
      });
    };
    const expectFreshConfirmation = (dialog: HTMLElement) => {
      expect(within(dialog).getByLabelText("输入 DELETE 确认")).toHaveValue("");
      expect(
        within(dialog).getByRole("button", { name: "永久删除" }),
      ).toBeDisabled();
    };

    let dialog = await openDeletionDialog();
    await user.type(
      within(dialog).getByLabelText("输入 DELETE 确认"),
      "DELETE",
    );
    await user.click(
      within(dialog).getByRole("button", {
        name: "关闭删除确认",
      }),
    );

    dialog = await openDeletionDialog();
    expectFreshConfirmation(dialog);
    await user.type(
      within(dialog).getByLabelText("输入 DELETE 确认"),
      "DELETE",
    );
    await user.click(within(dialog).getByRole("button", { name: "取消" }));

    dialog = await openDeletionDialog();
    expectFreshConfirmation(dialog);
    await user.type(
      within(dialog).getByLabelText("输入 DELETE 确认"),
      "DELETE",
    );
    await user.click(within(dialog).getByRole("button", { name: "永久删除" }));
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    dialog = await openDeletionDialog();
    expectFreshConfirmation(dialog);
  });

  it("shows a stable failed deletion state returned by Session detail", async () => {
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const path = new URL(String(input), "http://localhost").pathname;
      if (path === `/api/v1/sessions/${sessionId}`) {
        return json({
          ...sessionDetail,
          deletionState: "deletion_failed",
        });
      }
      return authenticatedHandler()(input, init);
    });

    renderApp(`/sessions/${sessionId}`);

    expect(await screen.findByText("永久删除失败")).toBeInTheDocument();
    expect(screen.getByLabelText("补充要求")).toBeDisabled();
  });
});

describe("artifact management", () => {
  it("uses shared file controls, statuses, and responsive artifact records", async () => {
    vi.mocked(fetch).mockImplementation(authenticatedHandler());

    renderApp("/files");
    const user = userEvent.setup();

    const heading = await screen.findByRole("heading", { name: "我的文件" });
    expect(await screen.findByText("quarterly-plan.pdf")).toBeInTheDocument();
    expect(screen.getAllByRole("main")).toHaveLength(1);
    expect(heading.closest("header")).toHaveClass("ui-page-header");
    expect(screen.getByLabelText("来源任务")).toHaveClass("ui-select");
    expect(screen.getByText("删除失败").closest(".ui-badge")).toHaveClass(
      "ui-badge",
      "ui-badge--danger",
    );
    expect(
      screen.getByRole("link", { name: "下载 quarterly-plan.pdf" }),
    ).toHaveClass("ui-icon-button", "ui-icon-button--small");
    const deleteArtifact = screen.getByRole("button", {
      name: "删除 quarterly-plan.pdf",
    });
    expect(deleteArtifact).toHaveClass(
      "ui-icon-button",
      "ui-icon-button--small",
    );
    // Each task's outputs collapse into one expandable record.
    const group = document.querySelector("details.artifact-group");
    expect(group).not.toBeNull();
    expect(group).not.toHaveAttribute("open");
    const groupSummary = within(group as HTMLElement).getByText(/个文件/);
    await user.click(groupSummary);
    expect(group).toHaveAttribute("open");
    const [metadataRule] = findStyleRules(".artifact-record__metadata");
    const [metadataItemRule] = findStyleRules(
      ".artifact-record__metadata > span",
    );
    expect(metadataRule?.style.minWidth).toBe("0px");
    expect(metadataItemRule?.style.minWidth).toBe("0px");
    expect(metadataItemRule?.style.overflowWrap).toBe("anywhere");

    await user.click(deleteArtifact);
    const dialog = screen.getByRole("dialog", { name: "删除文件？" });
    expect(dialog).toHaveClass("ui-dialog");
    expect(
      within(dialog).getByRole("button", {
        name: "关闭文件删除确认",
      }),
    ).toBeInTheDocument();
  });

  it("keeps the artifact retry workflow and shared error state", async () => {
    let artifactRequests = 0;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname === "/api/v1/artifacts") {
        artifactRequests += 1;
        if (artifactRequests === 1) {
          return apiError("ARK_UNAVAILABLE", 503, true);
        }
      }
      return authenticatedHandler()(input, init);
    });

    renderApp("/files");
    const user = userEvent.setup();

    const error = await screen.findByText("文件无法加载。");
    expect(error.closest(".ui-empty-state")).toBeInTheDocument();
    const retry = screen.getByRole("button", { name: "重试" });
    expect(retry).toHaveClass("ui-button", "ui-button--secondary");
    await user.click(retry);

    expect(await screen.findByText("quarterly-plan.pdf")).toBeInTheDocument();
    expect(artifactRequests).toBe(2);
  });

  it("lists only artifacts, filters by Session, downloads, and requests deletion", async () => {
    const calls: FetchCall[] = [];
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const url = new URL(String(input), "http://localhost");
      const method = init?.method ?? "GET";
      calls.push({
        path: `${url.pathname}${url.search}`,
        method,
        body: init?.body,
      });
      if (
        url.pathname === `/api/v1/artifacts/${artifactId}` &&
        method === "DELETE"
      ) {
        return json({ id: artifactId, deletionState: "pending" }, 202);
      }
      return authenticatedHandler()(input, init);
    });

    renderApp("/files");
    const user = userEvent.setup();

    expect(
      await screen.findByRole("heading", { name: "我的文件" }),
    ).toBeInTheDocument();
    expect(await screen.findByText("quarterly-plan.pdf")).toBeInTheDocument();
    expect(screen.getByText("1.5 KB")).toBeInTheDocument();
    expect(screen.getByText("删除失败")).toBeInTheDocument();
    expect(screen.queryByText("brief.txt")).not.toBeInTheDocument();
    expect(
      screen
        .getByLabelText("来源任务")
        .querySelector(`option[value="${createdSessionId}"]`),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "下载 quarterly-plan.pdf" }),
    ).toHaveAttribute("href", `/api/v1/artifacts/${artifactId}/download`);

    await user.selectOptions(screen.getByLabelText("来源任务"), sessionId);
    await waitFor(() => {
      expect(
        calls.some(
          (call) => call.path === `/api/v1/artifacts?sessionId=${sessionId}`,
        ),
      ).toBe(true);
    });

    const deleteArtifactTrigger = screen.getByRole("button", {
      name: "删除 quarterly-plan.pdf",
    });
    await user.click(deleteArtifactTrigger);
    const firstDialog = screen.getByRole("dialog", {
      name: "删除文件？",
    });
    await waitFor(() => {
      expect(
        within(firstDialog).getByRole("button", { name: "取消" }),
      ).toHaveFocus();
    });
    within(firstDialog)
      .getByRole("button", { name: "关闭文件删除确认" })
      .focus();
    await user.tab({ shift: true });
    expect(
      within(firstDialog).getByRole("button", { name: "删除文件" }),
    ).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(deleteArtifactTrigger).toHaveFocus();
    await user.click(deleteArtifactTrigger);
    const dialog = screen.getByRole("dialog", { name: "删除文件？" });
    await user.click(within(dialog).getByRole("button", { name: "删除文件" }));
    expect(await screen.findByText("删除中")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "我的文件" })).toHaveFocus();
  });
});

describe("unavailable capabilities", () => {
  it("hides unavailable capabilities and keeps assistant setup under settings", async () => {
    vi.mocked(fetch).mockImplementation(authenticatedHandler());
    renderApp("/settings");

    await screen.findByRole("heading", { name: "设置" });
    const section = screen
      .getByRole("heading", { name: "工作区能力" })
      .closest("section")!;

    for (const label of ["记忆", "技能", "MCP 服务", "凭据"]) {
      expect(within(section).queryByText(label)).not.toBeInTheDocument();
    }
    expect(
      within(section).getByRole("link", { name: "助手配置" }),
    ).toHaveAttribute("href", "/settings/agents");
    expect(within(section).queryByRole("button")).toBeNull();
    expect(within(section).queryByRole("textbox")).toBeNull();
    expect(within(section).queryByRole("combobox")).toBeNull();
  });

  it("leaves no route behind for a capability that is unavailable", async () => {
    vi.mocked(fetch).mockImplementation(authenticatedHandler());
    renderApp("/settings/vault");

    expect(
      await screen.findByRole("heading", { name: "新任务" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("Not available yet")).not.toBeInTheDocument();
  });

  it("paints the chosen theme onto the document and remembers it", async () => {
    vi.mocked(fetch).mockImplementation(authenticatedHandler());
    renderApp("/settings");
    const user = userEvent.setup();

    await screen.findByRole("heading", { name: "设置" });
    const theme = screen.getByLabelText("主题");
    expect(theme).toHaveValue("system");
    expect(document.documentElement.dataset.theme).toBe("light");

    await user.selectOptions(theme, "dark");

    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(localStorage.getItem("pwa.theme")).toBe("dark");

    document.documentElement.dataset.theme = "light";
    localStorage.removeItem("pwa.theme");
  });
});

describe("command palette", () => {
  it("opens on the shortcut, filters, and navigates by keyboard alone", async () => {
    vi.mocked(fetch).mockImplementation(authenticatedHandler());
    renderApp("/agents");
    const user = userEvent.setup();
    await screen.findByRole("heading", { name: "助手配置" });

    await user.keyboard("{Meta>}k{/Meta}");
    const search = await screen.findByRole("combobox", {
      name: "搜索操作",
    });
    expect(
      screen.getByRole("dialog", { name: "快捷操作" }),
    ).toBeInTheDocument();
    expect(search).toHaveFocus();
    expect(screen.getAllByRole("option").length).toBeGreaterThan(4);

    await user.type(search, "quarterly");
    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(1);
    expect(options[0]).toHaveTextContent("Quarterly plan");
    expect(options[0]).toHaveAttribute("aria-selected", "true");
    expect(search).toHaveAttribute("aria-activedescendant", options[0]!.id);

    await user.keyboard("{Enter}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Current location").textContent).toMatch(
      /^\/sessions\//,
    );
  });

  it("moves the selection with the arrow keys", async () => {
    vi.mocked(fetch).mockImplementation(authenticatedHandler());
    renderApp("/agents");
    const user = userEvent.setup();
    await screen.findByRole("heading", { name: "助手配置" });

    await user.keyboard("{Meta>}k{/Meta}");
    const search = await screen.findByRole("combobox", {
      name: "搜索操作",
    });
    const options = screen.getAllByRole("option");
    expect(search).toHaveAttribute("aria-activedescendant", options[0]!.id);

    await user.keyboard("{ArrowDown}");
    expect(search).toHaveAttribute("aria-activedescendant", options[1]!.id);

    await user.keyboard("{ArrowUp}");
    expect(search).toHaveAttribute("aria-activedescendant", options[0]!.id);

    // The selection does not run off the end of the list.
    await user.keyboard("{ArrowUp}");
    expect(search).toHaveAttribute("aria-activedescendant", options[0]!.id);
  });

  it("closes on Escape without navigating", async () => {
    vi.mocked(fetch).mockImplementation(authenticatedHandler());
    renderApp("/agents");
    const user = userEvent.setup();
    await screen.findByRole("heading", { name: "助手配置" });

    await user.keyboard("{Meta>}k{/Meta}");
    await screen.findByRole("combobox", { name: "搜索操作" });
    await user.keyboard("{Escape}");

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Current location").textContent).toBe(
      "/settings/agents",
    );
  });

  it("reports no match instead of an empty listbox", async () => {
    vi.mocked(fetch).mockImplementation(authenticatedHandler());
    renderApp("/agents");
    const user = userEvent.setup();
    await screen.findByRole("heading", { name: "助手配置" });

    await user.keyboard("{Meta>}k{/Meta}");
    const search = await screen.findByRole("combobox", {
      name: "搜索操作",
    });
    await user.type(search, "zzzz-no-such-command");

    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(screen.getByText("没有匹配的操作")).toBeInTheDocument();
    expect(search).toHaveAttribute("aria-expanded", "false");
  });

  it("switches the theme from the palette", async () => {
    vi.mocked(fetch).mockImplementation(authenticatedHandler());
    renderApp("/agents");
    const user = userEvent.setup();
    await screen.findByRole("heading", { name: "助手配置" });
    expect(document.documentElement.dataset.theme).toBe("light");

    await user.keyboard("{Meta>}k{/Meta}");
    const search = await screen.findByRole("combobox", {
      name: "搜索操作",
    });
    await user.type(search, "深色主题");
    await user.keyboard("{Enter}");

    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(localStorage.getItem("pwa.theme")).toBe("dark");

    document.documentElement.dataset.theme = "light";
    localStorage.removeItem("pwa.theme");
  });
});

describe("migrated CSS contracts", () => {
  it("defines every UI token referenced without a fallback", () => {
    const declared = new Set(
      [...migratedCss.matchAll(/(--ui-[\w-]+)\s*:/g)].map((match) => match[1]),
    );
    const required = [...migratedCss.matchAll(/var\((--ui-[\w-]+)\s*\)/g)].map(
      (match) => match[1],
    );
    expect([
      ...new Set(required.filter((token) => !declared.has(token))),
    ]).toEqual([]);
  });

  it("keeps the approved radius range and typography viewport-independent", () => {
    // Approved redesign permits a 16px composer, with smaller controls/panels.
    const oversizedRadii = Array.from(
      migratedCss.matchAll(/border-radius\s*:\s*(\d+(?:\.\d+)?)px/g),
    ).filter((match) => Number(match[1]) > 16);

    expect(oversizedRadii).toEqual([]);
    expect(migratedCss).not.toMatch(/font-size\s*:[^;]*(?:vw|vh|vmin|vmax)/i);
  });

  it("keeps component styles free of hardcoded colors", () => {
    // A literal cannot be rethemed, so it would sit dark-on-dark in dark mode.
    const literals = componentCss.match(/#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)/g);

    expect(literals ?? []).toEqual([]);
  });

  it("redefines every themed token in the light palette", () => {
    // Dark is the native medium on :root; light overrides via data-theme.
    const declarationsOf = (block: string) =>
      new Map(
        [...block.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((match) => [
          match[1],
          match[2]!.trim(),
        ]),
      );
    const rootBlock = /:root\s*\{([^}]*)\}/.exec(tokensCss)?.[1] ?? "";
    const lightBlock =
      /\[data-theme="light"\]\s*\{([^}]*)\}/.exec(tokensCss)?.[1] ?? "";
    const root = declarationsOf(rootBlock);
    const light = declarationsOf(lightBlock);

    const isThemed = (value: string) =>
      value.startsWith("#") ||
      value.startsWith("rgb") ||
      value.startsWith("hsl") ||
      value.startsWith("oklch");
    const missing = [...root.entries()]
      .filter(([, value]) => isThemed(value))
      .map(([name]) => name)
      .filter((name) => !light.has(name));

    expect(light.size).toBeGreaterThan(0);
    expect(missing).toEqual([]);
  });

  it("keeps the transcript flexible while allowing composer content to grow", () => {
    const [rule] = findStyleRules(".session-page");
    const rows = rule?.style.gridTemplateRows ?? "";

    expect(rows).toMatch(/^auto\s+minmax\([^)]*\)\s+auto$/);
  });

  it("meets WCAG AA contrast for text pairs in both palettes", () => {
    const parseBlock = (selector: string) => {
      const body =
        new RegExp(`${selector}\\s*\\{([^}]*)\\}`).exec(tokensCss)?.[1] ?? "";
      return new Map(
        [...body.matchAll(/(--[\w-]+)\s*:\s*(#[0-9a-fA-F]{6})\s*;/g)].map(
          (match) => [match[1], match[2]!],
        ),
      );
    };
    const luminance = (hex: string) => {
      const channel = (offset: number) => {
        const value = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
        return value <= 0.03928
          ? value / 12.92
          : ((value + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
    };
    const ratio = (a: string, b: string) => {
      const [lighter, darker] = [luminance(a), luminance(b)].sort(
        (x, y) => y - x,
      );
      return (lighter! + 0.05) / (darker! + 0.05);
    };

    const pairs: [string, string][] = [
      ["--ui-color-text", "--ui-color-surface"],
      ["--ui-color-text", "--ui-color-surface-canvas"],
      ["--ui-color-text-muted", "--ui-color-surface"],
      ["--ui-color-text-muted", "--ui-color-surface-subtle"],
      ["--ui-color-accent-interactive", "--ui-color-surface"],
      ["--ui-color-text-inverse", "--ui-color-accent"],
      ["--ui-color-danger", "--ui-color-danger-subtle"],
      ["--ui-color-warning", "--ui-color-warning-subtle"],
      ["--ui-color-success", "--ui-color-success-subtle"],
    ];

    for (const [selector, theme] of [
      [":root", "dark"],
      ['\\[data-theme="light"\\]', "light"],
    ] as const) {
      const tokens = parseBlock(selector);
      expect(tokens.size).toBeGreaterThan(0);
      for (const [foreground, background] of pairs) {
        const contrast = ratio(
          tokens.get(foreground)!,
          tokens.get(background)!,
        );
        expect(
          contrast,
          `${theme}: ${foreground} on ${background}`,
        ).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
});

describe("new task composer", () => {
  it("preserves shared sizing and radius contracts for migrated controls", async () => {
    const handler = authenticatedHandler();
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const path = new URL(String(input), "http://localhost").pathname;
      if (path === "/api/v1/uploads") {
        return json(
          {
            id: uploadId,
            name: "brief.txt",
            mimeType: "text/plain",
            sizeBytes: 5,
            mountPath: `/mnt/session/inputs/${uploadId}-brief.txt`,
            status: "uploaded",
            expiresAt: "2026-09-08T00:00:00.000Z",
          },
          201,
        );
      }
      return handler(input, init);
    });

    renderApp();
    const user = userEvent.setup();
    await screen.findByRole("heading", { name: "新任务" });

    const composer = screen.getByLabelText("任务要求").closest("form");
    const attach = screen.getByRole("button", { name: "添加材料" });
    expect(composer).toHaveClass("composer");
    expect(attach).toHaveClass(
      "attachment-button",
      "ui-button",
      "ui-button--compact",
    );
    expect(composer?.querySelector(".composer-controls")).not.toBeNull();
    expect(screen.getByRole("combobox", { name: "助手" })).toHaveClass(
      "agent-picker",
    );

    const file = new File(["hello"], "brief.txt", { type: "text/plain" });
    await user.upload(screen.getByLabelText("材料文件"), file);
    const remove = await screen.findByRole("button", {
      name: "移除 brief.txt",
    });
    expect(remove).toHaveClass(
      "small-control",
      "ui-icon-button",
      "ui-icon-button--small",
    );

    const [smallControlRule] = findStyleRules(".small-control");
    const [composerRule] = findStyleRules(".composer");
    const [sendRule] = findStyleRules(".send-button");
    expect(smallControlRule?.style.width).toBe("");
    expect(smallControlRule?.style.height).toBe("");
    expect(composerRule?.style.borderRadius).toBe("var(--ui-radius-composer)");
    expect(sendRule?.style.width).toBe("var(--ui-control-height-default)");
    expect(sendRule?.style.minHeight).toBe("var(--ui-control-height-default)");
    expect(findStyleRules(".ui-app-shell__main > .page")).toHaveLength(1);
  });

  it("persists the first message in creation and renders it without waiting for the stream", async () => {
    const calls: FetchCall[] = [];
    const durable = {
      ...sessionsResponse.sessions[0],
      id: createdSessionId,
      title: "Prepare the plan",
      upstreamReady: false,
      inputs: [],
      submissions: [
        {
          submissionId: "00000000-0000-4000-8000-000000000099",
          status: "queued",
          content: "Prepare the plan",
          upstreamEventId: null,
          errorCode: null,
          createdAt: "2026-09-08T00:00:00Z",
        },
      ],
    };
    const handler = authenticatedHandler();
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const path = new URL(String(input), "http://localhost").pathname;
      const method = init?.method ?? "GET";
      calls.push({ path, method, body: init?.body });
      if (path === "/api/v1/sessions" && method === "POST")
        return json(durable, 202);
      if (path === `/api/v1/sessions/${createdSessionId}`) return json(durable);
      return handler(input, init);
    });
    renderApp();
    const user = userEvent.setup();
    await screen.findByRole("heading", { name: "新任务" });
    await user.type(screen.getByLabelText("任务要求"), "Prepare the plan");
    await user.click(screen.getByRole("button", { name: "开始任务" }));
    expect(
      await within(
        await screen.findByRole("region", { name: "任务消息" }),
      ).findByText("Prepare the plan"),
    ).toBeInTheDocument();
    const createCall = calls.find(
      (call) => call.path === "/api/v1/sessions" && call.method === "POST",
    )!;
    expect(JSON.parse(String(createCall.body))).toEqual({
      agentId,
      uploadIds: [],
      title: "Prepare the plan",
      content: "Prepare the plan",
      submissionId: expect.any(String),
      temporary: false,
    });
    expect(
      calls.filter((call) => call.path.endsWith("/messages")),
    ).toHaveLength(0);
    expect(
      MockEventSource.instances.filter((source) =>
        source.url.includes(createdSessionId),
      ),
    ).toHaveLength(0);
    expect(
      screen.queryByRole("button", { name: "停止任务" }),
    ).not.toBeInTheDocument();
  });

  it("clears a persisted followup draft while its detail refresh is still pending", async () => {
    const handler = authenticatedHandler();
    let posted = false;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const path = new URL(String(input), "http://localhost").pathname;
      if (path === `/api/v1/sessions/${sessionId}/messages`) {
        posted = true;
        return json(
          { eventId: "receipt-1", delivery: "queued", status: "queued" },
          202,
        );
      }
      if (path === `/api/v1/sessions/${sessionId}` && posted)
        return new Promise<Response>(() => {});
      return handler(input, init);
    });
    renderApp(`/sessions/${sessionId}`);
    const user = userEvent.setup();
    const input = await screen.findByLabelText("补充要求");
    await user.type(input, "Persist this followup");
    await user.click(screen.getByRole("button", { name: "发送消息" }));
    await waitFor(() => expect(input).toHaveValue(""));
    expect(screen.getByText("Persist this followup")).toBeInTheDocument();
  });

  it("recovers the durable unknown message after reloading and does not offer blind retry", async () => {
    const handler = authenticatedHandler();
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const path = new URL(String(input), "http://localhost").pathname;
      if (path === `/api/v1/sessions/${sessionId}`)
        return json({
          ...sessionsResponse.sessions[0],
          inputs: [],
          submissions: [
            {
              submissionId: "00000000-0000-4000-8000-000000000099",
              status: "unknown",
              content: "Saved before disconnect",
              upstreamEventId: null,
              errorCode: "ARK_UNKNOWN_WRITE_OUTCOME",
              createdAt: "2026-09-08T00:00:00Z",
            },
          ],
        });
      return handler(input, init);
    });
    renderApp(`/sessions/${sessionId}`);
    expect(
      await screen.findByText("Saved before disconnect"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("正在核实消息发送结果，请勿重复发送。"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("00000000-0000-4000-8000-000000000099"),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Retry first message" }),
    ).not.toBeInTheDocument();
  });
});

describe("artifact chips in replies", () => {
  const reportArtifactId = "00000000-0000-4000-8000-000000000008";
  const reportArtifact = {
    id: reportArtifactId,
    sessionId,
    name: "report.html",
    mimeType: "text/html",
    sizeBytes: 64,
    generatedAt: "2026-09-07T08:07:00.000Z",
    deletionState: "none",
    error: null,
  };
  const syncPath = `/api/v1/sessions/${sessionId}/artifacts/sync`;

  function artifactHandler(options: {
    artifacts: unknown;
    syncArtifacts?: unknown;
    downloads?: Record<string, string>;
    calls: FetchCall[];
  }) {
    const base = authenticatedHandler({
      artifacts: { artifacts: options.artifacts },
    });
    return async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://localhost");
      const method = init?.method ?? "GET";
      if (method !== "GET") {
        options.calls.push({ path: url.pathname, method, body: init?.body });
      }
      if (url.pathname === syncPath && method === "POST") {
        return json(options.syncArtifacts ?? { artifacts: [] });
      }
      const download = options.downloads?.[url.pathname];
      if (download !== undefined) {
        return new Response(download, {
          status: 200,
          headers: { "content-type": "text/html" },
        });
      }
      return base(input, init);
    };
  }

  function emitTimelineMessage(name: string, id: string, content: string) {
    const source = MockEventSource.instances[0]!;
    act(() => {
      source.emitOpen();
      source.emit(name, {
        id,
        sourceType: name,
        type: name === "user.message" ? "message" : "message",
        createdAt: "2026-09-07T08:04:00.000Z",
        payload: { content },
      });
    });
  }

  it("renders an artifact path in a reply as a chip that opens the side panel preview", async () => {
    const calls: FetchCall[] = [];
    vi.mocked(fetch).mockImplementation(
      artifactHandler({
        artifacts: [reportArtifact],
        downloads: {
          [`/api/v1/artifacts/${reportArtifactId}/download`]: "<h1>Report</h1>",
        },
        calls,
      }),
    );
    renderApp(`/sessions/${sessionId}`);
    expect(
      await screen.findByRole("heading", { name: "Quarterly plan" }),
    ).toBeInTheDocument();

    expect(
      screen.queryByRole("complementary", { name: "Workspace panel" }),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: /打开成果面板/ })).toBeNull();
    await waitFor(() =>
      expect(MockEventSource.instances.length).toBeGreaterThan(0),
    );
    emitTimelineMessage(
      "agent.message",
      "event-chip-1",
      "搞定啦！文件在 /mnt/session/outputs/report.html。",
    );
    const timeline = screen.getByLabelText("任务消息");
    await userEvent
      .setup()
      .click(within(timeline).getByRole("button", { name: "report.html" }));

    expect(
      await screen.findByRole("tab", { name: "report.html" }),
    ).toBeInTheDocument();
    expect(
      await screen.findByRole("region", { name: "Preview of report.html" }),
    ).toBeInTheDocument();
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Close report.html" }));
    expect(
      screen.queryByRole("complementary", { name: "Workspace panel" }),
    ).toBeNull();
    await userEvent
      .setup()
      .click(within(timeline).getByRole("button", { name: "report.html" }));
    expect(
      await screen.findByRole("region", { name: "Preview of report.html" }),
    ).toBeInTheDocument();
  });

  it("leaves automatic artifact synchronization to the worker after a turn settles", async () => {
    vi.useFakeTimers();
    try {
      const calls: FetchCall[] = [];
      vi.mocked(fetch).mockImplementation(
        artifactHandler({
          artifacts: [reportArtifact],
          syncArtifacts: { artifacts: [reportArtifact] },
          calls,
        }),
      );
      renderApp(`/sessions/${sessionId}`);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(
        screen.getByRole("heading", { name: "Quarterly plan" }),
      ).toBeInTheDocument();
      const syncCount = () =>
        calls.filter((call) => call.path === syncPath).length;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000);
      });
      expect(syncCount()).toBe(0);

      const source = MockEventSource.instances[0]!;
      act(() => {
        source.emitOpen();
        source.emit("session.status_running", {
          id: "event-status-1",
          sourceType: "session.status_running",
          type: "status",
          createdAt: "2026-09-07T08:04:00.000Z",
          payload: { status: "running" },
        });
      });
      act(() => {
        source.emit("session.status_idle", {
          id: "event-status-2",
          sourceType: "session.status_idle",
          type: "status",
          createdAt: "2026-09-07T08:05:00.000Z",
          payload: { status: "idle" },
        });
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1499);
      });
      expect(syncCount()).toBe(0);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
      expect(syncCount()).toBe(0);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10000);
      });
      expect(syncCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("syncs on click when the path is unsynced and reports a missing file", async () => {
    const calls: FetchCall[] = [];
    vi.mocked(fetch).mockImplementation(
      artifactHandler({
        artifacts: [],
        syncArtifacts: { artifacts: [] },
        calls,
      }),
    );
    renderApp(`/sessions/${sessionId}`);
    expect(
      await screen.findByRole("heading", { name: "Quarterly plan" }),
    ).toBeInTheDocument();

    emitTimelineMessage(
      "agent.message",
      "event-chip-2",
      "Done: /mnt/session/outputs/later.html",
    );
    const timeline = screen.getByLabelText("任务消息");
    await userEvent
      .setup()
      .click(within(timeline).getByRole("button", { name: "later.html" }));

    expect(
      await screen.findByText("该文件尚未出现在此任务的成果中。"),
    ).toBeInTheDocument();
    expect(
      calls.some((call) => call.path === syncPath && call.method === "POST"),
    ).toBe(true);
  });
});
