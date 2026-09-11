import pino, { type Logger } from "pino";

const redactionPaths = [
  "authorization",
  "cookie",
  "token",
  "*.token",
  "apiKey",
  "*.apiKey",
  "clientSecret",
  "*.clientSecret",
  "accessKeySecret",
  "*.accessKeySecret",
  "stsToken",
  "*.stsToken",
  "systemPrompt",
  "*.systemPrompt",
  "prompt",
  "*.prompt",
  "message",
  "*.message",
  "content",
  "*.content",
  "filename",
  "*.filename",
  "fileName",
  "*.fileName",
  "bytes",
  "*.bytes",
];

export function createWorkerLogger(stream?: {
  write(message: string): void;
}): Logger {
  return pino(
    {
      redact: {
        paths: redactionPaths,
        censor: "[REDACTED]",
      },
    },
    stream,
  );
}

export function logWorkerFailure(
  logger: Logger,
  event: string,
  error: unknown,
): void {
  const context =
    typeof error === "object" && error !== null
      ? (error as Record<string, unknown>)
      : {};
  const errorCode =
    typeof context.category === "string"
      ? context.category
      : typeof context.code === "string"
        ? context.code
        : "UNKNOWN";
  logger.error(
    {
      event,
      result: "error",
      error_code: errorCode,
      ...(typeof context.arkRequestId === "string"
        ? { ark_request_id: context.arkRequestId }
        : {}),
    },
    "Worker operation failed",
  );
}
