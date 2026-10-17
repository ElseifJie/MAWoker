import type { ArkEvent, ArkGateway } from "@pwa/ark-client";
import { normalizeArkEvent } from "@pwa/contracts";
import type { ArtifactRecord } from "./artifacts.js";

export interface SessionTurnObservation {
  boundaryEventId: string;
  inputEventId: string;
  outcome: "completed" | "waiting" | "failed" | "confirming";
  summary: string;
  expectedNames: string[];
  startedAt: Date;
  endedAt: Date;
  usageState: "pending" | "complete";
}

export interface SessionTurnRecord extends SessionTurnObservation {
  id: string;
  ownerUserId: string;
  sessionId: string;
  artifactState: "pending" | "syncing" | "synced" | "failed" | "none";
  artifactIds: string[];
  errorCode: string | null;
  retryUntil: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface SessionDeliveryRepository {
  recoverSyncJobs?(now: Date, signal?: AbortSignal): PromiseLike<void>;
  listDiscoveryCandidates(input: {
    now: Date;
    limit: number;
    signal?: AbortSignal;
  }): PromiseLike<
    Array<{ ownerUserId: string; sessionId: string; arkSessionId: string }>
  >;
  markDiscoveryChecked(
    userId: string,
    sessionId: string,
    now: Date,
    success: boolean,
    signal?: AbortSignal,
  ): PromiseLike<void>;
  recordObservations(
    userId: string,
    sessionId: string,
    turns: SessionTurnObservation[],
    input: {
      upstreamStatus: string;
      now: Date;
      retryWindowMs: number;
      signal?: AbortSignal;
    },
  ): PromiseLike<void>;
  claimSync(
    userId: string,
    id: string,
    workerId: string,
    generation: number,
    signal?: AbortSignal,
  ): PromiseLike<
    | {
        turn: SessionTurnRecord;
        arkSessionId: string;
        blocked: boolean;
        inputFileIds?: string[];
        nextStartedAt?: Date | null;
      }
    | undefined
  >;
  finishSync(
    userId: string,
    id: string,
    workerId: string,
    generation: number,
    result: {
      artifactState: "pending" | "synced" | "failed";
      artifactIds: string[];
      errorCode: string | null;
      now: Date;
      signal?: AbortSignal;
    },
  ): PromiseLike<boolean>;
}

function outputNames(content: string): string[] {
  // `<` is excluded so an Agent's `<display>/mnt/.../x.jpg</display>` wrapper
  // ends the path: swallowing `</display` made the last path segment — the
  // expected artifact name — literally "display", which no real file matches,
  // and the turn settled as ARTIFACTS_NOT_VISIBLE.
  const matches = content.matchAll(
    /(?:sandbox:)?\/mnt\/(?:data|session\/outputs)\/([^\s)\]>"`<]+)|sandbox:\/([^\s)\]>"`<]+)/g,
  );
  const names = new Set<string>();
  for (const match of matches) {
    const raw = (match[1] ?? match[2] ?? "")
      .split("/")
      .at(-1)
      ?.replace(/[.,;:!?…、。，；：！？】》"'”’]+$/, "");
    if (!raw) continue;
    try {
      names.add(decodeURIComponent(raw));
    } catch {
      names.add(raw);
    }
  }
  return [...names].slice(0, 100);
}

/** IDs are opaque; a stable timestamp sort keeps upstream order for ties. */
export function observeSessionTurns(
  events: ArkEvent[],
): SessionTurnObservation[] {
  const seen = new Set<string>();
  const turns: SessionTurnObservation[] = [];
  let input: ArkEvent | undefined;
  let summary = "";
  let expectedNames = new Set<string>();
  let starts = 0;
  let ends = 0;
  for (const event of [...events].sort(
    (a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt),
  )) {
    if (seen.has(event.id)) continue;
    seen.add(event.id);
    if (event.type === "user.message") {
      input ??= event;
      continue;
    }
    if (!input) continue;
    if (event.type === "agent.message") {
      const content = normalizeArkEvent(event).payload.content;
      if (typeof content === "string" && content.trim()) {
        summary = content;
        for (const name of outputNames(content)) expectedNames.add(name);
      }
    }
    if (event.type === "span.model_request_start") starts++;
    if (event.type === "span.model_request_end") {
      const usage = event.data.model_usage as
        Record<string, unknown> | undefined;
      if (
        usage &&
        Number.isSafeInteger(usage.input_tokens) &&
        Number(usage.input_tokens) >= 0 &&
        Number.isSafeInteger(usage.output_tokens) &&
        Number(usage.output_tokens) >= 0
      )
        ends++;
    }
    const idle =
      event.type === "session.status_idle" ||
      (event.type === "session.status" && event.data.status === "idle");
    const terminal =
      event.type === "session.status_terminated" ||
      (event.type === "session.status" && event.data.status === "terminated");
    if (!idle && !terminal) continue;
    const stop = event.data.stop_reason as Record<string, unknown> | undefined;
    const reason = stop?.type;
    const outcome =
      terminal || reason === "retries_exhausted"
        ? "failed"
        : reason === "requires_action"
          ? "waiting"
          : reason === "end_turn" && summary
            ? "completed"
            : "confirming";
    turns.push({
      boundaryEventId: event.id,
      inputEventId: input.id,
      outcome,
      summary: summary.slice(0, 4000),
      expectedNames: [...expectedNames],
      startedAt: new Date(input.createdAt),
      endedAt: new Date(event.createdAt),
      usageState: starts > 0 && starts === ends ? "complete" : "pending",
    });
    // requires_action and unknown idle do not end the current turn.
    if (outcome === "completed" || outcome === "failed") {
      input = undefined;
      summary = "";
      expectedNames = new Set<string>();
      starts = ends = 0;
    }
  }
  return turns;
}

function deliveryError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}

async function bounded<T>(
  promise: PromiseLike<T>,
  signal: AbortSignal,
): Promise<T> {
  signal.throwIfAborted();
  let abort!: () => void;
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => reject(deliveryError("DELIVERY_TIMEOUT"));
    signal.addEventListener("abort", abort, { once: true });
  });
  try {
    return await Promise.race([promise, cancelled]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

export class SessionDeliveryService {
  constructor(
    private readonly dependencies: {
      repository: SessionDeliveryRepository;
      sessions: {
        reconcileHistory(
          id: string,
          context: { userId: string; requestId: string },
          signal?: AbortSignal,
        ): PromiseLike<ArkEvent[]>;
      };
      ark: Pick<ArkGateway, "getSession" | "listArtifacts">;
      artifacts: {
        syncSession(
          id: string,
          context: {
            userId: string;
            requestId: string;
            signal?: AbortSignal;
            sourceFileIds?: string[];
            refreshExisting?: boolean;
          },
        ): PromiseLike<ArtifactRecord[]>;
      };
      now?: () => Date;
      emptyGraceMs?: number;
      retryWindowMs?: number;
      timeoutMs?: number;
      batchSize?: number;
      reportError?: (message: string, error: unknown) => void;
    },
  ) {}

  async discoverOnce(): Promise<number> {
    const now = (this.dependencies.now ?? (() => new Date()))();
    const budget = AbortSignal.timeout(this.dependencies.timeoutMs ?? 30_000);
    await bounded(
      this.dependencies.repository.recoverSyncJobs?.(now, budget) ??
        Promise.resolve(),
      budget,
    );
    const candidates = await bounded(
      this.dependencies.repository.listDiscoveryCandidates({
        now,
        limit: this.dependencies.batchSize ?? 2,
        signal: budget,
      }),
      budget,
    );
    for (const candidate of candidates) {
      if (budget.aborted) break;
      let success = false;
      try {
        const signal = budget;
        const context = {
          userId: candidate.ownerUserId,
          requestId: `delivery:${candidate.sessionId}`,
        };
        const events = await bounded(
          this.dependencies.sessions.reconcileHistory(
            candidate.sessionId,
            context,
            signal,
          ),
          signal,
        );
        signal.throwIfAborted();
        const upstream = await bounded(
          this.dependencies.ark.getSession(candidate.arkSessionId, {
            correlationId: context.requestId,
            signal,
          }),
          signal,
        );
        await bounded(
          this.dependencies.repository.recordObservations(
            candidate.ownerUserId,
            candidate.sessionId,
            observeSessionTurns(events),
            {
              upstreamStatus: upstream.status,
              now,
              retryWindowMs: this.dependencies.retryWindowMs ?? 300_000,
              signal,
            },
          ),
          signal,
        );
        success = true;
      } catch (error) {
        this.dependencies.reportError?.(
          "Session delivery discovery failed",
          error,
        );
      } finally {
        if (!budget.aborted) {
          await bounded(
            this.dependencies.repository.markDiscoveryChecked(
              candidate.ownerUserId,
              candidate.sessionId,
              now,
              success,
              budget,
            ),
            budget,
          );
        }
      }
    }
    return candidates.length;
  }

  async syncArtifacts(
    id: string,
    context: {
      userId: string;
      workerId: string;
      leaseGeneration: number;
      requestId: string;
    },
  ): Promise<void> {
    const { repository } = this.dependencies;
    const signal = AbortSignal.timeout(this.dependencies.timeoutMs ?? 30_000);
    const claimed = await bounded(
      repository.claimSync(
        context.userId,
        id,
        context.workerId,
        context.leaseGeneration,
        signal,
      ),
      signal,
    );
    if (!claimed) throw deliveryError("DELIVERY_LEASE_LOST");
    const { turn } = claimed;
    if (
      turn.artifactState === "none" ||
      (turn.artifactState === "synced" && turn.expectedNames.length > 0)
    )
      return;
    if (claimed.blocked) throw deliveryError("ARTIFACT_SYNC_PENDING");
    const now = (this.dependencies.now ?? (() => new Date()))();
    let state: "pending" | "synced" | "failed" =
      turn.artifactState === "synced" ? "synced" : "pending";
    let code: string | null = null;
    let ids: string[] = [...turn.artifactIds];
    try {
      const options = { correlationId: context.requestId, signal };
      const upstream = await bounded(
        this.dependencies.ark.getSession(claimed.arkSessionId, options),
        signal,
      );
      if (upstream.status !== "idle" && upstream.status !== "terminated") {
        throw deliveryError("ARTIFACT_SYNC_PENDING");
      }
      const inventory = await bounded(
        this.dependencies.ark.listArtifacts(claimed.arkSessionId, options),
        signal,
      );
      const inputs = new Set(claimed.inputFileIds ?? []);
      const expected = new Set(turn.expectedNames);
      const beforeNextTurn = (createdAt: number) =>
        claimed.nextStartedAt == null ||
        createdAt < claimed.nextStartedAt.getTime();
      const belongsToTurn = (createdAt: number, name: string) =>
        beforeNextTurn(createdAt) &&
        (createdAt >= turn.startedAt.getTime() ||
          (claimed.nextStartedAt == null && expected.has(name)));
      const outputs = inventory.filter(
        (file) =>
          file.sessionId === claimed.arkSessionId &&
          !inputs.has(file.id) &&
          belongsToTurn(Date.parse(file.createdAt), file.name),
      );
      const synced = await bounded(
        this.dependencies.artifacts.syncSession(turn.sessionId, {
          userId: context.userId,
          requestId: context.requestId,
          signal,
          sourceFileIds: outputs.map((file) => file.id),
          refreshExisting:
            claimed.nextStartedAt == null && turn.artifactState !== "synced",
        }),
        signal,
      );
      signal.throwIfAborted();
      const relevant = synced.filter(
        (file) =>
          belongsToTurn(file.generatedAt.getTime(), file.name) &&
          file.deletionState === "none",
      );
      ids = [...new Set([...ids, ...relevant.map((file) => file.id)])];
      const missing = [...expected].some(
        (name) => !relevant.some((file) => file.name === name),
      );
      const unreachable = outputs.some(
        (file) =>
          !file.tos || !relevant.some((item) => item.arkFileId === file.id),
      );
      const grace =
        outputs.length === 0 &&
        relevant.length === 0 &&
        now.getTime() - turn.createdAt.getTime() <
          (this.dependencies.emptyGraceMs ?? 30_000);
      if (missing || unreachable || grace) code = "ARTIFACTS_NOT_VISIBLE";
      else state = "synced";
    } catch (error) {
      code =
        turn.artifactState === "synced"
          ? null
          : typeof error === "object" &&
              error !== null &&
              "code" in error &&
              error.code === "ARTIFACT_SYNC_PENDING"
            ? "SESSION_STILL_RUNNING"
            : "ARTIFACT_SYNC_FAILED";
    }
    const finishedAt = (this.dependencies.now ?? (() => new Date()))();
    if (state === "pending" && finishedAt >= turn.retryUntil) state = "failed";
    const finishSignal = AbortSignal.timeout(
      Math.min(this.dependencies.timeoutMs ?? 30_000, 10_000),
    );
    const saved = await bounded(
      repository.finishSync(
        context.userId,
        id,
        context.workerId,
        context.leaseGeneration,
        {
          artifactState: state,
          artifactIds: ids,
          errorCode: code,
          now: finishedAt,
          signal: finishSignal,
        },
      ),
      finishSignal,
    );
    if (!saved) throw deliveryError("DELIVERY_LEASE_LOST");
    // A text-only completion is visible immediately, while the same durable
    // job keeps watching for undeclared late files until the retry deadline.
    if (
      state === "pending" ||
      (state === "synced" && expectedLateFiles(turn, finishedAt))
    ) {
      throw deliveryError("ARTIFACT_SYNC_PENDING");
    }
  }
}

function expectedLateFiles(turn: SessionTurnRecord, now: Date) {
  return turn.expectedNames.length === 0 && now < turn.retryUntil;
}
