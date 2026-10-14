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
  ArkDream,
  ArkDreamInput,
  ArkMemory,
  ArkMemoryInput,
  ArkMemoryStore,
  ArkMemoryStoreInput,
  ArkRequestOptions,
  ArkResource,
  ArkSession,
  ArkSessionConfigSnapshot,
  ArkSessionInput,
  ArkSkill,
  ArkSkillInput,
} from "./types.js";

const agentSchema = z
  .object({
    id: z.string().min(1),
    version: z.number().int().positive(),
    name: z.string(),
    description: z.string().optional(),
    model: z.object({ id: z.string().min(1) }).passthrough(),
  })
  .passthrough();

type ArkAgentResponse = z.infer<typeof agentSchema>;

/**
 * Ark v3 agents use `model: {id}` and never return the instructions, so the
 * write body maps our camel-case config onto the upstream shape and the write
 * response re-attaches the `systemPrompt` we just sent. Skill bindings follow
 * the managed-agents wire format: an omitted `skills` key leaves the upstream
 * binding untouched, while an explicit array (even empty) replaces it.
 */
function arkAgentWriteBody(input: ArkAgentInput): Record<string, unknown> {
  return {
    name: input.name,
    description: input.description,
    model: { id: input.modelId },
    instructions: input.systemPrompt,
    ...(input.toolsetId !== undefined ? { toolsetId: input.toolsetId } : {}),
    ...(input.toolPermission !== undefined
      ? { toolPermission: input.toolPermission }
      : {}),
    ...(input.skills !== undefined
      ? {
          skills: input.skills.map((skill) => ({
            type: "custom",
            skill_id: skill.skillId,
            ...(skill.version !== undefined ? { version: skill.version } : {}),
          })),
        }
      : {}),
  };
}

function toArkAgent(response: ArkAgentResponse, written?: ArkAgentInput) {
  return {
    id: response.id,
    version: response.version,
    name: response.name,
    description: response.description ?? "",
    modelId: response.model.id,
    ...(written ? { systemPrompt: written.systemPrompt } : {}),
  };
}

const sessionStatusSchema = z
  .enum([
    "idle",
    "running",
    "rescheduled",
    "rescheduling",
    "terminated",
    "initializing",
    "upgrading",
    "failed",
  ])
  .transform((status) =>
    status === "rescheduling" ? ("rescheduled" as const) : status,
  );

type NormalizedOptional<T> = {
  value: T | null;
  valid: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalField<T>(
  record: Record<string, unknown>,
  key: string,
  predicate: (value: unknown) => value is T,
): NormalizedOptional<T> {
  const value = record[key];
  if (value === undefined) return { value: null, valid: true };
  return predicate(value)
    ? { value, valid: true }
    : { value: null, valid: false };
}

function requiredField<T>(
  record: Record<string, unknown>,
  key: string,
  predicate: (value: unknown) => value is T,
): NormalizedOptional<T> {
  const value = record[key];
  return predicate(value)
    ? { value, valid: true }
    : { value: null, valid: false };
}

const isString = (value: unknown): value is string => typeof value === "string";
const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;
const isBoolean = (value: unknown): value is boolean =>
  typeof value === "boolean";

function skillSnapshots(value: unknown): {
  value: ArkSessionConfigSnapshot["skills"];
  valid: boolean;
} {
  if (!Array.isArray(value)) return { value: null, valid: false };
  let valid = true;
  const skills = value.map((item) => {
    if (!isRecord(item)) {
      valid = false;
      return {
        type: null,
        skillId: null,
        version: null,
        useLatest: null,
        displayName: null,
      };
    }
    const type = optionalField(item, "type", isNonEmptyString);
    const skillId = requiredField(item, "skill_id", isNonEmptyString);
    const version = optionalField(item, "version", isNonEmptyString);
    const useLatest = optionalField(item, "use_latest", isBoolean);
    const displayName = optionalField(item, "display_name", isString);
    valid =
      valid &&
      type.valid &&
      skillId.valid &&
      version.valid &&
      useLatest.valid &&
      displayName.valid;
    return {
      type: type.value,
      skillId: skillId.value,
      version: version.value,
      useLatest: useLatest.value,
      displayName: displayName.value,
    };
  });
  return { value: skills, valid };
}

function configuredToolNames(
  tool: Record<string, unknown>,
): NormalizedOptional<string[]> {
  const configs = tool.configs;
  if (configs === undefined) return { value: null, valid: true };
  if (!Array.isArray(configs)) return { value: null, valid: false };
  const names: string[] = [];
  for (const config of configs) {
    if (!isRecord(config) || !isNonEmptyString(config.name)) {
      return { value: null, valid: false };
    }
    names.push(config.name);
  }
  return { value: names, valid: true };
}

function toolSnapshots(value: unknown): {
  value: ArkSessionConfigSnapshot["tools"];
  valid: boolean;
} {
  if (!Array.isArray(value)) return { value: null, valid: false };
  let valid = true;
  const tools = value.map((item) => {
    if (!isRecord(item)) {
      valid = false;
      return {
        type: null,
        name: null,
        mcpServerName: null,
        configuredToolNames: null,
      };
    }
    const type = requiredField(item, "type", isNonEmptyString);
    const name = optionalField(item, "name", isNonEmptyString);
    const mcpServerName = optionalField(
      item,
      "mcp_server_name",
      isNonEmptyString,
    );
    const configuredNames = configuredToolNames(item);
    valid =
      valid &&
      type.valid &&
      name.valid &&
      mcpServerName.valid &&
      configuredNames.valid;
    return {
      type: type.value,
      name: name.value,
      mcpServerName: mcpServerName.value,
      configuredToolNames: configuredNames.value,
    };
  });
  return { value: tools, valid };
}

function sessionConfigSnapshot(
  agent: Record<string, unknown>,
  environmentValue: unknown,
): ArkSessionConfigSnapshot {
  const model =
    isRecord(agent.model) && isNonEmptyString(agent.model.id)
      ? { value: agent.model.id, valid: true }
      : { value: null, valid: false };
  const skills = skillSnapshots(agent.skills);
  const tools = toolSnapshots(agent.tools);
  const environment = isRecord(environmentValue) ? environmentValue : {};
  const config = isRecord(environment.config) ? environment.config : {};
  const scope = optionalField(environment, "scope", isNonEmptyString);
  const environmentSnapshot = {
    id: isNonEmptyString(environment.id) ? environment.id : null,
    type: isNonEmptyString(environment.type) ? environment.type : null,
    configType: isNonEmptyString(config.type) ? config.type : null,
    scope: scope.value,
  };
  // Scope is descriptive metadata omitted by live Session snapshots. Keep
  // absence honest without treating it as a missing environment identity.
  const environmentComplete =
    scope.valid &&
    [
      environmentSnapshot.id,
      environmentSnapshot.type,
      environmentSnapshot.configType,
    ].every((field) => field !== null);

  return {
    modelId: model.value,
    skills: skills.value,
    tools: tools.value,
    environment: environmentSnapshot,
    completeness:
      model.valid && skills.valid && tools.valid && environmentComplete
        ? "complete"
        : "incomplete",
  };
}

const normalizedSessionSchema = z
  .object({
    id: z.string().min(1),
    agentId: z.string().min(1),
    agentVersion: z.number().int().positive(),
    environmentId: z.string().min(1),
    status: sessionStatusSchema,
  })
  .strict()
  .transform((session) => ({
    ...session,
    configSnapshot: {
      modelId: null,
      skills: null,
      tools: null,
      environment: {
        id: session.environmentId,
        type: null,
        configType: null,
        scope: null,
      },
      completeness: "incomplete" as const,
    },
  }));

const sessionSchema = z.union([
  normalizedSessionSchema,
  z
    .object({
      id: z.string().min(1),
      agent: z
        .object({
          id: z.string().min(1),
          version: z.number().int().positive(),
        })
        .passthrough(),
      environment_id: z.string().min(1),
      environment: z.unknown().optional(),
      status: sessionStatusSchema,
    })
    .passthrough()
    .transform(({ id, agent, environment_id, environment, status }) => ({
      id,
      agentId: agent.id,
      agentVersion: agent.version,
      environmentId: environment_id,
      status,
      configSnapshot: sessionConfigSnapshot(agent, environment),
    })),
]);

const eventSchema = z
  .object({
    id: z.string().min(1),
    type: z.string().min(1),
    createdAt: z.string().datetime(),
    data: z.record(z.string(), z.unknown()),
  })
  .strict();

const arkTimestampSchema = z
  .string()
  .refine((value) => !Number.isNaN(Date.parse(value)))
  .transform((value) => new Date(value).toISOString());

function normalizeEventData(
  data: Record<string, unknown>,
): Record<string, unknown> {
  if (!Array.isArray(data.content)) return data;
  const text = data.content
    .filter(
      (block): block is { type: "text"; text: string } =>
        typeof block === "object" &&
        block !== null &&
        "type" in block &&
        block.type === "text" &&
        "text" in block &&
        typeof block.text === "string",
    )
    .map((block) => block.text)
    .join("");
  return { ...data, content: text };
}

const persistedEventSchema = z
  .object({
    id: z.string().min(1),
    type: z.string().min(1),
    processed_at: arkTimestampSchema,
  })
  .passthrough()
  .transform(({ id, type, processed_at, ...data }) => ({
    id,
    type,
    createdAt: processed_at,
    data: normalizeEventData(data),
  }));

const eventPageDataSchema = z.union([
  z.array(eventSchema),
  z.array(persistedEventSchema),
]);

const eventPageSchema = z.union([
  eventPageDataSchema.transform((data) => ({ data, nextPage: null })),
  z
    .object({
      data: z.array(persistedEventSchema),
      next_page: z.string().nullable().optional(),
    })
    .passthrough()
    .transform(({ data, next_page }) => ({
      data,
      nextPage: next_page || null,
    })),
]);

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

const sessionResourceSchema = z.union([
  resourceSchema,
  z
    .object({
      id: z.string().min(1),
      type: z.literal("file"),
      file_id: z.string().min(1),
      mount_path: z.string().min(1),
    })
    .passthrough()
    .transform((resource) => ({
      id: resource.id,
      fileId: resource.file_id,
      mountPath: resource.mount_path,
    })),
  z
    .object({
      type: z.literal("memory_store"),
      memory_store_id: z.string().min(1),
      access: z.enum(["read_write", "read_only"]),
    })
    .passthrough()
    .transform(() => null),
]);

const memoryStoreSchema = z
  .object({
    id: z.string().min(1),
    name: z.string(),
    memory_count: z.number().int().nonnegative(),
    storage_bytes: z.number().int().nonnegative(),
  })
  .passthrough()
  .transform((store) => ({
    id: store.id,
    name: store.name,
    memoryCount: store.memory_count,
    storageBytes: store.storage_bytes,
  }));

const memoryMetadataSchema = z
  .object({
    id: z.string().min(1),
    path: z.string().min(1),
    content_sha256: z.string().regex(/^[a-f0-9]{64}$/),
    memory_version_id: z.string().min(1),
    content_size_bytes: z.number().int().nonnegative(),
  })
  .passthrough();

function toArkMemory(
  memory: z.infer<typeof memoryMetadataSchema>,
  content: string,
): ArkMemory {
  return {
    id: memory.id,
    path: memory.path,
    content,
    contentSha256: memory.content_sha256,
    memoryVersionId: memory.memory_version_id,
    sizeBytes: memory.content_size_bytes,
  };
}

const memorySchema = memoryMetadataSchema
  .extend({
    content: z.string(),
  })
  .transform((memory) => toArkMemory(memory, memory.content));

// jsonRequest unwraps data-only envelopes, including the final list page.
const memoryPageSchema = z.union([
  z.array(memoryMetadataSchema).transform((data) => ({ data, nextPage: null })),
  z
    .object({
      data: z.array(memoryMetadataSchema),
      next_page: z.string().nullish(),
    })
    .passthrough()
    .transform(({ data, next_page }) => ({
      data,
      nextPage: next_page || null,
    })),
]);

const dreamSchema = z
  .object({
    id: z.string().min(1),
    status: z.enum(["pending", "running", "completed", "failed", "canceled"]),
    outputs: z
      .array(
        z
          .object({
            type: z.literal("memory_store"),
            memory_store_id: z.string().min(1),
          })
          .passthrough(),
      )
      .nullish(),
    usage: z.record(z.string(), z.unknown()).nullish(),
  })
  .passthrough()
  .transform((dream) => ({
    id: dream.id,
    status: dream.status,
    outputMemoryStoreId: dream.outputs?.[0]?.memory_store_id ?? null,
    usage: dream.usage ?? null,
  }));

/**
 * Skill responses tolerate Ark's evolving shape: `latest_version` started as a
 * numeric placeholder before version management shipped and may arrive as a
 * scalar or a `{version}` object; `display_title`/`description` are optional.
 */
const skillSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().optional(),
    display_title: z.string().optional(),
    description: z.string().optional(),
    latest_version: z
      .union([
        z.number(),
        z.string(),
        z
          .object({ version: z.union([z.number(), z.string()]) })
          .passthrough()
          .transform(({ version }) => version),
      ])
      .optional(),
    source: z.enum(["custom", "skill_hub"]).optional(),
  })
  .passthrough()
  .transform((skill) => ({
    id: skill.id,
    name: skill.name ?? "",
    displayTitle: skill.display_title ?? "",
    description: skill.description ?? "",
    latestVersion:
      skill.latest_version === undefined ? "1" : String(skill.latest_version),
    source: skill.source ?? ("custom" as const),
  }));

function toArkSkill(
  response: z.infer<typeof skillSchema>,
  written?: ArkSkillInput,
): ArkSkill {
  return {
    ...response,
    displayTitle: response.displayTitle || written?.displayTitle || "",
  };
}

/**
 * The Files API reports snake_case, seconds-since-epoch timestamps and an
 * optional `tos` location. Unknown keys are deliberately tolerated: Ark adds
 * fields over time, and a strict schema turns an additive change into an
 * outage.
 */
const fileEntrySchema = z.object({
  id: z.string().min(1),
  purpose: z.string(),
  filename: z.string(),
  bytes: z.number().int().nonnegative(),
  mime_type: z.string(),
  created_at: z.number(),
  tos: z
    .object({ bucket: z.string().min(1), object_key: z.string().min(1) })
    .nullish(),
  scope: z.object({ type: z.string(), id: z.string() }).nullish(),
});

/** Empty Files inventories can be JSON null or an envelope with data:null.
 * Keep the page envelope so optional pagination fields remain meaningful. */
const filePageSchema = z.union([
  z.null().transform(() => ({
    files: [] as z.infer<typeof fileEntrySchema>[],
    hasMore: false,
    lastId: null,
  })),
  z
    .object({
      data: z.array(fileEntrySchema).nullable(),
      has_more: z.boolean().nullish(),
      last_id: z.string().nullish(),
    })
    .transform(({ data, has_more, last_id }) => ({
      files: data ?? [],
      hasMore: has_more === true,
      lastId: last_id ?? null,
    })),
]);

type FileEntry = z.infer<typeof fileEntrySchema>;

/** Guards against a pagination loop if Ark ever echoes a cursor we already used. */
const maxFilePages = 20;
const filePageLimit = 100;

function toArkArtifact(entry: FileEntry, sessionId: string): ArkArtifact {
  return {
    id: entry.id,
    sessionId,
    name: entry.filename,
    contentType: entry.mime_type,
    size: entry.bytes,
    createdAt: new Date(entry.created_at * 1000).toISOString(),
    tos: entry.tos
      ? { bucket: entry.tos.bucket, objectKey: entry.tos.object_key }
      : null,
  };
}

/**
 * Exports are the files Ark scoped to this Session. Uploaded inputs carry the
 * same `purpose` but no Session scope, and files belonging to another Session
 * are excluded rather than trusted to the query filter.
 */
function isSessionExport(entry: FileEntry, sessionId: string): boolean {
  return (
    entry.purpose === "agent" &&
    entry.scope?.type === "session" &&
    entry.scope.id === sessionId
  );
}

const errorBodySchema = z
  .object({
    code: z.string().optional(),
    message: z.string().optional(),
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

  createMemoryStore(
    input: ArkMemoryStoreInput,
    options?: ArkRequestOptions,
  ): Promise<ArkMemoryStore> {
    return this.jsonRequest({
      method: "POST",
      path: "/api/v3/memory_stores",
      safe: false,
      body: JSON.stringify(input),
      contentType: "application/json",
      schema: memoryStoreSchema,
      options,
    });
  }

  getMemoryStore(
    memoryStoreId: string,
    options?: ArkRequestOptions,
  ): Promise<ArkMemoryStore> {
    return this.jsonRequest({
      method: "GET",
      path: this.memoryStorePath(memoryStoreId),
      safe: true,
      schema: memoryStoreSchema,
      options,
    });
  }

  async deleteMemoryStore(
    memoryStoreId: string,
    options?: ArkRequestOptions,
  ): Promise<void> {
    await this.request(
      {
        method: "DELETE",
        path: this.memoryStorePath(memoryStoreId),
        safe: false,
        options,
      },
      async () => undefined,
    );
  }

  async listMemories(
    memoryStoreId: string,
    options?: ArkRequestOptions,
  ): Promise<ArkMemory[]> {
    const ids: string[] = [];
    const seenPages = new Set<string>();
    let page: string | null = null;
    do {
      const query = new URLSearchParams({ limit: "100", order_by: "path" });
      if (page) query.set("page", page);
      const result: z.infer<typeof memoryPageSchema> = await this.jsonRequest({
        method: "GET",
        path: `${this.memoryStorePath(memoryStoreId)}/memories?${query}`,
        safe: true,
        schema: memoryPageSchema,
        options,
      });
      ids.push(...result.data.map((memory) => memory.id));
      page = result.nextPage;
      if (page && seenPages.has(page))
        throw new ArkGatewayError("invalid_response");
      if (page) seenPages.add(page);
    } while (page);
    const memories: ArkMemory[] = [];
    for (const id of ids)
      memories.push(await this.getMemory(memoryStoreId, id, options));
    return memories;
  }

  getMemory(
    memoryStoreId: string,
    memoryId: string,
    options?: ArkRequestOptions,
  ): Promise<ArkMemory> {
    return this.jsonRequest({
      method: "GET",
      path: this.memoryPath(memoryStoreId, memoryId),
      safe: true,
      schema: memorySchema,
      options,
    });
  }

  createMemory(
    memoryStoreId: string,
    input: ArkMemoryInput,
    options?: ArkRequestOptions,
  ): Promise<ArkMemory> {
    return this.writeMemory(
      `${this.memoryStorePath(memoryStoreId)}/memories`,
      input,
      options,
    );
  }

  updateMemory(
    memoryStoreId: string,
    memoryId: string,
    input: ArkMemoryInput,
    options?: ArkRequestOptions,
  ): Promise<ArkMemory> {
    return this.writeMemory(
      this.memoryPath(memoryStoreId, memoryId),
      input,
      options,
    );
  }

  async deleteMemory(
    memoryStoreId: string,
    memoryId: string,
    options?: ArkRequestOptions,
  ): Promise<void> {
    await this.request(
      {
        method: "DELETE",
        path: this.memoryPath(memoryStoreId, memoryId),
        safe: false,
        options,
      },
      async () => undefined,
    );
  }

  createDream(
    input: ArkDreamInput,
    options?: ArkRequestOptions,
  ): Promise<ArkDream> {
    return this.jsonRequest({
      method: "POST",
      path: "/api/v3/dreams",
      safe: false,
      body: JSON.stringify({
        inputs: [
          { type: "memory_store", memory_store_id: input.memoryStoreId },
          { type: "sessions", session_ids: input.sessionIds },
        ],
        model: input.modelId,
        instructions: input.instructions,
        output_memory_store_name: "dream-curated-memory",
      }),
      contentType: "application/json",
      schema: dreamSchema,
      options,
    });
  }

  getDream(dreamId: string, options?: ArkRequestOptions): Promise<ArkDream> {
    return this.jsonRequest({
      method: "GET",
      path: `/api/v3/dreams/${encodeURIComponent(dreamId)}`,
      safe: true,
      schema: dreamSchema,
      options,
    });
  }

  cancelDream(dreamId: string, options?: ArkRequestOptions): Promise<ArkDream> {
    return this.jsonRequest({
      method: "POST",
      path: `/api/v3/dreams/${encodeURIComponent(dreamId)}/cancel`,
      safe: false,
      body: "{}",
      contentType: "application/json",
      schema: dreamSchema,
      options,
    });
  }

  private memoryStorePath(memoryStoreId: string): string {
    return `/api/v3/memory_stores/${encodeURIComponent(memoryStoreId)}`;
  }

  private memoryPath(memoryStoreId: string, memoryId: string): string {
    return `${this.memoryStorePath(memoryStoreId)}/memories/${encodeURIComponent(memoryId)}`;
  }

  private writeMemory(
    path: string,
    input: ArkMemoryInput,
    options?: ArkRequestOptions,
  ): Promise<ArkMemory> {
    // Write responses contain metadata only; echo the content accepted by this write.
    return this.jsonRequest({
      method: "POST",
      path,
      safe: false,
      body: JSON.stringify({ path: input.path, content: input.content }),
      contentType: "application/json",
      schema: memoryMetadataSchema,
      options,
    }).then((memory) => toArkMemory(memory, input.content));
  }

  createAgent(
    input: ArkAgentInput,
    options?: ArkRequestOptions,
  ): Promise<ArkAgent> {
    return this.jsonRequest({
      method: "POST",
      path: "/api/v3/agents",
      safe: false,
      body: JSON.stringify(arkAgentWriteBody(input)),
      contentType: "application/json",
      schema: agentSchema,
      options,
    }).then((response) => toArkAgent(response, input));
  }

  getAgent(agentId: string, options?: ArkRequestOptions): Promise<ArkAgent> {
    return this.jsonRequest({
      method: "GET",
      path: `/api/v3/agents/${encodeURIComponent(agentId)}`,
      safe: true,
      schema: agentSchema,
      options,
    }).then((response) => toArkAgent(response));
  }

  updateAgent(
    agentId: string,
    input: ArkAgentUpdate,
    options?: ArkRequestOptions,
  ): Promise<ArkAgent> {
    return this.jsonRequest({
      method: "POST",
      path: `/api/v3/agents/${encodeURIComponent(agentId)}`,
      safe: false,
      body: JSON.stringify({
        ...arkAgentWriteBody(input),
        version: input.currentVersion,
      }),
      contentType: "application/json",
      schema: agentSchema,
      options,
    }).then((response) => toArkAgent(response, input));
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
    if (!Number.isInteger(input.agentVersion) || input.agentVersion <= 0) {
      return Promise.reject(new ArkGatewayError("invalid_response"));
    }
    return this.jsonRequest({
      method: "POST",
      path: "/api/v3/sessions",
      safe: false,
      body: JSON.stringify({
        agent: {
          type: "agent",
          id: input.agentId,
          version: input.agentVersion,
        },
        environment_id: input.environmentId,
        resources: input.resources.map((resource) =>
          "type" in resource
            ? {
                type: "memory_store",
                memory_store_id: resource.memoryStoreId,
                access: resource.access,
              }
            : {
                type: "file",
                file_id: resource.fileId,
                mount_path: resource.mountPath,
              },
        ),
      }),
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
    const submitted =
      event.type === "user.message"
        ? {
            type: event.type,
            content: [
              {
                type: "text",
                text:
                  typeof event.data.content === "string"
                    ? event.data.content
                    : "",
              },
            ],
          }
        : { type: event.type };
    return this.jsonRequest({
      method: "POST",
      path: `/api/v3/sessions/${encodeURIComponent(sessionId)}/events`,
      safe: false,
      body: JSON.stringify({ events: [submitted] }),
      contentType: "application/json",
      schema: z.union([
        eventSchema,
        z
          .array(
            z
              .object({
                id: z.string().min(1),
                type: z.string().min(1),
              })
              .passthrough(),
          )
          .min(1)
          .transform((events) => {
            const { id, type, ...data } = events[0]!;
            return {
              id,
              type,
              createdAt: this.now().toISOString(),
              data: normalizeEventData(data),
            };
          }),
      ]),
      options,
    });
  }

  async listEvents(
    sessionId: string,
    options?: ArkRequestOptions,
  ): Promise<ArkEvent[]> {
    const path = `/api/v3/sessions/${encodeURIComponent(sessionId)}/events`;
    const events: ArkEvent[] = [];
    const seenPages = new Set<string>();
    let page: string | null = null;

    do {
      const result: { data: ArkEvent[]; nextPage: string | null } =
        await this.jsonRequest({
          method: "GET",
          path: page ? `${path}?page=${encodeURIComponent(page)}` : path,
          safe: true,
          schema: eventPageSchema,
          options,
        });
      events.push(...result.data);
      page = result.nextPage;
      if (page && seenPages.has(page)) {
        throw new ArkGatewayError("invalid_response");
      }
      if (page) seenPages.add(page);
    } while (page);

    return events;
  }

  async streamEvents(
    sessionId: string,
    options?: ArkRequestOptions,
  ): Promise<AsyncIterable<ArkEvent>> {
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
    const parseSseBlock = (block: string) => this.parseSseBlock(block);

    return {
      async *[Symbol.asyncIterator]() {
        let buffer = "";
        let completed = false;
        try {
          while (true) {
            const { done, value } = await reader.read();
            buffer += value ?? "";
            const blocks = buffer.split(/\r?\n\r?\n/);
            buffer = blocks.pop() ?? "";
            for (const block of blocks) {
              if (block.trim()) yield parseSseBlock(block);
            }
            if (done) {
              if (buffer.trim()) yield parseSseBlock(buffer);
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
              // Preserve the original stream result while releasing resources.
            }
          }
          reader.releaseLock();
          context.cancel();
          context.cleanup();
        }
      },
    };
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

  async deleteFile(fileId: string, options?: ArkRequestOptions): Promise<void> {
    await this.request(
      {
        method: "DELETE",
        path: `/api/v3/files/${encodeURIComponent(fileId)}`,
        safe: false,
        options,
      },
      async () => undefined,
    );
  }

  createSkill(
    input: ArkSkillInput,
    options?: ArkRequestOptions,
  ): Promise<ArkSkill> {
    const form = new FormData();
    form.set(
      "files",
      new Blob([new Uint8Array(input.file.bytes).buffer], {
        type: input.file.contentType,
      }),
      input.file.name,
    );
    if (input.displayTitle !== undefined) {
      form.set("display_title", input.displayTitle);
    }
    return this.jsonRequest({
      method: "POST",
      path: "/api/v3/skills",
      safe: false,
      body: form,
      schema: skillSchema,
      options,
    }).then((response) => toArkSkill(response, input));
  }

  getSkill(skillId: string, options?: ArkRequestOptions): Promise<ArkSkill> {
    return this.jsonRequest({
      method: "GET",
      path: `/api/v3/skills/${encodeURIComponent(skillId)}`,
      safe: true,
      schema: skillSchema,
      options,
    }).then((response) => toArkSkill(response));
  }

  listSessionResources(
    sessionId: string,
    options?: ArkRequestOptions,
  ): Promise<ArkResource[]> {
    return this.jsonRequest({
      method: "GET",
      path: `/api/v3/sessions/${encodeURIComponent(sessionId)}/resources`,
      safe: true,
      schema: z
        .array(sessionResourceSchema)
        .transform((resources) =>
          resources.filter(
            (resource): resource is ArkResource => resource !== null,
          ),
        ),
      options,
    });
  }

  listArtifacts(
    sessionId: string,
    options?: ArkRequestOptions,
  ): Promise<ArkArtifact[]> {
    return this.collectArtifacts(sessionId, options);
  }

  private async collectArtifacts(
    sessionId: string,
    options?: ArkRequestOptions,
  ): Promise<ArkArtifact[]> {
    const artifacts: ArkArtifact[] = [];
    let after: string | null = null;
    for (let page = 0; page < maxFilePages; page += 1) {
      const query = new URLSearchParams({
        scope_id: sessionId,
        limit: String(filePageLimit),
      });
      if (after) query.set("after", after);
      const result = await this.jsonRequest({
        method: "GET",
        path: `/api/v3/files?${query.toString()}`,
        safe: true,
        schema: filePageSchema,
        // Files data-only envelopes are still pages, including {data:null}.
        unwrapData: false,
        options,
      });
      for (const entry of result.files) {
        if (isSessionExport(entry, sessionId)) {
          artifacts.push(toArkArtifact(entry, sessionId));
        }
      }
      if (!result.hasMore || !result.lastId) return artifacts;
      after = result.lastId;
    }
    return artifacts;
  }

  private async jsonRequest<T>(
    definition: RequestDefinition<T> & {
      schema: z.ZodType<T>;
      unwrapData?: boolean;
    },
  ): Promise<T> {
    return this.request(definition, async (response) => {
      const invalidResponse = () =>
        new ArkGatewayError(
          definition.safe ? "invalid_response" : "unknown_write_outcome",
          {
            arkRequestId: response.headers.get("x-request-id") ?? undefined,
          },
        );
      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        throw invalidResponse();
      }
      const unwrapped =
        definition.unwrapData !== false &&
        payload !== null &&
        typeof payload === "object" &&
        "data" in payload &&
        Object.keys(payload).length === 1
          ? (payload as { data: unknown }).data
          : payload;
      const parsed = definition.schema.safeParse(unwrapped);
      if (!parsed.success) {
        throw invalidResponse();
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
    if (definition.options?.idempotencyKey) {
      headers.set("idempotency-key", definition.options.idempotencyKey);
    }
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
    if (
      !safe &&
      error instanceof ArkGatewayError &&
      error.category === "unknown_write_outcome"
    ) {
      return error;
    }
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
    let message: string | undefined;
    try {
      const body: unknown = await response.json();
      // Ark nests its error details under `error`; tolerate both that envelope
      // and a flat body so classification never depends on the shape drift.
      const readError = (value: unknown) => {
        const parsed = errorBodySchema.safeParse(value);
        if (parsed.success && parsed.data.code !== undefined) {
          code = parsed.data.code;
          message = parsed.data.message;
        }
      };
      readError(body);
      if (code === undefined && body !== null && typeof body === "object") {
        readError((body as { error?: unknown }).error);
      }
    } catch {
      // Error bodies are intentionally discarded to avoid leaking upstream data.
    }
    const options = {
      status: response.status,
      arkRequestId: response.headers.get("x-request-id") ?? undefined,
    };
    if (response.status === 429)
      return new ArkGatewayError("rate_limited", options);
    // Ark signals optimistic-concurrency losses as a generic 400 whose message
    // starts with "version:" instead of a dedicated error code.
    if (
      code === "VERSION_CONFLICT" ||
      (message !== undefined && message.startsWith("version:"))
    ) {
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
    let type = "";
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
    const eventData =
      typeof data === "object" && data !== null && !Array.isArray(data)
        ? (data as Record<string, unknown>)
        : undefined;
    const bodyId = eventData?.id;
    const bodyType = eventData?.type;
    const processedAt = eventData?.processed_at;
    const bodyCreatedAt = eventData?.createdAt;
    if (
      (bodyId !== undefined && typeof bodyId !== "string") ||
      (bodyType !== undefined && typeof bodyType !== "string") ||
      (processedAt !== undefined && typeof processedAt !== "string") ||
      (bodyCreatedAt !== undefined && typeof bodyCreatedAt !== "string") ||
      (id && typeof bodyId === "string" && id !== bodyId)
    ) {
      throw new ArkGatewayError("invalid_response");
    }
    const arkCreatedAt =
      typeof processedAt === "string" ? processedAt : bodyCreatedAt;
    const normalizedCreatedAt =
      typeof arkCreatedAt === "string" &&
      !Number.isNaN(Date.parse(arkCreatedAt))
        ? new Date(arkCreatedAt).toISOString()
        : undefined;
    const payload =
      eventData && typeof arkCreatedAt === "string"
        ? Object.fromEntries(
            Object.entries(eventData).filter(
              ([key]) =>
                key !== "id" &&
                key !== "type" &&
                key !== "processed_at" &&
                key !== "createdAt",
            ),
          )
        : data;
    const normalizedPayload =
      typeof payload === "object" && payload !== null && !Array.isArray(payload)
        ? normalizeEventData(payload as Record<string, unknown>)
        : payload;
    const parsed = eventSchema.safeParse({
      id: typeof bodyId === "string" ? bodyId : id,
      type: typeof bodyType === "string" ? bodyType : type || "message",
      createdAt: normalizedCreatedAt ?? this.now().toISOString(),
      data: normalizedPayload,
    });
    if (!parsed.success) {
      throw new ArkGatewayError("invalid_response");
    }
    return parsed.data;
  }
}
