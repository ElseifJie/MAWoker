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

const capacity = {
  count: 1,
  bytes: 7,
  maxEntryBytes: 7,
  countRatio: 0.0005,
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
let entries: Array<{ path: string; content: string }>;
let failure: { status: number; code: string } | null;
const fetchMock = vi.fn(
  async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (path === "/api/v1/me")
      return Response.json({
        user: { userId: "A", authSubject: "local:a", role: "user" },
      });
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
    if (failure && path.startsWith("/api/v1/memory"))
      return Response.json(
        { error: { code: failure.code, message: "Request failed" } },
        { status: failure.status },
      );
    if (path === "/api/v1/memory")
      return Response.json({ entries, capacity, state: currentState });
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
    if (path === "/api/v1/memory/dream" || path === "/api/v1/memory/compress") {
      currentState = {
        ...queued,
        run: {
          ...queued.run,
          kind: path.endsWith("dream") ? "dream" : "compress",
        },
      };
      return Response.json(currentState, { status: 202 });
    }
    throw new Error(`Unexpected request ${path}`);
  },
);
beforeEach(() => {
  currentState = state;
  entries = [{ path: "/memories/profile.md", content: "Profile" }];
  failure = null;
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
function open() {
  render(
    <MemoryRouter initialEntries={["/context"]}>
      <App />
    </MemoryRouter>,
  );
}

describe("MemoryPage", () => {
  it("loads the context route, directory, editor, capacity, and controls", async () => {
    open();
    expect(
      await screen.findByRole("heading", { name: "Context" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Context" })).toHaveAttribute(
      "href",
      "/context",
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "/memories/profile.md" }),
    );
    expect(screen.getByLabelText("Content")).toHaveValue("Profile");
    expect(screen.getByText(/1 \/ 2,000 entries/)).toBeInTheDocument();
    expect(screen.getByText(/7 bytes/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Dream" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Compress" })).toBeEnabled();
  });
  it("distinguishes queued saves from saved and refreshes after two-second polling", async () => {
    open();
    await screen.findByRole("heading", { name: "Context" });
    fireEvent.click(
      await screen.findByRole("button", { name: "/memories/profile.md" }),
    );
    fireEvent.change(screen.getByLabelText("Content"), {
      target: { value: "Updated" },
    });
    vi.useFakeTimers();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await act(async () => {});
    expect(screen.getByText(/Save queued.*not saved yet/i)).toBeInTheDocument();
    expect(screen.queryByText("Memory saved.")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/memory/entry",
      expect.objectContaining({
        method: "POST",
        credentials: "same-origin",
        body: JSON.stringify({
          path: "/memories/profile.md",
          content: "Updated",
        }),
      }),
    );
    currentState = { ...state, run: { ...queued.run, stage: "completed" } };
    entries = [{ path: "/memories/profile.md", content: "Updated" }];
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(screen.getByText("Memory saved.")).toBeInTheDocument();
    expect(screen.getByLabelText("Content")).toHaveValue("Updated");
    expect(
      fetchMock.mock.calls.filter(([url]) => url === "/api/v1/memory"),
    ).toHaveLength(2);
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
  it("creates a new path and sends protection and settings with strict payloads", async () => {
    open();
    fireEvent.click(
      await screen.findByRole("button", { name: "/memories/profile.md" }),
    );
    fireEvent.click(screen.getByLabelText("Protected"));
    await waitFor(() =>
      expect(screen.getByLabelText("Protected")).toBeChecked(),
    );
    fireEvent.click(screen.getByLabelText("Automatic Dream"));
    await waitFor(() =>
      expect(screen.getByLabelText("Automatic Dream")).not.toBeChecked(),
    );
    fireEvent.click(screen.getByRole("button", { name: "New entry" }));
    fireEvent.change(screen.getByLabelText("Path"), {
      target: { value: "/memories/new.md" },
    });
    fireEvent.change(screen.getByLabelText("Content"), {
      target: { value: "New fact" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText(/Save queued/i);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/memory/entry",
      expect.objectContaining({
        body: JSON.stringify({ path: "/memories/new.md", content: "New fact" }),
      }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/memory/protect",
      expect.objectContaining({
        body: JSON.stringify({ path: "/memories/profile.md", protected: true }),
      }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/memory/settings",
      expect.objectContaining({ body: JSON.stringify({ autoDream: false }) }),
    );
  });
  it.each(["Dream", "Compress", "Delete"])(
    "queues %s without claiming completion",
    async (label) => {
      open();
      fireEvent.click(
        await screen.findByRole("button", { name: "/memories/profile.md" }),
      );
      fireEvent.click(screen.getByRole("button", { name: label }));
      expect(await screen.findByText(/queued.*not .*yet/i)).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    },
  );
  it("shows a conflict without claiming that a save was accepted", async () => {
    open();
    fireEvent.click(
      await screen.findByRole("button", { name: "/memories/profile.md" }),
    );
    failure = { status: 409, code: "MEMORY_CONFLICT" };
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      /changed.*reload/i,
    );
    expect(screen.queryByText(/Save queued/i)).not.toBeInTheDocument();
  });
  it("handles initial auth failures through the existing sign-in flow", async () => {
    failure = { status: 401, code: "AUTH_REQUIRED" };
    open();
    expect(
      await screen.findByRole("heading", { name: "Sign in to your workspace" }),
    ).toBeInTheDocument();
  });
  it("handles polling auth failures and stops exposing the page", async () => {
    open();
    fireEvent.click(
      await screen.findByRole("button", { name: "/memories/profile.md" }),
    );
    vi.useFakeTimers();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await act(async () => {});
    failure = { status: 401, code: "AUTH_REQUIRED" };
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(
      screen.getByRole("heading", { name: "Sign in to your workspace" }),
    ).toBeInTheDocument();
  });
  it("waits for a delayed completion refresh before reporting saved", async () => {
    open();
    fireEvent.click(
      await screen.findByRole("button", { name: "/memories/profile.md" }),
    );
    vi.useFakeTimers();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await act(async () => {});
    currentState = { ...state, run: { ...queued.run, stage: "completed" } };
    let resolveList!: (response: Response) => void;
    fetchMock.mockImplementationOnce(async () => Response.json(currentState));
    fetchMock.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          resolveList = resolve;
        }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(screen.queryByText("Memory saved.")).not.toBeInTheDocument();
    await act(async () => {
      resolveList(Response.json({ entries, capacity, state: currentState }));
    });
    expect(screen.getByText("Memory saved.")).toBeInTheDocument();
  });
});
