import { createHash } from "node:crypto";
import { ArkGatewayError, type ArkErrorCategory } from "./errors.js";
import type {
  ArkAgent,
  ArkAgentInput,
  ArkAgentUpdate,
  ArkSkillBindingInput,
  ArkArtifact,
  ArkCall,
  ArkEvent,
  ArkEventInput,
  ArkFile,
  ArkFileInput,
  ArkFileResourceInput,
  ArkGateway,
  ArkDream,
  ArkDreamInput,
  ArkMemory,
  ArkMemoryInput,
  ArkMemoryStore,
  ArkMemoryStoreInput,
  ArkOperation,
  ArkRequestOptions,
  ArkResource,
  ArkSession,
  ArkSessionInput,
  ArkSkill,
  ArkSkillInput,
  SessionStatus,
} from "./types.js";

/** The bucket the stub pretends Ark exported into; mirrors the real `tos.bucket`. */
export const stubExportBucket = "ark-exports";

function slugifySkillName(source: string): string {
  const slug = source
    .toLowerCase()
    .replace(/\.zip$/i, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return slug || "skill";
}

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
  // Real tool_use events use their own id as the call id that tool_result back-references.
  id?: string;
  createdAt?: string;
}

const safeOperations = new Set<ArkOperation>([
  "getMemoryStore",
  "listMemories",
  "getMemory",
  "getDream",
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
  private readonly agentSkills = new Map<string, ArkSkillBindingInput[]>();
  private readonly skills = new Map<string, ArkSkill>();
  private readonly sessions = new Map<string, ArkSession>();
  private readonly sessionsByCreateIdempotencyKey = new Map<string, string>();
  private readonly events = new Map<string, ArkEvent[]>();
  private readonly files = new Map<string, ArkFile>();
  private readonly fileBytes = new Map<string, Uint8Array>();
  private readonly resources = new Map<string, ArkResource[]>();
  private readonly artifacts = new Map<string, ArkArtifact[]>();
  private readonly subscribers = new Map<string, Set<Subscriber>>();
  private readonly failures = new Map<ArkOperation, InjectedFailure[]>();
  private readonly memoryStores = new Map<string, ArkMemoryStore>();
  private readonly memories = new Map<string, Map<string, ArkMemory>>();
  private readonly dreams = new Map<string, ArkDream>();
  private counters = {
    agent: 0,
    session: 0,
    event: 0,
    file: 0,
    resource: 0,
    artifact: 0,
    skill: 0,
    memoryStore: 0,
    memory: 0,
    memoryVersion: 0,
    dream: 0,
  };

  constructor(options: InMemoryArkGatewayOptions = {}) {
    this.now = options.now ?? (() => new Date());
  }

  failNext(operation: ArkOperation, failure: InjectedFailure): void {
    const failures = this.failures.get(operation) ?? [];
    failures.push(failure);
    this.failures.set(operation, failures);
  }

  async createMemoryStore(
    input: ArkMemoryStoreInput,
    options?: ArkRequestOptions,
  ): Promise<ArkMemoryStore> {
    this.record("createMemoryStore", input, options);
    if (
      !input.name.trim() ||
      [...input.name].length > 64 ||
      Buffer.byteLength(input.description ?? "", "utf8") > 2048
    ) {
      throw new ArkGatewayError("invalid_response");
    }
    return structuredClone(this.newMemoryStore(input.name));
  }

  async getMemoryStore(
    memoryStoreId: string,
    options?: ArkRequestOptions,
  ): Promise<ArkMemoryStore> {
    this.record("getMemoryStore", { memoryStoreId }, options);
    return structuredClone(this.requireMemoryStore(memoryStoreId));
  }

  async deleteMemoryStore(
    memoryStoreId: string,
    options?: ArkRequestOptions,
  ): Promise<void> {
    this.record("deleteMemoryStore", { memoryStoreId }, options);
    this.requireMemoryStore(memoryStoreId);
    this.memoryStores.delete(memoryStoreId);
    this.memories.delete(memoryStoreId);
  }

  async listMemories(
    memoryStoreId: string,
    options?: ArkRequestOptions,
  ): Promise<ArkMemory[]> {
    this.record("listMemories", { memoryStoreId }, options);
    this.requireMemoryStore(memoryStoreId);
    return structuredClone(
      [...this.memories.get(memoryStoreId)!.values()].sort((a, b) =>
        a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
      ),
    );
  }

  async getMemory(
    memoryStoreId: string,
    memoryId: string,
    options?: ArkRequestOptions,
  ): Promise<ArkMemory> {
    this.record("getMemory", { memoryStoreId, memoryId }, options);
    return structuredClone(this.requireMemory(memoryStoreId, memoryId));
  }

  async createMemory(
    memoryStoreId: string,
    input: ArkMemoryInput,
    options?: ArkRequestOptions,
  ): Promise<ArkMemory> {
    this.record("createMemory", { memoryStoreId, ...input }, options);
    const store = this.requireMemoryStore(memoryStoreId);
    const memories = this.memories.get(memoryStoreId)!;
    this.validateMemory(input, memories);
    if (memories.size >= 2000) throw new ArkGatewayError("invalid_response");
    const memory = this.newMemory(input);
    memories.set(memory.id, memory);
    store.memoryCount = memories.size;
    store.storageBytes += memory.sizeBytes;
    return structuredClone(memory);
  }

  async updateMemory(
    memoryStoreId: string,
    memoryId: string,
    input: ArkMemoryInput,
    options?: ArkRequestOptions,
  ): Promise<ArkMemory> {
    this.record("updateMemory", { memoryStoreId, memoryId, ...input }, options);
    const original = this.requireMemory(memoryStoreId, memoryId);
    const store = this.requireMemoryStore(memoryStoreId);
    const memories = this.memories.get(memoryStoreId)!;
    this.validateMemory(input, memories, memoryId);
    const updated = this.newMemory(
      input,
      original.path === input.path ? memoryId : undefined,
    );
    memories.delete(memoryId);
    memories.set(updated.id, updated);
    store.storageBytes += updated.sizeBytes - original.sizeBytes;
    return structuredClone(updated);
  }

  async deleteMemory(
    memoryStoreId: string,
    memoryId: string,
    options?: ArkRequestOptions,
  ): Promise<void> {
    this.record("deleteMemory", { memoryStoreId, memoryId }, options);
    const memory = this.requireMemory(memoryStoreId, memoryId);
    const store = this.requireMemoryStore(memoryStoreId);
    this.memories.get(memoryStoreId)!.delete(memoryId);
    store.memoryCount -= 1;
    store.storageBytes -= memory.sizeBytes;
  }

  async createDream(
    input: ArkDreamInput,
    options?: ArkRequestOptions,
  ): Promise<ArkDream> {
    this.record("createDream", input, options);
    if (
      input.sessionIds.length < 1 ||
      input.sessionIds.length > 100 ||
      new Set(input.sessionIds).size !== input.sessionIds.length ||
      input.sessionIds.some((id) => !id.trim()) ||
      !input.modelId.trim() ||
      [...input.instructions].length > 4096
    ) {
      throw new ArkGatewayError("invalid_response");
    }
    this.requireMemoryStore(input.memoryStoreId);
    for (const id of input.sessionIds) this.requireSession(id);
    const output = this.newMemoryStore("dream-curated-memory");
    const dream: ArkDream = {
      id: `dream-${++this.counters.dream}`,
      status: "pending",
      outputMemoryStoreId: output.id,
      usage: null,
    };
    this.dreams.set(dream.id, dream);
    return structuredClone(dream);
  }

  async getDream(
    dreamId: string,
    options?: ArkRequestOptions,
  ): Promise<ArkDream> {
    this.record("getDream", { dreamId }, options);
    return structuredClone(this.requireDream(dreamId));
  }

  async cancelDream(
    dreamId: string,
    options?: ArkRequestOptions,
  ): Promise<ArkDream> {
    this.record("cancelDream", { dreamId }, options);
    const dream = this.requireDream(dreamId);
    if (dream.status === "completed" || dream.status === "failed") {
      throw new ArkGatewayError("invalid_response");
    }
    dream.status = "canceled";
    return structuredClone(dream);
  }

  setDreamResult(
    dreamId: string,
    outputStoreId: string,
    status: ArkDream["status"] = "completed",
  ): void {
    const dream = this.requireDream(dreamId);
    if (!this.memoryStores.has(outputStoreId))
      throw new ArkGatewayError("not_found");
    dream.outputMemoryStoreId = outputStoreId;
    dream.status = status;
  }

  private newMemoryStore(name: string): ArkMemoryStore {
    const store = {
      id: `memstore-${++this.counters.memoryStore}`,
      name,
      memoryCount: 0,
      storageBytes: 0,
    };
    this.memoryStores.set(store.id, store);
    this.memories.set(store.id, new Map());
    return store;
  }

  private requireMemoryStore(memoryStoreId: string): ArkMemoryStore {
    const store = this.memoryStores.get(memoryStoreId);
    if (!store) throw new ArkGatewayError("not_found");
    for (const dream of this.dreams.values()) {
      if (
        dream.outputMemoryStoreId === memoryStoreId &&
        (dream.status === "pending" || dream.status === "running")
      ) {
        throw new ArkGatewayError("runtime_busy");
      }
    }
    return store;
  }

  private requireMemory(memoryStoreId: string, memoryId: string): ArkMemory {
    this.requireMemoryStore(memoryStoreId);
    const memory = this.memories.get(memoryStoreId)!.get(memoryId);
    if (!memory) throw new ArkGatewayError("not_found");
    return memory;
  }

  private requireDream(dreamId: string): ArkDream {
    const dream = this.dreams.get(dreamId);
    if (!dream) throw new ArkGatewayError("not_found");
    return dream;
  }

  private validateMemory(
    input: ArkMemoryInput,
    memories: Map<string, ArkMemory>,
    excludeId?: string,
  ): void {
    const segments = input.path.slice(1).split("/");
    if (
      !input.path.startsWith("/") ||
      !/\.(md|txt)$/.test(input.path) ||
      Buffer.byteLength(input.path, "utf8") > 1024 ||
      [...input.path].some(
        (character) =>
          character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
      ) ||
      /[%;?]/.test(input.path) ||
      segments.some(
        (segment) => !segment || segment === "." || segment === "..",
      ) ||
      Buffer.from(input.path, "utf8").toString("utf8") !== input.path ||
      Buffer.from(input.content, "utf8").toString("utf8") !== input.content ||
      Buffer.byteLength(input.content, "utf8") > 102400 ||
      [...memories.values()].some(
        (memory) => memory.id !== excludeId && memory.path === input.path,
      )
    ) {
      throw new ArkGatewayError("invalid_response");
    }
  }

  private newMemory(input: ArkMemoryInput, id?: string): ArkMemory {
    return {
      ...input,
      id: id ?? `mem-${++this.counters.memory}`,
      contentSha256: createHash("sha256")
        .update(input.content, "utf8")
        .digest("hex"),
      memoryVersionId: `memversion-${++this.counters.memoryVersion}`,
      sizeBytes: Buffer.byteLength(input.content, "utf8"),
    };
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
    this.requireSkills(input.skills);
    const agent = {
      ...input,
      id: `agent-${++this.counters.agent}`,
      version: 1,
    };
    this.agents.set(agent.id, agent);
    this.agentSkills.set(agent.id, structuredClone(input.skills ?? []));
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
    this.requireSkills(input.skills);
    const updated = {
      id: current.id,
      version: current.version + 1,
      name: input.name,
      description: input.description,
      modelId: input.modelId,
      systemPrompt: input.systemPrompt,
    };
    this.agents.set(agentId, updated);
    if (input.skills !== undefined) {
      this.agentSkills.set(agentId, structuredClone(input.skills));
    }
    return structuredClone(updated);
  }

  async deleteAgent(
    agentId: string,
    options?: ArkRequestOptions,
  ): Promise<void> {
    this.record("deleteAgent", { agentId }, options);
    this.requireAgent(agentId);
    this.agents.delete(agentId);
    this.agentSkills.delete(agentId);
  }

  /**
   * Test seam: the Skill ids an Agent carries, mirroring what Ark would
   * resolve for a Session it opens with that Agent.
   */
  agentSkillIds(agentId: string): string[] {
    this.requireAgent(agentId);
    return (this.agentSkills.get(agentId) ?? []).map(
      (binding) => binding.skillId,
    );
  }

  async createSkill(
    input: ArkSkillInput,
    options?: ArkRequestOptions,
  ): Promise<ArkSkill> {
    this.record(
      "createSkill",
      {
        name: input.file.name,
        contentType: input.file.contentType,
        size: input.file.bytes.byteLength,
        displayTitle: input.displayTitle,
      },
      options,
    );
    const skill: ArkSkill = {
      id: `skill-${++this.counters.skill}`,
      name: slugifySkillName(input.displayTitle ?? input.file.name),
      displayTitle: input.displayTitle ?? "",
      description: "",
      latestVersion: "1",
      source: "custom",
    };
    this.skills.set(skill.id, skill);
    return structuredClone(skill);
  }

  async getSkill(
    skillId: string,
    options?: ArkRequestOptions,
  ): Promise<ArkSkill> {
    this.record("getSkill", { skillId }, options);
    const skill = this.skills.get(skillId);
    if (!skill) throw new ArkGatewayError("not_found");
    return structuredClone(skill);
  }

  private requireSkills(input: ArkAgentInput["skills"]): void {
    for (const binding of input ?? []) {
      if (!this.skills.has(binding.skillId)) {
        throw new ArkGatewayError("not_found");
      }
    }
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
      if ("type" in resource) {
        this.requireMemoryStore(resource.memoryStoreId);
      } else if (!this.files.has(resource.fileId)) {
        throw new ArkGatewayError("not_found");
      }
    }
    const session: ArkSession = {
      id: `session-${++this.counters.session}`,
      agentId: input.agentId,
      agentVersion: input.agentVersion,
      environmentId: input.environmentId,
      status: "idle",
      configSnapshot: {
        modelId: agent.modelId,
        skills: (this.agentSkills.get(agent.id) ?? []).map((binding) => {
          const skill = this.skills.get(binding.skillId)!;
          return {
            type: skill.source,
            skillId: binding.skillId,
            version: binding.version ?? skill.latestVersion,
            useLatest: binding.version === undefined,
            displayName: skill.displayTitle,
          };
        }),
        tools: [],
        environment: {
          id: input.environmentId,
          type: null,
          configType: null,
          scope: null,
        },
        completeness: "incomplete",
      },
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
      input.resources
        .filter(
          (resource): resource is ArkFileResourceInput => !("type" in resource),
        )
        .map((resource) => ({
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
    for (const artifact of this.artifacts.get(sessionId) ?? []) {
      this.fileBytes.delete(artifact.id);
    }
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

  async streamEvents(
    sessionId: string,
    options?: ArkRequestOptions,
  ): Promise<AsyncIterable<ArkEvent>> {
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

    return {
      async *[Symbol.asyncIterator]() {
        try {
          while (!subscriber.closed && !options?.signal?.aborted) {
            if (subscriber.events.length === 0) {
              const onAbort = () => subscriber.notify?.();
              await new Promise<void>((resolve) => {
                subscriber.notify = resolve;
                options?.signal?.addEventListener("abort", onAbort, {
                  once: true,
                });
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
      },
    };
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
    this.fileBytes.set(file.id, new Uint8Array(input.bytes));
    return structuredClone(file);
  }

  async deleteFile(fileId: string, options?: ArkRequestOptions): Promise<void> {
    this.record("deleteFile", { fileId }, options);
    if (!this.files.has(fileId) && !this.fileBytes.has(fileId)) {
      throw new ArkGatewayError("not_found");
    }
    this.files.delete(fileId);
    this.fileBytes.delete(fileId);
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
        status === "terminated" ||
        status === "initializing" ||
        status === "upgrading" ||
        status === "failed"
      ) {
        session.status = status;
      } else if (status === "rescheduling") {
        session.status = "rescheduled";
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
      tos: {
        bucket: stubExportBucket,
        objectKey: `ark_ma/outputs/${sessionId}/${input.name}`,
      },
    };
    this.artifacts.get(sessionId)?.push(artifact);
    this.fileBytes.set(artifact.id, new Uint8Array(input.bytes));
    return structuredClone(artifact);
  }

  /**
   * Test hook: the bytes and TOS location the stub pretends Ark exported, so a
   * harness can prime whichever storage it wires up.
   */
  artifactExport(
    artifactId: string,
  ): { bucket: string; objectKey: string; bytes: Uint8Array } | undefined {
    const bytes = this.fileBytes.get(artifactId);
    if (!bytes) return undefined;
    for (const artifacts of this.artifacts.values()) {
      const artifact = artifacts.find(
        (candidate) => candidate.id === artifactId,
      );
      if (artifact?.tos) {
        return {
          bucket: artifact.tos.bucket,
          objectKey: artifact.tos.objectKey,
          bytes,
        };
      }
    }
    return undefined;
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
      id: input.id ?? `event-${++this.counters.event}`,
      type: input.type,
      createdAt: input.createdAt ?? this.now().toISOString(),
      data: structuredClone(input.data),
    };
    this.events.get(sessionId)?.push(event);
    this.publish(sessionId, event);
    return structuredClone(event);
  }
}
