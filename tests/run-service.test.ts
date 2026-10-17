import { describe, expect, it, vi } from "vitest";
import {
  ResourceNotFoundError,
  RunService,
  RunTransitionConflictError,
  type RunRecord,
} from "../packages/domain/src/index.js";

const run: RunRecord = {
  id: "00000000-0000-4000-8000-000000000010",
  ownerUserId: "00000000-0000-4000-8000-000000000001",
  conversationId: "00000000-0000-4000-8000-000000000002",
  triggerKind: "manual",
  submissionId: "00000000-0000-4000-8000-000000000003",
  status: "queued",
  arkSessionId: null,
  turnId: null,
  automationId: null,
  errorCode: null,
  startedAt: null,
  endedAt: null,
  version: 1,
  createdAt: new Date("2026-10-17T00:00:00.000Z"),
  updatedAt: new Date("2026-10-17T00:00:00.000Z"),
};

function repository(
  overrides: Partial<{
    findOwned: () => Promise<RunRecord | undefined>;
    findBySubmission: () => Promise<RunRecord | undefined>;
    transition: (input: {
      to: RunRecord["status"];
    }) => Promise<RunRecord | undefined>;
  }> = {},
) {
  return {
    findOwned: vi.fn(overrides.findOwned ?? (async () => run)),
    findBySubmission: vi.fn(overrides.findBySubmission ?? (async () => run)),
    transition: vi.fn(
      overrides.transition ??
        (async (input: { to: RunRecord["status"] }) => ({
          ...run,
          status: input.to,
          version: 2,
        })),
    ),
  };
}

describe("RunService", () => {
  it("returns an owner-scoped Run", async () => {
    const repo = repository();
    const service = new RunService({ repository: repo });

    await expect(service.get(run.ownerUserId, run.id)).resolves.toEqual(run);
    expect(repo.findOwned).toHaveBeenCalledWith(run.ownerUserId, run.id);
  });

  it("hides a Run from another owner", async () => {
    const repo = repository({ findOwned: async () => undefined });
    const service = new RunService({ repository: repo });

    await expect(service.get("other-user", run.id)).rejects.toBeInstanceOf(
      ResourceNotFoundError,
    );
  });

  it("resolves a Run by its durable submission", async () => {
    const repo = repository();
    const service = new RunService({ repository: repo });

    await expect(
      service.findBySubmission(run.ownerUserId, run.submissionId),
    ).resolves.toEqual(run);
    await expect(
      new RunService({
        repository: repository({ findBySubmission: async () => undefined }),
      }).findBySubmission(run.ownerUserId, run.submissionId),
    ).rejects.toBeInstanceOf(ResourceNotFoundError);
  });

  it("moves status with the owner and source statuses attached", async () => {
    const repo = repository();
    const service = new RunService({ repository: repo });

    await expect(
      service.transition(run.ownerUserId, run.id, {
        from: ["queued"],
        to: "running",
        startedAt: new Date("2026-10-17T00:01:00.000Z"),
      }),
    ).resolves.toMatchObject({ status: "running", version: 2 });
    expect(repo.transition).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerUserId: run.ownerUserId,
        id: run.id,
        from: ["queued"],
        to: "running",
      }),
    );
  });

  it("rejects a stale transition instead of overwriting it", async () => {
    const repo = repository({ transition: async () => undefined });
    const service = new RunService({ repository: repo });

    await expect(
      service.transition(run.ownerUserId, run.id, {
        from: ["queued"],
        to: "running",
      }),
    ).rejects.toBeInstanceOf(RunTransitionConflictError);
  });

  it("does not attempt a transition for a missing Run", async () => {
    const repo = repository({ findOwned: async () => undefined });
    const service = new RunService({ repository: repo });

    await expect(
      service.transition(run.ownerUserId, run.id, {
        from: ["queued"],
        to: "running",
      }),
    ).rejects.toBeInstanceOf(ResourceNotFoundError);
    expect(repo.transition).not.toHaveBeenCalled();
  });

  it("rejects an empty source-status set", async () => {
    const service = new RunService({ repository: repository() });

    await expect(
      service.transition(run.ownerUserId, run.id, {
        from: [],
        to: "running",
      }),
    ).rejects.toThrow("at least one source status");
  });
});
