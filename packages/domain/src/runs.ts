import { ResourceNotFoundError } from "./errors.js";

export type RunTriggerKind = "manual" | "automation";

export type RunStatus =
  | "queued"
  | "starting"
  | "running"
  | "waiting_user"
  | "waiting_device"
  | "completed"
  | "failed"
  | "canceled"
  | "unknown";

/**
 * Product-visible execution. A durable submission is created first; the Run
 * shares its transaction and is the object notifications and automation attach
 * to. Dates are database timestamps, not client-supplied values.
 */
export interface RunRecord {
  id: string;
  ownerUserId: string;
  conversationId: string;
  triggerKind: RunTriggerKind;
  submissionId: string;
  status: RunStatus;
  arkSessionId: string | null;
  turnId: string | null;
  automationId: string | null;
  errorCode: string | null;
  startedAt: Date | null;
  endedAt: Date | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface RunTransitionInput {
  ownerUserId: string;
  id: string;
  /** Statuses this update is allowed to move from; empty is rejected. */
  from: readonly RunStatus[];
  to: RunStatus;
  errorCode?: string | null;
  arkSessionId?: string | null;
  turnId?: string | null;
  startedAt?: Date | null;
  endedAt?: Date | null;
  now?: Date;
}

export interface RunRepository {
  findOwned(
    ownerUserId: string,
    id: string,
  ): PromiseLike<RunRecord | undefined>;
  findBySubmission(
    ownerUserId: string,
    submissionId: string,
  ): PromiseLike<RunRecord | undefined>;
  transition(input: RunTransitionInput): PromiseLike<RunRecord | undefined>;
}

export class RunTransitionConflictError extends Error {
  constructor() {
    super("Run status changed concurrently");
    this.name = "RunTransitionConflictError";
  }
}

export class RunService {
  constructor(
    private readonly dependencies: {
      repository: RunRepository;
    },
  ) {}

  async get(userId: string, id: string): Promise<RunRecord> {
    const run = await this.dependencies.repository.findOwned(userId, id);
    if (!run) throw new ResourceNotFoundError();
    return run;
  }

  async findBySubmission(
    userId: string,
    submissionId: string,
  ): Promise<RunRecord> {
    const run = await this.dependencies.repository.findBySubmission(
      userId,
      submissionId,
    );
    if (!run) throw new ResourceNotFoundError();
    return run;
  }

  /**
   * Conditional transition with optimistic concurrency. The row's own version
   * is the fence: a stale caller gets a conflict instead of overwriting a
   * newer state. Status and version move together in one UPDATE.
   */
  async transition(
    userId: string,
    id: string,
    input: Omit<RunTransitionInput, "ownerUserId" | "id">,
  ): Promise<RunRecord> {
    if (input.from.length === 0) {
      throw new Error("Run transition requires at least one source status");
    }
    const existing = await this.dependencies.repository.findOwned(userId, id);
    if (!existing) throw new ResourceNotFoundError();
    const run = await this.dependencies.repository.transition({
      ...input,
      ownerUserId: userId,
      id,
    });
    if (!run) throw new RunTransitionConflictError();
    return run;
  }
}
