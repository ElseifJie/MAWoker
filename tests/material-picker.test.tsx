// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import React, { useRef, useState } from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ArtifactSummary } from "../apps/web/src/api.js";
import { MaterialPicker } from "../apps/web/src/components/MaterialPicker.js";

const files: ArtifactSummary[] = [
  {
    id: "same-prefix-file-one",
    sessionId: "source-task-one",
    name: "报告.txt",
    mimeType: "text/plain",
    sizeBytes: 12,
    generatedAt: "2026-10-13T00:00:00Z",
    deletionState: "none",
    error: null,
  },
  {
    id: "same-prefix-file-two",
    sessionId: "source-task-two",
    name: "报告.txt",
    mimeType: "text/plain",
    sizeBytes: 24,
    generatedAt: "2026-10-13T00:00:00Z",
    deletionState: "none",
    error: null,
  },
  {
    id: "deleted-file",
    sessionId: "source-task-one",
    name: "删除中的文件.txt",
    mimeType: "text/plain",
    sizeBytes: 1,
    generatedAt: "2026-10-13T00:00:00Z",
    deletionState: "pending",
    error: null,
  },
];

function Harness({ onConfirm = vi.fn() }: { onConfirm?: ReturnType<typeof vi.fn> }) {
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState(new Set([files[0]!.id]));
  return (
    <>
      <button ref={trigger} type="button" onClick={() => setOpen(true)}>
        选已有文件
      </button>
      <output aria-label="已提交的材料">{[...selected].join(",")}</output>
      <MaterialPicker
        open={open}
        files={files}
        selectedIds={selected}
        returnFocusRef={trigger}
        onClose={() => setOpen(false)}
        onConfirm={(ids) => {
          onConfirm(ids);
          setSelected(ids);
          setOpen(false);
        }}
      />
    </>
  );
}

afterEach(cleanup);

describe("material picker", () => {
  it("searches file names, full IDs and source IDs without losing hidden selections", () => {
    const confirm = vi.fn();
    render(<Harness onConfirm={confirm} />);
    fireEvent.click(screen.getByRole("button", { name: "选已有文件" }));
    const dialog = screen.getByRole("dialog", { name: "选择已有文件" });
    const search = within(dialog).getByRole("searchbox", { name: "搜索文件" });
    expect(within(dialog).getAllByRole("checkbox")).toHaveLength(2);
    expect(within(dialog).getByText("same-prefix-file-one")).toBeVisible();
    expect(within(dialog).getByText("same-prefix-file-two")).toBeVisible();
    expect(within(dialog).getByText("来源任务：source-task-two")).toBeVisible();
    expect(within(dialog).queryByText("删除中的文件.txt")).not.toBeInTheDocument();
    fireEvent.change(search, { target: { value: "  SOURCE-TASK-TWO  " } });
    expect(within(dialog).getAllByRole("checkbox")).toHaveLength(1);
    fireEvent.click(within(dialog).getByRole("checkbox"));
    expect(confirm).not.toHaveBeenCalled();
    expect(screen.getByLabelText("已提交的材料")).toHaveTextContent(files[0]!.id);
    fireEvent.change(search, { target: { value: "missing" } });
    expect(within(dialog).getByText("没有匹配文件")).toBeVisible();
    fireEvent.change(search, { target: { value: "报告" } });
    expect(within(dialog).getAllByRole("checkbox")).toHaveLength(2);
    fireEvent.change(search, { target: { value: files[1]!.id } });
    expect(within(dialog).getByRole("checkbox")).toBeChecked();
    fireEvent.click(within(dialog).getByRole("button", { name: "确认选择" }));
    expect(confirm).toHaveBeenCalledWith(new Set([files[0]!.id, files[1]!.id]));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it.each(["取消", "关闭材料选择", "Escape"])(
    "restores prior selection on %s and resets tentative choices on reopening",
    (close) => {
      const confirm = vi.fn();
      render(<Harness onConfirm={confirm} />);
      const trigger = screen.getByRole("button", { name: "选已有文件" });
      trigger.focus();
      fireEvent.click(trigger);
      const first = screen.getByRole("checkbox", { name: /same-prefix-file-one/ });
      const second = screen.getByRole("checkbox", { name: /same-prefix-file-two/ });
      fireEvent.click(first);
      fireEvent.click(second);
      if (close === "Escape") fireEvent.keyDown(second, { key: "Escape" });
      else fireEvent.click(screen.getByRole("button", { name: close }));
      expect(confirm).not.toHaveBeenCalled();
      expect(trigger).toHaveFocus();
      fireEvent.click(trigger);
      expect(screen.getByRole("checkbox", { name: /same-prefix-file-one/ })).toBeChecked();
      expect(screen.getByRole("checkbox", { name: /same-prefix-file-two/ })).not.toBeChecked();
      expect(screen.getByRole("searchbox", { name: "搜索文件" })).toHaveValue("");
    },
  );

  it("supports keyboard selection and traps focus until returning to the trigger", async () => {
    const user = userEvent.setup();
    const confirm = vi.fn();
    render(<Harness onConfirm={confirm} />);
    const trigger = screen.getByRole("button", { name: "选已有文件" });
    await user.click(trigger);
    expect(screen.getByRole("searchbox", { name: "搜索文件" })).toHaveFocus();
    await user.tab();
    await user.keyboard(" ");
    expect(screen.getByRole("checkbox", { name: /same-prefix-file-one/ })).not.toBeChecked();
    const commit = screen.getByRole("button", { name: "确认选择" });
    commit.focus();
    await user.tab();
    expect(screen.getByRole("button", { name: "关闭材料选择" })).toHaveFocus();
    await user.tab({ shift: true });
    expect(commit).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(confirm).toHaveBeenCalledWith(new Set());
    expect(trigger).toHaveFocus();
  });

  it("shows an empty state for no reusable files and preserves unknown prior IDs", () => {
    const confirm = vi.fn();
    render(
      <MaterialPicker
        open
        files={[files[2]!]}
        selectedIds={new Set(["not-in-list"])}
        onClose={vi.fn()}
        onConfirm={confirm}
      />,
    );
    expect(screen.getByText("暂无可选文件")).toBeVisible();
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "确认选择" }));
    expect(confirm).toHaveBeenCalledWith(new Set(["not-in-list"]));
  });
});
