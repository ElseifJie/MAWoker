// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccountDeletion } from "./AccountDeletion.js";

afterEach(cleanup);

describe("AccountDeletion", () => {
  it("requires DELETE confirmation before calling the API", async () => {
    const user = userEvent.setup();
    const remove = vi.fn(async () => ({ deleted: true as const }));
    const onDeleted = vi.fn();
    render(<AccountDeletion deleteAccount={remove} onDeleted={onDeleted} />);

    await user.type(screen.getByLabelText("当前密码"), "password123");
    await user.type(screen.getByLabelText("输入 DELETE 确认"), "delete");
    await user.click(screen.getByRole("button", { name: "注销账号" }));

    expect(remove).not.toHaveBeenCalled();
    expect(screen.getByText("请输入 DELETE 以确认注销。")).toBeVisible();
  });

  it("deletes after confirmation and invokes the redirect callback", async () => {
    const user = userEvent.setup();
    const remove = vi.fn(async () => ({ deleted: true as const }));
    const onDeleted = vi.fn();
    render(<AccountDeletion deleteAccount={remove} onDeleted={onDeleted} />);

    await user.type(screen.getByLabelText("当前密码"), "password123");
    await user.type(screen.getByLabelText("输入 DELETE 确认"), "DELETE");
    await user.click(screen.getByRole("button", { name: "注销账号" }));

    expect(remove).toHaveBeenCalledWith("password123");
    expect(onDeleted).toHaveBeenCalledOnce();
  });
});
