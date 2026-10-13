// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import React from "react";
import userEvent from "@testing-library/user-event";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { FilesPage } from "../apps/web/src/FilesPage.js";
import { apiClient } from "../apps/web/src/api.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function Destination() {
  return <output>{useLocation().search}</output>;
}

it("distinguishes an empty search and clears the filters", async () => {
  vi.spyOn(apiClient, "listArtifacts").mockResolvedValue({
    artifacts: [
      {
        id: "file",
        sessionId: "source",
        name: "报告.txt",
        mimeType: "text/plain",
        sizeBytes: 3,
        generatedAt: "2026-10-13",
        deletionState: "none",
      },
    ],
  });
  render(
    <MemoryRouter>
      <FilesPage sessions={[]} onAuthRequired={vi.fn()} />
    </MemoryRouter>,
  );
  await screen.findByText("报告.txt");
  fireEvent.change(screen.getByLabelText("搜索文件"), {
    target: { value: "missing" },
  });
  expect(screen.getByText("没有匹配的文件")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "清除筛选" }));
  expect(screen.getByText("报告.txt")).toBeInTheDocument();
});

it("filters files and carries the chosen same-name artifact ID without submitting", async () => {
  vi.spyOn(apiClient, "listArtifacts").mockResolvedValue({
    artifacts: [
      {
        id: "first",
        sessionId: "source-a",
        name: "报告.txt",
        mimeType: "text/plain",
        sizeBytes: 3,
        generatedAt: "2026-10-13",
        deletionState: "none",
      },
      {
        id: "second",
        sessionId: "source-b",
        name: "报告.txt",
        mimeType: "text/plain",
        sizeBytes: 3,
        generatedAt: "2026-10-13",
        deletionState: "none",
      },
      {
        id: "sheet",
        sessionId: "source-b",
        name: "预算.xlsx",
        mimeType:
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        sizeBytes: 3,
        generatedAt: "2026-10-13",
        deletionState: "none",
      },
    ],
  });
  const create = vi.spyOn(apiClient, "createSession");
  const reuse = vi.spyOn(apiClient, "reuseArtifact");
  render(
    <MemoryRouter initialEntries={["/files"]}>
      <Routes>
        <Route
          path="/files"
          element={
            <FilesPage
              sessions={
                [
                  { id: "source-a", title: "任务A" },
                  { id: "source-b", title: "任务B" },
                ] as never
              }
              onAuthRequired={vi.fn()}
            />
          }
        />
        <Route path="/" element={<Destination />} />
      </Routes>
    </MemoryRouter>,
  );
  await screen.findByText("预算.xlsx");
  fireEvent.change(screen.getByLabelText("文件类型"), {
    target: { value: "spreadsheet" },
  });
  expect(screen.queryByText("报告.txt")).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("文件类型"), {
    target: { value: "" },
  });
  fireEvent.change(screen.getByLabelText("搜索文件"), {
    target: { value: "报告" },
  });
  expect(screen.queryByText("预算.xlsx")).not.toBeInTheDocument();
  const records = screen
    .getAllByText("报告.txt")
    .map((name) => name.closest("li")!);
  expect(records).toHaveLength(2);
  fireEvent.click(
    within(records[1]!).getByRole("button", { name: "继续修改" }),
  );
  expect(screen.getByRole("status")).toHaveTextContent("?artifactId=second");
  expect(reuse).not.toHaveBeenCalled();
  expect(create).not.toHaveBeenCalled();
});

it("treats an empty source filter as filtered-empty and restores all-file context", async () => {
  vi.spyOn(apiClient, "listArtifacts").mockImplementation(async (id) => ({
    artifacts: id
      ? []
      : [
          {
            id: "file",
            sessionId: "source-a",
            name: "报告.txt",
            mimeType: "text/plain",
            sizeBytes: 3,
            generatedAt: "2026-10-13",
            deletionState: "none",
            error: null,
          },
        ],
  }));
  render(
    <MemoryRouter>
      <FilesPage
        sessions={
          [
            { id: "source-a", title: "有文件的任务" },
            { id: "empty-source", title: "没有文件的任务" },
          ] as never
        }
        onAuthRequired={vi.fn()}
      />
    </MemoryRouter>,
  );
  await screen.findByText("报告.txt");
  fireEvent.change(screen.getByLabelText("来源任务"), {
    target: { value: "empty-source" },
  });
  await screen.findByText("没有匹配的文件");
  fireEvent.click(screen.getByRole("button", { name: "清除筛选" }));
  expect(await screen.findByText("报告.txt")).toBeInTheDocument();
  expect(screen.getByLabelText("来源任务")).toHaveValue("");
});

it.each(["Escape", "close button"])(
  "opens an early same-name row in an independent preview and retains list context after %s",
  async (closeMethod) => {
    const files = Array.from({ length: 80 }, (_, index) => ({
      id: `file-${index}`,
      sessionId: "source",
      name: index < 2 ? "报告.txt" : `报告-${index}.txt`,
      mimeType: "text/plain",
      sizeBytes: 12,
      generatedAt: "2026-10-13",
      deletionState: "none" as const,
      error: null,
    }));
    vi.spyOn(apiClient, "listArtifacts").mockResolvedValue({
      artifacts: files,
    });
    const download = vi.fn(
      async () =>
        new Response("first-preview-content", {
          headers: { "content-type": "text/plain" },
        }),
    );
    vi.stubGlobal("fetch", download);
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <FilesPage
          sessions={[{ id: "source", title: "来源任务" }] as never}
          onAuthRequired={vi.fn()}
        />
      </MemoryRouter>,
    );
    await screen.findByText("报告-79.txt");
    await user.type(screen.getByLabelText("搜索文件"), "报告");
    await user.selectOptions(screen.getByLabelText("来源任务"), "source");
    await screen.findByText("报告-79.txt");
    await user.selectOptions(screen.getByLabelText("文件类型"), "text");
    const list = screen.getByRole("list", { name: "成果文件" });
    const records = within(list).getAllByRole("listitem");
    expect(records).toHaveLength(80);
    const firstRow = records[0]!;
    const trigger = within(firstRow).getByRole("button", { name: "预览" });
    await user.click(trigger);
    const dialog = await screen.findByRole("dialog", {
      name: "文件预览：报告.txt",
    });
    const close = within(dialog).getByRole("button", { name: "关闭文件预览" });
    expect(close).toHaveFocus();
    expect(
      within(dialog).queryByRole("button", { name: "Close preview" }),
    ).not.toBeInTheDocument();
    expect(
      await within(dialog).findByText("first-preview-content"),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByRole("link", { name: "Download" }),
    ).toHaveAttribute("href", "/api/v1/artifacts/file-0/download");
    expect(download).toHaveBeenCalledWith(
      "/api/v1/artifacts/file-0/download",
      expect.objectContaining({
        credentials: "include",
        signal: expect.any(AbortSignal),
      }),
    );
    const signal = (
      download.mock.calls[0] as unknown as [string, RequestInit]
    )[1].signal!;
    const otherAction = within(dialog).getByRole("button", {
      name: "Copy name",
    });
    otherAction.focus();
    await user.tab();
    expect(close).toHaveFocus();
    if (closeMethod === "Escape") await user.keyboard("{Escape}");
    else await user.click(close);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    expect(signal.aborted).toBe(true);
    expect(screen.getByLabelText("搜索文件")).toHaveValue("报告");
    expect(screen.getByLabelText("来源任务")).toHaveValue("source");
    expect(screen.getByLabelText("文件类型")).toHaveValue("text");
    expect(
      within(screen.getByRole("list", { name: "成果文件" })).getAllByRole(
        "listitem",
      )[0],
    ).toBe(firstRow);
    expect(within(firstRow).getByText("file-0")).toBeInTheDocument();
  },
);
