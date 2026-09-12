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

function noContent() {
  return new Response(null, { status: 204 });
}

function apiError(code: string, status: number, retryable = false) {
  return json(
    {
      error: {
        code,
        message: "Upstream failure",
        requestId: "request-1",
        retryable,
        arkAgentId: "must-not-render-ark-id",
        apiKey: "must-not-render-api-key",
      },
    },
    status,
  );
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

    renderApp("/files");

    expect(
      await screen.findByRole("heading", { name: "Users" }),
    ).toBeInTheDocument();
    await screen.findByText("user@example.com");
    expect(document.querySelector(".ui-app-shell")).toBeInTheDocument();
    const navigation = screen.getByRole("navigation", {
      name: "Administration",
    });
    expect(
      within(navigation).getByRole("link", { name: "Platform Agents" }),
    ).toBeInTheDocument();
    expect(
      within(navigation).getByRole("link", { name: "Users" }),
    ).toBeInTheDocument();
    for (const name of ["New task", "Agents", "My files", "Sessions"]) {
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
      "/api/v1/capabilities",
      "/api/v1/admin/users",
    ]);
    expect(requestedPaths).not.toContain("/api/v1/sessions");
    expect(requestedPaths).not.toContain("/api/v1/artifacts");
    expect(requestedPaths).not.toContain("/api/v1/uploads");
  });

  it("never renders or requests admin resources for an ordinary user", async () => {
    vi.stubGlobal("fetch", vi.fn(userHandler()));

    renderApp("/admin/users");

    expect(
      await screen.findByRole("heading", { name: "New task" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("navigation", { name: "Administration" }),
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
      await screen.findByRole("heading", { name: "Users" }),
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
      screen.getByRole("region", { name: "Identity" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Quotas" })).toBeInTheDocument();
    expect(
      screen.getByLabelText("Default Agent for user@example.com"),
    ).toBeInTheDocument();
    expect(
      screen.getByLabelText("Monthly token limit for user@example.com"),
    ).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Sessions" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Audit" })).toBeInTheDocument();
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
      "H2:Identity",
      "H3:Default Agent",
      "H2:Quotas",
    ]);
  });

  it("keeps the mobile admin drawer out of the tab order while closed", async () => {
    setMobileViewport(true);
    vi.stubGlobal("fetch", vi.fn(adminHandler()));

    renderApp("/admin/platform-agents");
    const user = userEvent.setup();
    await screen.findByRole("heading", { name: "Platform Agents" });
    const sidebar = screen.getByRole("complementary", { hidden: true });
    const menu = screen.getByRole("button", {
      name: "Open administration navigation",
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
  // The dense row actions live behind the "…" overflow menu.
  async function openRowMenu(
    user: ReturnType<typeof userEvent.setup>,
    rowName: string,
  ) {
    await user.click(
      screen.getByRole("button", { name: `Actions for ${rowName}` }),
    );
    return screen.getByRole("menu");
  }

  it("reserves the Agent editor loading icon slot while idle", async () => {
    vi.stubGlobal("fetch", vi.fn(adminHandler()));

    renderApp("/admin/platform-agents");
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", { name: "New platform Agent" }),
    );

    const saveButton = screen.getByRole("button", { name: "Create Agent" });
    expect(
      saveButton.querySelector(".admin-loading-icon-slot"),
    ).toHaveAttribute("aria-hidden", "true");
  });

  it("uses responsive labeled records without hiding long model identifiers", async () => {
    vi.stubGlobal("fetch", vi.fn(adminHandler()));

    renderApp("/admin/platform-agents");

    const table = await screen.findByRole("table", {
      name: "Platform Agents",
    });
    expect(table).toHaveClass("ui-data-table");
    const modelCell = within(table).getByText(longModelId).closest("td");
    expect(modelCell).toHaveAttribute("data-label", "Model");
    expect(modelCell).toHaveClass("admin-agent-model");
    expect(
      within(table).getByRole("button", {
        name: "Edit Research assistant",
      }),
    ).toBeInTheDocument();
    expect(
      within(table).getByRole("button", {
        name: "Actions for Research assistant",
      }),
    ).toBeInTheDocument();
  });

  it("switches Platform Agents to labeled records before the 1024px table overflows", () => {
    const tableRule = adminStyles.indexOf(".admin-agent-table.ui-data-table");
    const mediaRule = adminStyles.lastIndexOf("@media", tableRule);
    const mediaHeader = adminStyles.slice(
      mediaRule,
      adminStyles.indexOf("{", mediaRule),
    );

    expect(mediaHeader).toContain("max-width: 1240px");
  });

  it("creates, version-updates, disables, enables, and confirms deletion", async () => {
    let agents = structuredClone(platformAgents.agents);
    const calls: Array<{ method: string; path: string; body: unknown }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = requestPath(input);
        const method = init?.method ?? "GET";
        const body =
          typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
        calls.push({ method, path, body });
        if (path === "/api/v1/me") {
          return json({
            user: {
              userId: "admin-1",
              authSubject: "managed:admin@example.com",
              role: "admin",
            },
          });
        }
        if (path === "/api/v1/admin/users") return json(adminUsers);
        if (path === "/api/v1/admin/platform-agents" && method === "GET") {
          return json({ agents });
        }
        if (path === "/api/v1/admin/platform-agents" && method === "POST") {
          const created = {
            id: "00000000-0000-4000-8000-000000000004",
            ...body,
            arkVersion: "1",
            status: "active",
            lastErrorCode: null,
          };
          agents = [...agents, created];
          return json(created, 201);
        }
        if (
          path === `/api/v1/admin/platform-agents/${agentId}` &&
          method === "PATCH"
        ) {
          const current = agents.find((agent) => agent.id === agentId)!;
          const updated = {
            ...current,
            ...body,
            arkVersion: "status" in (body as object) ? current.arkVersion : "5",
          };
          agents = agents.map((agent) =>
            agent.id === agentId ? updated : agent,
          );
          return json(updated);
        }
        if (
          path === `/api/v1/admin/platform-agents/${disabledAgentId}` &&
          method === "PATCH"
        ) {
          const current = agents.find((agent) => agent.id === disabledAgentId)!;
          const updated = { ...current, ...body };
          agents = agents.map((agent) =>
            agent.id === disabledAgentId ? updated : agent,
          );
          return json(updated);
        }
        if (
          path === `/api/v1/admin/platform-agents/${disabledAgentId}` &&
          method === "DELETE"
        ) {
          agents = agents.filter((agent) => agent.id !== disabledAgentId);
          return noContent();
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
        throw new Error(`Unexpected request: ${method} ${path}`);
      }),
    );

    renderApp("/admin/platform-agents");
    const user = userEvent.setup();
    await screen.findByRole("heading", { name: "Platform Agents" });

    const createTrigger = screen.getByRole("button", {
      name: "New platform Agent",
    });
    await user.click(createTrigger);
    await waitFor(() =>
      expect(screen.getByLabelText("Agent name")).toHaveFocus(),
    );
    await user.type(screen.getByLabelText("Agent name"), "Code reviewer");
    await user.type(screen.getByLabelText("Description"), "Reviews changes");
    await user.selectOptions(screen.getByLabelText("Model"), "model-c");
    await user.type(screen.getByLabelText("System"), "Review carefully.");
    await user.click(screen.getByRole("button", { name: "Create Agent" }));
    expect(await screen.findByText("Code reviewer")).toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: "Edit Research assistant" }),
    );
    const name = screen.getByLabelText("Agent name");
    await user.clear(name);
    await user.type(name, "Research lead");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByText("Research lead")).toBeInTheDocument();
    expect(screen.getByText("5")).toBeInTheDocument();

    await openRowMenu(user, "Research lead");
    await user.click(screen.getByRole("menuitem", { name: "Disable" }));
    await waitFor(() =>
      expect(
        calls.some(
          (call) =>
            call.method === "PATCH" &&
            call.path.endsWith(agentId) &&
            (call.body as { status?: string }).status === "disabled",
        ),
      ).toBe(true),
    );

    await openRowMenu(user, "Legacy assistant");
    await user.click(screen.getByRole("menuitem", { name: "Enable" }));
    await waitFor(() =>
      expect(
        calls.some(
          (call) =>
            call.method === "PATCH" &&
            call.path.endsWith(disabledAgentId) &&
            (call.body as { status?: string }).status === "active",
        ),
      ).toBe(true),
    );

    const menuTrigger = screen.getByRole("button", {
      name: "Actions for Legacy assistant",
    });
    await user.click(menuTrigger);
    const deleteMenuItem = screen.getByRole("menuitem", { name: "Delete" });
    await user.click(deleteMenuItem);
    const firstDialog = screen.getByRole("dialog", {
      name: "Delete platform Agent?",
    });
    await waitFor(() =>
      expect(
        within(firstDialog).getByRole("button", { name: "Cancel" }),
      ).toHaveFocus(),
    );
    within(firstDialog)
      .getByRole("button", { name: "Close platform Agent deletion" })
      .focus();
    await user.tab({ shift: true });
    expect(
      within(firstDialog).getByRole("button", { name: "Delete Agent" }),
    ).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    await user.click(menuTrigger);
    await user.click(screen.getByRole("menuitem", { name: "Delete" }));
    await user.click(
      within(
        screen.getByRole("dialog", { name: "Delete platform Agent?" }),
      ).getByRole("button", { name: "Delete Agent" }),
    );
    await waitFor(() =>
      expect(screen.queryByText("Legacy assistant")).not.toBeInTheDocument(),
    );

    expect(
      calls.find(
        (call) =>
          call.method === "POST" &&
          call.path === "/api/v1/admin/platform-agents",
      )?.body,
    ).toEqual({
      name: "Code reviewer",
      description: "Reviews changes",
      modelId: "model-c",
      systemPrompt: "Review carefully.",
    });
    expect(
      calls.find(
        (call) =>
          call.method === "PATCH" &&
          call.path.endsWith(agentId) &&
          (call.body as { name?: string }).name === "Research lead",
      )?.body,
    ).toEqual({
      name: "Research lead",
      description: "Company research",
      modelId: longModelId,
      systemPrompt: "Use primary sources.",
      arkVersion: "4",
    });
    expect(
      calls.some(
        (call) =>
          call.method === "PATCH" &&
          call.path.endsWith(agentId) &&
          (call.body as { status?: string }).status === "disabled",
      ),
    ).toBe(true);
    expect(
      calls.some(
        (call) =>
          call.method === "PATCH" &&
          call.path.endsWith(disabledAgentId) &&
          (call.body as { status?: string }).status === "active",
      ),
    ).toBe(true);
  });

  it("keeps the current-version editor open when Ark reports a conflict", async () => {
    const base = adminHandler();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = requestPath(input);
        if (
          path === `/api/v1/admin/platform-agents/${agentId}` &&
          init?.method === "PATCH"
        ) {
          return apiError("ARK_CONFLICT", 409);
        }
        return base(input);
      }),
    );

    renderApp("/admin/platform-agents");
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", {
        name: "Edit Research assistant",
      }),
    );
    expect(screen.getByText("Current Ark version: 4")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    expect(
      await screen.findByText(
        "This Agent changed elsewhere. Reload the page before saving again.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("dialog", { name: "Edit Agent" }),
    ).toBeInTheDocument();
  });

  it("shows retryable Ark failures without leaking provider details", async () => {
    const base = adminHandler();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = requestPath(input);
        if (
          path === `/api/v1/admin/platform-agents/${agentId}` &&
          init?.method === "PATCH"
        ) {
          return apiError("ARK_UNAVAILABLE", 503, true);
        }
        return base(input);
      }),
    );

    renderApp("/admin/platform-agents");
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", {
        name: "Actions for Research assistant",
      }),
    );
    await user.click(screen.getByRole("menuitem", { name: "Disable" }));

    expect(
      await screen.findByText("Ark is temporarily unavailable. Try again."),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("must-not-render-ark-id"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("must-not-render-api-key"),
    ).not.toBeInTheDocument();
  });

  it("keeps protected deletion open and explains reference conflicts", async () => {
    const base = adminHandler();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = requestPath(input);
        if (
          path === `/api/v1/admin/platform-agents/${agentId}` &&
          init?.method === "DELETE"
        ) {
          return apiError("VALIDATION_FAILED", 409);
        }
        return base(input);
      }),
    );

    renderApp("/admin/platform-agents");
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", {
        name: "Actions for Research assistant",
      }),
    );
    await user.click(screen.getByRole("menuitem", { name: "Delete" }));
    const dialog = screen.getByRole("dialog", {
      name: "Delete platform Agent?",
    });
    await user.click(
      within(dialog).getByRole("button", { name: "Delete Agent" }),
    );

    expect(
      await within(dialog).findByText(
        "This Agent is still assigned to users or referenced by Sessions.",
      ),
    ).toBeInTheDocument();
    expect(screen.getAllByText("Research assistant")).toHaveLength(2);
    expect(dialog).toBeInTheDocument();
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
        name: "Save default Agent for user@example.com",
      }),
      screen.getByRole("button", {
        name: "Save quotas for user@example.com",
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
      "Personal Agent limit for user@example.com",
    );
    await user.clear(quotaInput);
    await user.type(quotaInput, "77");
    await user.selectOptions(
      screen.getByLabelText("Default Agent for user@example.com"),
      agentId,
    );
    const saveDefaultAgent = screen.getByRole("button", {
      name: "Save default Agent for user@example.com",
    });
    await user.click(saveDefaultAgent);

    expect(await screen.findByText("Default Agent saved.")).toBeInTheDocument();
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
      "Default Agent for user@example.com",
    );
    await user.selectOptions(agentSelect, disabledAgentId);
    const quotaInput = screen.getByLabelText(
      "Personal Agent limit for user@example.com",
    );
    await user.clear(quotaInput);
    await user.type(quotaInput, "78");
    await user.click(
      screen.getByRole("button", {
        name: "Save quotas for user@example.com",
      }),
    );

    expect(await screen.findByText("Quotas saved.")).toBeInTheDocument();
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

    const agentSelect = screen.getByLabelText(
      "Default Agent for user@example.com",
    );
    expect(
      within(agentSelect).getByRole("option", { name: "Legacy assistant" }),
    ).toBeDisabled();
    await user.selectOptions(agentSelect, agentId);
    await user.click(
      screen.getByRole("button", {
        name: "Save default Agent for user@example.com",
      }),
    );
    expect(await screen.findByText("Default Agent saved.")).toBeInTheDocument();
    expect(
      calls.filter(
        (call) => call.method === "PUT" && call.path.endsWith("/default-agent"),
      ),
    ).toHaveLength(1);
    expect(calls.some((call) => call.path.endsWith("/quota"))).toBe(false);

    const saveQuotas = screen.getByRole("button", {
      name: "Save quotas for user@example.com",
    });
    const quotaValues = [
      ["Personal Agent limit for user@example.com", "12"],
      ["Concurrent Session limit for user@example.com", "3"],
      ["Daily Session limit for user@example.com", "30"],
      ["Monthly token limit for user@example.com", "200000"],
    ] as const;
    for (const [label, value] of quotaValues) {
      const input = screen.getByLabelText(label);
      await user.clear(input);
      await user.type(input, value);
    }
    await user.click(saveQuotas);
    expect(await screen.findByText("Quotas saved.")).toBeInTheDocument();
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
      screen.getByLabelText("Monthly token limit for user@example.com"),
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
    await user.click(await screen.findByRole("button", { name: "New user" }));

    await user.type(screen.getByLabelText("Email"), "Newcomer@Example.com");
    await user.type(screen.getByLabelText("Password"), "newcomer-password");
    await user.type(
      screen.getByLabelText("Confirm password"),
      "newcomer-password",
    );
    await user.click(screen.getByRole("button", { name: "Create user" }));

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
    await user.click(await screen.findByRole("button", { name: "New user" }));
    await user.type(screen.getByLabelText("Email"), "newcomer@example.com");
    await user.type(screen.getByLabelText("Password"), "newcomer-password");
    await user.type(screen.getByLabelText("Confirm password"), "different");

    expect(screen.getByRole("button", { name: "Create user" })).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "Create user" }));
    expect(calls.some((call) => call.method === "POST")).toBe(false);
  });

  it("resets a password from the account detail", async () => {
    const { calls } = await createUserHandler();

    renderApp(`/admin/users/${userId}`);
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", {
        name: "Reset password for user@example.com",
      }),
    );
    await user.type(screen.getByLabelText("New password"), "rotated-password");
    await user.type(
      screen.getByLabelText("Confirm password"),
      "rotated-password",
    );
    await user.click(screen.getByRole("button", { name: "Reset password" }));

    expect(await screen.findByText("Password reset.")).toBeInTheDocument();
    const resetCall = calls.find((call) => call.path.endsWith("/password"));
    expect(resetCall?.path).toBe(`/api/v1/admin/users/${userId}/password`);
    expect(resetCall?.body).toEqual({ password: "rotated-password" });
  });
});
