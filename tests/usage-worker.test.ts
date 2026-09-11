import { describe, expect, it, vi } from "vitest";
import { QuotaInterruptProcessor } from "../apps/worker/src/quota-interrupt.js";
import { UsageReconciliationProcessor } from "../apps/worker/src/usage-reconciliation.js";

describe("usage reconciliation worker", () => {
  it("projects complete Ark history without a browser SSE connection", async () => {
    const repository = {
      listReconcilable: vi.fn(async () => [
        {
          sessionId: "session-1",
          ownerUserId: "user-1",
          arkSessionId: "ark-session-1",
          status: "running" as const,
        },
      ]),
      projectEvent: vi.fn(),
      markReconciled: vi.fn(),
    };
    const ark = {
      listEvents: vi.fn(async () => [
        {
          id: "event-usage",
          type: "span.model_request_end",
          createdAt: "2026-09-01T00:00:00.000Z",
          data: {
            model_usage: { input_tokens: 13, output_tokens: 5 },
          },
        },
      ]),
    };
    const processor = new UsageReconciliationProcessor({
      repository,
      ark,
      workerId: "usage-worker-1",
      now: () => new Date("2026-09-01T00:05:00.000Z"),
    });

    await expect(processor.runOnce()).resolves.toBe(1);
    expect(ark.listEvents).toHaveBeenCalledWith("ark-session-1", {
      correlationId: "usage-reconcile:usage-worker-1:session-1",
    });
    expect(repository.projectEvent).toHaveBeenCalledWith(
      "user-1",
      "session-1",
      {
        eventId: "event-usage",
        observedAt: new Date("2026-09-01T00:00:00.000Z"),
        metrics: [
          { metricType: "input_tokens", quantity: 13 },
          { metricType: "output_tokens", quantity: 5 },
        ],
      },
    );
  });

  it("orders history by Ark timestamp and continues after one Session fails", async () => {
    const repository = {
      listReconcilable: vi.fn(async () => [
        {
          sessionId: "session-failed",
          ownerUserId: "user-1",
          arkSessionId: "ark-session-failed",
          status: "running" as const,
        },
        {
          sessionId: "session-2",
          ownerUserId: "user-1",
          arkSessionId: "ark-session-2",
          status: "running" as const,
        },
      ]),
      projectEvent: vi.fn(),
      markReconciled: vi.fn(),
    };
    const ark = {
      listEvents: vi.fn(async (arkSessionId: string) => {
        if (arkSessionId === "ark-session-failed") {
          throw new Error("temporary");
        }
        return [
          {
            id: "event-idle",
            type: "session.status_idle",
            createdAt: "2026-09-01T00:00:02.000Z",
            data: {},
          },
          {
            id: "event-running",
            type: "session.status_running",
            createdAt: "2026-09-01T00:00:00.000Z",
            data: {},
          },
        ];
      }),
    };
    const reportError = vi.fn();
    const processor = new UsageReconciliationProcessor({
      repository,
      ark,
      workerId: "usage-worker-1",
      reportError,
    });

    await expect(processor.runOnce()).resolves.toBe(2);
    expect(
      repository.projectEvent.mock.calls.map((call) => call[2].eventId),
    ).toEqual(["event-running", "event-idle"]);
    expect(reportError).toHaveBeenCalledWith(
      "Usage reconciliation failed",
      expect.objectContaining({ message: "temporary" }),
    );
  });

  it("advances past the first batch so every candidate is eventually scanned", async () => {
    const sessions = Array.from({ length: 30 }, (_, index) => ({
      sessionId: `session-${String(index).padStart(2, "0")}`,
      ownerUserId: `user-${index % 2}`,
      arkSessionId: `ark-session-${index}`,
      status: "idle" as const,
    }));
    const reconciledAt = new Map<string, Date>();
    const repository = {
      listReconcilable: vi.fn(
        async ({ limit }: { cutoff: Date; limit: number }) =>
          [...sessions]
            .sort((left, right) => {
              const leftAt = reconciledAt.get(left.sessionId);
              const rightAt = reconciledAt.get(right.sessionId);
              if (!leftAt && rightAt) return -1;
              if (leftAt && !rightAt) return 1;
              return (
                (leftAt?.getTime() ?? 0) - (rightAt?.getTime() ?? 0) ||
                left.sessionId.localeCompare(right.sessionId)
              );
            })
            .slice(0, limit),
      ),
      projectEvent: vi.fn(),
      markReconciled: vi.fn(
        async (userId: string, sessionId: string, scannedAt: Date) => {
          const session = sessions.find(
            (candidate) =>
              candidate.ownerUserId === userId &&
              candidate.sessionId === sessionId,
          );
          if (session) reconciledAt.set(sessionId, scannedAt);
        },
      ),
    };
    const ark = {
      listEvents: vi.fn(async (arkSessionId: string) => {
        if (arkSessionId === "ark-session-0") {
          throw new Error("temporary");
        }
        return [];
      }),
    };
    let now = new Date("2026-09-01T00:00:00.000Z");
    const processor = new UsageReconciliationProcessor({
      repository,
      ark,
      workerId: "usage-worker-1",
      batchSize: 25,
      now: () => now,
      reportError: vi.fn(),
    });

    await processor.runOnce();
    now = new Date("2026-09-01T00:00:01.000Z");
    await processor.runOnce();

    expect(new Set(ark.listEvents.mock.calls.map(([id]) => id))).toHaveLength(
      30,
    );
    expect(repository.markReconciled).toHaveBeenCalledWith(
      "user-0",
      "session-00",
      new Date("2026-09-01T00:00:00.000Z"),
    );
  });
});

describe("quota interrupt worker", () => {
  const job = {
    id: "job-1",
    userId: "user-1",
    sessionId: "session-1",
    arkSessionId: "ark-session-1",
    monthStart: new Date("2026-09-01T00:00:00.000Z"),
    attempts: 1,
    maxAttempts: 10,
  };

  it.each(["running", "rescheduled"] as const)(
    "interrupts an observed %s Session with a stable idempotency key",
    async (status) => {
      const jobs = {
        claim: vi.fn(async () => [job]),
        succeed: vi.fn(),
        retry: vi.fn(),
      };
      const ark = {
        getSession: vi.fn(async () => ({
          id: "ark-session-1",
          agentId: "agent-1",
          agentVersion: 1,
          environmentId: "env-1",
          status,
        })),
        submitEvent: vi.fn(async () => ({
          id: "interrupt-event",
          type: "user.interrupt",
          createdAt: "2026-09-01T00:01:00.000Z",
          data: {},
        })),
      };
      const processor = new QuotaInterruptProcessor({
        jobs,
        ark,
        workerId: "quota-worker-1",
      });

      await expect(processor.runOnce()).resolves.toBe(1);
      expect(ark.submitEvent).toHaveBeenCalledWith(
        "ark-session-1",
        { type: "user.interrupt", data: {} },
        {
          correlationId: "quota-interrupt:job-1:1",
          idempotencyKey:
            "quota-interrupt:user-1:session-1:2026-09-01T00:00:00.000Z",
        },
      );
      expect(jobs.succeed).toHaveBeenCalledWith("job-1", "quota-worker-1");
      expect(jobs.retry).not.toHaveBeenCalled();
    },
  );

  it("retries failures and treats an already stopped Session as complete", async () => {
    const jobs = {
      claim: vi
        .fn()
        .mockResolvedValueOnce([job])
        .mockResolvedValueOnce([{ ...job, attempts: 2 }]),
      succeed: vi.fn(),
      retry: vi.fn(),
    };
    const ark = {
      getSession: vi
        .fn()
        .mockRejectedValueOnce(new Error("temporary"))
        .mockResolvedValueOnce({
          id: "ark-session-1",
          agentId: "agent-1",
          agentVersion: 1,
          environmentId: "env-1",
          status: "idle" as const,
        }),
      submitEvent: vi.fn(),
    };
    const processor = new QuotaInterruptProcessor({
      jobs,
      ark,
      workerId: "quota-worker-1",
    });

    await processor.runOnce();
    await processor.runOnce();

    expect(jobs.retry).toHaveBeenCalledWith(
      "job-1",
      "quota-worker-1",
      "QUOTA_INTERRUPT_FAILED",
      false,
    );
    expect(ark.submitEvent).not.toHaveBeenCalled();
    expect(jobs.succeed).toHaveBeenCalledWith("job-1", "quota-worker-1");
  });
});
