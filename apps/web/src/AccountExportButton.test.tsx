// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccountExportButton } from "./AccountExportButton.js";

afterEach(cleanup);

describe("AccountExportButton", () => {
  it("downloads the exported account payload", async () => {
    const user = userEvent.setup();
    const exportAccount = vi.fn(async () => ({
      schemaVersion: "1",
      user: { email: "user@example.com" },
      sessions: [],
    }));
    const download = vi.fn();
    render(
      <AccountExportButton exportAccount={exportAccount} download={download} />,
    );

    await user.click(screen.getByRole("button", { name: "导出我的数据" }));

    expect(exportAccount).toHaveBeenCalledOnce();
    expect(download).toHaveBeenCalledWith(
      expect.objectContaining({
        schemaVersion: "1",
        user: { email: "user@example.com" },
      }),
    );
    expect(screen.getByText("导出文件已开始下载。")).toBeVisible();
  });

  it("reports an export failure", async () => {
    const user = userEvent.setup();
    render(
      <AccountExportButton
        exportAccount={vi.fn(async () => {
          throw new Error("offline");
        })}
        download={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "导出我的数据" }));

    expect(screen.getByText("导出失败，请稍后重试。")).toBeVisible();
  });
});
