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
  count: 2,
  bytes: 67,
  maxEntryBytes: 54,
  countRatio: 0.001,
  byteRatio: null,
  level: "normal",
  targetCount: 1200,
};
const store = {
  id: "memstore-20261010143827-obuom",
  updatedAt: "2026-10-10T14:38:27Z",
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
let failure: { status: number; code: string; path?: string } | null;
let sessionCount = 1;
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
    if (path === "/api/v1/memory")
      return Response.json({
        entries,
        capacity,
        state: currentState,
        store,
        sessionCount,
      });
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
    { path: "/memories/profile.md", content: "Profile" },
    { path: "/resources/README.md", content: "Resources" },
  ];
  failure = null;
  sessionCount = 1;
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
  fireEvent.click(await screen.findByText("Personal Memory"));
  await screen.findByText("Files");
}

describe("MemoryPage", () => {
  it("lists the Memory Store with usage and opens the detail from the row", async () => {
    open();
    expect(
      await screen.findByRole("heading", { name: "Memory Stores" }),
    ).toBeInTheDocument();
    expect(await screen.findByText("Personal Memory")).toBeInTheDocument();
    expect(screen.getByText(store.id)).toBeInTheDocument();
    expect(screen.getByText("67 B")).toBeInTheDocument();
    expect(screen.getByText("2026-10-10 14:38:27")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Personal Memory"));
    expect(await screen.findByText("Files")).toBeInTheDocument();
    expect(screen.getByText(store.id)).toBeInTheDocument();
    expect(screen.getByText(/Memories: 2/)).toBeInTheDocument();
    expect(screen.getByText(/Sessions: 1/)).toBeInTheDocument();
  });
  it("renders the path tree and opens a memory for editing", async () => {
    await openDetail();
    expect(screen.getByRole("button", { name: /memories/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /resources/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "profile.md" }));
    expect(screen.getByLabelText("Content")).toHaveValue("Profile");
    expect(screen.getByLabelText("Path")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
    expect(
      screen.getByRole("button", { name: "README.md" }),
    ).toBeInTheDocument();
  });
  it("keeps editing read-only while an operation is running", async () => {
    currentState = queued;
    await openDetail();
    fireEvent.click(await screen.findByRole("button", { name: "profile.md" }));
    expect(screen.getByLabelText("Content")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "+ New memory" }),
    ).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled();
  });
  it("cancels a running operation and unlocks the page", async () => {
    currentState = queued;
    await openDetail();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/memory/cancel",
      expect.objectContaining({ method: "POST" }),
    );
    expect(
      await screen.findByText("Operation cancelled."),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "+ New memory" }),
    ).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
  });
  it("queues saves and refreshes the editor after two-second polling", async () => {
    await openDetail();
    fireEvent.click(await screen.findByRole("button", { name: "profile.md" }));
    vi.useFakeTimers();
    fireEvent.change(screen.getByLabelText("Content"), {
      target: { value: "Updated" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await act(async () => {});
    expect(screen.getByText(/Save queued.*not saved yet/i)).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/memory/entry",
      expect.objectContaining({
        method: "POST",
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
    fireEvent.click(screen.getByLabelText("Protected"));
    await waitFor(() =>
      expect(screen.getByLabelText("Protected")).toBeChecked(),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/memory/protect",
      expect.objectContaining({
        body: JSON.stringify({ path: "/memories/profile.md", protected: true }),
      }),
    );
    fireEvent.click(screen.getByLabelText("Auto consolidation"));
    await waitFor(() =>
      expect(screen.getByLabelText("Auto consolidation")).not.toBeChecked(),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/memory/settings",
      expect.objectContaining({ body: JSON.stringify({ autoDream: false }) }),
    );
    fireEvent.click(screen.getByRole("button", { name: "+ New memory" }));
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
  });
  it("queues deletion and clears the editor after completion", async () => {
    await openDetail();
    fireEvent.click(await screen.findByRole("button", { name: "profile.md" }));
    vi.useFakeTimers();
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await act(async () => {});
    expect(
      screen.getByText(/Delete queued.*not deleted yet/i),
    ).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/memory/entry",
      expect.objectContaining({ method: "DELETE" }),
    );
    currentState = { ...state, run: { ...queued.run, stage: "completed" } };
    entries = [{ path: "/resources/README.md", content: "Resources" }];
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(screen.getByText("Memory deleted.")).toBeInTheDocument();
    expect(
      screen.getByText(/Select a file from the tree/),
    ).toBeInTheDocument();
  });
  it("shows a conflict without claiming that a save was accepted", async () => {
    await openDetail();
    fireEvent.click(await screen.findByRole("button", { name: "profile.md" }));
    failure = { status: 409, code: "MEMORY_CONFLICT" };
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      /changed.*reload/i,
    );
    expect(screen.queryByText(/Save queued/i)).not.toBeInTheDocument();
  });
  it("offers repair while memory is stuck and resumes after recovery", async () => {
    currentState = {
      ...state,
      status: "repairing",
      run: {
        kind: "dream",
        stage: "repairing",
        error: "Memory operation failed. Reload or contact support.",
        before: null,
        after: null,
      },
    };
    failure = { status: 409, code: "MEMORY_BUSY", path: "/api/v1/memory" };
    open("/context/store");
    expect(
      await screen.findByText(
        "Memory is busy. Wait for the current operation.",
      ),
    ).toBeInTheDocument();
    expect(await screen.findByText("repairing")).toBeInTheDocument();
    expect(screen.getByText("Memory Store unavailable")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Repair" }));
    expect(
      await screen.findByText(/Repair accepted; memory resumes/i),
    ).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/memory/recover",
      expect.objectContaining({ method: "POST" }),
    );
    failure = null;
    currentState = {
      ...state,
      run: { ...queued.run, kind: "dream", stage: "completed" },
    };
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(
      await screen.findByRole("button", { name: "profile.md" }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Memory is busy/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Repair" })).toBeNull();
  });
  it("handles initial auth failures through the existing sign-in flow", async () => {
    failure = { status: 401, code: "AUTH_REQUIRED" };
    open();
    expect(
      await screen.findByRole("heading", { name: "Sign in to your workspace" }),
    ).toBeInTheDocument();
  });
  it("handles polling auth failures and stops exposing the page", async () => {
    await openDetail();
    fireEvent.click(await screen.findByRole("button", { name: "profile.md" }));
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
    await openDetail();
    fireEvent.click(await screen.findByRole("button", { name: "profile.md" }));
    vi.useFakeTimers();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await act(async () => {});
    currentState = { ...state, run: { ...queued.run, stage: "completed" } };
    fetchMock.mockImplementationOnce(async () =>
      Response.json(currentState),
    );
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
    expect(screen.getByText(/not saved yet/i)).toBeInTheDocument();
    await act(async () => {
      resolveList(
        Response.json({
          entries,
          capacity,
          state: currentState,
          store,
          sessionCount,
        }),
      );
    });
    expect(screen.getByText("Memory saved.")).toBeInTheDocument();
  });
});
