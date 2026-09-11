import type { ArkEvent } from "@pwa/ark-client";
import {
  isRecoverableArkError,
  sessionStatusSchema,
  type SessionStatus,
} from "@pwa/contracts";

export type UsageMetricType =
  "input_tokens" | "output_tokens" | "runtime_ms" | "tool_calls";

export interface UsageMetric {
  metricType: UsageMetricType;
  quantity: number;
}

export interface ArkEventProjection {
  eventId: string;
  observedAt: Date;
  metrics: UsageMetric[];
  status?: SessionStatus;
  errorCode?: string | null;
  errorRecoverable?: boolean | null;
}

export interface QuotaUsageSummary {
  period: { startsAt: Date; endsAt: Date };
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
    runtimeMs: number;
    toolCalls: number;
  };
  exhausted: {
    personalAgents: boolean;
    concurrentSessions: boolean;
    dailySessions: boolean;
    monthlyTokens: boolean;
  };
}

export class QuotaUsageService {
  constructor(
    private readonly dependencies: {
      repository: {
        summary(userId: string, now: Date): PromiseLike<QuotaUsageSummary>;
      };
      now?: () => Date;
    },
  ) {}

  getSummary(userId: string): PromiseLike<QuotaUsageSummary> {
    return this.dependencies.repository.summary(
      userId,
      (this.dependencies.now ?? (() => new Date()))(),
    );
  }
}

function isNonnegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function modelUsageMetrics(data: Record<string, unknown>): UsageMetric[] {
  const usage = data.model_usage;
  if (typeof usage !== "object" || usage === null || Array.isArray(usage)) {
    return [];
  }
  const values = usage as Record<string, unknown>;
  if (
    !isNonnegativeInteger(values.input_tokens) ||
    !isNonnegativeInteger(values.output_tokens)
  ) {
    return [];
  }
  return [
    { metricType: "input_tokens", quantity: values.input_tokens },
    { metricType: "output_tokens", quantity: values.output_tokens },
  ];
}

export function projectArkEvent(event: ArkEvent): ArkEventProjection {
  const projection: ArkEventProjection = {
    eventId: event.id,
    observedAt: new Date(event.createdAt),
    metrics: [],
  };

  if (event.type === "span.model_request_end") {
    projection.metrics = modelUsageMetrics(event.data);
    return projection;
  }
  const toolUse =
    event.type === "agent.tool_use" ||
    event.type === "agent.mcp_tool_use" ||
    event.type === "agent.custom_tool_use" ||
    event.type === "tool.call";
  if (toolUse) {
    projection.metrics = [{ metricType: "tool_calls", quantity: 1 }];
  }
  if (event.type === "agent.thinking" || toolUse) {
    return {
      ...projection,
      status: "running",
      errorCode: null,
      errorRecoverable: null,
    };
  }
  const statusByType: Partial<Record<string, SessionStatus>> = {
    "session.status_running": "running",
    "session.status_rescheduled": "rescheduled",
    "session.status_idle": "idle",
    "session.status_terminated": "terminated",
  };
  const eventStatus = statusByType[event.type];
  if (eventStatus) {
    return {
      ...projection,
      status: eventStatus,
      errorCode: null,
      errorRecoverable: null,
    };
  }
  if (event.type === "session.status") {
    const status = sessionStatusSchema.safeParse(event.data.status);
    return status.success
      ? {
          ...projection,
          status: status.data,
          errorCode: null,
          errorRecoverable: null,
        }
      : projection;
  }
  if (event.type === "session.error") {
    const recoverable = isRecoverableArkError(event.data);
    const nestedError =
      typeof event.data.error === "object" &&
      event.data.error !== null &&
      !Array.isArray(event.data.error)
        ? (event.data.error as Record<string, unknown>)
        : undefined;
    return {
      ...projection,
      status: recoverable ? "rescheduled" : "terminated",
      errorCode:
        typeof nestedError?.type === "string"
          ? nestedError.type
          : typeof event.data.code === "string"
            ? event.data.code
            : "SESSION_ERROR",
      errorRecoverable: recoverable,
    };
  }
  return projection;
}

export function isPublicSessionEvent(type: string): boolean {
  return !type.startsWith("span.") && type !== "session.usage";
}
