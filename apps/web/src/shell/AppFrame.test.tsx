// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppFrame } from "./AppFrame.js";
import { solveShellLayout } from "./layout.js";

afterEach(cleanup);

describe("AppFrame", () => {
  it("renders left, center, and right regions with the solved widths", () => {
    const layout = solveShellLayout({ viewportWidth: 1440 });
    const { container } = render(
      <AppFrame
        layout={layout}
        left={<nav>导航</nav>}
        center={<article>内容</article>}
        right={<aside>产物</aside>}
      />,
    );

    expect(
      screen.getByRole("complementary", { name: "Navigation" }),
    ).toBeVisible();
    expect(screen.getByRole("main")).toHaveTextContent("内容");
    expect(
      screen.getByRole("complementary", { name: "Workspace panel" }),
    ).toHaveTextContent("产物");
    const frame = container.querySelector(".ui-app-frame") as HTMLElement;
    expect(frame.style.getPropertyValue("--ui-shell-left-width")).toBe("280px");
    expect(frame.style.getPropertyValue("--ui-shell-right-width")).toBe(
      "648px",
    );
  });

  it("omits the right region when the panel is closed", () => {
    render(
      <AppFrame
        layout={solveShellLayout({ viewportWidth: 1440, rightOpen: false })}
        left={<nav>导航</nav>}
        center={<article>内容</article>}
        right={<aside>产物</aside>}
      />,
    );

    expect(
      screen.queryByRole("complementary", { name: "Workspace panel" }),
    ).not.toBeInTheDocument();
  });

  it("marks the right region as an overlay on narrow screens", () => {
    const { container } = render(
      <AppFrame
        layout={solveShellLayout({ viewportWidth: 767 })}
        left={<nav>导航</nav>}
        center={<article>内容</article>}
        right={<aside>产物</aside>}
      />,
    );

    expect(
      container.querySelector(".ui-app-frame__right--overlay"),
    ).not.toBeNull();
  });

  it("[shell.narrow] locks scroll, traps focus, and closes the drawer on Escape or backdrop", async () => {
    const onCloseDrawer = vi.fn();
    const { container, unmount } = render(
      <AppFrame
        layout={solveShellLayout({ viewportWidth: 600, rightOpen: true })}
        left={
          <nav>
            <button type="button" data-drawer-trigger="true">
              菜单
            </button>
            <button type="button">第二项</button>
          </nav>
        }
        center={<article>内容</article>}
        right={<aside>产物</aside>}
        drawerOpen
        onCloseDrawer={onCloseDrawer}
        drawerLabel="关闭导航"
      />,
    );
    const user = userEvent.setup();

    expect(container.querySelector(".ui-app-frame")).toHaveAttribute(
      "data-drawer",
      "open",
    );
    expect(screen.getByRole("button", { name: "菜单" })).toHaveFocus();
    expect(document.body.style.overflow).toBe("hidden");
    expect(screen.getByRole("main")).toHaveAttribute("inert");
    expect(
      screen.getByRole("complementary", { name: "Workspace panel" }),
    ).toHaveAttribute("inert");

    await user.tab({ shift: true });
    expect(screen.getByRole("button", { name: "第二项" })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("button", { name: "菜单" })).toHaveFocus();

    await user.keyboard("{Escape}");
    expect(onCloseDrawer).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: "关闭导航" }));
    expect(onCloseDrawer).toHaveBeenCalledTimes(2);

    unmount();
    expect(document.body.style.overflow).toBe("");
  });

  it("[panel.overlay] closes the narrow right overlay from its floating control", async () => {
    const onCloseOverlay = vi.fn();
    render(
      <AppFrame
        layout={solveShellLayout({ viewportWidth: 767, rightOpen: true })}
        left={<nav>导航</nav>}
        center={<article>内容</article>}
        right={<aside>产物</aside>}
        onCloseOverlay={onCloseOverlay}
        overlayCloseLabel="关闭面板"
      />,
    );

    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "关闭面板" }));
    expect(onCloseOverlay).toHaveBeenCalledTimes(1);
  });

  it("[layout.bounds] resizes the left and right rails by keyboard and pointer", async () => {
    const onLeftWidthChange = vi.fn();
    const onRightWidthChange = vi.fn();
    render(
      <AppFrame
        layout={solveShellLayout({ viewportWidth: 1440, rightOpen: true })}
        left={<nav>导航</nav>}
        center={<article>内容</article>}
        right={<aside>产物</aside>}
        onLeftWidthChange={onLeftWidthChange}
        onRightWidthChange={onRightWidthChange}
        leftResizeLabel="调整导航宽度"
        rightResizeLabel="调整面板宽度"
      />,
    );
    const user = userEvent.setup();

    const left = screen.getByRole("separator", { name: "调整导航宽度" });
    expect(left).toHaveAttribute("aria-valuenow", "280");
    expect(left).toHaveAttribute("aria-valuemin", "264");
    expect(left).toHaveAttribute("aria-valuemax", "420");
    left.focus();
    await user.keyboard("{ArrowRight}");
    expect(onLeftWidthChange).toHaveBeenLastCalledWith(304);
    await user.keyboard("{Home}");
    expect(onLeftWidthChange).toHaveBeenLastCalledWith(264);

    const right = screen.getByRole("separator", { name: "调整面板宽度" });
    expect(right).toHaveAttribute("aria-valuenow", "648");
    expect(right).toHaveAttribute("aria-valuemax", "760");
    right.focus();
    await user.keyboard("{ArrowLeft}");
    expect(onRightWidthChange).toHaveBeenLastCalledWith(672);
    await user.keyboard("{End}");
    expect(onRightWidthChange).toHaveBeenLastCalledWith(760);

    fireEvent.pointerDown(left, { clientX: 100, pointerId: 1 });
    fireEvent.pointerMove(left, { clientX: 140, pointerId: 1 });
    expect(onLeftWidthChange).toHaveBeenLastCalledWith(320);
    fireEvent.pointerUp(left, { clientX: 140, pointerId: 1 });
  });
});
