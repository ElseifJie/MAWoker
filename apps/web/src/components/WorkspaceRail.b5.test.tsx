// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  RAIL_DEFAULT_WIDTH,
  RAIL_MAX_WIDTH,
  WorkspaceRail,
} from "./WorkspaceRail.js";

let containerWidth: number;
let containerRight: number;
let overlay: boolean;
let resizeContainer: () => void;
const disconnect = vi.fn();

function RailHarness({
  initialWidth = RAIL_DEFAULT_WIDTH,
  containerStyle = {},
} = {}) {
  const [width, setWidth] = useState(initialWidth);
  return (
    <div data-testid="workspace" style={containerStyle}>
      <main>Transcript</main>
      <WorkspaceRail
        todos={[]}
        artifacts={[]}
        artifactsError={false}
        onRetryArtifacts={() => undefined}
        selectedArtifactId={null}
        onSelectArtifact={() => undefined}
        width={width}
        onWidthChange={setWidth}
      />
    </div>
  );
}

function rail() {
  return screen.getByRole("complementary", { name: "Session side panel" });
}

function separator() {
  return screen.getByRole("separator", { name: "Resize side panel" });
}

beforeEach(() => {
  containerWidth = 900;
  containerRight = 1100;
  overlay = false;
  disconnect.mockClear();
  const getComputedStyle = window.getComputedStyle.bind(window);
  vi.spyOn(window, "getComputedStyle").mockImplementation((element) => {
    const style = getComputedStyle(element);
    if (element.classList.contains("workspace-rail")) {
      Object.defineProperty(style, "position", {
        value: overlay ? "fixed" : "relative",
      });
    }
    return style;
  });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      const width =
        this.dataset.testid === "workspace"
          ? containerWidth
          : this.classList.contains("workspace-rail")
            ? Number.parseFloat(this.style.width)
            : 0;
      return {
        x: containerRight - width,
        y: 0,
        left: containerRight - width,
        right: containerRight,
        top: 0,
        bottom: 600,
        width,
        height: 600,
        toJSON: () => ({}),
      };
    },
  );
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: ResizeObserverCallback) {
        resizeContainer = () => callback([], this as unknown as ResizeObserver);
      }
      observe = vi.fn();
      disconnect = disconnect;
    },
  );
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("B5 responsive workspace rail", () => {
  it("clamps a restored width while reserving space for the transcript", () => {
    render(<RailHarness initialWidth={1200} />);
    expect(rail()).toHaveStyle({ width: "516px" });
    expect(separator()).toHaveAttribute("aria-valuemax", "516");
    expect(separator()).toHaveAttribute("aria-valuenow", "516");
  });

  it("subtracts the container's padding, border, and grid gap", () => {
    render(
      <RailHarness
        initialWidth={700}
        containerStyle={{
          padding: "24px",
          border: "1px solid",
          columnGap: "16px",
        }}
      />,
    );
    expect(rail()).toHaveStyle({ width: "450px" });
  });

  it("scales the transcript reserve with the user's root font size", () => {
    document.documentElement.style.fontSize = "20px";
    try {
      render(<RailHarness initialWidth={700} />);
      expect(rail()).toHaveStyle({ width: "450px" });
    } finally {
      document.documentElement.style.removeProperty("font-size");
    }
  });

  it("reclamps on container resize and restores the preferred width on growth", () => {
    render(<RailHarness initialWidth={600} />);
    act(() => {
      containerWidth = 600;
      resizeContainer();
    });
    expect(rail()).toHaveStyle({ width: "300px" });
    act(() => {
      containerWidth = 1300;
      resizeContainer();
    });
    expect(rail()).toHaveStyle({ width: "600px" });
    expect(separator()).toHaveAttribute("aria-valuemax", `${RAIL_MAX_WIDTH}`);
  });

  it("allows less than the nominal minimum when the container is very narrow", () => {
    containerWidth = 240;
    render(<RailHarness />);
    expect(rail()).toHaveStyle({ width: "120px" });
    expect(separator()).toHaveAttribute("aria-valuemin", "120");
    expect(separator()).toHaveAttribute("aria-valuemax", "120");
    fireEvent.keyDown(separator(), { key: "ArrowLeft" });
    expect(rail()).toHaveStyle({ width: "120px" });
  });

  it("uses the panel's right edge for dragging and applies container bounds", () => {
    render(<RailHarness />);
    const handle = separator();
    handle.setPointerCapture = vi.fn();
    handle.hasPointerCapture = vi.fn().mockReturnValue(true);
    handle.releasePointerCapture = vi.fn();
    // jsdom has no PointerEvent implementation.
    vi.stubGlobal("PointerEvent", MouseEvent);
    fireEvent.pointerDown(handle, { clientX: 760 });
    fireEvent.pointerMove(handle, { clientX: 700 });
    expect(rail()).toHaveStyle({ width: "400px" });
    fireEvent.pointerMove(handle, { clientX: 0 });
    expect(rail()).toHaveStyle({ width: "516px" });
    fireEvent.pointerUp(handle);
    expect(handle.releasePointerCapture).toHaveBeenCalled();
  });

  it("uses the effective width for keyboard resize after a container shrink", () => {
    render(<RailHarness initialWidth={600} />);
    act(() => {
      containerWidth = 800;
      resizeContainer();
    });
    fireEvent.keyDown(separator(), { key: "ArrowRight" });
    expect(rail()).toHaveStyle({ width: "392px" });
    fireEvent.keyDown(separator(), { key: "ArrowLeft" });
    fireEvent.keyDown(separator(), { key: "ArrowLeft" });
    expect(rail()).toHaveStyle({ width: "416px" });
  });

  it("bounds a drawer by both the workspace and viewport on window resize", () => {
    overlay = true;
    containerWidth = 400;
    vi.stubGlobal("innerWidth", 320);
    render(<RailHarness initialWidth={600} />);
    expect(rail()).toHaveStyle({ width: "320px" });
    act(() => {
      vi.stubGlobal("innerWidth", 240);
      window.dispatchEvent(new Event("resize"));
    });
    expect(rail()).toHaveStyle({ width: "240px" });
    expect(separator()).toHaveAttribute("aria-valuemin", "240");
  });

  it("normalizes non-finite widths and disconnects its resize observer", () => {
    const { unmount } = render(<RailHarness initialWidth={Number.NaN} />);
    expect(rail()).toHaveStyle({ width: "340px" });
    unmount();
    expect(disconnect).toHaveBeenCalledOnce();
  });
});
