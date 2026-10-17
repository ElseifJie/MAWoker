// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClientError } from "./api.js";
import { NotificationChannels } from "./NotificationChannels.js";

afterEach(cleanup);

const channel = {
  id: "channel-1",
  name: "Feishu",
  type: "webhook" as const,
  url: "https://open.feishu.cn/…oken",
  enabled: true,
  lastErrorCode: null,
};

function props() {
  return {
    list: vi.fn(async () => ({ channels: [channel] })),
    create: vi.fn(async (name: string, url: string) => ({
      channel: { ...channel, id: "channel-2", name, url },
    })),
    setEnabled: vi.fn(async (_id: string, enabled: boolean) => ({
      channel: { ...channel, enabled },
    })),
    remove: vi.fn(async () => undefined),
  };
}

describe("NotificationChannels", () => {
  it("lists, adds, disables, and deletes channels", async () => {
    const user = userEvent.setup();
    const view = props();
    render(<NotificationChannels {...view} />);

    expect(await screen.findByText("Feishu")).toBeVisible();
    await user.type(screen.getByLabelText("名称"), "Backup");
    await user.type(
      screen.getByLabelText("Webhook URL"),
      "https://hooks.example.com/hook",
    );
    await user.click(screen.getByRole("button", { name: "添加通知渠道" }));
    expect(view.create).toHaveBeenCalledWith(
      "Backup",
      "https://hooks.example.com/hook",
    );

    const stopButtons = screen.getAllByRole("button", { name: "停用" });
    await user.click(stopButtons[stopButtons.length - 1]!);
    expect(view.setEnabled).toHaveBeenCalledWith("channel-1", false);

    const deleteButtons = screen.getAllByRole("button", { name: "删除" });
    await user.click(deleteButtons[deleteButtons.length - 1]!);
    expect(view.remove).toHaveBeenCalledWith("channel-1");
  });

  it("explains an unsafe webhook URL", async () => {
    const user = userEvent.setup();
    const view = props();
    view.create.mockRejectedValueOnce(
      new ApiClientError(400, "CHANNEL_URL_UNSAFE", "private host"),
    );
    render(<NotificationChannels {...view} />);
    await screen.findByText("Feishu");

    await user.type(screen.getByLabelText("名称"), "Bad");
    await user.type(
      screen.getByLabelText("Webhook URL"),
      "https://127.0.0.1/hook",
    );
    await user.click(screen.getByRole("button", { name: "添加通知渠道" }));

    expect(await screen.findByText(/只允许 HTTPS 公网地址/)).toBeVisible();
  });
});
