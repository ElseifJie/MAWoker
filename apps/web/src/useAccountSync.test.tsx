// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiClient } from "./api.js";
import { useAccountSync } from "./useAccountSync.js";

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("useAccountSync", () => {
  it("bootstraps and stores the snapshot cursor", async () => {
    vi.spyOn(apiClient, "getSyncSnapshot").mockResolvedValue({
      cursor: 7,
      resources: { runs: [], notifications: [] },
    });
    const storage = memoryStorage();
    renderHook(() =>
      useAccountSync({ userId: "user-1", storage, onChange: vi.fn() }),
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(storage.values.get("maworker.sync.user-1")).toBe("7");
  });

  it("polls from the stored cursor and reports changes", async () => {
    const change = {
      seq: 3,
      resourceType: "run",
      resourceId: "run-1",
      revision: 2,
      deleted: false,
      changedAt: "2026-10-17T00:00:00.000Z",
    };
    const fetchChanges = vi
      .spyOn(apiClient, "getSyncChanges")
      .mockResolvedValue({ cursor: 3, hasMore: false, changes: [change] });
    const storage = memoryStorage({ "maworker.sync.user-1": "2" });
    const onChange = vi.fn();
    renderHook(() =>
      useAccountSync({
        userId: "user-1",
        storage,
        onChange,
        intervalMs: 5_000,
      }),
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(fetchChanges).toHaveBeenCalledWith(2);
    expect(onChange).toHaveBeenCalledWith([change]);
    expect(storage.values.get("maworker.sync.user-1")).toBe("3");

    fetchChanges.mockResolvedValue({ cursor: 4, hasMore: false, changes: [] });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(fetchChanges).toHaveBeenLastCalledWith(3);
  });

  it("does nothing while disabled", async () => {
    const snapshot = vi.spyOn(apiClient, "getSyncSnapshot");
    const storage = memoryStorage();
    renderHook(() =>
      useAccountSync({
        userId: "user-1",
        enabled: false,
        storage,
        onChange: vi.fn(),
      }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });
    expect(snapshot).not.toHaveBeenCalled();
    expect(storage.values.size).toBe(0);
  });
});
