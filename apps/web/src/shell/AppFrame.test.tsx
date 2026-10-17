// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
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
});
