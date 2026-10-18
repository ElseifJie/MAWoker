// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { solveShellLayout } from "./layout.js";
import { DEFAULT_SHELL_STATE, type PanelDescriptor } from "./shell-state.js";
import {
  useShellLayout,
  type ShellLayoutController,
} from "./useShellLayout.js";
import { WorkspaceFrame } from "./WorkspaceFrame.js";

const panels: PanelDescriptor[] = [
  { id: "panel-1", type: "artifact", title: "报表.xlsx" },
];

function controller(viewportWidth: number): ShellLayoutController {
  return {
    layout: solveShellLayout({ viewportWidth }),
    state: DEFAULT_SHELL_STATE,
    setLeftWidth: vi.fn(),
    setRightWidth: vi.fn(),
    setLeftCollapsed: vi.fn(),
    setRightOpen: vi.fn(),
    toggleLeft: vi.fn(),
    toggleRight: vi.fn(),
  };
}

function renderFrame(shell: ShellLayoutController) {
  return render(
    <WorkspaceFrame
      shell={shell}
      left={<nav>导航</nav>}
      center={<article>会话</article>}
      panels={panels}
      activePanelId="panel-1"
      onSelectPanel={vi.fn()}
      onClosePanel={vi.fn()}
      renderPanel={(panel) => <div>预览：{panel.title}</div>}
    />,
  );
}

afterEach(cleanup);

describe("WorkspaceFrame", () => {
  it("composes navigation, conversation, and the active panel", () => {
    renderFrame(controller(1440));

    expect(
      screen.getByRole("complementary", { name: "Navigation" }),
    ).toHaveTextContent("导航");
    expect(screen.getByRole("main")).toHaveTextContent("会话");
    expect(screen.getByRole("tab", { name: "报表.xlsx" })).toBeVisible();
    expect(screen.getByRole("tabpanel")).toHaveTextContent("预览：报表.xlsx");
  });

  it("omits the panel host when the right panel is closed", () => {
    const shell = controller(1440);
    shell.layout = solveShellLayout({ viewportWidth: 1440, rightOpen: false });
    renderFrame(shell);

    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("complementary", { name: "Workspace panel" }),
    ).not.toBeInTheDocument();
  });

  it("renders the empty panel state", () => {
    const shell = controller(1440);
    render(
      <WorkspaceFrame
        shell={shell}
        left={<nav>导航</nav>}
        center={<article>会话</article>}
        panels={[]}
        activePanelId={null}
        onSelectPanel={vi.fn()}
        onClosePanel={vi.fn()}
        renderPanel={vi.fn()}
      />,
    );

    expect(
      screen.getByText("Open a file or result to see it here."),
    ).toBeVisible();
  });

  it("renders the right region as an overlay on narrow screens", () => {
    const { container } = renderFrame(controller(767));

    expect(
      container.querySelector(".ui-app-frame__right--overlay"),
    ).not.toBeNull();
  });

  it("hides the right host when the current view has no visible panels", () => {
    const shell = controller(1440);
    shell.layout = solveShellLayout({ viewportWidth: 1440, rightOpen: true });
    const { container } = render(
      <WorkspaceFrame
        shell={shell}
        left={<nav>导航</nav>}
        center={<article>会话</article>}
        panels={panels}
        activePanelId="panel-1"
        onSelectPanel={vi.fn()}
        onClosePanel={vi.fn()}
        renderPanel={(panel) => <div>预览：{panel.title}</div>}
        rightVisible={false}
      />,
    );

    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
    expect(container.querySelector(".ui-app-frame__right")).toBeNull();
  });

  it("keeps the hook-composed controller usable with the frame", () => {
    function Harness() {
      const shell = useShellLayout({
        storage: undefined,
        viewport: 1440,
        initial: { rightOpen: true },
      });
      return (
        <WorkspaceFrame
          shell={shell}
          left={<nav>导航</nav>}
          center={<article>会话</article>}
          panels={panels}
          activePanelId="panel-1"
          onSelectPanel={vi.fn()}
          onClosePanel={vi.fn()}
          renderPanel={(panel) => <div>预览：{panel.title}</div>}
        />
      );
    }
    render(<Harness />);

    expect(screen.getByRole("main")).toHaveTextContent("会话");
    expect(screen.getByRole("tab", { name: "报表.xlsx" })).toBeVisible();
  });
});
