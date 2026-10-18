// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClientError } from "./api.js";
import { PrivacyConsents } from "./PrivacyConsents.js";

const base = {
  currentVersion: "2026-10-18",
  documents: ["terms", "privacy"],
};

afterEach(cleanup);

describe("PrivacyConsents", () => {
  it("asks for each pending document and records the current version", async () => {
    const accept = vi.fn(async (document: string, version: string) => ({
      consent: {
        document,
        version,
        acceptedAt: "2026-10-18T09:00:00.000Z",
      },
    }));
    render(
      <PrivacyConsents
        list={vi.fn().mockResolvedValue({ ...base, consents: [] })}
        accept={accept}
      />,
    );
    const user = userEvent.setup();

    expect(
      await screen.findByRole("button", { name: "同意隐私政策" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "同意服务条款" }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "同意隐私政策" }));

    expect(accept).toHaveBeenCalledWith("privacy", "2026-10-18");
    expect(await screen.findByText("已同意 · 2026-10-18")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "同意隐私政策" })).toBeNull();
  });

  it("shows the accepted versions without repeating the action", async () => {
    render(
      <PrivacyConsents
        list={vi.fn().mockResolvedValue({
          ...base,
          consents: [
            {
              document: "privacy",
              version: "2026-10-18",
              acceptedAt: "2026-10-18T08:00:00.000Z",
            },
            {
              document: "terms",
              version: "2026-10-18",
              acceptedAt: "2026-10-18T08:01:00.000Z",
            },
          ],
        })}
        accept={vi.fn()}
      />,
    );

    expect(await screen.findAllByText("已同意 · 2026-10-18")).toHaveLength(2);
    expect(screen.queryByRole("button", { name: /同意/ })).toBeNull();
    expect(screen.getByText(/账号注销采用匿名化软删除/)).toBeInTheDocument();
    expect(screen.getByText(/请联系邀请你的管理员/)).toBeInTheDocument();
  });

  it("retries a failed load", async () => {
    const list = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce({ ...base, consents: [] });
    render(<PrivacyConsents list={list} accept={vi.fn()} />);
    const user = userEvent.setup();

    expect(
      await screen.findByText("隐私与数据状态加载失败。"),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "重试" }));
    expect(
      await screen.findByRole("button", { name: "同意隐私政策" }),
    ).toBeInTheDocument();
    expect(list).toHaveBeenCalledTimes(2);
  });

  it("signs out when the session expired", async () => {
    const onAuthRequired = vi.fn();
    render(
      <PrivacyConsents
        onAuthRequired={onAuthRequired}
        list={vi
          .fn()
          .mockRejectedValue(
            new ApiClientError(401, "UNAUTHENTICATED", "expired"),
          )}
        accept={vi.fn()}
      />,
    );

    await vi.waitFor(() => expect(onAuthRequired).toHaveBeenCalledTimes(1));
  });
});
