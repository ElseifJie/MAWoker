import { describe, expect, it, vi } from "vitest";
import { syncAccountChanges } from "../apps/web/src/useAccountSync.js";

const emptySnapshot = {
  cursor: 4,
  resources: { runs: [], notifications: [] },
};

describe("account sync", () => {
  it("bootstraps from the snapshot when no cursor exists", async () => {
    const fetchSnapshot = vi.fn(async () => emptySnapshot);
    const onChange = vi.fn();

    await expect(
      syncAccountChanges({
        cursor: null,
        fetchSnapshot,
        fetchChanges: vi.fn(),
        onChange,
      }),
    ).resolves.toEqual({ cursor: 4, changes: [] });
    expect(fetchSnapshot).toHaveBeenCalledOnce();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("drains pages, reports changes, and returns the newest cursor", async () => {
    const changes = [
      {
        seq: 5,
        resourceType: "run",
        resourceId: "run-1",
        revision: 1,
        deleted: false,
        changedAt: "2026-10-17T00:00:00.000Z",
      },
      {
        seq: 6,
        resourceType: "notification",
        resourceId: "notification-1",
        revision: null,
        deleted: false,
        changedAt: "2026-10-17T00:00:01.000Z",
      },
    ];
    const fetchChanges = vi
      .fn()
      .mockResolvedValueOnce({
        cursor: 5,
        hasMore: true,
        changes: [changes[0]],
      })
      .mockResolvedValueOnce({
        cursor: 6,
        hasMore: false,
        changes: [changes[1]],
      });
    const onChange = vi.fn();

    const result = await syncAccountChanges({
      cursor: 4,
      fetchSnapshot: vi.fn(),
      fetchChanges,
      onChange,
    });

    expect(result).toEqual({ cursor: 6, changes });
    expect(fetchChanges.mock.calls).toEqual([[4], [5]]);
    expect(onChange).toHaveBeenCalledWith(changes);
  });
});
