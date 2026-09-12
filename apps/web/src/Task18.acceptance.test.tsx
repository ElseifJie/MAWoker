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
  await screen.findByRole("heading", { name: "Sign in to your workspace" });
  await user.type(screen.getByLabelText("Email"), email);
  await user.type(screen.getByLabelText("Password"), "acceptance-password");
  await user.click(screen.getByRole("button", { name: "Sign in" }));
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
    vi.stubGlobal("fetch", vi.fn(backend.fetch));
    renderApp();
    const user = await signIn("user-a@example.com");

    expect(
      await screen.findByRole("heading", { name: "New task" }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Agent")).toHaveValue(backend.platformAgentId);

    await user.upload(
      screen.getByLabelText("File picker"),
      new File(["acceptance input"], "brief.txt", { type: "text/plain" }),
    );
    expect(await screen.findByText("Ready")).toBeInTheDocument();
    await user.type(
      screen.getByLabelText("Task message"),
      "Prepare an acceptance report",
    );
    await user.click(screen.getByRole("button", { name: "Send task" }));

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
    await waitFor(() =>
      expect(backend.callsFor("POST", "/messages")).toHaveLength(1),
    );
    const sessionHeading = screen.getByRole("heading", {
      name: "Prepare an acceptance report",
    });
    const sessionMeta = sessionHeading
      .closest(".session-page")!
      .querySelector<HTMLElement>(".session-meta")!;
    expect(
      within(sessionMeta).getByText("Idle").closest(".ui-badge"),
    ).toHaveClass("ui-badge");
    expect(
      within(sessionMeta).getByText("Live").closest(".ui-badge"),
    ).toHaveClass("ui-badge", "ui-badge--success");
    expect(screen.getByRole("button", { name: "Send message" })).toHaveClass(
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
    expect(toolRow().textContent).toContain("Writing");
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
    expect(toolRow().textContent).toContain("Wrote");
    expect(toolRow().textContent).not.toContain("Writing");
    expect(toolRow().textContent).toContain("500ms");
    const preview = screen.getByText("Wrote /workspace/acceptance-report.md");
    expect(preview).toBeInTheDocument();
    expect(preview).not.toBeVisible();

    act(() => stream.emitError());
    expect(screen.getByText("Reconnecting…")).toBeVisible();
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

    await user.type(screen.getByLabelText("Message"), "Add the risk section");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    expect(await screen.findByText("Message queued.")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Interrupt Session" }));
    expect(await screen.findByText("Interrupt requested.")).toBeVisible();

    await user.click(screen.getByRole("link", { name: "Agents" }));
    await screen.findByRole("heading", { name: "Agents" });
    await user.click(
      screen.getByRole("button", { name: "New personal Agent" }),
    );
    await user.type(screen.getByLabelText("Agent name"), "Private reviewer");
    await user.type(screen.getByLabelText("Description"), "Checks reports");
    await user.selectOptions(screen.getByLabelText("Model"), "model-a");
    await user.type(screen.getByLabelText("System Prompt"), "Review safely.");
    await user.click(screen.getByRole("button", { name: "Create Agent" }));
    expect(await screen.findByText("Private reviewer")).toBeVisible();

    await user.click(
      screen.getByRole("button", { name: "Edit Private reviewer" }),
    );
    const agentName = await screen.findByLabelText("Agent name");
    await user.clear(agentName);
    await user.type(agentName, "Private editor");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByText("Private editor")).toBeVisible();
    await user.click(
      screen.getByRole("button", { name: "Delete Private editor" }),
    );
    await user.click(
      within(
        screen.getByRole("dialog", { name: "Delete personal Agent?" }),
      ).getByRole("button", { name: "Delete Agent" }),
    );
    await waitFor(() =>
      expect(screen.queryByText("Private editor")).not.toBeInTheDocument(),
    );

    await user.click(screen.getByRole("link", { name: "My files" }));
    expect(
      await screen.findByRole("heading", { name: "My files" }),
    ).toBeVisible();
    const download = screen.getByRole("link", {
      name: "Download acceptance-report.txt",
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
    await user.click(screen.getByRole("button", { name: "Session actions" }));
    await user.click(screen.getByRole("button", { name: "Archive Session" }));
    expect(
      await screen.findByRole("button", { name: "Restore Session" }),
    ).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Restore Session" }));
    await user.click(screen.getByRole("button", { name: "Session actions" }));
    await user.click(
      screen.getByRole("button", { name: "Delete Session permanently" }),
    );
    const dialog = screen.getByRole("dialog", {
      name: "Delete Session permanently?",
    });
    await user.type(
      within(dialog).getByLabelText("Type DELETE to confirm"),
      "DELETE",
    );
    await user.click(
      within(dialog).getByRole("button", { name: "Delete permanently" }),
    );

    expect(await screen.findByText("Permanent deletion pending")).toBeVisible();
    expect(backend.callsFor("POST", "/messages")).toHaveLength(2);
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
      await screen.findByRole("heading", { name: "Platform Agents" }),
    ).toBeVisible();
    await user.click(
      screen.getByRole("button", { name: "New platform Agent" }),
    );
    await user.type(screen.getByLabelText("Agent name"), "Operations Agent");
    await user.type(screen.getByLabelText("Description"), "Runs operations");
    await user.type(screen.getByLabelText("Model"), "model-a");
    await user.type(screen.getByLabelText("System Prompt"), "Operate safely.");
    await user.click(screen.getByRole("button", { name: "Create Agent" }));
    expect(await screen.findByText("Operations Agent")).toBeVisible();

    await user.click(
      screen.getByRole("button", { name: "Edit Operations Agent" }),
    );
    const name = screen.getByLabelText("Agent name");
    await user.clear(name);
    await user.type(name, "Operations Lead");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByText("Operations Lead")).toBeVisible();

    await user.click(screen.getByRole("link", { name: "Users" }));
    await screen.findByRole("heading", { name: "Users" });
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
      screen.getByLabelText("Default Agent for user-a@example.com"),
      backend.createdPlatformAgentId,
    );
    await user.click(
      screen.getByRole("button", {
        name: "Save default Agent for user-a@example.com",
      }),
    );
    expect(await screen.findByText("Default Agent saved.")).toBeVisible();

    const quotaValues = [
      ["Personal Agent limit for user-a@example.com", "12"],
      ["Concurrent Session limit for user-a@example.com", "3"],
      ["Daily Session limit for user-a@example.com", "30"],
      ["Monthly token limit for user-a@example.com", "2000"],
    ] as const;
    for (const [label, value] of quotaValues) {
      const input = screen.getByLabelText(label);
      await user.clear(input);
      await user.type(input, value);
    }
    await user.click(
      screen.getByRole("button", {
        name: "Save quotas for user-a@example.com",
      }),
    );
    expect(await screen.findByText("Quotas saved.")).toBeVisible();

    await user.click(screen.getByRole("link", { name: "Platform Agents" }));
    await user.click(
      await screen.findByRole("button", { name: "Disable Operations Lead" }),
    );
    expect(
      await screen.findByRole("button", { name: "Enable Operations Lead" }),
    ).toBeVisible();
    await user.click(
      screen.getByRole("button", { name: "Delete Operations Lead" }),
    );
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
    ).toBeVisible();

    expect(backend.platformAgentVersion()).toBe("2");
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
