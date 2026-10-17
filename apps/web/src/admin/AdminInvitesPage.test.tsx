// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AdminInvitesPage } from "./AdminInvitesPage.js";

const pendingInvite = {
  id: "invite-1",
  email: "invitee@example.com",
  createdBy: "admin-1",
  usedByUserId: null,
  status: "pending" as const,
  expiresAt: "2026-10-24T00:00:00.000Z",
  usedAt: null,
  revokedAt: null,
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
      if (url.pathname === "/api/v1/admin/invites" && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as {
          email: string;
          expiresInDays: number;
        };
        return json(
          {
            invite: {
              ...pendingInvite,
              id: "invite-2",
              email: body.email,
              expiresAt: "2026-10-31T00:00:00.000Z",
            },
            code: "invite-code-123456",
          },
          201,
        );
      }
      if (
        url.pathname === "/api/v1/admin/invites/invite-1/revoke" &&
        init?.method === "POST"
      ) {
        return json({
          invite: {
            ...pendingInvite,
            status: "revoked",
            revokedAt: "2026-10-17T01:00:00.000Z",
          },
        });
      }
      if (url.pathname === "/api/v1/admin/invites") {
        return json({ invites: [pendingInvite] });
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

describe("AdminInvitesPage", () => {
  it("lists invites with their status", async () => {
    render(<AdminInvitesPage onAuthRequired={vi.fn()} />);

    expect(await screen.findByText("invitee@example.com")).toBeVisible();
    expect(screen.getByText("待使用")).toBeVisible();
  });

  it("creates an invite and shows the one-time link", async () => {
    const user = userEvent.setup();
    render(<AdminInvitesPage onAuthRequired={vi.fn()} />);
    await screen.findByText("invitee@example.com");

    await user.type(screen.getByLabelText("受邀邮箱"), "new@example.com");
    await user.click(screen.getByRole("button", { name: "生成邀请" }));

    const link = await screen.findByLabelText("邀请链接");
    expect(link).toHaveValue(
      `${window.location.origin}/invite?code=invite-code-123456`,
    );
    expect(screen.getByText(/已为 new@example.com 生成邀请/)).toBeVisible();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/admin/invites",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          email: "new@example.com",
          expiresInDays: 7,
        }),
      }),
    );
  });

  it("revokes a pending invite in place", async () => {
    const user = userEvent.setup();
    render(<AdminInvitesPage onAuthRequired={vi.fn()} />);
    await screen.findByText("invitee@example.com");

    await user.click(screen.getByRole("button", { name: "撤销" }));

    await waitFor(() => {
      expect(screen.getByText("已撤销")).toBeVisible();
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/admin/invites/invite-1/revoke",
      expect.objectContaining({ method: "POST" }),
    );
  });
});
