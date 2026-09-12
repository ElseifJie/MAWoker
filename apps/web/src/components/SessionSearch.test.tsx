// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionSummary } from "../api.js";
import { SessionSearch } from "./SessionSearch.js";

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

describe("SessionSearch", () => {
  afterEach(cleanup);

  it("searches active and archived tasks and opens the selection", async () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    render(
      <SessionSearch
        open
        sessions={[session({ id: "a", title: "Quarterly plan" })]}
        archivedSessions={[
          session({
            id: "b",
            title: "Archived budget",
            archivedAt: "2026-09-01T00:00:00.000Z",
          }),
        ]}
        onClose={onClose}
        onSelect={onSelect}
      />,
    );

    const user = userEvent.setup();
    const input = screen.getByRole("combobox", { name: "Search tasks" });
    expect(input).toHaveFocus();

    await user.type(input, "budget");
    expect(screen.queryByText("Quarterly plan")).not.toBeInTheDocument();
    expect(screen.getByText("Archived budget")).toBeInTheDocument();

    await user.click(screen.getByRole("option", { name: /Archived budget/ }));
    expect(onClose).toHaveBeenCalledOnce();
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: "b" }));
  });

  it("opens the highlighted task with Enter", async () => {
    const onSelect = vi.fn();
    render(
      <SessionSearch
        open
        sessions={[session({ id: "a", title: "Quarterly plan" })]}
        archivedSessions={[]}
        onClose={vi.fn()}
        onSelect={onSelect}
      />,
    );

    const user = userEvent.setup();
    await user.keyboard("{Enter}");
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: "a" }));
  });
});
