// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PanelHost } from "./PanelHost.js";
import type { PanelDescriptor } from "./shell-state.js";

const panels: PanelDescriptor[] = [
  { id: "panel-1", type: "file", title: "方案.md" },
  { id: "panel-2", type: "artifact", title: "报表.xlsx" },
];

afterEach(cleanup);

function props(activeId: string | null = "panel-1") {
  return {
    panels,
    activeId,
    onSelect: vi.fn(),
    onClose: vi.fn(),
    onReorder: vi.fn(),
    renderPanel: (panel: PanelDescriptor) => <div>内容：{panel.title}</div>,
  };
}

describe("PanelHost", () => {
  it("renders an accessible tablist and the active panel", () => {
    render(<PanelHost {...props()} />);

    expect(screen.getByRole("tablist", { name: "Open panels" })).toBeVisible();
    expect(screen.getByRole("tab", { name: "方案.md" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByRole("tabpanel")).toHaveTextContent("内容：方案.md");
  });

  it("selects and closes a panel by its accessible name", async () => {
    const user = userEvent.setup();
    const view = props();
    render(<PanelHost {...view} />);

    await user.click(screen.getByRole("tab", { name: "报表.xlsx" }));
    expect(view.onSelect).toHaveBeenCalledWith("panel-2");

    await user.click(screen.getByRole("button", { name: "Close 方案.md" }));
    expect(view.onClose).toHaveBeenCalledWith("panel-1");
  });

  it("moves the active panel with arrow, Home, and End keys", async () => {
    const user = userEvent.setup();
    const view = props();
    render(<PanelHost {...view} />);
    const first = screen.getByRole("tab", { name: "方案.md" });

    first.focus();
    await user.keyboard("{ArrowRight}");
    expect(view.onSelect).toHaveBeenLastCalledWith("panel-2");
    await user.keyboard("{Home}");
    expect(view.onSelect).toHaveBeenLastCalledWith("panel-1");
    await user.keyboard("{End}");
    expect(view.onSelect).toHaveBeenLastCalledWith("panel-2");
  });

  it("renders the empty state when no panels are open", () => {
    render(<PanelHost {...props(null)} panels={[]} />);

    expect(screen.getByText("No panels are open.")).toBeVisible();
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
  });

  it("[panel.drag] reorders tabs on drop", () => {
    const view = props();
    render(<PanelHost {...view} />);
    const first = screen.getByRole("tab", { name: "方案.md" });
    const second = screen.getByRole("tab", { name: "报表.xlsx" });
    const store = new Map<string, string>();
    const dataTransfer = {
      effectAllowed: "move",
      setData: (type: string, value: string) => store.set(type, value),
      getData: (type: string) => store.get(type) ?? "",
    };

    fireEvent.dragStart(first, { dataTransfer });
    fireEvent.dragOver(second, { dataTransfer });
    fireEvent.drop(second, { dataTransfer });

    expect(view.onReorder).toHaveBeenCalledWith(0, 1);
  });
});
