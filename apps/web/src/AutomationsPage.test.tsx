// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AutomationsPage } from "./AutomationsPage.js";

const reminder = {
  id: "automation-1",
  title: "喝水",
  kind: "reminder" as const,
  schedule: { type: "daily" as const, time: "09:00" },
  timezone: "Asia/Shanghai",
  nextRunAt: "2026-10-18T01:00:00.000Z",
  enabled: true,
  scheduleVersion: 1,
  revision: 1,
  createdAt: "2026-10-17T00:00:00.000Z",
  updatedAt: "2026-10-17T00:00:00.000Z",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn(
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname === "/api/v1/automations" && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as {
          title: string;
          schedule: typeof reminder.schedule;
        };
        return json(
          {
            automation: { ...reminder, id: "automation-2", title: body.title },
          },
          201,
        );
      }
      if (
        url.pathname === "/api/v1/automations/automation-1" &&
        init?.method === "PATCH"
      ) {
        return json({ automation: { ...reminder, enabled: false } });
      }
      if (
        url.pathname === "/api/v1/automations/automation-1" &&
        init?.method === "DELETE"
      ) {
        return new Response(null, { status: 204 });
      }
      if (url.pathname === "/api/v1/automations") {
        return json({ automations: [reminder] });
      }
      return json({ error: { code: "NOT_FOUND" } }, 404);
    },
  );
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("AutomationsPage", () => {
  it("lists reminders with their rule and next run", async () => {
    render(<AutomationsPage onAuthRequired={vi.fn()} />);

    expect(await screen.findByText("喝水")).toBeVisible();
    expect(screen.getByText("每天 09:00")).toBeVisible();
    expect(screen.getByText("已启用")).toBeVisible();
  });

  it("creates a daily reminder", async () => {
    const user = userEvent.setup();
    render(<AutomationsPage onAuthRequired={vi.fn()} />);
    await screen.findByText("喝水");

    await user.type(screen.getByLabelText("提醒内容"), "站起来走动");
    await user.click(screen.getByRole("button", { name: "创建提醒" }));

    expect(await screen.findByText("提醒已创建。")).toBeVisible();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/automations",
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining('"title":"站起来走动"'),
      }),
    );
    const call = fetchMock.mock.calls.find(
      ([input, init]) =>
        String(input) === "/api/v1/automations" && init?.method === "POST",
    );
    expect(JSON.parse(String(call?.[1]?.body))).toMatchObject({
      title: "站起来走动",
      schedule: { type: "daily", time: "09:00" },
    });
  });

  it("pauses a reminder and updates its status", async () => {
    const user = userEvent.setup();
    render(<AutomationsPage onAuthRequired={vi.fn()} />);
    await screen.findByText("喝水");

    await user.click(screen.getByRole("button", { name: "暂停" }));

    expect(await screen.findByText("已暂停")).toBeVisible();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/automations/automation-1",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ enabled: false }),
      }),
    );
  });

  it("deletes a reminder from the list", async () => {
    const user = userEvent.setup();
    render(<AutomationsPage onAuthRequired={vi.fn()} />);
    await screen.findByText("喝水");

    await user.click(screen.getByRole("button", { name: "删除" }));

    await waitFor(() => {
      expect(screen.queryByText("喝水")).not.toBeInTheDocument();
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/automations/automation-1",
      expect.objectContaining({ method: "DELETE" }),
    );
  });
});
