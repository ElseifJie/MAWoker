// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  THEME_STORAGE_KEY,
  applyTheme,
  readThemePreference,
  resolveTheme,
  useThemePreference,
  writeThemePreference,
} from "./theme.js";

type Listener = (event: { matches: boolean }) => void;

/** jsdom's matchMedia always reports light, so the system path needs a stub. */
function stubMatchMedia(matches: boolean) {
  const listeners = new Set<Listener>();
  const mediaQueryList = {
    matches,
    media: "(prefers-color-scheme: dark)",
    addEventListener: (_: string, listener: Listener) => {
      listeners.add(listener);
    },
    removeEventListener: (_: string, listener: Listener) => {
      listeners.delete(listener);
    },
  };
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => mediaQueryList),
  );
  return {
    setMatches(next: boolean) {
      mediaQueryList.matches = next;
      for (const listener of listeners) listener({ matches: next });
    },
    listenerCount: () => listeners.size,
  };
}

beforeEach(() => {
  localStorage.clear();
  delete document.documentElement.dataset.theme;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("theme preference", () => {
  it("defaults to following the system", () => {
    expect(readThemePreference()).toBe("system");
  });

  it("ignores a stored value outside the three preferences", () => {
    localStorage.setItem(THEME_STORAGE_KEY, "sepia");

    expect(readThemePreference()).toBe("system");
  });

  it("round-trips a stored preference", () => {
    writeThemePreference("dark");

    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
    expect(readThemePreference()).toBe("dark");
  });

  it("resolves the system preference from the media query", () => {
    stubMatchMedia(true);
    expect(resolveTheme("system")).toBe("dark");

    stubMatchMedia(false);
    expect(resolveTheme("system")).toBe("light");
  });

  it("ignores the media query for an explicit preference", () => {
    stubMatchMedia(true);

    expect(resolveTheme("light")).toBe("light");
  });

  it("paints the resolved theme onto the document element", () => {
    stubMatchMedia(false);

    expect(applyTheme("dark")).toBe("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(document.documentElement.style.colorScheme).toBe("dark");

    applyTheme("system");
    expect(document.documentElement.dataset.theme).toBe("light");
  });
});

describe("useThemePreference", () => {
  it("applies and persists a chosen preference", () => {
    stubMatchMedia(true);
    const { result } = renderHook(() => useThemePreference());

    expect(result.current.preference).toBe("system");
    expect(result.current.resolved).toBe("dark");

    act(() => result.current.setPreference("light"));

    expect(result.current.resolved).toBe("light");
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");
  });

  it("starts from the stored preference", () => {
    stubMatchMedia(true);
    localStorage.setItem(THEME_STORAGE_KEY, "light");

    const { result } = renderHook(() => useThemePreference());

    expect(result.current.preference).toBe("light");
    expect(result.current.resolved).toBe("light");
  });

  it("tracks live system changes only while following the system", () => {
    const system = stubMatchMedia(false);
    const { result } = renderHook(() => useThemePreference());

    expect(result.current.resolved).toBe("light");
    act(() => system.setMatches(true));
    expect(result.current.resolved).toBe("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");

    act(() => result.current.setPreference("light"));
    act(() => system.setMatches(false));

    // An explicit choice must not be overridden by the system.
    expect(result.current.resolved).toBe("light");
    expect(system.listenerCount()).toBe(0);
  });
});
