export interface PersonalAgentReconciliationJob {
  id: string;
  ownerUserId: string | null;
  type:
    | "delete_session"
    | "delete_artifact"
    | "cleanup_artifact_object"
    | "cleanup_drive_object"
    | "cleanup_upload"
    | "reconcile_session"
    | "reconcile_personal_agent";
  status: "running";
  priority: number;
  payload: Record<string, unknown>;
  attempts: number;
  maxAttempts: number;
  runAfter: Date;
  lockedAt: Date;
  lockedBy: string;
  createdAt: Date;
}

interface ReconciliationJobs {
  claim(input: {
    workerId: string;
    limit: number;
    types: ["reconcile_personal_agent"];
  }): PromiseLike<PersonalAgentReconciliationJob[]>;
  succeed(id: string, workerId: string): PromiseLike<void>;
  retry(
    id: string,
    workerId: string,
    error: string,
    final: boolean,
  ): PromiseLike<void>;
}

interface ReconciliationService {
  reconcileCreate(
    id: string,
    context: { userId: string; requestId: string },
  ): PromiseLike<unknown>;
  reconcileUpdate(
    id: string,
    intent: {
      configuration: {
        name: string;
        description: string;
        modelId: string;
        systemPrompt: string;
      };
      arkVersion: string;
    },
    context: { userId: string; requestId: string },
  ): PromiseLike<unknown>;
  reconcileDelete(
    id: string,
    context: { userId: string; requestId: string },
  ): PromiseLike<void>;
}

interface UpdatePayload {
  operation: "update";
  personalAgentId: string;
  configuration: {
    name: string;
    description: string;
    modelId: string;
    systemPrompt: string;
  };
  arkVersion: string;
}

type ReconciliationPayload =
  { operation: "create" | "delete"; personalAgentId: string } | UpdatePayload;

function requiredString(
  value: unknown,
  field: string,
): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Invalid personal Agent reconciliation ${field}`);
  }
}

function parsePayload(payload: Record<string, unknown>): ReconciliationPayload {
  requiredString(payload.personalAgentId, "personalAgentId");
  if (payload.operation === "create" || payload.operation === "delete") {
    return {
      operation: payload.operation,
      personalAgentId: payload.personalAgentId,
    };
  }
  if (payload.operation !== "update") {
    throw new Error("Invalid personal Agent reconciliation operation");
  }
  if (
    typeof payload.configuration !== "object" ||
    payload.configuration === null
  ) {
    throw new Error("Invalid personal Agent reconciliation configuration");
  }
  const configuration = payload.configuration as Record<string, unknown>;
  requiredString(configuration.name, "name");
  if (typeof configuration.description !== "string") {
    throw new Error("Invalid personal Agent reconciliation description");
  }
  requiredString(configuration.modelId, "modelId");
  if (typeof configuration.systemPrompt !== "string") {
    throw new Error("Invalid personal Agent reconciliation systemPrompt");
  }
  requiredString(payload.arkVersion, "arkVersion");
  return {
    operation: "update",
    personalAgentId: payload.personalAgentId,
    configuration: {
      name: configuration.name,
      description: configuration.description,
      modelId: configuration.modelId,
      systemPrompt: configuration.systemPrompt,
    },
    arkVersion: payload.arkVersion,
  };
}

export class PersonalAgentReconciliationProcessor {
  constructor(
    private readonly dependencies: {
      jobs: ReconciliationJobs;
      service: ReconciliationService;
      workerId: string;
      batchSize?: number;
    },
  ) {}

  async runOnce(): Promise<number> {
    const jobs = await this.dependencies.jobs.claim({
      workerId: this.dependencies.workerId,
      limit: this.dependencies.batchSize ?? 10,
      types: ["reconcile_personal_agent"],
    });
    for (const job of jobs) {
      await this.process(job);
    }
    return jobs.length;
  }

  private async process(job: PersonalAgentReconciliationJob): Promise<void> {
    try {
      if (job.type !== "reconcile_personal_agent") {
        throw new Error(`Unsupported reconciliation job type: ${job.type}`);
      }
      if (!job.ownerUserId) {
        throw new Error("Personal Agent reconciliation requires an owner");
      }
      const payload = parsePayload(job.payload);
      const context = {
        userId: job.ownerUserId,
        requestId: `worker:${job.id}:${job.attempts}`,
      };
      if (payload.operation === "create") {
        await this.dependencies.service.reconcileCreate(
          payload.personalAgentId,
          context,
        );
      } else if (payload.operation === "update") {
        await this.dependencies.service.reconcileUpdate(
          payload.personalAgentId,
          {
            configuration: payload.configuration,
            arkVersion: payload.arkVersion,
          },
          context,
        );
      } else {
        await this.dependencies.service.reconcileDelete(
          payload.personalAgentId,
          context,
        );
      }
      await this.dependencies.jobs.succeed(job.id, this.dependencies.workerId);
    } catch (error) {
      await this.dependencies.jobs.retry(
        job.id,
        this.dependencies.workerId,
        error instanceof Error ? error.message : String(error),
        job.attempts >= job.maxAttempts,
      );
    }
  }
}
