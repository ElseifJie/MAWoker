// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { usePwaInstall, type PwaInstallPromptEvent } from "./usePwaInstall.js";

afterEach(() => {
  vi.restoreAllMocks();
});

function promptEvent(outcome: "accepted" | "dismissed") {
  const event = new Event("beforeinstallprompt") as PwaInstallPromptEvent;
  const prompt = vi.fn(async () => undefined);
  Object.defineProperty(event, "prompt", { value: prompt });
  Object.defineProperty(event, "userChoice", {
    value: Promise.resolve({ outcome, platform: "web" }),
  });
  return { event, prompt };
}

describe("usePwaInstall", () => {
  it("offers installation after beforeinstallprompt and records acceptance", async () => {
    const { result } = renderHook(() => usePwaInstall());
    expect(result.current.canInstall).toBe(false);

    const { event, prompt } = promptEvent("accepted");
    act(() => window.dispatchEvent(event));
    expect(result.current.canInstall).toBe(true);

    let outcome: string | undefined;
    await act(async () => {
      outcome = await result.current.install();
    });
    expect(prompt).toHaveBeenCalledOnce();
    expect(outcome).toBe("accepted");
    expect(result.current.installed).toBe(true);
    expect(result.current.canInstall).toBe(false);
  });

  it("keeps the prompt when the user dismisses it", async () => {
    const { result } = renderHook(() => usePwaInstall());
    const { event } = promptEvent("dismissed");
    act(() => window.dispatchEvent(event));

    await act(async () => {
      expect(await result.current.install()).toBe("dismissed");
    });
    expect(result.current.installed).toBe(false);
    expect(result.current.canInstall).toBe(false);
  });

  it("marks the app installed from the appinstalled event", () => {
    const { result } = renderHook(() => usePwaInstall());
    act(() => window.dispatchEvent(new Event("appinstalled")));
    expect(result.current.installed).toBe(true);
    expect(result.current.canInstall).toBe(false);
  });

  it("returns unavailable when no prompt was captured", async () => {
    const { result } = renderHook(() => usePwaInstall());
    await expect(result.current.install()).resolves.toBe("unavailable");
  });
});
