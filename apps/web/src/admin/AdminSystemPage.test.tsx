// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AdminSystemPage } from "./AdminSystemPage.js";

const snapshot = {
  generatedAt: "2026-10-17T00:00:00.000Z",
  database: { latencyMs: 12 },
  jobs: {
    pending: 3,
    running: 1,
    failedLast24h: 2,
    oldestPendingSeconds: 125,
  },
  runs: {
    queued: 1,
    starting: 0,
    running: 2,
    waiting_user: 1,
    waiting_device: 0,
    completed: 10,
    failed: 1,
    canceled: 0,
    unknown: 0,
  },
  sessions: { running: 2 },
  automations: { active: 4, pending: 2, overdue: 1 },
  notifications: { unread: 7 },
  users: { active: 5, disabled: 1 },
};

function json(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn(async (input: string | URL | Request) => {
    const url = new URL(String(input), "http://localhost");
    if (url.pathname === "/api/v1/admin/system") return json(snapshot);
    return json({ error: { code: "NOT_FOUND" } });
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("AdminSystemPage", () => {
  it("renders queue, run, and reminder health", async () => {
    render(<AdminSystemPage onAuthRequired={vi.fn()} />);

    expect(await screen.findByText("系统状态")).toBeVisible();
    expect(screen.getByText("12 ms")).toBeVisible();
    expect(screen.getByText("最老待处理")).toBeVisible();
    expect(screen.getByText("2 分钟")).toBeVisible();
    expect(screen.getByText("逾期提醒")).toBeVisible();
    expect(screen.getByRole("heading", { name: "Run 状态分布" })).toBeVisible();
    expect(screen.getByRole("table")).toHaveTextContent("运行中");
  });

  it("refreshes on demand", async () => {
    const user = userEvent.setup();
    render(<AdminSystemPage onAuthRequired={vi.fn()} />);
    await screen.findByText("12 ms");

    await user.click(screen.getByRole("button", { name: "立即刷新" }));

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
