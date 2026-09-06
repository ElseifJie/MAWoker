import { ArkGatewayError, type ArkErrorCategory } from "./errors.js";
import type {
  ArkAgent,
  ArkAgentInput,
  ArkAgentUpdate,
  ArkArtifact,
  ArkCall,
  ArkEvent,
  ArkEventInput,
  ArkFile,
  ArkFileInput,
  ArkGateway,
  ArkOperation,
  ArkRequestOptions,
  ArkResource,
  ArkSession,
  ArkSessionInput,
  SessionStatus,
} from "./types.js";

type InjectedFailure =
  | Extract<
      ArkErrorCategory,
      | "rate_limited"
      | "unavailable"
      | "version_conflict"
      | "runtime_busy"
      | "session_terminated"
    >
  | "connection_failure";

interface Subscriber {
  events: ArkEvent[];
  notify: (() => void) | undefined;
  closed: boolean;
}

export interface InMemoryArkGatewayOptions {
  now?: () => Date;
}

export interface StubArtifactInput {
  name: string;
  contentType: string;
  bytes: Uint8Array;
}

export interface StubEventInput {
  type: string;
  data: Record<string, unknown>;
}

const safeOperations = new Set<ArkOperation>([
  "getAgent",
  "getSession",
  "listEvents",
  "streamEvents",
  "listSessionResources",
  "listArtifacts",
]);

export class InMemoryArkGateway implements ArkGateway {
  readonly calls: ArkCall[] = [];

  private readonly now: () => Date;
  private readonly agents = new Map<string, ArkAgent>();
  private readonly agentsByCreateIdempotencyKey = new Map<string, string>();
  private readonly sessions = new Map<string, ArkSession>();
  private readonly sessionsByCreateIdempotencyKey = new Map<string, string>();
  private readonly events = new Map<string, ArkEvent[]>();
  private readonly files = new Map<string, ArkFile>();
  private readonly resources = new Map<string, ArkResource[]>();
  private readonly artifacts = new Map<string, ArkArtifact[]>();
  private readonly subscribers = new Map<string, Set<Subscriber>>();
  private readonly failures = new Map<ArkOperation, InjectedFailure[]>();
  private counters = {
    agent: 0,
    session: 0,
    event: 0,
    file: 0,
    resource: 0,
    artifact: 0,
  };

  constructor(options: InMemoryArkGatewayOptions = {}) {
    this.now = options.now ?? (() => new Date());
  }

  failNext(operation: ArkOperation, failure: InjectedFailure): void {
    const failures = this.failures.get(operation) ?? [];
    failures.push(failure);
    this.failures.set(operation, failures);
  }

  async createAgent(
    input: ArkAgentInput,
    options?: ArkRequestOptions,
  ): Promise<ArkAgent> {
    this.record("createAgent", input, options);
    const existingId = options?.idempotencyKey
      ? this.agentsByCreateIdempotencyKey.get(options.idempotencyKey)
      : undefined;
    if (existingId) {
      return structuredClone(this.requireAgent(existingId));
    }
    const agent = {
      ...input,
      id: `agent-${++this.counters.agent}`,
      version: 1,
    };
    this.agents.set(agent.id, agent);
    if (options?.idempotencyKey) {
      this.agentsByCreateIdempotencyKey.set(options.idempotencyKey, agent.id);
    }
    return structuredClone(agent);
  }

  async getAgent(
    agentId: string,
    options?: ArkRequestOptions,
  ): Promise<ArkAgent> {
    this.record("getAgent", { agentId }, options);
    return structuredClone(this.requireAgent(agentId));
  }

  async updateAgent(
    agentId: string,
    input: ArkAgentUpdate,
    options?: ArkRequestOptions,
  ): Promise<ArkAgent> {
    this.record("updateAgent", { agentId, ...input }, options);
    const current = this.requireAgent(agentId);
    if (input.currentVersion !== current.version) {
      throw new ArkGatewayError("version_conflict");
    }
    const updated = {
      id: current.id,
      version: current.version + 1,
      name: input.name,
      description: input.description,
      modelId: input.modelId,
      systemPrompt: input.systemPrompt,
    };
    this.agents.set(agentId, updated);
    return structuredClone(updated);
  }

  async deleteAgent(
    agentId: string,
    options?: ArkRequestOptions,
  ): Promise<void> {
    this.record("deleteAgent", { agentId }, options);
    this.requireAgent(agentId);
    this.agents.delete(agentId);
  }

  async createSession(
    input: ArkSessionInput,
    options?: ArkRequestOptions,
  ): Promise<ArkSession> {
    this.record("createSession", input, options);
    const existingId = options?.idempotencyKey
      ? this.sessionsByCreateIdempotencyKey.get(options.idempotencyKey)
      : undefined;
    if (existingId) {
      return structuredClone(this.requireSession(existingId));
    }
    const agent = this.requireAgent(input.agentId);
    if (agent.version !== input.agentVersion) {
      throw new ArkGatewayError("version_conflict");
    }
    for (const resource of input.resources) {
      if (!this.files.has(resource.fileId)) {
        throw new ArkGatewayError("not_found");
      }
    }
    const session: ArkSession = {
      id: `session-${++this.counters.session}`,
      agentId: input.agentId,
      agentVersion: input.agentVersion,
      environmentId: input.environmentId,
      status: "idle",
    };
    this.sessions.set(session.id, session);
    if (options?.idempotencyKey) {
      this.sessionsByCreateIdempotencyKey.set(
        options.idempotencyKey,
        session.id,
      );
    }
    this.events.set(session.id, []);
    this.resources.set(
      session.id,
      input.resources.map((resource) => ({
        ...resource,
        id: `resource-${++this.counters.resource}`,
      })),
    );
    this.artifacts.set(session.id, []);
    return structuredClone(session);
  }

  async getSession(
    sessionId: string,
    options?: ArkRequestOptions,
  ): Promise<ArkSession> {
    this.record("getSession", { sessionId }, options);
    return structuredClone(this.requireSession(sessionId));
  }

  async deleteSession(
    sessionId: string,
    options?: ArkRequestOptions,
  ): Promise<void> {
    this.record("deleteSession", { sessionId }, options);
    this.requireSession(sessionId);
    this.sessions.delete(sessionId);
    for (const [key, value] of this.sessionsByCreateIdempotencyKey) {
      if (value === sessionId) this.sessionsByCreateIdempotencyKey.delete(key);
    }
    this.events.delete(sessionId);
    this.resources.delete(sessionId);
    this.artifacts.delete(sessionId);
    for (const subscriber of this.subscribers.get(sessionId) ?? []) {
      subscriber.closed = true;
      subscriber.notify?.();
      subscriber.notify = undefined;
    }
    this.subscribers.delete(sessionId);
  }

  async submitEvent(
    sessionId: string,
    input: ArkEventInput,
    options?: ArkRequestOptions,
  ): Promise<ArkEvent> {
    this.record("submitEvent", { sessionId, ...input }, options);
    const session = this.requireSession(sessionId);
    if (session.status === "terminated") {
      throw new ArkGatewayError("session_terminated");
    }
    session.status = input.type === "user.interrupt" ? "idle" : "running";
    return this.appendEvent(sessionId, input);
  }

  async listEvents(
    sessionId: string,
    options?: ArkRequestOptions,
  ): Promise<ArkEvent[]> {
    this.record("listEvents", { sessionId }, options);
    this.requireSession(sessionId);
    return structuredClone(this.events.get(sessionId) ?? []);
  }

  async *streamEvents(
    sessionId: string,
    options?: ArkRequestOptions,
  ): AsyncIterable<ArkEvent> {
    this.record("streamEvents", { sessionId }, options);
    this.requireSession(sessionId);
    const subscriber: Subscriber = {
      events: [],
      notify: undefined,
      closed: false,
    };
    const subscribers = this.subscribers.get(sessionId) ?? new Set();
    subscribers.add(subscriber);
    this.subscribers.set(sessionId, subscribers);

    try {
      while (!subscriber.closed && !options?.signal?.aborted) {
        if (subscriber.events.length === 0) {
          const onAbort = () => subscriber.notify?.();
          await new Promise<void>((resolve) => {
            subscriber.notify = resolve;
            options?.signal?.addEventListener("abort", onAbort, { once: true });
          });
          options?.signal?.removeEventListener("abort", onAbort);
          subscriber.notify = undefined;
        }
        if (subscriber.closed || options?.signal?.aborted) break;
        const event = subscriber.events.shift();
        if (event) yield structuredClone(event);
      }
    } finally {
      subscribers.delete(subscriber);
    }
  }

  async uploadFile(
    input: ArkFileInput,
    options?: ArkRequestOptions,
  ): Promise<ArkFile> {
    this.record(
      "uploadFile",
      {
        name: input.name,
        contentType: input.contentType,
        size: input.bytes.byteLength,
        purpose: input.purpose,
      },
      options,
    );
    const file: ArkFile = {
      id: `file-${++this.counters.file}`,
      name: input.name,
      contentType: input.contentType,
      size: input.bytes.byteLength,
      purpose: input.purpose,
    };
    this.files.set(file.id, file);
    return structuredClone(file);
  }

  async listSessionResources(
    sessionId: string,
    options?: ArkRequestOptions,
  ): Promise<ArkResource[]> {
    this.record("listSessionResources", { sessionId }, options);
    this.requireSession(sessionId);
    return structuredClone(this.resources.get(sessionId) ?? []);
  }

  async listArtifacts(
    sessionId: string,
    options?: ArkRequestOptions,
  ): Promise<ArkArtifact[]> {
    this.record("listArtifacts", { sessionId }, options);
    this.requireSession(sessionId);
    return structuredClone(this.artifacts.get(sessionId) ?? []);
  }

  setSessionStatus(sessionId: string, status: SessionStatus): void {
    this.requireSession(sessionId).status = status;
  }

  emitEvent(sessionId: string, input: StubEventInput): ArkEvent {
    const session = this.requireSession(sessionId);
    if (input.type === "session.status") {
      const status = input.data.status;
      if (
        status === "idle" ||
        status === "running" ||
        status === "rescheduled" ||
        status === "terminated"
      ) {
        session.status = status;
      }
    }
    return this.appendEvent(sessionId, input);
  }

  addArtifact(sessionId: string, input: StubArtifactInput): ArkArtifact {
    this.requireSession(sessionId);
    const artifact: ArkArtifact = {
      id: `artifact-${++this.counters.artifact}`,
      sessionId,
      name: input.name,
      contentType: input.contentType,
      size: input.bytes.byteLength,
      createdAt: this.now().toISOString(),
    };
    this.artifacts.get(sessionId)?.push(artifact);
    return structuredClone(artifact);
  }

  private record(
    operation: ArkOperation,
    input: object,
    options?: ArkRequestOptions,
  ): void {
    const call: ArkCall = {
      operation,
      input: structuredClone(input) as Record<string, unknown>,
    };
    if (options?.correlationId !== undefined) {
      call.correlationId = options.correlationId;
    }
    if (options?.idempotencyKey !== undefined) {
      call.idempotencyKey = options.idempotencyKey;
    }
    this.calls.push(call);
    const failure = this.failures.get(operation)?.shift();
    if (!failure) return;
    if (failure === "connection_failure") {
      throw new ArkGatewayError(
        safeOperations.has(operation) ? "unavailable" : "unknown_write_outcome",
      );
    }
    throw new ArkGatewayError(failure);
  }

  private requireAgent(agentId: string): ArkAgent {
    const agent = this.agents.get(agentId);
    if (!agent) throw new ArkGatewayError("not_found");
    return agent;
  }

  private requireSession(sessionId: string): ArkSession {
    const session = this.sessions.get(sessionId);
    if (!session) throw new ArkGatewayError("not_found");
    return session;
  }

  private publish(sessionId: string, event: ArkEvent): void {
    for (const subscriber of this.subscribers.get(sessionId) ?? []) {
      subscriber.events.push(event);
      subscriber.notify?.();
      subscriber.notify = undefined;
    }
  }

  private appendEvent(sessionId: string, input: StubEventInput): ArkEvent {
    const event: ArkEvent = {
      id: `event-${++this.counters.event}`,
      type: input.type,
      createdAt: this.now().toISOString(),
      data: structuredClone(input.data),
    };
    this.events.get(sessionId)?.push(event);
    this.publish(sessionId, event);
    return structuredClone(event);
  }
}
