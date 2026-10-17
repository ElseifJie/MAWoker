// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClientError } from "./api.js";
import { InvitePage } from "./InvitePage.js";

afterEach(cleanup);

function renderPage(
  acceptInvite?: (
    code: string,
    password: string,
  ) => Promise<{
    user: { userId: string; email: string };
  }>,
  entry = "/invite?code=invite-code-123456",
) {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <InvitePage acceptInvite={acceptInvite} />
    </MemoryRouter>,
  );
}

async function fillPasswords(password: string, confirmation = password) {
  const user = userEvent.setup();
  await user.type(screen.getByLabelText("密码", { exact: true }), password);
  await user.type(screen.getByLabelText("确认密码"), confirmation);
  return user;
}

describe("InvitePage", () => {
  it("accepts the invite and confirms the activated email", async () => {
    const accept = vi.fn(async () => ({
      user: { userId: "user-1", email: "invitee@example.com" },
    }));
    renderPage(accept);
    const user = await fillPasswords("password123");

    await user.click(screen.getByRole("button", { name: "开通账号" }));

    expect(accept).toHaveBeenCalledWith("invite-code-123456", "password123");
    expect(await screen.findByText("账号已开通")).toBeVisible();
    expect(screen.getByText("invitee@example.com")).toBeVisible();
  });

  it("rejects a mismatch before calling the API", async () => {
    const accept = vi.fn();
    renderPage(accept);
    const user = await fillPasswords("password123", "password124");

    await user.click(screen.getByRole("button", { name: "开通账号" }));

    expect(accept).not.toHaveBeenCalled();
    expect(screen.getByText("两次输入的密码不一致。")).toBeVisible();
  });

  it("explains an invalid or used invite", async () => {
    const accept = vi.fn(async () => {
      throw new ApiClientError(400, "INVITE_INVALID", "Invalid invite");
    });
    renderPage(accept);
    const user = await fillPasswords("password123");

    await user.click(screen.getByRole("button", { name: "开通账号" }));

    expect(
      await screen.findByText(/邀请链接无效、已过期或已经使用/),
    ).toBeVisible();
  });

  it("reports a missing invitation code", () => {
    renderPage(undefined, "/invite");

    expect(screen.getByText("邀请链接不完整")).toBeVisible();
    expect(screen.getByText("返回登录")).toBeVisible();
  });
});
