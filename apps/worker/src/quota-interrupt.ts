import type { ArkGateway } from "@pwa/ark-client";

export interface QuotaInterruptJob {
  id: string;
  userId: string;
  sessionId: string;
  arkSessionId: string;
  monthStart: Date;
  attempts: number;
  maxAttempts: number;
}

interface QuotaInterruptJobs {
  claim(input: {
    workerId: string;
    limit: number;
  }): PromiseLike<QuotaInterruptJob[]>;
  succeed(id: string, workerId: string): PromiseLike<void>;
  retry(
    id: string,
    workerId: string,
    error: string,
    final: boolean,
  ): PromiseLike<void>;
}

export class QuotaInterruptProcessor {
  constructor(
    private readonly dependencies: {
      jobs: QuotaInterruptJobs;
      ark: Pick<ArkGateway, "getSession" | "submitEvent">;
      workerId: string;
      batchSize?: number;
    },
  ) {}

  async runOnce(): Promise<number> {
    const jobs = await this.dependencies.jobs.claim({
      workerId: this.dependencies.workerId,
      limit: this.dependencies.batchSize ?? 10,
    });
    for (const job of jobs) await this.process(job);
    return jobs.length;
  }

  private async process(job: QuotaInterruptJob): Promise<void> {
    try {
      const session = await this.dependencies.ark.getSession(job.arkSessionId, {
        correlationId: `quota-observe:${job.id}:${job.attempts}`,
      });
      if (session.status === "running" || session.status === "rescheduled") {
        await this.dependencies.ark.submitEvent(
          job.arkSessionId,
          { type: "user.interrupt", data: {} },
          {
            correlationId: `quota-interrupt:${job.id}:${job.attempts}`,
            idempotencyKey: [
              "quota-interrupt",
              job.userId,
              job.sessionId,
              job.monthStart.toISOString(),
            ].join(":"),
          },
        );
      }
      await this.dependencies.jobs.succeed(job.id, this.dependencies.workerId);
    } catch {
      await this.dependencies.jobs.retry(
        job.id,
        this.dependencies.workerId,
        "QUOTA_INTERRUPT_FAILED",
        job.attempts >= job.maxAttempts,
      );
    }
  }
}
