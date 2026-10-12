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
    expect(screen.getByText(currentStore.id)).toBeInTheDocument();
    expect(screen.getByText("67 B")).toBeInTheDocument();
    expect(screen.getByText("2026-10-10 14:38:27")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Personal Memory"));
    expect(await screen.findByText("Files")).toBeInTheDocument();
    expect(screen.getByText(currentStore.id)).toBeInTheDocument();
    expect(screen.getByText(/Memories: 2/)).toBeInTheDocument();
    expect(screen.getByText(/Sessions: 1/)).toBeInTheDocument();
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
    expect(screen.getByRole("button", { name: "+ New memory" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled();
  });
  it("keeps the store readable while consolidation is running", async () => {
    currentState = {
      ...state,
      run: { ...queued.run, stage: "polling" },
    };
    await openDetail();
    // The files render and an informational banner explains the refresh;
    // only editing stays gated on the run.
    expect(screen.getByText("Files")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Memory consolidation is running. This is a point-in-time read of the live store and may show changes being applied; the page refreshes and editing unlocks when it finishes.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "+ New memory" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled();
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
    expect(await screen.findByText("Files")).toBeInTheDocument();
    releaseMemoryList?.();
    holdMemoryList = null;
    await screen.findByRole("button", { name: "profile.md" });
  });
  it("cancels a running operation and unlocks the page", async () => {
    currentState = queued;
    await openDetail();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/memory/cancel",
      expect.objectContaining({ method: "POST" }),
    );
    expect(await screen.findByText("Operation cancelled.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "+ New memory" })).toBeEnabled();
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
    expect(screen.getByText(/Select a file from the tree/)).toBeInTheDocument();
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
    await openDetail();
    // The stuck store stays readable; only editing is gated on the repair.
    expect(screen.getByText("Files")).toBeInTheDocument();
    expect(screen.getByText("repairing")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Repair" })).toBeEnabled();
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
    expect(screen.queryByRole("button", { name: "Repair" })).toBeNull();
  });
  it("reports a store that was never provisioned as unavailable", async () => {
    currentState = { ...state, status: "provisioning", run: null };
    failure = { status: 409, code: "MEMORY_BUSY", path: "/api/v1/memory" };
    open("/context/store");
    expect(
      await screen.findByText(
        "Memory is busy. Wait for the current operation.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("Memory Store unavailable")).toBeInTheDocument();
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
    expect(screen.getByText(/not saved yet/i)).toBeInTheDocument();
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
    expect(screen.getByText("Memory saved.")).toBeInTheDocument();
  });

  it("blocks an unversioned save and re-reads instead of writing", async () => {
    entries = [{ path: "/memories/profile.md", content: "Profile" }];
    await openDetail();
    fireEvent.click(await screen.findByRole("button", { name: "profile.md" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    // No versioned write may leave the browser: the page re-reads instead.
    expect(
      await screen.findByText(/read without a version/i),
    ).toBeInTheDocument();
    expect(
      fetchMock.mock.calls.filter(
        ([url, init]) =>
          url === "/api/v1/memory/entry" && init?.method === "POST",
      ),
    ).toHaveLength(0);
    // The re-read keeps the draft and, with the hash restored, saving works.
    expect(screen.getByLabelText("Content")).toHaveValue("Profile");
    entries = [
      { path: "/memories/profile.md", content: "Profile", hash: "hash-v2" },
    ];
    // Second save attempt triggers the re-read that restores the base; the
    // draft was byte-identical, so the third attempt writes with a version.
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(screen.queryByText(/read without a version/i)).toBeNull(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText(/Save queued/i);
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
    fireEvent.change(screen.getByLabelText("Content"), {
      target: { value: "My concurrent edit" },
    });
    failure = { status: 409, code: "MEMORY_CONFLICT" };
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /changed.*reload/i,
    );
    // The failed save keeps the user's draft verbatim and never retries with
    // a fresh hash behind their back.
    expect(screen.getByLabelText("Content")).toHaveValue("My concurrent edit");
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
    fireEvent.click(screen.getByRole("button", { name: "Account: a" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /disconnect/i }));
    expect(
      await screen.findByRole("heading", {
        name: "Sign in to your workspace",
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
    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: "b@example.com" },
    });
    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: "password123" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    // B lands on the store detail; while B's request is pending, nothing from
    // A's account may render — not A's store id, entries, or paths.
    await screen.findByRole("status", { name: "Loading memory" });
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
