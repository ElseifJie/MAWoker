export interface EventIngestorCandidate {
  sessionId: string;
  ownerUserId: string;
}

export interface EventIngestorClaim {
  generation: number;
  lastEventId: string | null;
}

export interface EventIngestorRepository {
  listCandidates(
    now: Date,
    limit: number,
  ): PromiseLike<EventIngestorCandidate[]>;
  claim(input: {
    sessionId: string;
    ownerUserId: string;
    consumerId: string;
    now: Date;
    leaseUntil: Date;
  }): PromiseLike<EventIngestorClaim | undefined>;
  checkpoint(input: {
    sessionId: string;
    consumerId: string;
    generation: number;
    lastEventId: string | null;
    now: Date;
    leaseUntil: Date;
  }): PromiseLike<boolean>;
  release(input: {
    sessionId: string;
    consumerId: string;
    generation: number;
    now: Date;
    errorCode?: string | null;
  }): PromiseLike<void>;
}

export interface EventIngestorSessionSource {
  openEvents(
    id: string,
    context: { userId: string; requestId: string },
    signal?: AbortSignal,
  ): PromiseLike<{
    session: unknown;
    events: AsyncIterable<{ id: string }>;
  }>;
}

/**
 * Shadow-mode ingestor: it claims a Session's upstream stream, persists the
 * events through the existing projection (which is idempotent), and records
 * the last consumed event. SSE still reads upstream in this mode; switching
 * `EVENT_SOURCE=local` is a later, separately verified step.
 */
export class EventIngestorProcessor {
  constructor(
    private readonly dependencies: {
      repository: EventIngestorRepository;
      sessions: EventIngestorSessionSource;
      workerId: string;
      enabled: boolean;
      leaseMs?: number;
      budgetMs?: number;
      batchSize?: number;
      maxEvents?: number;
      now?: () => Date;
    },
  ) {}

  async runOnce(): Promise<number> {
    if (!this.dependencies.enabled) return 0;
    const now = this.dependencies.now?.() ?? new Date();
    const batchSize = this.dependencies.batchSize ?? 2;
    const leaseMs = this.dependencies.leaseMs ?? 30_000;
    const budgetMs = this.dependencies.budgetMs ?? 5_000;
    const maxEvents = this.dependencies.maxEvents ?? 200;
    const candidates = await this.dependencies.repository.listCandidates(
      now,
      batchSize,
    );
    let consumed = 0;
    for (const candidate of candidates) {
      const claim = await this.dependencies.repository.claim({
        sessionId: candidate.sessionId,
        ownerUserId: candidate.ownerUserId,
        consumerId: this.dependencies.workerId,
        now,
        leaseUntil: new Date(now.getTime() + leaseMs),
      });
      if (!claim) continue;
      consumed += await this.consume(
        candidate,
        claim,
        leaseMs,
        budgetMs,
        maxEvents,
      );
    }
    return consumed;
  }

  private async consume(
    candidate: EventIngestorCandidate,
    claim: EventIngestorClaim,
    leaseMs: number,
    budgetMs: number,
    maxEvents: number,
  ): Promise<number> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), budgetMs);
    timer.unref?.();
    let lastEventId = claim.lastEventId;
    let count = 0;
    let failure: unknown;
    let abortedByBudget = false;
    try {
      const opened = await this.dependencies.sessions.openEvents(
        candidate.sessionId,
        {
          userId: candidate.ownerUserId,
          requestId: `event-ingest:${candidate.sessionId}:${claim.generation}`,
        },
        controller.signal,
      );
      for await (const event of opened.events) {
        lastEventId = event.id;
        count += 1;
        if (count >= maxEvents || controller.signal.aborted) break;
      }
    } catch (error) {
      failure = error;
    } finally {
      abortedByBudget = controller.signal.aborted;
      clearTimeout(timer);
      controller.abort();
    }

    const now = this.dependencies.now?.() ?? new Date();
    const leaseUntil = new Date(now.getTime() + leaseMs);
    if (failure && !abortedByBudget) {
      await this.dependencies.repository.release({
        sessionId: candidate.sessionId,
        consumerId: this.dependencies.workerId,
        generation: claim.generation,
        now,
        errorCode: "EVENT_INGEST_FAILED",
      });
      return count;
    }
    await this.dependencies.repository.checkpoint({
      sessionId: candidate.sessionId,
      consumerId: this.dependencies.workerId,
      generation: claim.generation,
      lastEventId,
      now,
      leaseUntil,
    });
    return count;
  }
}
