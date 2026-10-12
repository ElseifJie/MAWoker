import type { ArkEvent, ArkGateway } from "@pwa/ark-client";

export type SettlementState = "pending" | "confirmed" | "unknown";

/**
 * What a settlement pass proved. Counters, booleans and reason codes only —
 * never event ids, message bodies or tokens.
 */
export interface SettlementEvidence {
  /** Open shape: the repository persists it as opaque jsonb. */
  [key: string]: unknown;
  arkEventsRead: number;
  modelRequestsStarted: number;
  modelRequestsEnded: number;
  modelRequestsOpen: number;
  historyReadComplete: boolean;
  reason?:
    | "message_admission_unclosed"
    | "upstream_missing"
    | "ark_transient"
    | "open_model_requests";
}

export interface SettlementRepository {
  /** The admission flags and upstream id the gate needs; owner-scoped. */
  findSettlementTarget(
    userId: string,
    sessionId: string,
  ): PromiseLike<
    | {
        arkSessionId: string;
        messageInFlightCount: number;
        messageStartPending: boolean;
        messageUnknownOutcome: boolean;
      }
    | undefined
  >;
  recordSettlement(
    userId: string,
    sessionId: string,
    input: {
      state: SettlementState;
      evidence: SettlementEvidence;
      checkedAt: Date;
    },
  ): PromiseLike<void>;
}

function isNonnegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isArkCategory(error: unknown, category: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "category" in error &&
    (error as { category: unknown }).category === category
  );
}

/**
 * "Triggered a check" is not "settled": `confirmed` requires the full Ark
 * history to have been read and every model request to carry a valid end —
 * usage counters, or an explicit error terminal. Anything that cannot be
 * proven stays `unknown` (kept for maintenance) and transient failures stay
 * `pending` (retryable); neither unlocks the irreversible delete steps.
 */
export class SessionSettlementService {
  constructor(
    private readonly dependencies: {
      repository: SettlementRepository;
      ark: Pick<ArkGateway, "listEvents">;
      now?: () => Date;
    },
  ) {}

  async verify(
    userId: string,
    sessionId: string,
    context: { requestId: string },
  ): Promise<SettlementState> {
    const now = (this.dependencies.now ?? (() => new Date()))();
    const target = await this.dependencies.repository.findSettlementTarget(
      userId,
      sessionId,
    );
    if (!target) return "confirmed";

    if (
      target.messageInFlightCount > 0 ||
      target.messageStartPending ||
      target.messageUnknownOutcome
    ) {
      return await this.record(userId, sessionId, "unknown", now, {
        arkEventsRead: 0,
        modelRequestsStarted: 0,
        modelRequestsEnded: 0,
        modelRequestsOpen: 0,
        historyReadComplete: false,
        reason: "message_admission_unclosed",
      });
    }

    let events: ArkEvent[];
    try {
      events = await this.dependencies.ark.listEvents(target.arkSessionId, {
        correlationId: `settlement:${context.requestId}`,
      });
    } catch (error) {
      if (isArkCategory(error, "not_found")) {
        // The upstream record is already gone: history cannot be recovered,
        // so completeness is unknowable, not retryable.
        return await this.record(userId, sessionId, "unknown", now, {
          arkEventsRead: 0,
          modelRequestsStarted: 0,
          modelRequestsEnded: 0,
          modelRequestsOpen: 0,
          historyReadComplete: false,
          reason: "upstream_missing",
        });
      }
      // Rate limits, timeouts and unavailable upstreams are transient: the
      // caller retries; this must not degrade to unknown.
      return await this.record(userId, sessionId, "pending", now, {
        arkEventsRead: 0,
        modelRequestsStarted: 0,
        modelRequestsEnded: 0,
        modelRequestsOpen: 0,
        historyReadComplete: false,
        reason: "ark_transient",
      });
    }

    const analysis = analyzeModelRequests(events);
    if (!analysis.complete) {
      return await this.record(userId, sessionId, "unknown", now, {
        arkEventsRead: events.length,
        modelRequestsStarted: analysis.started,
        modelRequestsEnded: analysis.ended,
        modelRequestsOpen: analysis.open,
        historyReadComplete: true,
        reason: "open_model_requests",
      });
    }
    return await this.record(userId, sessionId, "confirmed", now, {
      arkEventsRead: events.length,
      modelRequestsStarted: analysis.started,
      modelRequestsEnded: analysis.ended,
      modelRequestsOpen: 0,
      historyReadComplete: true,
    });
  }

  private async record(
    userId: string,
    sessionId: string,
    state: SettlementState,
    checkedAt: Date,
    evidence: SettlementEvidence,
  ): Promise<SettlementState> {
    // The persisted verdict is the maintenance entry point; a failed write
    // propagates so the caller retries the whole verification rather than
    // acting on a verdict that left no audit trail.
    await this.dependencies.repository.recordSettlement(userId, sessionId, {
      state,
      evidence,
      checkedAt,
    });
    return state;
  }
}

/**
 * Pairing analysis over the Ark span events: every `model_request_start`
 * needs an end that references it and carries either usage counters or an
 * error terminal; orphan ends are just as disqualifying, because they cannot
 * be attributed to any request the history shows.
 */
export function analyzeModelRequests(events: ArkEvent[]): {
  started: number;
  ended: number;
  open: number;
  complete: boolean;
} {
  const startedIds = new Set<string>();
  for (const event of events) {
    if (event.type === "span.model_request_start") startedIds.add(event.id);
  }
  const endedStartIds = new Set<string>();
  let ended = 0;
  let orphanEnds = 0;
  let invalidEnds = 0;
  for (const event of events) {
    if (event.type !== "span.model_request_end") continue;
    const data =
      typeof event.data === "object" && event.data !== null
        ? (event.data as Record<string, unknown>)
        : {};
    const startId = data.model_request_start_id;
    if (typeof startId !== "string" || !startedIds.has(startId)) {
      orphanEnds += 1;
      continue;
    }
    const usage = data.model_usage;
    const usageRecord =
      typeof usage === "object" && usage !== null && !Array.isArray(usage)
        ? (usage as Record<string, unknown>)
        : undefined;
    const hasUsage =
      usageRecord !== undefined &&
      isNonnegativeInteger(usageRecord.input_tokens) &&
      isNonnegativeInteger(usageRecord.output_tokens);
    const errorTerminal = data.is_error === true;
    if (!hasUsage && !errorTerminal) {
      invalidEnds += 1;
      continue;
    }
    if (!endedStartIds.has(startId)) {
      endedStartIds.add(startId);
      ended += 1;
    }
  }
  const open = startedIds.size - endedStartIds.size;
  return {
    started: startedIds.size,
    ended,
    open,
    complete: open === 0 && orphanEnds === 0 && invalidEnds === 0,
  };
}
