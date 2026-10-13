// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import { HistoryPage } from "./HistoryPage.js";
import type { SessionSummary } from "./api.js";

const base: SessionSummary = {
  id: "old",
  title: "Older research",
  status: "idle",
  upstreamReady: true,
  error: null,
  deletionState: "none",
  archivedAt: null,
  pinnedAt: null,
  lastEventAt: null,
  createdAt: "2026-10-12",
  updatedAt: "2026-10-12",
  agent: {
    id: "a",
    name: "Research assistant",
    version: "1",
    kind: "personal",
  },
};
afterEach(cleanup);
describe("history tasks", () => {
  it("orders recent activity, deduplicates tasks, includes archive and excludes deleted records", () => {
    render(
      <MemoryRouter>
        <HistoryPage
          sessions={[
            base,
            {
              ...base,
              id: "recent",
              title: "Recent",
              status: "running",
              updatedAt: "2026-10-13",
            },
            {
              ...base,
              id: "deleted",
              title: "Deleted",
              deletionState: "deleted",
            },
          ]}
          archivedSessions={[{ ...base, archivedAt: "2026-10-13" }]}
        />
      </MemoryRouter>,
    );
    const links = screen.getAllByRole("link");
    expect(links.map((link) => link.getAttribute("href"))).toEqual([
      "/sessions/recent",
      "/sessions/old",
    ]);
    expect(screen.getByText("执行中")).toBeInTheDocument();
    expect(screen.queryByText("本轮完成")).toBeNull();
    expect(
      screen.getByText("已归档", { selector: ".ui-badge span" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("Deleted")).toBeNull();
    fireEvent.change(screen.getByLabelText("任务范围"), {
      target: { value: "archived" },
    });
    expect(screen.queryByText("Recent")).toBeNull();
  });
  it("searches case-insensitive task and agent names and keeps a new-task escape from empty results", () => {
    render(
      <MemoryRouter>
        <HistoryPage sessions={[base]} archivedSessions={[]} />
      </MemoryRouter>,
    );
    fireEvent.change(screen.getByLabelText("搜索历史任务"), {
      target: { value: "  RESEARCH ASSISTANT " },
    });
    expect(screen.getByText(base.title)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("搜索历史任务"), {
      target: { value: "missing" },
    });
    expect(screen.getByText("没有符合条件的任务")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "创建新任务" })).toHaveAttribute(
      "href",
      "/",
    );
  });
});
