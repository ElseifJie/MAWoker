import { quotaSchema, type Quota } from "@pwa/contracts";
import { ResourceNotFoundError } from "./errors.js";

export interface QuotaPolicyRecord extends Quota {
  key: "default";
  updatedBy: string | null;
  updatedAt: Date;
}

export interface QuotaPolicyRepository {
  getDefault(): PromiseLike<QuotaPolicyRecord | undefined>;
  /**
   * Replaces the default policy and, inside the same transaction, enqueues
   * quota interrupts for every user whose current-month token usage now
   * exceeds the new limit.
   */
  updateDefault(input: {
    quota: Quota;
    updatedBy: string;
    now: Date;
  }): PromiseLike<
    | {
        previous: QuotaPolicyRecord;
        updated: QuotaPolicyRecord;
        overLimitUserIds: string[];
      }
    | undefined
  >;
  audit(entry: {
    actorUserId: string;
    action: string;
    resourceType: string;
    resourceId?: string;
    result: "succeeded" | "failed";
    requestId: string;
    errorCode?: string;
    metadata?: Record<string, unknown>;
  }): PromiseLike<void>;
}

export class QuotaPolicyService {
  constructor(
    private readonly dependencies: {
      repository: QuotaPolicyRepository;
      notifier?: {
        quotaExhausted(
          userId: string,
          dimension: "monthlyTokens",
        ): Promise<void>;
      };
    },
  ) {}

  getDefault(): PromiseLike<QuotaPolicyRecord | undefined> {
    return this.dependencies.repository.getDefault();
  }

  async updateDefault(
    quota: Quota,
    context: { adminId: string; requestId: string },
    now = new Date(),
  ): Promise<{ updated: QuotaPolicyRecord; overLimitUserIds: string[] }> {
    const validated = quotaSchema.parse(quota);
    try {
      const result = await this.dependencies.repository.updateDefault({
        quota: validated,
        updatedBy: context.adminId,
        now,
      });
      if (!result) throw new ResourceNotFoundError();
      await this.dependencies.repository.audit({
        actorUserId: context.adminId,
        action: "quota_policy.update",
        resourceType: "quota_policy",
        resourceId: "default",
        result: "succeeded",
        requestId: context.requestId,
        metadata: {
          from: {
            personalAgentLimit: result.previous.personalAgentLimit,
            concurrentSessionLimit: result.previous.concurrentSessionLimit,
            dailySessionLimit: result.previous.dailySessionLimit,
            monthlyTokenLimit: result.previous.monthlyTokenLimit,
          },
          to: { ...validated },
        },
      });
      for (const userId of result.overLimitUserIds) {
        await this.dependencies.notifier?.quotaExhausted(
          userId,
          "monthlyTokens",
        );
      }
      return {
        updated: result.updated,
        overLimitUserIds: result.overLimitUserIds,
      };
    } catch (error) {
      await this.dependencies.repository.audit({
        actorUserId: context.adminId,
        action: "quota_policy.update",
        resourceType: "quota_policy",
        resourceId: "default",
        result: "failed",
        requestId: context.requestId,
        errorCode:
          error instanceof ResourceNotFoundError
            ? "RESOURCE_NOT_FOUND"
            : error instanceof Error && error.name === "ZodError"
              ? "VALIDATION_FAILED"
              : "QUOTA_POLICY_UPDATE_FAILED",
      });
      throw error;
    }
  }
}
