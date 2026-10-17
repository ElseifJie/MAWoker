// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClientError } from "./api.js";
import { McpServers } from "./McpServers.js";

afterEach(cleanup);

const server = {
  id: "server-1",
  name: "Feishu",
  url: "https://mcp.example.com/mcp",
  enabled: true,
  createdAt: "2026-10-17T00:00:00.000Z",
  updatedAt: "2026-10-17T00:00:00.000Z",
};

function props() {
  return {
    list: vi.fn(async () => ({ servers: [server] })),
    create: vi.fn(async (name: string, url: string) => ({
      server: { ...server, id: "server-2", name, url },
    })),
    setEnabled: vi.fn(async (_id: string, enabled: boolean) => ({
      server: { ...server, enabled },
    })),
    remove: vi.fn(async () => undefined),
  };
}

describe("McpServers", () => {
  it("lists, adds, disables, and deletes servers", async () => {
    const user = userEvent.setup();
    const view = props();
    render(<McpServers {...view} />);

    expect(await screen.findByText("Feishu")).toBeVisible();
    await user.type(screen.getByLabelText("名称"), "Docs");
    await user.type(
      screen.getByLabelText("MCP URL"),
      "https://docs.example.com/mcp",
    );
    await user.click(screen.getByRole("button", { name: "添加 MCP 服务" }));
    expect(view.create).toHaveBeenCalledWith(
      "Docs",
      "https://docs.example.com/mcp",
    );

    const stopButtons = screen.getAllByRole("button", { name: "停用" });
    await user.click(stopButtons[stopButtons.length - 1]!);
    expect(view.setEnabled).toHaveBeenCalledWith("server-1", false);

    const deleteButtons = screen.getAllByRole("button", { name: "删除" });
    await user.click(deleteButtons[deleteButtons.length - 1]!);
    expect(view.remove).toHaveBeenCalledWith("server-1");
  });

  it("explains an unsafe URL", async () => {
    const user = userEvent.setup();
    const view = props();
    view.create.mockRejectedValueOnce(
      new ApiClientError(400, "MCP_URL_UNSAFE", "private host"),
    );
    render(<McpServers {...view} />);
    await screen.findByText("Feishu");

    await user.type(screen.getByLabelText("名称"), "Bad");
    await user.type(screen.getByLabelText("MCP URL"), "https://127.0.0.1/mcp");
    await user.click(screen.getByRole("button", { name: "添加 MCP 服务" }));

    expect(await screen.findByText(/只允许 HTTPS 公网地址/)).toBeVisible();
  });
});
