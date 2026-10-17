import { apiErrorSchema, type ApiError } from "@pwa/contracts";

export interface ApiClientOptions {
  /** Origin to prefix, e.g. `https://assistant.example.com`. */
  baseUrl?: string;
  /** Injectable for tests and native shells. */
  fetch?: typeof fetch;
}

export class ApiClientError extends Error {
  constructor(
    readonly status: number,
    readonly error: ApiError["error"] | null,
    message = error?.message ?? `Request failed with status ${status}`,
  ) {
    super(message);
    this.name = "ApiClientError";
  }

  get code(): ApiError["error"]["code"] {
    return this.error?.code ?? "INTERNAL_ERROR";
  }

  get retryable(): boolean {
    return this.error?.retryable ?? false;
  }
}

export interface AssistantProfileDto {
  ownerUserId: string;
  defaultAgentId: string | null;
  displayName: string;
  persona: string;
  preferences: Record<string, unknown>;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface AssistantAgentDto {
  id: string;
  name: string;
  modelId: string;
  status: string;
  arkAgentId: string;
}

export interface AssistantViewDto {
  profile: AssistantProfileDto;
  agent: AssistantAgentDto | null;
}

export interface AssistantProfileUpdate {
  displayName?: string;
  persona?: string;
  preferences?: Record<string, unknown>;
  expectedRevision?: number;
}

export interface RunDto {
  id: string;
  conversationId: string;
  triggerKind: "manual" | "automation";
  submissionId: string;
  status: string;
  arkSessionId: string | null;
  turnId: string | null;
  errorCode: string | null;
  startedAt: string | null;
  endedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SyncChangeDto {
  seq: number;
  resourceType: string;
  resourceId: string;
  revision: number | null;
  deleted: boolean;
  changedAt: string;
}

export interface SyncSnapshotDto {
  cursor: number;
  resources: {
    runs: RunDto[];
    notifications: unknown[];
  };
}

export interface SyncChangesDto {
  cursor: number;
  hasMore: boolean;
  changes: SyncChangeDto[];
}

export interface SseEvent {
  event: string;
  data: unknown;
  id?: string;
}

export interface EventStreamOptions {
  sessionId: string;
  onEvent: (event: SseEvent) => void;
  lastEventId?: string;
  signal?: AbortSignal;
  onError?: (error: unknown) => void;
}

export interface ApiClient {
  getAssistantProfile(): Promise<AssistantViewDto>;
  updateAssistantProfile(
    input: AssistantProfileUpdate,
  ): Promise<AssistantViewDto>;
  getRun(id: string): Promise<RunDto>;
  getSyncSnapshot(): Promise<SyncSnapshotDto>;
  getSyncChanges(cursor: number, limit?: number): Promise<SyncChangesDto>;
  openEventStream(options: EventStreamOptions): Promise<{ close(): void }>;
}

function parseSseFrame(frame: string): SseEvent | undefined {
  let event = "message";
  let id: string | undefined;
  const data: string[] = [];
  for (const line of frame.split("\n")) {
    if (line === "" || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    const raw = colon === -1 ? "" : line.slice(colon + 1);
    const value = raw.startsWith(" ") ? raw.slice(1) : raw;
    if (field === "event") event = value;
    else if (field === "id") id = value;
    else if (field === "data") data.push(value);
  }
  if (event === "message" && data.length === 0) return undefined;
  const joined = data.join("\n");
  let parsed: unknown = joined;
  if (joined.length > 0) {
    try {
      parsed = JSON.parse(joined) as unknown;
    } catch {
      parsed = joined;
    }
  }
  return { event, data: parsed, ...(id === undefined ? {} : { id }) };
}

async function consumeSse(
  body: NonNullable<Response["body"]>,
  onEvent: (event: SseEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (!signal.aborted) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      buffer = buffer.replace(/\r\n/g, "\n");
      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const parsed = parseSseFrame(frame);
        if (parsed) onEvent(parsed);
        boundary = buffer.indexOf("\n\n");
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

export function createApiClient(options: ApiClientOptions = {}): ApiClient {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const baseUrl = options.baseUrl ?? "";

  async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set("accept", "application/json");
    if (init.body !== undefined && !headers.has("content-type")) {
      headers.set("content-type", "application/json");
    }
    const response = await fetchImpl(`${baseUrl}${path}`, {
      credentials: "same-origin",
      ...init,
      headers,
    });
    if (!response.ok) {
      const payload = (await response.json().catch(() => null)) as unknown;
      const parsed = apiErrorSchema.safeParse(payload);
      throw new ApiClientError(
        response.status,
        parsed.success ? parsed.data.error : null,
      );
    }
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  return {
    getAssistantProfile: () =>
      request<AssistantViewDto>("/api/v1/assistant/profile"),

    updateAssistantProfile: (input) =>
      request<AssistantViewDto>("/api/v1/assistant/profile", {
        method: "PATCH",
        body: JSON.stringify(input),
      }),

    getRun: (id) => request<RunDto>(`/api/v1/runs/${encodeURIComponent(id)}`),

    getSyncSnapshot: () => request<SyncSnapshotDto>("/api/v1/sync/snapshot"),

    getSyncChanges: (cursor, limit = 100) =>
      request<SyncChangesDto>(
        `/api/v1/sync/changes?cursor=${encodeURIComponent(String(cursor))}&limit=${encodeURIComponent(String(limit))}`,
      ),

    async openEventStream(input) {
      const controller = new AbortController();
      const abort = () => controller.abort();
      if (input.signal?.aborted) controller.abort();
      else input.signal?.addEventListener("abort", abort, { once: true });
      const response = await fetchImpl(
        `${baseUrl}/api/v1/sessions/${encodeURIComponent(input.sessionId)}/events`,
        {
          credentials: "same-origin",
          headers: {
            accept: "text/event-stream",
            ...(input.lastEventId === undefined
              ? {}
              : { "last-event-id": input.lastEventId }),
          },
          signal: controller.signal,
        },
      );
      if (!response.ok || !response.body) {
        input.signal?.removeEventListener("abort", abort);
        throw new ApiClientError(response.status, null);
      }
      void consumeSse(response.body, input.onEvent, controller.signal).catch(
        (error: unknown) => {
          if (!controller.signal.aborted) input.onError?.(error);
        },
      );
      return {
        close() {
          input.signal?.removeEventListener("abort", abort);
          controller.abort();
        },
      };
    },
  };
}
