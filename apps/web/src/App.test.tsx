// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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
import { MemoryRouter, useLocation } from "react-router-dom";
import { App } from "./App.js";

const pageStyles = readFileSync(
  resolve(
    process.cwd(),
    process.cwd().endsWith("apps/web")
      ? "src/styles.css"
      : "apps/web/src/styles.css",
  ),
  "utf8",
);

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

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
  MockEventSource.instances = [];
  vi.stubGlobal("EventSource", MockEventSource);
  setMobileViewport(false);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("authentication", () => {
  it("routes unauthenticated users through email-code login and normalizes expired codes", async () => {
    let authenticated = false;
    let verificationAttempts = 0;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const path = new URL(String(input), "http://localhost").pathname;
      if (path === "/api/v1/me") {
        return authenticated
          ? json({
              user: {
                userId: "user-1",
                authSubject: "managed:user@example.com",
                role: "user",
              },
            })
          : apiError("AUTH_REQUIRED", 401);
      }
      if (path === "/api/v1/auth/email-code") {
        return json({ accepted: true }, 202);
      }
      if (path === "/api/v1/auth/verify") {
        verificationAttempts += 1;
        if (verificationAttempts === 1) {
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
      await screen.findByRole("heading", { name: "Sign in to your workspace" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "Quarterly plan" }),
    ).not.toBeInTheDocument();

    const email = screen.getByLabelText("Email");
    expect(email).toHaveAccessibleDescription(
      "Use your work email. No password is required.",
    );
    await user.type(email, "User@Example.com");
    await user.click(screen.getByRole("button", { name: "Send code" }));
    expect(
      await screen.findByText("We sent a code to user@example.com."),
    ).toBeInTheDocument();

    const verificationCode = screen.getByLabelText("Verification code");
    expect(verificationCode).toHaveAccessibleDescription(
      "We sent a code to user@example.com.",
    );
    await user.type(verificationCode, "000000");
    await user.click(
      screen.getByRole("button", { name: "Verify and sign in" }),
    );
    expect(
      await screen.findByText(
        "The code is invalid or expired. Request a new code and try again.",
      ),
    ).toBeInTheDocument();
    expect(verificationCode).toHaveAccessibleDescription(
      "The code is invalid or expired. Request a new code and try again.",
    );

    await user.clear(verificationCode);
    await user.type(verificationCode, "123456");
    await user.click(
      screen.getByRole("button", { name: "Verify and sign in" }),
    );
    expect(
      await screen.findByRole("heading", { name: "Session" }),
    ).toBeInTheDocument();
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

    const logout = await screen.findByRole("button", { name: "Sign out" });
    expect(logout).toHaveAttribute("title", "Sign out");
    await user.click(logout);
    expect(
      await screen.findByRole("heading", { name: "Sign in to your workspace" }),
    ).toBeInTheDocument();
  });

  it.each([401, 403])(
    "treats a %i /me response as unauthenticated",
    async (status) => {
      vi.mocked(fetch).mockResolvedValue(apiError("AUTH_REQUIRED", status));

      renderApp();

      expect(
        await screen.findByRole("heading", {
          name: "Sign in to your workspace",
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
      await screen.findByRole("heading", { name: "Workspace unavailable" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "Sign in to your workspace" }),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(
      await screen.findByRole("heading", { name: "New task" }),
    ).toBeInTheDocument();
  });
});

describe("workspace shell", () => {
  it("shows compact navigation, active Sessions, and keyboard-operable drawer state", async () => {
    vi.mocked(fetch).mockImplementation(authenticatedHandler());
    renderApp();
    const user = userEvent.setup();

    expect(
      await screen.findByRole("heading", { name: "New task" }),
    ).toBeInTheDocument();
    const navigation = screen.getByRole("navigation", { name: "Workspace" });
    expect(navigation).toHaveClass("ui-app-shell__navigation");
    for (const name of [
      "New task",
      "Agents",
      "My files",
      "Context",
      "Settings",
    ]) {
      expect(
        within(navigation).getByRole("link", { name }),
      ).toBeInTheDocument();
    }
    expect(within(navigation).getByText("Quarterly plan")).toBeInTheDocument();
    expect(within(navigation).getByText("Running")).toBeInTheDocument();

    const menu = screen.getByRole("button", { name: "Open navigation" });
    const sidebar = screen.getByRole("complementary");
    expect(sidebar).toHaveAttribute("id", menu.getAttribute("aria-controls"));
    expect(menu).toHaveAttribute("title", "Open navigation");
    expect(menu).toHaveAttribute("aria-expanded", "false");
    await user.click(menu);
    expect(menu).toHaveAttribute("aria-expanded", "true");
    expect(menu).toHaveAttribute("aria-label", "Close navigation");
    expect(menu).toHaveAttribute("title", "Close navigation");
    await user.keyboard("{Escape}");
    expect(menu).toHaveAttribute("aria-expanded", "false");

    await user.click(within(navigation).getByRole("link", { name: "Context" }));
    expect(
      await screen.findByRole("heading", { name: "Context" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Not available yet")).toBeInTheDocument();
    expect(screen.queryByRole("form")).not.toBeInTheDocument();
  });

  it("removes the closed mobile drawer from the accessibility tree and tab order", async () => {
    setMobileViewport(true);
    vi.mocked(fetch).mockImplementation(authenticatedHandler());
    renderApp();
    const user = userEvent.setup();

    await screen.findByRole("heading", { name: "New task" });
    const sidebar = screen.getByRole("complementary", { hidden: true });
    const menu = screen.getByRole("button", { name: "Open navigation" });

    expect(sidebar).toHaveAttribute("aria-hidden", "true");
    expect(sidebar).toHaveAttribute("inert");
    await user.tab();
    expect(menu).toHaveFocus();

    await user.click(menu);
    expect(sidebar).not.toHaveAttribute("aria-hidden");
    expect(sidebar).not.toHaveAttribute("inert");
    const closeNavigationControls = screen.getAllByRole("button", {
      name: "Close navigation",
    });
    expect(closeNavigationControls).toHaveLength(2);
    await user.click(closeNavigationControls[1]!);
    expect(sidebar).toHaveAttribute("aria-hidden", "true");
    expect(menu).toHaveAttribute("aria-expanded", "false");

    await user.click(menu);
    (document.activeElement as HTMLElement).blur();
    await user.tab();
    expect(screen.getByRole("link", { name: "New task" })).toHaveFocus();

    await user.keyboard("{Escape}");
    expect(sidebar).toHaveAttribute("aria-hidden", "true");
    expect(sidebar).toHaveAttribute("inert");
    (document.activeElement as HTMLElement).blur();
    await user.tab();
    expect(menu).toHaveFocus();

    await user.click(menu);
    await user.click(screen.getByRole("link", { name: /Quarterly plan/ }));
    expect(sidebar).toHaveAttribute("aria-hidden", "true");
    expect(menu).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByLabelText("Current location")).toHaveTextContent(
      `/sessions/${sessionId}`,
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
      await screen.findByText(
        "No default Agent is available. Contact an administrator to continue.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send task" })).toBeDisabled();
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
      await screen.findByText(
        "Monthly token quota is exhausted. Existing work remains available.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send task" })).toBeDisabled();
  });
});

describe("Agent management", () => {
  it("uses shared page primitives and compact typed Agent records", async () => {
    vi.mocked(fetch).mockImplementation(authenticatedHandler());

    renderApp("/agents");
    const user = userEvent.setup();

    const heading = await screen.findByRole("heading", { name: "Agents" });
    expect(screen.getAllByRole("main")).toHaveLength(1);
    expect(heading.closest("header")).toHaveClass("ui-page-header");

    const platformSection = screen.getByRole("region", {
      name: "Platform provided",
    });
    const personalSection = screen.getByRole("region", {
      name: "My Agents",
    });
    expect(
      within(platformSection)
        .getByRole("heading", { name: "Platform provided" })
        .closest("header"),
    ).toHaveClass("ui-section-header");
    expect(
      within(personalSection)
        .getByRole("heading", { name: "My Agents" })
        .closest("header"),
    ).toHaveClass("ui-section-header");
    expect(
      within(platformSection).getByRole("list", {
        name: "Platform Agents",
      }),
    ).toHaveClass("agent-records");
    expect(
      within(personalSection).getByRole("list", {
        name: "Personal Agents",
      }),
    ).toHaveClass("agent-records");
    expect(
      within(platformSection).getByText("Platform").closest(".ui-badge"),
    ).toHaveClass("ui-badge");
    expect(
      within(personalSection).getByText("Personal").closest(".ui-badge"),
    ).toHaveClass("ui-badge");

    const newAgent = screen.getByRole("button", {
      name: "New personal Agent",
    });
    expect(newAgent).toHaveClass("ui-button", "ui-button--primary");
    expect(
      within(personalSection).getByRole("button", {
        name: "Edit Writing assistant",
      }),
    ).toHaveClass("ui-button", "ui-button--secondary");
    expect(
      within(personalSection).getByRole("button", {
        name: "Delete Writing assistant",
      }),
    ).toHaveClass("ui-button", "ui-button--text");

    await user.click(newAgent);
    const dialog = screen.getByRole("dialog", { name: "Create Agent" });
    expect(dialog).toHaveClass("ui-dialog");
    expect(
      within(dialog).getByRole("button", { name: "Close Agent editor" }),
    ).toBeInTheDocument();
  });

  it("uses only the server capability allowlist for personal Agent models", async () => {
    vi.mocked(fetch).mockImplementation(
      authenticatedHandler({
        capabilities: { personalAgentModels: ["model-c"] },
      }),
    );

    renderApp("/agents");
    const user = userEvent.setup();
    const trigger = await screen.findByRole("button", {
      name: "New personal Agent",
    });
    await user.click(trigger);

    const model = screen.getByLabelText("Model");
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
      await screen.findByRole("heading", { name: "Platform provided" }),
    ).toBeInTheDocument();
    const platformSection = screen.getByRole("region", {
      name: "Platform provided",
    });
    expect(
      within(platformSection).getByText("Research assistant"),
    ).toBeVisible();
    expect(
      within(platformSection).queryByRole("button", { name: /Edit/ }),
    ).not.toBeInTheDocument();

    const newAgentTrigger = screen.getByRole("button", {
      name: "New personal Agent",
    });
    await user.click(newAgentTrigger);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByLabelText("Agent name")).toHaveFocus();
    });
    screen.getByRole("button", { name: "Close Agent editor" }).focus();
    await user.tab({ shift: true });
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(newAgentTrigger).toHaveFocus();
    await user.click(newAgentTrigger);
    await user.type(screen.getByLabelText("Agent name"), "Code reviewer");
    await user.type(screen.getByLabelText("Description"), "Reviews changes");
    await user.selectOptions(screen.getByLabelText("Model"), "model-a");
    await user.type(
      screen.getByLabelText("System Prompt"),
      "Review carefully.",
    );
    await user.click(screen.getByRole("button", { name: "Create Agent" }));
    expect(await screen.findByText("Code reviewer")).toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: "Edit Writing assistant" }),
    );
    const name = await screen.findByLabelText("Agent name");
    await user.clear(name);
    await user.type(name, "Editorial assistant");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByText("Editorial assistant")).toBeInTheDocument();

    const deleteAgentTrigger = screen.getByRole("button", {
      name: "Delete Editorial assistant",
    });
    await user.click(deleteAgentTrigger);
    const dialog = screen.getByRole("dialog", {
      name: "Delete personal Agent?",
    });
    await waitFor(() => {
      expect(
        within(dialog).getByRole("button", { name: "Cancel" }),
      ).toHaveFocus();
    });
    await user.tab({ shift: true });
    expect(
      within(dialog).getByRole("button", { name: "Delete Agent" }),
    ).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(deleteAgentTrigger).toHaveFocus();
    await user.click(deleteAgentTrigger);
    const reopenedDeleteDialog = screen.getByRole("dialog", {
      name: "Delete personal Agent?",
    });
    await user.click(
      within(reopenedDeleteDialog).getByRole("button", {
        name: "Delete Agent",
      }),
    );
    await waitFor(() => {
      expect(screen.queryByText("Editorial assistant")).not.toBeInTheDocument();
    });
    expect(screen.getByRole("heading", { name: "Agents" })).toHaveFocus();

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
      await screen.findByRole("button", { name: "Edit Writing assistant" }),
    );
    await user.click(
      await screen.findByRole("button", { name: "Save changes" }),
    );

    expect(
      await screen.findByText(
        "This Agent changed elsewhere. Close and reopen the editor, then try again.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
});

describe("Session page", () => {
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
    await user.type(screen.getByLabelText("Message"), "Pending old action");
    await user.click(screen.getByRole("button", { name: "Send message" }));

    await user.click(screen.getByRole("link", { name: /Second Session/ }));

    expect(
      screen.queryByRole("heading", { name: "Quarterly plan" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Old Session response")).not.toBeInTheDocument();
    expect(screen.getByText("Loading Session…")).toBeInTheDocument();
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
    expect(screen.getByLabelText("Message")).toBeEnabled();
    expect(screen.getByLabelText("Message")).toHaveValue("");
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
    const archivedRegion = await screen.findByRole("region", {
      name: "Archived Sessions",
    });
    expect(
      within(archivedRegion).getByRole("link", { name: /Archived research/ }),
    ).toBeInTheDocument();
    expect(calls).toContain("GET /api/v1/sessions?archived=true");

    await user.click(
      within(archivedRegion).getByRole("link", { name: /Archived research/ }),
    );
    await user.click(
      await screen.findByRole("button", { name: "Restore Session" }),
    );

    expect(
      within(screen.getByRole("region", { name: "Active Sessions" })).getByRole(
        "link",
        { name: /Archived research/ },
      ),
    ).toBeInTheDocument();
    expect(
      within(
        screen.getByRole("region", { name: "Archived Sessions" }),
      ).queryByRole("link", { name: /Archived research/ }),
    ).not.toBeInTheDocument();
  });

  it("renders ordered deduplicated events without exposing reasoning text and closes SSE", async () => {
    vi.mocked(fetch).mockImplementation(authenticatedHandler());
    const rendered = renderApp(`/sessions/${sessionId}`);

    expect(
      await screen.findByRole("heading", { name: "Quarterly plan" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Research assistant")).toBeInTheDocument();
    expect(screen.getByText("Version 4")).toBeInTheDocument();
    expect(screen.getByText("brief.txt")).toBeInTheDocument();

    const source = MockEventSource.instances[0]!;
    expect(source.url).toBe(`/api/v1/sessions/${sessionId}/events`);
    expect(source.withCredentials).toBe(true);
    act(() => {
      source.emitOpen();
      source.emit("user.message", {
        id: "event-1",
        sourceType: "user.message",
        type: "unknown",
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
      source.emit("tool.call", {
        id: "event-3",
        sourceType: "tool.call",
        type: "tool",
        createdAt: "2026-09-07T08:03:00.000Z",
        payload: { name: "search", status: "running" },
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
    expect(screen.getByText("Reconnecting…")).toBeInTheDocument();
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

    const timeline = screen.getByLabelText("Session timeline");
    expect(
      Array.from(timeline.querySelectorAll("[data-event-id]")).map((item) =>
        item.getAttribute("data-event-id"),
      ),
    ).toEqual([
      "event-1",
      "event-2",
      "event-3",
      "event-4",
      "event-5",
      "event-6",
    ]);
    expect(screen.getByText("Prepare the plan")).toBeInTheDocument();
    expect(screen.getByText("Agent is thinking…")).toBeInTheDocument();
    expect(
      screen.queryByText("private chain of thought"),
    ).not.toBeInTheDocument();
    expect(screen.getByText("search · Running")).toBeInTheDocument();
    expect(screen.getByText("Recoverable error")).toBeInTheDocument();
    expect(screen.getByText("Execution stopped")).toBeInTheDocument();
    expect(screen.getAllByText("Terminated")).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
    expect(screen.getByText("Ended")).toBeInTheDocument();
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

    await user.type(screen.getByLabelText("Message"), "Add risks");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    expect(await screen.findByText("Message queued.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Interrupt Session" }));
    expect(await screen.findByText("Interrupt requested.")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Session actions" }));
    await user.click(screen.getByRole("button", { name: "Archive Session" }));
    expect(
      await screen.findByRole("button", { name: "Restore Session" }),
    ).toBeInTheDocument();
    expect(
      within(
        screen.getByRole("region", { name: "Archived Sessions" }),
      ).getByRole("link", { name: /Quarterly plan/ }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Restore Session" }));
    expect(
      within(screen.getByRole("region", { name: "Active Sessions" })).getByRole(
        "link",
        { name: /Quarterly plan/ },
      ),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Session actions" }));
    await user.click(
      screen.getByRole("button", { name: "Delete Session permanently" }),
    );
    const firstDialog = screen.getByRole("dialog", {
      name: "Delete Session permanently?",
    });
    await waitFor(() => {
      expect(
        within(firstDialog).getByLabelText("Type DELETE to confirm"),
      ).toHaveFocus();
    });
    await user.type(
      within(firstDialog).getByLabelText("Type DELETE to confirm"),
      "DELETE",
    );
    expect(
      within(firstDialog).getByRole("button", { name: "Delete permanently" }),
    ).toBeEnabled();
    within(firstDialog)
      .getByRole("button", { name: "Close deletion confirmation" })
      .focus();
    await user.tab({ shift: true });
    expect(
      within(firstDialog).getByRole("button", { name: "Delete permanently" }),
    ).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Session actions" }),
    ).toHaveFocus();
    await user.click(screen.getByRole("button", { name: "Session actions" }));
    await user.click(
      screen.getByRole("button", { name: "Delete Session permanently" }),
    );
    const reopenedDialog = screen.getByRole("dialog", {
      name: "Delete Session permanently?",
    });
    const confirmDelete = within(reopenedDialog).getByRole("button", {
      name: "Delete permanently",
    });
    expect(confirmDelete).toBeDisabled();
    await user.type(
      within(reopenedDialog).getByLabelText("Type DELETE to confirm"),
      "DELETE",
    );
    await user.click(confirmDelete);

    expect(
      await screen.findByText("Permanent deletion pending"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Quarterly plan" }),
    ).toHaveFocus();
    expect(screen.getByLabelText("Current location")).toHaveTextContent(
      `/sessions/${sessionId}`,
    );
    expect(screen.getByLabelText("Message")).toBeDisabled();
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
      await user.click(screen.getByRole("button", { name: "Session actions" }));
      await user.click(
        screen.getByRole("button", { name: "Delete Session permanently" }),
      );
      return screen.getByRole("dialog", {
        name: "Delete Session permanently?",
      });
    };
    const expectFreshConfirmation = (dialog: HTMLElement) => {
      expect(
        within(dialog).getByLabelText("Type DELETE to confirm"),
      ).toHaveValue("");
      expect(
        within(dialog).getByRole("button", { name: "Delete permanently" }),
      ).toBeDisabled();
    };

    let dialog = await openDeletionDialog();
    await user.type(
      within(dialog).getByLabelText("Type DELETE to confirm"),
      "DELETE",
    );
    await user.click(
      within(dialog).getByRole("button", {
        name: "Close deletion confirmation",
      }),
    );

    dialog = await openDeletionDialog();
    expectFreshConfirmation(dialog);
    await user.type(
      within(dialog).getByLabelText("Type DELETE to confirm"),
      "DELETE",
    );
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));

    dialog = await openDeletionDialog();
    expectFreshConfirmation(dialog);
    await user.type(
      within(dialog).getByLabelText("Type DELETE to confirm"),
      "DELETE",
    );
    await user.click(
      within(dialog).getByRole("button", { name: "Delete permanently" }),
    );
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

    expect(
      await screen.findByText("Permanent deletion failed"),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Message")).toBeDisabled();
  });
});

describe("artifact management", () => {
  it("uses shared file controls, statuses, and responsive artifact records", async () => {
    vi.mocked(fetch).mockImplementation(authenticatedHandler());

    renderApp("/files");
    const user = userEvent.setup();

    const heading = await screen.findByRole("heading", { name: "My files" });
    expect(await screen.findByText("quarterly-plan.pdf")).toBeInTheDocument();
    expect(screen.getAllByRole("main")).toHaveLength(1);
    expect(heading.closest("header")).toHaveClass("ui-page-header");
    expect(screen.getByLabelText("Filter by Session")).toHaveClass("ui-select");
    expect(
      screen.getByText("Deletion failed").closest(".ui-badge"),
    ).toHaveClass("ui-badge", "ui-badge--danger");
    expect(
      screen.getByRole("link", { name: "Download quarterly-plan.pdf" }),
    ).toHaveClass("ui-icon-button", "ui-icon-button--small");
    const deleteArtifact = screen.getByRole("button", {
      name: "Delete quarterly-plan.pdf",
    });
    expect(deleteArtifact).toHaveClass(
      "ui-icon-button",
      "ui-icon-button--small",
    );
    const mimeType = screen.getByText(longDocumentMimeType);
    expect(mimeType.parentElement).toHaveClass("artifact-record__metadata");
    expect(pageStyles).toMatch(
      /@media \(max-width: 760px\)[\s\S]*?\.artifact-record__metadata\s*\{[\s\S]*?display:\s*grid/,
    );
    const [metadataRule] = findStyleRules(".artifact-record__metadata");
    const [metadataItemRule] = findStyleRules(
      ".artifact-record__metadata > span",
    );
    expect(metadataRule?.style.minWidth).toBe("0px");
    expect(metadataItemRule?.style.minWidth).toBe("0px");
    expect(metadataItemRule?.style.overflowWrap).toBe("anywhere");

    await user.click(deleteArtifact);
    const dialog = screen.getByRole("dialog", { name: "Delete artifact?" });
    expect(dialog).toHaveClass("ui-dialog");
    expect(
      within(dialog).getByRole("button", {
        name: "Close artifact deletion",
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

    const error = await screen.findByText("Artifacts could not be loaded.");
    expect(error.closest(".ui-empty-state")).toBeInTheDocument();
    const retry = screen.getByRole("button", { name: "Retry" });
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
      await screen.findByRole("heading", { name: "My files" }),
    ).toBeInTheDocument();
    expect(await screen.findByText("quarterly-plan.pdf")).toBeInTheDocument();
    expect(screen.getByText("1.5 KB")).toBeInTheDocument();
    expect(screen.getByText("Deletion failed")).toBeInTheDocument();
    expect(screen.queryByText("brief.txt")).not.toBeInTheDocument();
    expect(
      screen
        .getByLabelText("Filter by Session")
        .querySelector(`option[value="${createdSessionId}"]`),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Download quarterly-plan.pdf" }),
    ).toHaveAttribute("href", `/api/v1/artifacts/${artifactId}/download`);

    await user.selectOptions(
      screen.getByLabelText("Filter by Session"),
      sessionId,
    );
    await waitFor(() => {
      expect(
        calls.some(
          (call) => call.path === `/api/v1/artifacts?sessionId=${sessionId}`,
        ),
      ).toBe(true);
    });

    const deleteArtifactTrigger = screen.getByRole("button", {
      name: "Delete quarterly-plan.pdf",
    });
    await user.click(deleteArtifactTrigger);
    const firstDialog = screen.getByRole("dialog", {
      name: "Delete artifact?",
    });
    await waitFor(() => {
      expect(
        within(firstDialog).getByRole("button", { name: "Cancel" }),
      ).toHaveFocus();
    });
    within(firstDialog)
      .getByRole("button", { name: "Close artifact deletion" })
      .focus();
    await user.tab({ shift: true });
    expect(
      within(firstDialog).getByRole("button", { name: "Delete artifact" }),
    ).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(deleteArtifactTrigger).toHaveFocus();
    await user.click(deleteArtifactTrigger);
    const dialog = screen.getByRole("dialog", { name: "Delete artifact?" });
    await user.click(
      within(dialog).getByRole("button", { name: "Delete artifact" }),
    );
    expect(await screen.findByText("Deletion pending")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "My files" })).toHaveFocus();
  });
});

describe("unavailable capabilities", () => {
  it("provides explicit Context, Skills, MCP, and Vault pages without controls", async () => {
    vi.mocked(fetch).mockImplementation(authenticatedHandler());
    renderApp("/settings");
    const user = userEvent.setup();

    await screen.findByRole("heading", { name: "Settings" });
    for (const [linkName, heading] of [
      ["Skills", "Skills"],
      ["MCP servers", "MCP"],
      ["Vault", "Vault"],
    ]) {
      await user.click(screen.getByRole("link", { name: linkName }));
      expect(
        await screen.findByRole("heading", { name: heading }),
      ).toBeInTheDocument();
      expect(screen.getByText("Not available yet")).toBeInTheDocument();
      expect(screen.queryByRole("form")).not.toBeInTheDocument();
      await user.click(screen.getByRole("link", { name: "Settings" }));
    }

    await user.click(screen.getByRole("link", { name: "Context" }));
    expect(
      await screen.findByRole("heading", { name: "Context" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Not available yet")).toBeInTheDocument();
    expect(screen.queryByRole("form")).not.toBeInTheDocument();
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
    await screen.findByRole("heading", { name: "New task" });

    const composer = screen.getByLabelText("Task message").closest("form");
    const attach = screen.getByRole("button", { name: "Attach files" });
    expect(composer).toHaveClass("composer");
    expect(attach).toHaveClass(
      "attachment-button",
      "ui-icon-button",
      "ui-icon-button--small",
    );

    const file = new File(["hello"], "brief.txt", { type: "text/plain" });
    await user.upload(screen.getByLabelText("File picker"), file);
    const remove = await screen.findByRole("button", {
      name: "Remove brief.txt",
    });
    expect(remove).toHaveClass(
      "small-control",
      "ui-icon-button",
      "ui-icon-button--small",
    );

    const [attachmentRule] = findStyleRules(".attachment-button");
    const [smallControlRule] = findStyleRules(".small-control");
    const [composerRule] = findStyleRules(".composer");
    expect(attachmentRule?.style.width).toBe("");
    expect(attachmentRule?.style.height).toBe("");
    expect(smallControlRule?.style.width).toBe("");
    expect(smallControlRule?.style.height).toBe("");
    expect(composerRule?.style.borderRadius).toBe("var(--ui-radius-large)");
    expect(findStyleRules(".ui-app-shell__main > .page")).toHaveLength(1);
  });

  it("retains a created Session and retries only its failed first message", async () => {
    const calls: FetchCall[] = [];
    let uploadAttempts = 0;
    let resolveCreate!: (response: Response) => void;
    let resolveMessage!: (response: Response) => void;
    let messageAttempts = 0;
    const createResponse = new Promise<Response>((resolve) => {
      resolveCreate = resolve;
    });
    const messageResponse = new Promise<Response>((resolve) => {
      resolveMessage = resolve;
    });

    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const path = new URL(String(input), "http://localhost").pathname;
      const method = init?.method ?? "GET";
      calls.push({ path, method, body: init?.body });

      if (path === "/api/v1/uploads") {
        uploadAttempts += 1;
        return uploadAttempts === 1
          ? apiError("ARK_UNAVAILABLE", 503, true)
          : json(
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
      if (path === "/api/v1/sessions" && method === "POST") {
        return createResponse;
      }
      if (path === `/api/v1/sessions/${createdSessionId}/messages`) {
        messageAttempts += 1;
        return messageAttempts === 1
          ? messageResponse
          : json({ eventId: "event-2", delivery: "accepted" }, 202);
      }
      return authenticatedHandler()(input, init);
    });

    renderApp();
    const user = userEvent.setup();
    await screen.findByRole("heading", { name: "New task" });

    const file = new File(["hello"], "brief.txt", { type: "text/plain" });
    await user.upload(screen.getByLabelText("File picker"), file);
    expect(
      await screen.findByText("brief.txt could not be uploaded."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send task" })).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "Retry upload" }));
    expect(await screen.findByText("Ready")).toBeInTheDocument();
    await user.type(
      screen.getByLabelText("Task message"),
      "Summarize the attached brief",
    );

    const send = screen.getByRole("button", { name: "Send task" });
    expect(send).toHaveAttribute("title", "Send task");
    await user.click(send);
    expect(await screen.findByText("Creating Session…")).toBeInTheDocument();

    resolveCreate(
      json(
        {
          ...sessionsResponse.sessions[0],
          id: createdSessionId,
          title: "Summarize the attached brief",
          status: "idle",
        },
        201,
      ),
    );

    await waitFor(() => {
      expect(screen.getByLabelText("Current location")).toHaveTextContent(
        `/sessions/${createdSessionId}`,
      );
    });
    expect(
      screen.getByRole("link", { name: /Summarize the attached brief/ }),
    ).toBeInTheDocument();
    expect(
      await screen.findByText("Connecting before first message…"),
    ).toBeInTheDocument();
    expect(
      calls.filter((call) => call.path.endsWith("/messages")),
    ).toHaveLength(0);
    const createdSource = MockEventSource.instances.find((source) =>
      source.url.includes(createdSessionId),
    )!;
    act(() => createdSource.emitOpen());
    expect(
      await screen.findByText("Sending first message…"),
    ).toBeInTheDocument();
    expect(
      within(
        document.querySelector<HTMLFormElement>(".session-composer")!,
      ).getByText("Sending first message…"),
    ).toBeInTheDocument();
    expect(document.querySelector(".session-delivery")).not.toBeInTheDocument();
    resolveMessage(apiError("ARK_UNAVAILABLE", 503, true));

    expect(
      await within(
        document.querySelector<HTMLFormElement>(".session-composer")!,
      ).findByText(
        "The first message could not be sent. Retry from this Session.",
      ),
    ).toBeInTheDocument();
    expect(document.querySelector(".session-delivery")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Current location")).toHaveTextContent(
      `/sessions/${createdSessionId}`,
    );

    await user.click(
      screen.getByRole("button", { name: "Retry first message" }),
    );
    await waitFor(() => {
      expect(
        screen.queryByRole("button", { name: "Retry first message" }),
      ).not.toBeInTheDocument();
    });

    const createCall = calls.find(
      (call) => call.path === "/api/v1/sessions" && call.method === "POST",
    );
    const messageCall = calls.find((call) => call.path.endsWith("/messages"));
    expect(JSON.parse(String(createCall?.body))).toEqual({
      agentId,
      uploadIds: [uploadId],
      title: "Summarize the attached brief",
    });
    expect(JSON.parse(String(messageCall?.body))).toEqual({
      content: "Summarize the attached brief",
    });
    expect(calls.indexOf(createCall!)).toBeLessThan(
      calls.indexOf(messageCall!),
    );
    expect(
      calls.filter(
        (call) => call.path === "/api/v1/sessions" && call.method === "POST",
      ),
    ).toHaveLength(1);
    expect(
      calls.filter((call) => call.path.endsWith("/messages")),
    ).toHaveLength(2);
  });
});
