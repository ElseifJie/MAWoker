import type { ArkEvent, ArkGateway } from "@pwa/ark-client";
import {
  projectArkEvent,
  type ArkEventProjection,
  type Notifier,
} from "@pwa/domain";

interface UsageReconciliationRepository {
  listReconcilable(input: { cutoff: Date; limit: number }): PromiseLike<
    Array<{
      sessionId: string;
      ownerUserId: string;
      arkSessionId: string;
      status: "idle" | "running" | "rescheduled" | "terminated";
    }>
  >;
  /** Resolves to `true` when the projection recorded new token usage. */
  projectEvent(
    userId: string,
    sessionId: string,
    projection: ArkEventProjection,
  ): PromiseLike<boolean>;
  markReconciled(
    userId: string,
    sessionId: string,
    reconciledAt: Date,
  ): PromiseLike<void>;
  monthlyTokenState(
    userId: string,
    now: Date,
  ): PromiseLike<{ used: number; limit: number }>;
}

export class UsageReconciliationProcessor {
  constructor(
    private readonly dependencies: {
      repository: UsageReconciliationRepository;
      ark: Pick<ArkGateway, "listEvents">;
      workerId: string;
      batchSize?: number;
      lookbackMs?: number;
      now?: () => Date;
      reportError?: (message: string, error: unknown) => void;
      notifier?: Notifier;
    },
  ) {}

  async runOnce(): Promise<number> {
    const now = (this.dependencies.now ?? (() => new Date()))();
    const sessions = await this.dependencies.repository.listReconcilable({
      cutoff: new Date(
        now.getTime() - (this.dependencies.lookbackMs ?? 24 * 60 * 60_000),
      ),
      limit: this.dependencies.batchSize ?? 25,
    });
    for (const session of sessions) {
      try {
        const events = await this.dependencies.ark.listEvents(
          session.arkSessionId,
          {
            correlationId: `usage-reconcile:${this.dependencies.workerId}:${session.sessionId}`,
          },
        );
        events.sort(
          (left, right) =>
            Date.parse(left.createdAt) - Date.parse(right.createdAt) ||
            left.id.localeCompare(right.id),
        );
        let tokenUsageRecorded = false;
        for (const event of events) {
          tokenUsageRecorded =
            (await this.project(
              session.ownerUserId,
              session.sessionId,
              event,
            )) || tokenUsageRecorded;
        }
        if (tokenUsageRecorded) {
          await this.notifyQuotaState(session.ownerUserId);
        }
      } catch (error) {
        (this.dependencies.reportError ?? console.error)(
          "Usage reconciliation failed",
          error,
        );
      } finally {
        try {
          await this.dependencies.repository.markReconciled(
            session.ownerUserId,
            session.sessionId,
            now,
          );
        } catch (error) {
          (this.dependencies.reportError ?? console.error)(
            "Usage reconciliation scheduling failed",
            error,
          );
        }
      }
    }
    return sessions.length;
  }

  private project(
    userId: string,
    sessionId: string,
    event: ArkEvent,
  ): PromiseLike<boolean> {
    return this.dependencies.repository.projectEvent(
      userId,
      sessionId,
      projectArkEvent(event),
    );
  }

  /**
   * Quota notification seam: after reconciling a session that consumed tokens,
   * surface a near-limit / exhausted signal through the notifier (logs only
   * until a channel is wired).
   */
  private async notifyQuotaState(userId: string): Promise<void> {
    const notifier = this.dependencies.notifier;
    if (!notifier) return;
    try {
      const { used, limit } =
        await this.dependencies.repository.monthlyTokenState(
          userId,
          (this.dependencies.now ?? (() => new Date()))(),
        );
      if (limit <= 0 || used >= limit) {
        await notifier.quotaExhausted(userId, "monthlyTokens");
      } else if (used >= limit * 0.8) {
        await notifier.quotaNearLimit(userId, "monthlyTokens", used, limit);
      }
    } catch (error) {
      (this.dependencies.reportError ?? console.error)(
        "Quota notification failed",
        error,
      );
    }
  }
}
