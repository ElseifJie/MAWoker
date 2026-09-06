import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ArkGatewayError } from "./errors.js";
import type {
  ArkAgent,
  ArkAgentInput,
  ArkAgentUpdate,
  ArkArtifact,
  ArkEvent,
  ArkEventInput,
  ArkFile,
  ArkFileInput,
  ArkGateway,
  ArkRequestOptions,
  ArkResource,
  ArkSession,
  ArkSessionInput,
} from "./types.js";

const agentSchema = z
  .object({
    id: z.string().min(1),
    version: z.number().int().positive(),
    name: z.string(),
    description: z.string(),
    modelId: z.string(),
    systemPrompt: z.string(),
  })
  .strict();

const sessionSchema = z
  .object({
    id: z.string().min(1),
    agentId: z.string().min(1),
    agentVersion: z.number().int().positive(),
    environmentId: z.string().min(1),
    status: z.enum(["idle", "running", "rescheduled", "terminated"]),
  })
  .strict();

const eventSchema = z
  .object({
    id: z.string().min(1),
    type: z.string().min(1),
    createdAt: z.string().datetime(),
    data: z.record(z.string(), z.unknown()),
  })
  .strict();

const fileSchema = z
  .object({
    id: z.string().min(1),
    name: z.string(),
    contentType: z.string(),
    size: z.number().int().nonnegative(),
    purpose: z.literal("agent"),
  })
  .strict();

const resourceSchema = z
  .object({
    id: z.string().min(1),
    fileId: z.string().min(1),
    mountPath: z.string().min(1),
  })
  .strict();

const artifactSchema = z
  .object({
    id: z.string().min(1),
    sessionId: z.string().min(1),
    name: z.string(),
    contentType: z.string(),
    size: z.number().int().nonnegative(),
    createdAt: z.string().datetime(),
  })
  .strict();

const errorBodySchema = z
  .object({
    code: z.string().optional(),
  })
  .passthrough();

type Fetch = typeof globalThis.fetch;
type Sleep = (milliseconds: number, signal: AbortSignal) => Promise<void>;

interface RequestContext {
  signal: AbortSignal;
  timedOut: () => boolean;
  clearTimer: () => void;
  cleanup: () => void;
  cancel: () => void;
}

interface OpenResponse {
  response: Response;
  context: RequestContext;
}

export interface HttpArkGatewayOptions {
  baseUrl: string;
  apiKey: string;
  fetch?: Fetch;
  timeoutMs?: number;
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  random?: () => number;
  sleep?: Sleep;
  createCorrelationId?: () => string;
  now?: () => Date;
}

interface RequestDefinition<T> {
  method: "GET" | "POST" | "PATCH" | "DELETE";
  path: string;
  safe: boolean;
  body?: BodyInit | undefined;
  contentType?: string | undefined;
  schema?: z.ZodType<T> | undefined;
  options?: ArkRequestOptions | undefined;
}

function defaultSleep(
  milliseconds: number,
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
      reject(signal.reason);
    };
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export class HttpArkGateway implements ArkGateway {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetch: Fetch;
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly random: () => number;
  private readonly sleep: Sleep;
  private readonly createCorrelationId: () => string;
  private readonly now: () => Date;

  constructor(options: HttpArkGatewayOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.fetch = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.maxAttempts = options.maxAttempts ?? 3;
    this.baseDelayMs = options.baseDelayMs ?? 100;
    this.maxDelayMs = options.maxDelayMs ?? 2_000;
    this.random = options.random ?? Math.random;
    this.sleep = options.sleep ?? defaultSleep;
    this.createCorrelationId =
      options.createCorrelationId ?? (() => `req_${randomUUID()}`);
    this.now = options.now ?? (() => new Date());
  }

  createAgent(
    input: ArkAgentInput,
    options?: ArkRequestOptions,
  ): Promise<ArkAgent> {
    return this.jsonRequest({
      method: "POST",
      path: "/api/v3/agents",
      safe: false,
      body: JSON.stringify(input),
      contentType: "application/json",
      schema: agentSchema,
      options,
    });
  }

  getAgent(agentId: string, options?: ArkRequestOptions): Promise<ArkAgent> {
    return this.jsonRequest({
      method: "GET",
      path: `/api/v3/agents/${encodeURIComponent(agentId)}`,
      safe: true,
      schema: agentSchema,
      options,
    });
  }

  updateAgent(
    agentId: string,
    input: ArkAgentUpdate,
    options?: ArkRequestOptions,
  ): Promise<ArkAgent> {
    return this.jsonRequest({
      method: "PATCH",
      path: `/api/v3/agents/${encodeURIComponent(agentId)}`,
      safe: false,
      body: JSON.stringify(input),
      contentType: "application/json",
      schema: agentSchema,
      options,
    });
  }

  async deleteAgent(
    agentId: string,
    options?: ArkRequestOptions,
  ): Promise<void> {
    await this.request(
      {
        method: "DELETE",
        path: `/api/v3/agents/${encodeURIComponent(agentId)}`,
        safe: false,
        options,
      },
      async () => undefined,
    );
  }

  createSession(
    input: ArkSessionInput,
    options?: ArkRequestOptions,
  ): Promise<ArkSession> {
    return this.jsonRequest({
      method: "POST",
      path: "/api/v3/sessions",
      safe: false,
      body: JSON.stringify(input),
      contentType: "application/json",
      schema: sessionSchema,
      options,
    });
  }

  getSession(
    sessionId: string,
    options?: ArkRequestOptions,
  ): Promise<ArkSession> {
    return this.jsonRequest({
      method: "GET",
      path: `/api/v3/sessions/${encodeURIComponent(sessionId)}`,
      safe: true,
      schema: sessionSchema,
      options,
    });
  }

  async deleteSession(
    sessionId: string,
    options?: ArkRequestOptions,
  ): Promise<void> {
    await this.request(
      {
        method: "DELETE",
        path: `/api/v3/sessions/${encodeURIComponent(sessionId)}`,
        safe: false,
        options,
      },
      async () => undefined,
    );
  }

  submitEvent(
    sessionId: string,
    event: ArkEventInput,
    options?: ArkRequestOptions,
  ): Promise<ArkEvent> {
    return this.jsonRequest({
      method: "POST",
      path: `/api/v3/sessions/${encodeURIComponent(sessionId)}/events`,
      safe: false,
      body: JSON.stringify(event),
      contentType: "application/json",
      schema: eventSchema,
      options,
    });
  }

  listEvents(
    sessionId: string,
    options?: ArkRequestOptions,
  ): Promise<ArkEvent[]> {
    return this.jsonRequest({
      method: "GET",
      path: `/api/v3/sessions/${encodeURIComponent(sessionId)}/events`,
      safe: true,
      schema: z.array(eventSchema),
      options,
    });
  }

  async *streamEvents(
    sessionId: string,
    options?: ArkRequestOptions,
  ): AsyncIterable<ArkEvent> {
    const definition: RequestDefinition<unknown> = {
      method: "GET",
      path: `/api/v3/sessions/${encodeURIComponent(sessionId)}/events/stream`,
      safe: true,
      options,
    };
    const { response, context } = await this.retry(
      definition,
      (correlationId) => this.openResponse(definition, correlationId),
    );
    context.clearTimer();
    if (!response.body) {
      context.cleanup();
      throw new ArkGatewayError("invalid_response");
    }

    const reader = response.body
      .pipeThrough(new TextDecoderStream())
      .getReader();
    let buffer = "";
    let completed = false;
    try {
      while (true) {
        const { done, value } = await reader.read();
        buffer += value ?? "";
        const blocks = buffer.split(/\r?\n\r?\n/);
        buffer = blocks.pop() ?? "";
        for (const block of blocks) {
          if (block.trim()) yield this.parseSseBlock(block);
        }
        if (done) {
          if (buffer.trim()) yield this.parseSseBlock(buffer);
          completed = true;
          break;
        }
      }
    } catch (error) {
      if (options?.signal?.aborted) {
        throw new ArkGatewayError("cancelled");
      }
      if (error instanceof ArkGatewayError) throw error;
      throw new ArkGatewayError("unavailable");
    } finally {
      if (!completed) {
        try {
          await reader.cancel();
        } catch {
          // Preserve the original stream result while still releasing resources.
        }
      }
      reader.releaseLock();
      context.cancel();
      context.cleanup();
    }
  }

  uploadFile(
    input: ArkFileInput,
    options?: ArkRequestOptions,
  ): Promise<ArkFile> {
    const form = new FormData();
    form.set("purpose", input.purpose);
    form.set(
      "file",
      new Blob([new Uint8Array(input.bytes).buffer], {
        type: input.contentType,
      }),
      input.name,
    );
    return this.jsonRequest({
      method: "POST",
      path: "/api/v3/files",
      safe: false,
      body: form,
      schema: fileSchema,
      options,
    });
  }

  listSessionResources(
    sessionId: string,
    options?: ArkRequestOptions,
  ): Promise<ArkResource[]> {
    return this.jsonRequest({
      method: "GET",
      path: `/api/v3/sessions/${encodeURIComponent(sessionId)}/resources`,
      safe: true,
      schema: z.array(resourceSchema),
      options,
    });
  }

  listArtifacts(
    sessionId: string,
    options?: ArkRequestOptions,
  ): Promise<ArkArtifact[]> {
    const query = new URLSearchParams({
      scope_id: sessionId,
      kind: "artifact",
    });
    return this.jsonRequest({
      method: "GET",
      path: `/api/v3/files?${query.toString()}`,
      safe: true,
      schema: z.array(artifactSchema),
      options,
    });
  }

  private async jsonRequest<T>(
    definition: RequestDefinition<T> & { schema: z.ZodType<T> },
  ): Promise<T> {
    return this.request(definition, async (response) => {
      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        throw new ArkGatewayError("invalid_response");
      }
      const unwrapped =
        payload !== null &&
        typeof payload === "object" &&
        "data" in payload &&
        Object.keys(payload).length === 1
          ? (payload as { data: unknown }).data
          : payload;
      const parsed = definition.schema.safeParse(unwrapped);
      if (!parsed.success) {
        throw new ArkGatewayError("invalid_response", {
          arkRequestId: response.headers.get("x-request-id") ?? undefined,
        });
      }
      return parsed.data;
    });
  }

  private request<T>(
    definition: RequestDefinition<unknown>,
    consume: (response: Response) => Promise<T>,
  ): Promise<T> {
    return this.retry(definition, (correlationId) =>
      this.requestOnce(definition, correlationId, consume),
    );
  }

  private async retry<T>(
    definition: RequestDefinition<unknown>,
    operation: (correlationId: string) => Promise<T>,
  ): Promise<T> {
    const correlationId =
      definition.options?.correlationId ?? this.createCorrelationId();
    let lastError: ArkGatewayError | undefined;

    for (let attempt = 0; attempt < this.maxAttempts; attempt += 1) {
      try {
        return await operation(correlationId);
      } catch (error) {
        const classified =
          error instanceof ArkGatewayError
            ? error
            : new ArkGatewayError(
                definition.safe ? "unavailable" : "unknown_write_outcome",
              );
        lastError = classified;
        const canRetry =
          definition.safe &&
          classified.retryable &&
          attempt + 1 < this.maxAttempts;
        if (!canRetry) throw classified;
        const ceiling = Math.min(
          this.maxDelayMs,
          this.baseDelayMs * 2 ** attempt,
        );
        const delay = Math.floor(this.random() * ceiling);
        try {
          await this.sleep(
            delay,
            definition.options?.signal ?? new AbortController().signal,
          );
        } catch {
          if (definition.options?.signal?.aborted) {
            throw new ArkGatewayError("cancelled");
          }
          throw new ArkGatewayError("unavailable");
        }
      }
    }
    throw lastError ?? new ArkGatewayError("unavailable");
  }

  private async requestOnce<T>(
    definition: RequestDefinition<unknown>,
    correlationId: string,
    consume: (response: Response) => Promise<T>,
  ): Promise<T> {
    const opened = await this.openResponse(definition, correlationId);
    try {
      return await consume(opened.response);
    } catch (error) {
      throw this.classifyError(error, definition.safe, opened.context);
    } finally {
      opened.context.cleanup();
    }
  }

  private async openResponse(
    definition: RequestDefinition<unknown>,
    correlationId: string,
  ): Promise<OpenResponse> {
    if (definition.options?.signal?.aborted) {
      throw new ArkGatewayError("cancelled");
    }
    const context = this.createRequestContext(definition.options?.signal);
    const headers = new Headers({
      authorization: `Bearer ${this.apiKey}`,
      "x-correlation-id": correlationId,
    });
    if (definition.contentType) {
      headers.set("content-type", definition.contentType);
    }

    try {
      const requestInit: RequestInit = {
        method: definition.method,
        headers,
        signal: context.signal,
      };
      if (definition.body !== undefined) requestInit.body = definition.body;
      const response = await this.fetch(
        `${this.baseUrl}${definition.path}`,
        requestInit,
      );
      if (!response.ok) {
        const classified = await this.classifyResponse(
          response,
          definition.safe,
        );
        if (context.timedOut()) {
          throw new ArkGatewayError(
            definition.safe ? "timeout" : "unknown_write_outcome",
          );
        }
        throw classified;
      }
      return { response, context };
    } catch (error) {
      const classified = this.classifyError(error, definition.safe, context);
      context.cleanup();
      throw classified;
    }
  }

  private createRequestContext(callerSignal?: AbortSignal): RequestContext {
    const controller = new AbortController();
    let timedOut = false;
    const onCallerAbort = () => controller.abort();
    callerSignal?.addEventListener("abort", onCallerAbort, { once: true });
    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeoutMs);
    let timerActive = true;
    const clearTimer = () => {
      if (!timerActive) return;
      clearTimeout(timeoutHandle);
      timerActive = false;
    };
    return {
      signal: controller.signal,
      timedOut: () => timedOut,
      clearTimer,
      cleanup: () => {
        clearTimer();
        callerSignal?.removeEventListener("abort", onCallerAbort);
      },
      cancel: () => controller.abort(),
    };
  }

  private classifyError(
    error: unknown,
    safe: boolean,
    context: RequestContext,
  ): ArkGatewayError {
    if (context.signal.aborted && !context.timedOut()) {
      return new ArkGatewayError("cancelled");
    }
    if (context.timedOut()) {
      return new ArkGatewayError(safe ? "timeout" : "unknown_write_outcome");
    }
    if (error instanceof ArkGatewayError) return error;
    return new ArkGatewayError(safe ? "unavailable" : "unknown_write_outcome");
  }

  private async classifyResponse(
    response: Response,
    safe: boolean,
  ): Promise<ArkGatewayError> {
    let code: string | undefined;
    try {
      const parsed = errorBodySchema.safeParse(await response.json());
      if (parsed.success) code = parsed.data.code;
    } catch {
      // Error bodies are intentionally discarded to avoid leaking upstream data.
    }
    const options = {
      status: response.status,
      arkRequestId: response.headers.get("x-request-id") ?? undefined,
    };
    if (response.status === 429)
      return new ArkGatewayError("rate_limited", options);
    if (code === "VERSION_CONFLICT") {
      return new ArkGatewayError("version_conflict", options);
    }
    if (code === "RUNTIME_BUSY") {
      return new ArkGatewayError("runtime_busy", options);
    }
    if (code === "SESSION_TERMINATED") {
      return new ArkGatewayError("session_terminated", options);
    }
    if (response.status === 404)
      return new ArkGatewayError("not_found", options);
    if (response.status >= 500) {
      return new ArkGatewayError(
        safe ? "unavailable" : "unknown_write_outcome",
        options,
      );
    }
    return new ArkGatewayError("invalid_response", options);
  }

  private parseSseBlock(block: string): ArkEvent {
    let id = "";
    let type = "message";
    const dataLines: string[] = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith("id:")) id = line.slice(3).trim();
      if (line.startsWith("event:")) type = line.slice(6).trim();
      if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
    }
    let data: unknown;
    try {
      data = JSON.parse(dataLines.join("\n"));
    } catch {
      throw new ArkGatewayError("invalid_response");
    }
    const parsed = eventSchema.safeParse({
      id,
      type,
      createdAt: this.now().toISOString(),
      data,
    });
    if (!parsed.success) {
      throw new ArkGatewayError("invalid_response");
    }
    return parsed.data;
  }
}
