import { describe, expect, it, vi } from "vitest";
import { SyncService } from "../packages/domain/src/index.js";

function change(seq: number) {
  return {
    seq,
    resourceType: "run",
    resourceId: `run-${seq}`,
    revision: seq,
    deleted: false,
    changedAt: new Date("2026-10-17T00:00:00.000Z"),
  };
}

function build(
  overrides: {
    getCursor?: () => Promise<number>;
    listChanges?: () => Promise<{
      changes: ReturnType<typeof change>[];
      hasMore: boolean;
    }>;
  } = {},
) {
  const repository = {
    getCursor: vi.fn(overrides.getCursor ?? (async () => 2)),
    listChanges: vi.fn(
      overrides.listChanges ??
        (async () => ({ changes: [change(3), change(4)], hasMore: false })),
    ),
  };
  const runs = {
    listForOwner: vi.fn(async () => [{ id: "run-1" }]),
  };
  const notifications = {
    listNotifications: vi.fn(async () => [{ id: "notification-1" }]),
  };
  return {
    service: new SyncService({ repository, runs, notifications }),
    repository,
    runs,
    notifications,
  };
}

describe("SyncService", () => {
  it("returns a snapshot at the current cursor", async () => {
    const { service, runs, notifications } = build();

    await expect(service.snapshot("user-1")).resolves.toEqual({
      cursor: 2,
      resources: {
        runs: [{ id: "run-1" }],
        notifications: [{ id: "notification-1" }],
      },
    });
    expect(runs.listForOwner).toHaveBeenCalledWith("user-1", 50);
    expect(notifications.listNotifications).toHaveBeenCalledWith("user-1", 50);
  });

  it("advances the cursor to the last returned change", async () => {
    const { service, repository } = build();

    await expect(service.changes("user-1", 2, 10)).resolves.toMatchObject({
      cursor: 4,
      hasMore: false,
      changes: [{ seq: 3 }, { seq: 4 }],
    });
    expect(repository.listChanges).toHaveBeenCalledWith("user-1", 2, 10);
  });

  it("keeps the caller cursor when no changes exist", async () => {
    const { service } = build({
      listChanges: async () => ({ changes: [], hasMore: false }),
    });

    await expect(service.changes("user-1", 7, 10)).resolves.toEqual({
      cursor: 7,
      hasMore: false,
      changes: [],
    });
  });

  it("passes through hasMore for a paginated read", async () => {
    const { service } = build({
      listChanges: async () => ({ changes: [change(5)], hasMore: true }),
    });

    await expect(service.changes("user-1", 4, 1)).resolves.toMatchObject({
      cursor: 5,
      hasMore: true,
    });
  });
});
