import { computeNextRunAt, parseAutomationSchedule } from "@pwa/domain";

interface AutomationClaim {
  occurrenceId: string;
  ownerUserId: string;
  automationId: string;
  scheduleVersion: number;
  scheduledAt: Date;
  leaseGeneration: number;
  title: string;
  kind: "reminder" | "execute";
  prompt: string | null;
  schedule: Record<string, unknown>;
  timezone: string;
}

export interface AutomationWorkerDependencies {
  repository: {
    claimDue(input: {
      now: Date;
      limit: number;
      leaseMs: number;
    }): PromiseLike<AutomationClaim[]>;
    enqueueOccurrence(input: {
      id: string;
      ownerUserId: string;
      automationId: string;
      scheduleVersion: number;
      scheduledAt: Date;
      now: Date;
    }): PromiseLike<void>;
    advance(input: {
      ownerUserId: string;
      id: string;
      nextRunAt: Date;
      enabled: boolean;
      now: Date;
    }): PromiseLike<void>;
    completeOccurrence(input: {
      id: string;
      generation: number;
      now: Date;
    }): PromiseLike<boolean>;
    failOccurrence(input: {
      id: string;
      generation: number;
      errorCode: string;
      now: Date;
    }): PromiseLike<void>;
  };
  notifications: {
    createSystemNotification(input: {
      id: string;
      ownerUserId: string;
      kind: "reminder";
      sourceType: string;
      sourceId: string;
      dedupeKey: string;
      payload: Record<string, unknown>;
      now: Date;
    }): PromiseLike<{ id: string; created: boolean }>;
  };
  createId: () => string;
  execute?: (input: {
    ownerUserId: string;
    title: string;
    prompt: string;
    occurrenceId: string;
  }) => PromiseLike<void>;
  notifyExternal?: (input: {
    ownerUserId: string;
    title: string;
    text: string;
  }) => PromiseLike<void>;
  now?: () => Date;
  batchSize?: number;
  leaseMs?: number;
  logger?: { error?: (context: unknown, message: string) => void };
}

export function createAutomationWorker(
  dependencies: AutomationWorkerDependencies,
) {
  const now = dependencies.now ?? (() => new Date());
  return {
    async runOnce(): Promise<{
      claimed: number;
      notified: number;
      failed: number;
    }> {
      const at = now();
      const claims = await dependencies.repository.claimDue({
        now: at,
        limit: dependencies.batchSize ?? 10,
        leaseMs: dependencies.leaseMs ?? 60_000,
      });
      let notified = 0;
      let failed = 0;
      for (const claim of claims) {
        try {
          if (claim.kind === "execute") {
            if (!dependencies.execute || !claim.prompt) {
              throw new Error("Execute automation is not configured");
            }
            await dependencies.execute({
              ownerUserId: claim.ownerUserId,
              title: claim.title,
              prompt: claim.prompt,
              occurrenceId: claim.occurrenceId,
            });
            await Promise.resolve(
              dependencies.notifyExternal?.({
                ownerUserId: claim.ownerUserId,
                title: claim.title,
                text: "定时任务已启动。",
              }),
            ).catch(() => undefined);
          } else {
            const created =
              await dependencies.notifications.createSystemNotification({
                id: dependencies.createId(),
                ownerUserId: claim.ownerUserId,
                kind: "reminder",
                sourceType: "automation",
                sourceId: claim.occurrenceId,
                dedupeKey: `automation:${claim.occurrenceId}`,
                payload: {
                  title: claim.title,
                  automationId: claim.automationId,
                  scheduledAt: claim.scheduledAt.toISOString(),
                },
                now: at,
              });
            if (created.created) notified += 1;
            await Promise.resolve(
              dependencies.notifyExternal?.({
                ownerUserId: claim.ownerUserId,
                title: claim.title,
                text: "提醒时间到了。",
              }),
            ).catch(() => undefined);
          }

          const schedule = parseAutomationSchedule(claim.schedule);
          const nextRunAt = computeNextRunAt(
            schedule,
            claim.timezone,
            claim.scheduledAt,
          );
          if (nextRunAt) {
            await dependencies.repository.enqueueOccurrence({
              id: dependencies.createId(),
              ownerUserId: claim.ownerUserId,
              automationId: claim.automationId,
              scheduleVersion: claim.scheduleVersion,
              scheduledAt: nextRunAt,
              now: at,
            });
          }
          await dependencies.repository.advance({
            ownerUserId: claim.ownerUserId,
            id: claim.automationId,
            nextRunAt: nextRunAt ?? claim.scheduledAt,
            enabled: nextRunAt !== null,
            now: at,
          });
          await dependencies.repository.completeOccurrence({
            id: claim.occurrenceId,
            generation: claim.leaseGeneration,
            now: at,
          });
        } catch (error) {
          failed += 1;
          dependencies.logger?.error?.(
            { error, occurrenceId: claim.occurrenceId },
            "automation reminder failed",
          );
          await dependencies.repository.failOccurrence({
            id: claim.occurrenceId,
            generation: claim.leaseGeneration,
            errorCode: "REMINDER_FAILED",
            now: at,
          });
        }
      }
      return { claimed: claims.length, notified, failed };
    },
  };
}
