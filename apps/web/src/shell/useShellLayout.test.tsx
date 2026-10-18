// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { SHELL_STATE_KEY } from "./shell-state.js";
import { useShellLayout } from "./useShellLayout.js";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
  };
}

afterEach(() => {
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    writable: true,
    value: 1024,
  });
});

describe("useShellLayout", () => {
  it("solves the default desktop geometry", () => {
    const { result } = renderHook(() =>
      useShellLayout({
        storage: memoryStorage(),
        viewport: 1440,
        initial: { rightOpen: true },
      }),
    );

    expect(result.current.layout).toMatchObject({
      leftWidth: 280,
      rightWidth: 648,
      centerWidth: 512,
      leftMode: "expanded",
      rightMode: "panel",
    });
  });

  it("clamps resize requests and persists them per device", () => {
    const storage = memoryStorage();
    const { result } = renderHook(() =>
      useShellLayout({ storage, viewport: 1440, initial: { rightOpen: true } }),
    );

    act(() => result.current.setRightWidth(900));
    expect(result.current.layout.rightWidth).toBe(760);
    act(() => result.current.setLeftWidth(999));
    expect(result.current.layout.leftWidth).toBe(420);

    const stored = JSON.parse(storage.values.get(SHELL_STATE_KEY) ?? "{}") as {
      leftWidth?: number;
      rightWidth?: number;
    };
    expect(stored).toMatchObject({ leftWidth: 420, rightWidth: 760 });
  });

  it("auto-collapses the left rail below 1024 and reopens on desktop", () => {
    const { result } = renderHook(() =>
      useShellLayout({
        storage: memoryStorage(),
        viewport: 800,
        initial: { rightOpen: true },
      }),
    );
    expect(result.current.layout.leftMode).toBe("collapsed");
    expect(result.current.layout.leftWidth).toBe(56);

    act(() => result.current.setLeftCollapsed(false));
    expect(result.current.layout.leftMode).toBe("collapsed");
  });

  it("closes and reopens the right panel", () => {
    const { result } = renderHook(() =>
      useShellLayout({
        storage: memoryStorage(),
        viewport: 1440,
        initial: { rightOpen: true },
      }),
    );

    act(() => result.current.setRightOpen(false));
    expect(result.current.layout.rightMode).toBe("closed");
    expect(result.current.layout.centerWidth).toBe(1160);

    act(() => result.current.toggleRight());
    expect(result.current.layout.rightMode).toBe("panel");
  });

  it("reacts to viewport resize when no fixed viewport is supplied", () => {
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      writable: true,
      value: 1440,
    });
    const { result } = renderHook(() =>
      useShellLayout({
        storage: memoryStorage(),
        initial: { rightOpen: true },
      }),
    );
    expect(result.current.layout.leftMode).toBe("expanded");

    act(() => {
      window.innerWidth = 800;
      window.dispatchEvent(new Event("resize"));
    });
    expect(result.current.layout.leftMode).toBe("collapsed");
    expect(result.current.layout.rightWidth).toBe(344);
  });

  it("opens, activates, reorders, and closes workspace panels", () => {
    const storage = memoryStorage();
    const { result } = renderHook(() =>
      useShellLayout({ storage, viewport: 1440 }),
    );
    const first = {
      id: "artifact:a",
      type: "artifact",
      title: "a.pdf",
      resourceRef: "a",
      conversationId: "session-1",
    };
    const second = {
      id: "artifact:b",
      type: "artifact",
      title: "b.pdf",
      resourceRef: "b",
      conversationId: "session-1",
    };

    act(() => result.current.openPanel(first));
    expect(result.current.state.panels).toEqual([first]);
    expect(result.current.state.activePanelId).toBe(first.id);
    expect(result.current.layout.rightMode).toBe("panel");

    act(() => result.current.openPanel(second));
    expect(result.current.state.panels.map((panel) => panel.id)).toEqual([
      first.id,
      second.id,
    ]);
    expect(result.current.state.activePanelId).toBe(second.id);

    act(() => result.current.reorderPanels(0, 1));
    expect(result.current.state.panels.map((panel) => panel.id)).toEqual([
      second.id,
      first.id,
    ]);

    act(() => result.current.setActivePanel(first.id));
    expect(result.current.state.activePanelId).toBe(first.id);

    act(() => result.current.closePanel(first.id));
    expect(result.current.state.panels.map((panel) => panel.id)).toEqual([
      second.id,
    ]);
    expect(result.current.state.activePanelId).toBe(second.id);

    act(() => result.current.closePanel(second.id));
    expect(result.current.state.panels).toEqual([]);
    expect(result.current.state.activePanelId).toBeNull();
    expect(result.current.layout.rightMode).toBe("closed");
  });

  it("updates a panel descriptor without duplicating its tab", () => {
    const { result } = renderHook(() =>
      useShellLayout({ storage: memoryStorage(), viewport: 1440 }),
    );
    const panel = {
      id: "artifact:a",
      type: "artifact",
      title: "a.pdf",
      resourceRef: "a",
      conversationId: "session-1",
    };

    act(() => result.current.openPanel(panel));
    act(() => result.current.openPanel({ ...panel, title: "renamed.pdf" }));

    expect(result.current.state.panels).toHaveLength(1);
    expect(result.current.state.panels[0]?.title).toBe("renamed.pdf");
    expect(result.current.state.activePanelId).toBe(panel.id);
  });

  it("[shell.restore] loads persisted panels and the active tab", () => {
    const storage = memoryStorage();
    storage.setItem(
      SHELL_STATE_KEY,
      JSON.stringify({
        leftWidth: 300,
        rightWidth: 520,
        leftCollapsed: false,
        rightOpen: true,
        panels: [
          {
            id: "artifact:a",
            type: "artifact",
            title: "a.pdf",
            resourceRef: "a",
            conversationId: "session-1",
          },
        ],
        activePanelId: "artifact:a",
      }),
    );

    const { result } = renderHook(() =>
      useShellLayout({ storage, viewport: 1440 }),
    );

    expect(result.current.state.leftWidth).toBe(300);
    expect(result.current.state.rightOpen).toBe(true);
    expect(result.current.state.panels).toHaveLength(1);
    expect(result.current.state.activePanelId).toBe("artifact:a");
    expect(result.current.layout.rightMode).toBe("panel");
  });
});
