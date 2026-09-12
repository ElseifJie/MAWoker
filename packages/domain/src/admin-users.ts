import { ResourceNotFoundError } from "./errors.js";
import type { QuotaUsageSummary } from "./usage.js";
import type { QuotaDimensionKey } from "./platform-agents.js";

export interface AdminUserDetail {
  id: string;
  email: string;
  role: "user" | "admin";
  status: "active" | "disabled";
  hasPassword: boolean;
  defaultAgentId: string | null;
  createdAt: Date;
  updatedAt: Date;
  quota: QuotaUsageSummary["quota"];
  inherited: Record<QuotaDimensionKey, boolean>;
  usage: QuotaUsageSummary["usage"];
  exhausted: QuotaUsageSummary["exhausted"];
  period: QuotaUsageSummary["period"];
}

export interface AdminUserSessionRow {
  id: string;
  title: string;
  status: "idle" | "running" | "rescheduled" | "terminated";
  agentKind: "platform" | "personal";
  agentName: string;
  agentVersion: string;
  createdAt: Date;
  lastEventAt: Date | null;
  archivedAt: Date | null;
  deletionState: "none" | "pending" | "deletion_failed" | "deleted";
  tokens: number;
}

export interface AdminUserDetailRepository {
  getUser(userId: string): PromiseLike<
    | {
        id: string;
        email: string;
        role: "user" | "admin";
        status: "active" | "disabled";
        hasPassword: boolean;
        defaultAgentId: string | null;
        createdAt: Date;
        updatedAt: Date;
        overridden: Record<QuotaDimensionKey, boolean>;
      }
    | undefined
  >;
  listSessions(
    userId: string,
    input: {
      limit: number;
      before: { createdAt: string; id: string } | null;
    },
  ): PromiseLike<{
    sessions: AdminUserSessionRow[];
    nextCursor: { createdAt: string; id: string } | null;
  }>;
  summary(userId: string, now: Date): PromiseLike<QuotaUsageSummary>;
}

export class AdminUserDetailService {
  constructor(
    private readonly dependencies: {
      repository: AdminUserDetailRepository;
      audit?: {
        recordUserView(input: {
          adminId: string;
          userId: string;
          requestId: string;
        }): Promise<void>;
      };
      now?: () => Date;
    },
  ) {}

  async getDetail(
    userId: string,
    context: { adminId: string; requestId: string },
  ): Promise<AdminUserDetail> {
    const user = await this.dependencies.repository.getUser(userId);
    if (!user) throw new ResourceNotFoundError();
    await this.dependencies.audit?.recordUserView({
      adminId: context.adminId,
      userId,
      requestId: context.requestId,
    });
    const summary = await this.dependencies.repository.summary(
      userId,
      (this.dependencies.now ?? (() => new Date()))(),
    );
    return {
      id: user.id,
      email: user.email,
      role: user.role,
      status: user.status,
      hasPassword: user.hasPassword,
      defaultAgentId: user.defaultAgentId,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
      quota: summary.quota,
      inherited: {
        personalAgentLimit: !user.overridden.personalAgentLimit,
        concurrentSessionLimit: !user.overridden.concurrentSessionLimit,
        dailySessionLimit: !user.overridden.dailySessionLimit,
        monthlyTokenLimit: !user.overridden.monthlyTokenLimit,
      },
      usage: summary.usage,
      exhausted: summary.exhausted,
      period: summary.period,
    };
  }

  listSessions(
    userId: string,
    input: { limit: number; before: { createdAt: string; id: string } | null },
  ): PromiseLike<{
    sessions: AdminUserSessionRow[];
    nextCursor: { createdAt: string; id: string } | null;
  }> {
    return this.dependencies.repository.listSessions(userId, input);
  }
}
