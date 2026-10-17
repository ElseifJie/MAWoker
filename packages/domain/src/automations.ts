import {
  computeNextRunAt,
  InvalidAutomationScheduleError,
  parseAutomationSchedule,
} from "./automation-schedule.js";
import { ResourceNotFoundError } from "./errors.js";

export interface AutomationRecord {
  id: string;
  ownerUserId: string;
  title: string;
  kind: "reminder" | "execute";
  prompt: string | null;
  schedule: Record<string, unknown>;
  timezone: string;
  nextRunAt: Date;
  enabled: boolean;
  scheduleVersion: number;
  revision: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface AutomationRepository {
  createWithOccurrence(input: {
    id: string;
    occurrenceId: string;
    ownerUserId: string;
    title: string;
    kind: "reminder" | "execute";
    prompt: string | null;
    schedule: Record<string, unknown>;
    timezone: string;
    nextRunAt: Date;
    now: Date;
  }): PromiseLike<AutomationRecord>;
  listOwned(ownerUserId: string): PromiseLike<AutomationRecord[]>;
  findOwned(
    ownerUserId: string,
    id: string,
  ): PromiseLike<AutomationRecord | undefined>;
  setEnabled(input: {
    ownerUserId: string;
    id: string;
    enabled: boolean;
    bumpVersion?: boolean;
    now: Date;
  }): PromiseLike<AutomationRecord | undefined>;
  cancelPending(ownerUserId: string, id: string, now: Date): PromiseLike<void>;
  enqueueOccurrence(input: {
    id: string;
    ownerUserId: string;
    automationId: string;
    scheduleVersion: number;
    scheduledAt: Date;
    now: Date;
  }): PromiseLike<void>;
}

export class AutomationConflictError extends Error {
  readonly code = "AUTOMATION_CONFLICT";
  constructor() {
    super("Automation changed concurrently");
    this.name = "AutomationConflictError";
  }
}

export class AutomationService {
  constructor(
    private readonly dependencies: {
      repository: AutomationRepository;
      createId: () => string;
      now?: () => Date;
    },
  ) {}

  private now(): Date {
    return this.dependencies.now?.() ?? new Date();
  }

  async create(
    ownerUserId: string,
    input: {
      title: string;
      kind?: "reminder" | "execute";
      prompt?: string;
      schedule: unknown;
      timezone: string;
    },
  ): Promise<AutomationRecord> {
    const title = input.title.trim();
    if (title.length === 0 || title.length > 120) {
      throw new InvalidAutomationScheduleError(
        "Title must be 1–120 characters",
      );
    }
    if (typeof input.timezone !== "string" || input.timezone.length === 0) {
      throw new InvalidAutomationScheduleError("A time zone is required");
    }
    const kind = input.kind ?? "reminder";
    const prompt = kind === "execute" ? (input.prompt?.trim() ?? "") : null;
    if (
      kind === "execute" &&
      (prompt === null || prompt.length === 0 || prompt.length > 8_000)
    ) {
      throw new InvalidAutomationScheduleError(
        "Execute automations need a prompt of 1–8000 characters",
      );
    }
    const schedule = parseAutomationSchedule(input.schedule);
    const now = this.now();
    const nextRunAt = computeNextRunAt(schedule, input.timezone, now);
    if (!nextRunAt) {
      throw new InvalidAutomationScheduleError(
        "The schedule has no future occurrence",
      );
    }
    return this.dependencies.repository.createWithOccurrence({
      id: this.dependencies.createId(),
      occurrenceId: this.dependencies.createId(),
      ownerUserId,
      title,
      kind,
      prompt,
      schedule: schedule as unknown as Record<string, unknown>,
      timezone: input.timezone,
      nextRunAt,
      now,
    });
  }

  list(ownerUserId: string): PromiseLike<AutomationRecord[]> {
    return this.dependencies.repository.listOwned(ownerUserId);
  }

  async setEnabled(
    ownerUserId: string,
    id: string,
    enabled: boolean,
  ): Promise<AutomationRecord> {
    const now = this.now();
    const existing = await this.dependencies.repository.findOwned(
      ownerUserId,
      id,
    );
    if (!existing) throw new ResourceNotFoundError();
    if (!enabled) {
      const updated = await this.dependencies.repository.setEnabled({
        ownerUserId,
        id,
        enabled: false,
        now,
      });
      if (!updated) throw new ResourceNotFoundError();
      await this.dependencies.repository.cancelPending(ownerUserId, id, now);
      return updated;
    }
    const schedule = parseAutomationSchedule(existing.schedule);
    const nextRunAt = computeNextRunAt(schedule, existing.timezone, now);
    if (!nextRunAt) {
      throw new InvalidAutomationScheduleError(
        "The schedule has no future occurrence",
      );
    }
    const updated = await this.dependencies.repository.setEnabled({
      ownerUserId,
      id,
      enabled: true,
      bumpVersion: true,
      now,
    });
    if (!updated) throw new ResourceNotFoundError();
    await this.dependencies.repository.enqueueOccurrence({
      id: this.dependencies.createId(),
      ownerUserId,
      automationId: id,
      scheduleVersion: updated.scheduleVersion,
      scheduledAt: nextRunAt,
      now,
    });
    return updated;
  }

  async delete(ownerUserId: string, id: string): Promise<void> {
    await this.setEnabled(ownerUserId, id, false);
  }
}
