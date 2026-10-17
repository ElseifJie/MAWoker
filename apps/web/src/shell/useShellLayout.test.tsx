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
});
