import { describe, expect, it, vi } from "vitest";
import type { ArkEvent } from "../packages/ark-client/src/index.js";
import {
  SessionSettlementService,
  type SettlementRepository,
} from "../packages/domain/src/session-settlement.js";

const userId = "00000000-0000-4000-8000-000000000001";
const sessionId = "00000000-0000-4000-8000-000000000002";
const arkSessionId = "ark-session-settle-1";
const timestamp = new Date("2026-09-06T00:00:00.000Z");

function modelStart(id: string): ArkEvent {
  return {
    id,
    type: "span.model_request_start",
    createdAt: "2026-09-06T00:00:01.000Z",
    data: {},
  } as unknown as ArkEvent;
}

function modelEnd(
  id: string,
  startId: string,
  usage?: { input_tokens: number; output_tokens: number },
  isError = false,
): ArkEvent {
  return {
    id,
    type: "span.model_request_end",
    createdAt: "2026-09-06T00:00:02.000Z",
    data: {
      model_request_start_id: startId,
      ...(usage ? { model_usage: usage } : {}),
      is_error: isError,
    },
  } as unknown as ArkEvent;
}

type SettlementTarget = Awaited<
  ReturnType<SettlementRepository["findSettlementTarget"]>
>;

function repository(target: SettlementTarget): SettlementRepository {
  return {
    findSettlementTarget: vi.fn(async () => target),
    recordSettlement: vi.fn(async () => undefined),
  };
}

function service(input: {
  repository: SettlementRepository;
  events: ArkEvent[];
  listEventsError?: unknown;
}) {
  return new SessionSettlementService({
    repository: input.repository,
    ark: {
      listEvents: vi.fn(async () => {
        if (input.listEventsError) throw input.listEventsError;
        return input.events;
      }),
    },
    now: () => timestamp,
  });
}

const idleTarget = {
  arkSessionId,
  messageInFlightCount: 0,
  messageStartPending: false,
  messageUnknownOutcome: false,
};

describe("SessionSettlementService", () => {
  it("confirms a fully paired model history with evidence", async () => {
    const repo = repository(idleTarget);
    const result = await service({
      repository: repo,
      events: [
        modelStart("start-1"),
        modelEnd("end-1", "start-1", {
          input_tokens: 10,
          output_tokens: 5,
        }),
        modelStart("start-2"),
        modelEnd("end-2", "start-2", undefined, true),
      ],
    }).verify(userId, sessionId, { requestId: "r" });

    expect(result).toBe("confirmed");
    expect(repo.recordSettlement).toHaveBeenCalledWith(
      userId,
      sessionId,
      expect.objectContaining({
        state: "confirmed",
        checkedAt: timestamp,
        evidence: {
          arkEventsRead: 4,
          modelRequestsStarted: 2,
          modelRequestsEnded: 2,
          modelRequestsOpen: 0,
          historyReadComplete: true,
        },
      }),
    );
  });

  it("confirms an empty history with explicit zero-event evidence", async () => {
    const repo = repository(idleTarget);
    const result = await service({
      repository: repo,
      events: [],
    }).verify(userId, sessionId, { requestId: "r" });

    expect(result).toBe("confirmed");
    expect(repo.recordSettlement).toHaveBeenCalledWith(
      userId,
      sessionId,
      expect.objectContaining({
        state: "confirmed",
        evidence: expect.objectContaining({ arkEventsRead: 0 }),
      }),
    );
  });

  it("marks an open model request as unknown", async () => {
    const repo = repository(idleTarget);
    const result = await service({
      repository: repo,
      events: [
        modelStart("start-1"),
        modelEnd("end-1", "start-1", {
          input_tokens: 1,
          output_tokens: 1,
        }),
        modelStart("start-2"),
      ],
    }).verify(userId, sessionId, { requestId: "r" });

    expect(result).toBe("unknown");
    expect(repo.recordSettlement).toHaveBeenCalledWith(
      userId,
      sessionId,
      expect.objectContaining({
        state: "unknown",
        evidence: expect.objectContaining({
          modelRequestsOpen: 1,
          reason: "open_model_requests",
        }),
      }),
    );
  });

  it("marks an end event without usage and without an error terminal as unknown", async () => {
    const repo = repository(idleTarget);
    const result = await service({
      repository: repo,
      events: [modelStart("start-1"), modelEnd("end-1", "start-1")],
    }).verify(userId, sessionId, { requestId: "r" });

    expect(result).toBe("unknown");
    expect(repo.recordSettlement).toHaveBeenLastCalledWith(
      userId,
      sessionId,
      expect.objectContaining({
        state: "unknown",
        evidence: expect.objectContaining({ reason: "open_model_requests" }),
      }),
    );
  });

  it("marks an orphan end event as unknown", async () => {
    const repo = repository(idleTarget);
    const result = await service({
      repository: repo,
      events: [
        modelEnd("end-orphan", "start-missing", {
          input_tokens: 3,
          output_tokens: 4,
        }),
      ],
    }).verify(userId, sessionId, { requestId: "r" });

    expect(result).toBe("unknown");
  });

  it("marks unclosed message admission as unknown before touching Ark", async () => {
    const repo = repository({
      arkSessionId,
      messageInFlightCount: 1,
      messageStartPending: false,
      messageUnknownOutcome: false,
    });
    const settlement = new SessionSettlementService({
      repository: repo,
      ark: { listEvents: vi.fn(async () => []) },
      now: () => timestamp,
    });

    const result = await settlement.verify(userId, sessionId, {
      requestId: "r",
    });

    expect(result).toBe("unknown");
    expect(repo.recordSettlement).toHaveBeenCalledWith(
      userId,
      sessionId,
      expect.objectContaining({
        state: "unknown",
        evidence: expect.objectContaining({
          reason: "message_admission_unclosed",
        }),
      }),
    );
  });

  it("keeps a transient Ark failure as pending, not unknown", async () => {
    const repo = repository(idleTarget);
    const result = await service({
      repository: repo,
      events: [],
      listEventsError: Object.assign(new Error("rate limited"), {
        name: "ArkGatewayError",
        category: "rate_limited",
      }),
    }).verify(userId, sessionId, { requestId: "r" });

    expect(result).toBe("pending");
    expect(repo.recordSettlement).toHaveBeenCalledWith(
      userId,
      sessionId,
      expect.objectContaining({
        state: "pending",
        evidence: expect.objectContaining({ reason: "ark_transient" }),
      }),
    );
  });

  it("marks a vanished upstream session as unknown with upstream_missing", async () => {
    const repo = repository(idleTarget);
    const result = await service({
      repository: repo,
      events: [],
      listEventsError: Object.assign(new Error("gone"), {
        name: "ArkGatewayError",
        category: "not_found",
      }),
    }).verify(userId, sessionId, { requestId: "r" });

    expect(result).toBe("unknown");
    expect(repo.recordSettlement).toHaveBeenCalledWith(
      userId,
      sessionId,
      expect.objectContaining({
        state: "unknown",
        evidence: expect.objectContaining({ reason: "upstream_missing" }),
      }),
    );
  });

  it("treats a missing local session as nothing left to settle", async () => {
    const repo = repository(undefined);
    const result = await service({
      repository: repo,
      events: [],
    }).verify(userId, sessionId, { requestId: "r" });

    expect(result).toBe("confirmed");
    expect(repo.recordSettlement).not.toHaveBeenCalled();
  });
});
