import type { SessionService } from "@pwa/domain";

interface HistoryRepository {
  listHistoryReconcilable(input: {
    now: Date;
    limit: number;
    cooldownMs: number;
    signal?: AbortSignal;
  }): PromiseLike<
    Array<{ sessionId: string; ownerUserId: string; arkSessionId: string }>
  >;
  finishHistoryAttempt(
    userId: string,
    id: string,
    input: {
      now: Date;
      succeeded: boolean;
      cooldownMs: number;
      maxBackoffMs: number;
      attemptedAt?: Date;
      signal?: AbortSignal;
    },
  ): PromiseLike<void>;
}

export class SessionHistoryProcessor {
  constructor(
    private readonly dependencies: {
      repository: HistoryRepository;
      service: Pick<SessionService, "reconcileHistory">;
      workerId: string;
      enabled?: boolean;
      batchSize?: number;
      cooldownMs?: number;
      maxBackoffMs?: number;
      requestTimeoutMs?: number;
      now?: () => Date;
      reportError?: (message: string, error: unknown) => void;
    },
  ) {}

  async runOnce(): Promise<number> {
    if (this.dependencies.enabled === false) return 0;
    const now = this.dependencies.now ?? (() => new Date());
    const cooldownMs = Math.max(1000, this.dependencies.cooldownMs ?? 60_000);
    const attemptedAt = now();
    const selection = new AbortController();
    let selectionTimeout!: ReturnType<typeof setTimeout>;
    const selectionCancelled = new Promise<never>((_resolve, reject) => {
      selectionTimeout = setTimeout(() => {
        selection.abort();
        reject(new Error("Session history selection timed out"));
      }, this.dependencies.requestTimeoutMs ?? 30_000);
    });
    let sessions: Array<{
      sessionId: string;
      ownerUserId: string;
      arkSessionId: string;
    }>;
    try {
      sessions = await Promise.race([
        this.dependencies.repository.listHistoryReconcilable({
          now: attemptedAt,
          limit: Math.max(1, Math.min(5, this.dependencies.batchSize ?? 2)),
          cooldownMs,
          signal: selection.signal,
        }),
        selectionCancelled,
      ]);
      selection.signal.throwIfAborted();
    } catch (error) {
      (this.dependencies.reportError ?? console.error)(
        "Session history selection failed",
        error,
      );
      return 0;
    } finally {
      clearTimeout(selectionTimeout);
    }
    for (const session of sessions) {
      let succeeded = false;
      const controller = new AbortController();
      const timeout = setTimeout(
        () => controller.abort(),
        this.dependencies.requestTimeoutMs ?? 30_000,
      );
      let abort!: () => void;
      const cancelled = new Promise<never>((_resolve, reject) => {
        abort = () => reject(new Error("Session history request timed out"));
        controller.signal.addEventListener("abort", abort, { once: true });
      });
      try {
        await Promise.race([
          this.dependencies.service.reconcileHistory(
            session.sessionId,
            {
              userId: session.ownerUserId,
              requestId: `history:${this.dependencies.workerId}:${session.sessionId}`,
            },
            controller.signal,
          ),
          cancelled,
        ]);
        controller.signal.throwIfAborted();
        succeeded = true;
      } catch (error) {
        (this.dependencies.reportError ?? console.error)(
          "Session history repair failed",
          error,
        );
      } finally {
        clearTimeout(timeout);
        controller.signal.removeEventListener("abort", abort);
        const scheduling = new AbortController();
        let schedulingTimeout!: ReturnType<typeof setTimeout>;
        const schedulingCancelled = new Promise<never>((_resolve, reject) => {
          schedulingTimeout = setTimeout(() => {
            scheduling.abort();
            reject(new Error("Session history scheduling timed out"));
          }, this.dependencies.requestTimeoutMs ?? 30_000);
        });
        try {
          await Promise.race([
            this.dependencies.repository.finishHistoryAttempt(
              session.ownerUserId,
              session.sessionId,
              {
                now: now(),
                attemptedAt,
                signal: scheduling.signal,
                succeeded,
                cooldownMs,
                maxBackoffMs: this.dependencies.maxBackoffMs ?? 15 * 60_000,
              },
            ),
            schedulingCancelled,
          ]);
        } catch (error) {
          (this.dependencies.reportError ?? console.error)(
            "Session history scheduling failed",
            error,
          );
        } finally {
          clearTimeout(schedulingTimeout);
        }
      }
    }
    return sessions.length;
  }
}
