import { dimensionStatus } from "./notifications.js";

export interface AdminUsageTotals {
  inputTokens: number;
  outputTokens: number;
  tokens: number;
  activeUsers: number;
  sessions: number;
  exhaustedUsers: number;
}

export interface AdminUsageUserRow {
  userId: string;
  email: string;
  role: "user" | "admin";
  status: "active" | "disabled";
  quota: {
    personalAgentLimit: number;
    concurrentSessionLimit: number;
    dailySessionLimit: number;
    monthlyTokenLimit: number;
  };
  usage: {
    personalAgents: number;
    concurrentSessions: number;
    dailySessions: number;
    inputTokens: number;
    outputTokens: number;
    tokens: number;
    toolCalls: number;
  };
  dimensionStatus: {
    personalAgents: ReturnType<typeof dimensionStatus>;
    concurrentSessions: ReturnType<typeof dimensionStatus>;
    dailySessions: ReturnType<typeof dimensionStatus>;
    monthlyTokens: ReturnType<typeof dimensionStatus>;
  };
}

export interface AdminUsageOverview {
  period: { startsAt: Date; endsAt: Date };
  totals: AdminUsageTotals;
  users: AdminUsageUserRow[];
  nextCursor: { tokens: number; userId: string } | null;
}

export interface AdminPlatformAgentUsage {
  platformAgentId: string;
  name: string;
  status: string;
  defaultAssignments: number;
  inputTokens: number;
  outputTokens: number;
  tokens: number;
}

export interface AdminPersonalAgentUsage {
  personalAgents: number;
  tokens: number;
}

export interface AdminUsageRepository {
  overview(input: {
    now: Date;
    limit: number;
    before: { tokens: number; userId: string } | null;
  }): PromiseLike<{
    totals: Omit<AdminUsageTotals, "tokens"> & { tokens: number };
    users: Array<Omit<AdminUsageUserRow, "dimensionStatus">>;
    nextCursor: { tokens: number; userId: string } | null;
    period: { startsAt: Date; endsAt: Date };
  }>;
  byAgents(input: { now: Date }): PromiseLike<{
    platform: Array<{
      platformAgentId: string;
      name: string;
      status: string;
      defaultAssignments: number;
      inputTokens: number;
      outputTokens: number;
    }>;
    personal: { personalAgents: number; tokens: number };
  }>;
}

export class AdminUsageService {
  constructor(
    private readonly dependencies: {
      repository: AdminUsageRepository;
      now?: () => Date;
    },
  ) {}

  async overview(input: {
    limit: number;
    before: { tokens: number; userId: string } | null;
  }): Promise<AdminUsageOverview> {
    const page = await this.dependencies.repository.overview({
      now: (this.dependencies.now ?? (() => new Date()))(),
      limit: input.limit,
      before: input.before,
    });
    return {
      period: page.period,
      totals: page.totals,
      users: page.users.map((row) => ({
        ...row,
        dimensionStatus: {
          personalAgents: dimensionStatus(
            row.usage.personalAgents,
            row.quota.personalAgentLimit,
          ),
          concurrentSessions: dimensionStatus(
            row.usage.concurrentSessions,
            row.quota.concurrentSessionLimit,
          ),
          dailySessions: dimensionStatus(
            row.usage.dailySessions,
            row.quota.dailySessionLimit,
          ),
          monthlyTokens: dimensionStatus(
            row.usage.tokens,
            row.quota.monthlyTokenLimit,
          ),
        },
      })),
      nextCursor: page.nextCursor,
    };
  }

  async byAgents(): Promise<{
    platform: AdminPlatformAgentUsage[];
    personal: AdminPersonalAgentUsage;
  }> {
    const result = await this.dependencies.repository.byAgents({
      now: (this.dependencies.now ?? (() => new Date()))(),
    });
    return {
      platform: result.platform.map((agent) => ({
        ...agent,
        tokens: agent.inputTokens + agent.outputTokens,
      })),
      personal: {
        personalAgents: result.personal.personalAgents,
        tokens: result.personal.tokens,
      },
    };
  }
}
