// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccountSessions } from "./AccountSessions.js";

afterEach(cleanup);

const sessions = [
  {
    id: "current",
    current: true,
    createdAt: "2026-10-17T00:00:00.000Z",
    expiresAt: "2026-10-24T00:00:00.000Z",
  },
  {
    id: "other",
    current: false,
    createdAt: "2026-10-16T00:00:00.000Z",
    expiresAt: "2026-10-23T00:00:00.000Z",
  },
];

describe("AccountSessions", () => {
  it("lists devices and revokes the other sessions", async () => {
    const user = userEvent.setup();
    const revoke = vi.fn(async () => ({ revoked: 1 }));
    render(
      <AccountSessions
        list={vi.fn(async () => ({ sessions }))}
        revokeOthers={revoke}
      />,
    );

    expect(await screen.findByText("当前设备")).toBeVisible();
    expect(screen.getByText("其他设备")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "退出其他设备" }));

    expect(revoke).toHaveBeenCalledOnce();
    expect(screen.queryByText("其他设备")).not.toBeInTheDocument();
    expect(screen.getByText("已退出 1 个其他设备。")).toBeVisible();
  });

  it("disables revocation when only the current device remains", async () => {
    render(
      <AccountSessions
        list={vi.fn(async () => ({ sessions: [sessions[0]!] }))}
        revokeOthers={vi.fn()}
      />,
    );
    expect(
      await screen.findByRole("button", { name: "退出其他设备" }),
    ).toBeDisabled();
  });
});
