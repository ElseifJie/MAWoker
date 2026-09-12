// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
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
import type { SessionSummary } from "../api.js";
import { SessionList, groupSessions, matchesQuery } from "./SessionList.js";

function session(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    title: "Quarterly plan",
    status: "idle",
    error: null,
    deletionState: "none",
    archivedAt: null,
    pinnedAt: null,
    lastEventAt: null,
    createdAt: "2026-09-11T08:00:00.000Z",
    updatedAt: "2026-09-11T09:00:00.000Z",
    agent: {
      id: "00000000-0000-4000-8000-000000000002",
      kind: "platform",
      name: "Research assistant",
      version: "3",
    },
    ...overrides,
  };
}

function renderList(ui: Parameters<typeof SessionList>[0]) {
  return render(
    <MemoryRouter>
      <SessionList {...ui} />
    </MemoryRouter>,
  );
}

const today = new Date("2026-09-11T12:00:00.000Z");

describe("groupSessions", () => {
  it("buckets by most recent activity relative to today", () => {
    const groups = groupSessions(
      [
        session({ id: "a", updatedAt: "2026-09-11T09:00:00.000Z" }),
        session({ id: "b", updatedAt: "2026-09-10T09:00:00.000Z" }),
        session({ id: "c", updatedAt: "2026-09-08T09:00:00.000Z" }),
        session({ id: "d", updatedAt: "2026-08-01T09:00:00.000Z" }),
      ],
      today,
    );

    expect(groups.map((group) => [group.label, group.sessions.length])).toEqual(
      [
        ["Today", 1],
        ["Yesterday", 1],
        ["Previous 7 days", 1],
        ["Older", 1],
      ],
    );
  });

  it("prefers the last event time over the row timestamp and drops empty buckets", () => {
    const groups = groupSessions(
      [session({ lastEventAt: "2026-09-11T11:00:00.000Z" })],
      today,
    );

    expect(groups).toHaveLength(1);
    expect(groups[0]!.label).toBe("Today");
  });
});

describe("matchesQuery", () => {
  it("matches on the title, case-insensitively", () => {
    expect(matchesQuery(session(), "quarterly")).toBe(true);
    expect(matchesQuery(session(), "research")).toBe(false);
    expect(matchesQuery(session(), "  ")).toBe(true);
  });
});

describe("SessionList", () => {
  const onSessionChanged = vi.fn();

  beforeEach(() => {
    onSessionChanged.mockReset();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  function stubFetch(handler: (path: string, method: string) => unknown) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = new URL(String(input), "http://localhost").pathname;
        const body = handler(path, init?.method ?? "GET");
        return new Response(JSON.stringify(body ?? {}), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );
  }

  it("shows pinned Sessions in their own group and keeps them out of the time buckets", () => {
    renderList({
      sessions: [
        session({
          id: "pinned",
          title: "Pinned task",
          pinnedAt: "2026-09-11T10:00:00.000Z",
        }),
        session({
          id: "plain",
          title: "Plain task",
          updatedAt: new Date().toISOString(),
        }),
      ],
      archivedSessions: [],
      onSessionChanged,
      onAuthRequired: vi.fn(),
    });

    const pinned = screen.getByRole("region", { name: "Pinned sessions" });
    expect(within(pinned).getByText("Pinned task")).toBeInTheDocument();
    const todayRegion = screen.getByRole("region", { name: "Today" });
    expect(within(todayRegion).getByText("Plain task")).toBeInTheDocument();
    expect(
      within(todayRegion).queryByText("Pinned task"),
    ).not.toBeInTheDocument();
  });

  it("exposes the management menu on each row and pins through the API", async () => {
    stubFetch((path, method) =>
      path.endsWith("/pin") && method === "PUT"
        ? { ...session(), pinnedAt: "2026-09-11T12:00:00.000Z" }
        : {},
    );
    renderList({
      sessions: [session()],
      archivedSessions: [],
      onSessionChanged,
      onAuthRequired: vi.fn(),
    });

    const user = userEvent.setup();
    await user.click(
      screen.getByRole("button", { name: "Actions for Quarterly plan" }),
    );
    const menu = screen.getByRole("menu");
    expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((item) => item.textContent),
    ).toEqual(["Rename", "Export", "Pin", "Archive", "Delete"]);

    await user.click(within(menu).getByRole("menuitem", { name: "Pin" }));
    await waitFor(() =>
      expect(onSessionChanged).toHaveBeenCalledWith(
        expect.objectContaining({ pinnedAt: "2026-09-11T12:00:00.000Z" }),
      ),
    );
  });

  it("renames a Session through a dialog and reports validation failures", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              error: {
                code: "VALIDATION_FAILED",
                message: "nope",
                requestId: "req-1",
                retryable: false,
              },
            }),
            { status: 400, headers: { "content-type": "application/json" } },
          ),
      ),
    );
    renderList({
      sessions: [session()],
      archivedSessions: [],
      onSessionChanged,
      onAuthRequired: vi.fn(),
    });

    const user = userEvent.setup();
    await user.click(
      screen.getByRole("button", { name: "Actions for Quarterly plan" }),
    );
    await user.click(screen.getByRole("menuitem", { name: "Rename" }));

    const field = await screen.findByLabelText("Session name");
    await user.clear(field);
    await user.type(field, "Plan v2");
    await user.click(screen.getByRole("button", { name: "Save name" }));

    expect(
      await screen.findByText(
        "That name is not accepted. Use 1 to 120 characters.",
      ),
    ).toBeInTheDocument();
    expect(onSessionChanged).not.toHaveBeenCalled();
  });

  it("exports the folded transcript without opening the Session", async () => {
    stubFetch((path) =>
      path.endsWith("/transcript")
        ? {
            events: [
              {
                id: "event-1",
                sourceType: "user.message",
                type: "message",
                createdAt: "2026-09-11T09:00:00.000Z",
                payload: { content: "Prepare the plan" },
              },
              {
                id: "event-2",
                sourceType: "agent.message",
                type: "message",
                createdAt: "2026-09-11T09:01:00.000Z",
                payload: { content: "On it." },
              },
            ],
          }
        : {},
    );
    const createObjectURL = vi.fn(() => "blob:transcript");
    const revokeObjectURL = vi.fn();
    // Defined on URL rather than replacing the constructor: the fetch stub above
    // still needs `new URL` to parse request paths.
    Object.defineProperty(URL, "createObjectURL", {
      value: createObjectURL,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      value: revokeObjectURL,
      configurable: true,
      writable: true,
    });

    renderList({
      sessions: [session()],
      archivedSessions: [],
      onSessionChanged,
      onAuthRequired: vi.fn(),
    });

    const user = userEvent.setup();
    await user.click(
      screen.getByRole("button", { name: "Actions for Quarterly plan" }),
    );
    await user.click(screen.getByRole("menuitem", { name: "Export" }));

    await waitFor(() => expect(createObjectURL).toHaveBeenCalledOnce());
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:transcript");
  });

  it("pins a Session from the row's hover control", async () => {
    stubFetch((path, method) =>
      path.endsWith("/pin") && method === "PUT"
        ? { ...session(), pinnedAt: "2026-09-11T12:00:00.000Z" }
        : {},
    );
    renderList({
      sessions: [session()],
      archivedSessions: [],
      onSessionChanged,
      onAuthRequired: vi.fn(),
    });

    const user = userEvent.setup();
    const pin = screen.getByRole("button", { name: "Pin Quarterly plan" });
    expect(pin).toHaveAttribute("aria-pressed", "false");
    await user.click(pin);

    await waitFor(() =>
      expect(onSessionChanged).toHaveBeenCalledWith(
        expect.objectContaining({ pinnedAt: "2026-09-11T12:00:00.000Z" }),
      ),
    );
  });

  it("unpins a pinned Session from the row control", async () => {
    stubFetch((path, method) =>
      path.endsWith("/pin") && method === "DELETE"
        ? { ...session(), pinnedAt: null }
        : {},
    );
    renderList({
      sessions: [session({ pinnedAt: "2026-09-11T10:00:00.000Z" })],
      archivedSessions: [],
      onSessionChanged,
      onAuthRequired: vi.fn(),
    });

    const user = userEvent.setup();
    const pin = screen.getByRole("button", { name: "Unpin Quarterly plan" });
    expect(pin).toHaveAttribute("aria-pressed", "true");
    await user.click(pin);

    await waitFor(() =>
      expect(onSessionChanged).toHaveBeenCalledWith(
        expect.objectContaining({ pinnedAt: null }),
      ),
    );
  });
});
