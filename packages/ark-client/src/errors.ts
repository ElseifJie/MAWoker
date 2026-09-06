export type ArkErrorCategory =
  | "rate_limited"
  | "unavailable"
  | "version_conflict"
  | "runtime_busy"
  | "session_terminated"
  | "unknown_write_outcome"
  | "invalid_response"
  | "timeout"
  | "cancelled"
  | "not_found";

const defaults: Record<
  ArkErrorCategory,
  { message: string; retryable: boolean }
> = {
  rate_limited: { message: "Ark rate limit exceeded", retryable: true },
  unavailable: { message: "Ark service is unavailable", retryable: true },
  version_conflict: {
    message: "Ark agent version conflict",
    retryable: false,
  },
  runtime_busy: { message: "Ark session runtime is busy", retryable: true },
  session_terminated: {
    message: "Ark session is terminated",
    retryable: false,
  },
  unknown_write_outcome: {
    message: "Ark write outcome is unknown",
    retryable: false,
  },
  invalid_response: {
    message: "Ark returned an invalid response",
    retryable: false,
  },
  timeout: { message: "Ark request timed out", retryable: true },
  cancelled: { message: "Ark request was cancelled", retryable: false },
  not_found: { message: "Ark resource was not found", retryable: false },
};

export class ArkGatewayError extends Error {
  readonly category: ArkErrorCategory;
  readonly retryable: boolean;
  readonly status?: number;
  readonly arkRequestId?: string;

  constructor(
    category: ArkErrorCategory,
    options: {
      status?: number | undefined;
      arkRequestId?: string | undefined;
    } = {},
  ) {
    super(defaults[category].message);
    this.name = "ArkGatewayError";
    this.category = category;
    this.retryable = defaults[category].retryable;
    if (options.status !== undefined) this.status = options.status;
    if (options.arkRequestId !== undefined) {
      this.arkRequestId = options.arkRequestId;
    }
  }
}
