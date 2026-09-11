import type { ArkEvent, ArkGateway } from "@pwa/ark-client";
import { projectArkEvent, type ArkEventProjection } from "@pwa/domain";

interface UsageReconciliationRepository {
  listReconcilable(input: { cutoff: Date; limit: number }): PromiseLike<
    Array<{
      sessionId: string;
      ownerUserId: string;
      arkSessionId: string;
      status: "idle" | "running" | "rescheduled" | "terminated";
    }>
  >;
  projectEvent(
    userId: string,
    sessionId: string,
    projection: ArkEventProjection,
  ): PromiseLike<void>;
  markReconciled(
    userId: string,
    sessionId: string,
    reconciledAt: Date,
  ): PromiseLike<void>;
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
        for (const event of events) {
          await this.project(session.ownerUserId, session.sessionId, event);
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
  ): PromiseLike<void> {
    return this.dependencies.repository.projectEvent(
      userId,
      sessionId,
      projectArkEvent(event),
    );
  }
}
