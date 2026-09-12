/**
 * Notification seam. No channel is wired in this iteration: `LoggingNotifier`
 * only emits structured logs. Adding SMTP / webhook delivery later means
 * registering another implementation — the two detection points below stay
 * untouched.
 */
export interface Notifier {
  quotaNearLimit(
    userId: string,
    dimension: "monthlyTokens",
    consumed: number,
    limit: number,
  ): Promise<void>;
  quotaExhausted(userId: string, dimension: "monthlyTokens"): Promise<void>;
}

export type NotifierLog = (
  fields: Record<string, unknown>,
  message: string,
) => void;

export class LoggingNotifier implements Notifier {
  constructor(private readonly log: NotifierLog = console.log) {}

  async quotaNearLimit(
    userId: string,
    dimension: "monthlyTokens",
    consumed: number,
    limit: number,
  ): Promise<void> {
    this.log(
      {
        event: "notification.quota_near_limit",
        user_id: userId,
        dimension,
        consumed,
        limit,
      },
      "Quota near limit",
    );
  }

  async quotaExhausted(
    userId: string,
    dimension: "monthlyTokens",
  ): Promise<void> {
    this.log(
      {
        event: "notification.quota_exhausted",
        user_id: userId,
        dimension,
      },
      "Quota exhausted",
    );
  }
}

export const QUOTA_NEAR_LIMIT_RATIO = 0.8;

export type DimensionStatus = "ok" | "near" | "exhausted";

/**
 * `limit = 0` means "nothing allowed", which is exhausted by definition —
 * matching the quota enforcement points where a zero limit blocks outright.
 */
export function dimensionStatus(
  consumed: number,
  limit: number,
): DimensionStatus {
  if (consumed >= limit) return "exhausted";
  if (limit > 0 && consumed >= limit * QUOTA_NEAR_LIMIT_RATIO) return "near";
  return "ok";
}
