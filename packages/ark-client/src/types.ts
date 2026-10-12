import type {
  ArkEvent,
  SessionStatus as ContractSessionStatus,
} from "@pwa/contracts";

export type SessionStatus =
  ContractSessionStatus | "initializing" | "upgrading" | "failed";

export interface ArkRequestOptions {
  correlationId?: string;
  idempotencyKey?: string;
  signal?: AbortSignal;
}

/**
 * A Skill bound to an Agent. Only custom (user-uploaded) Skills are bound by
 * this app; the version is pinned at bind time so Ark resolves exactly the
 * package snapshot we validated.
 */
export interface ArkSkillBindingInput {
  skillId: string;
  version?: string | undefined;
}

export interface ArkAgentInput {
  name: string;
  description: string;
  modelId: string;
  systemPrompt: string;
  toolsetId?: string | undefined;
  toolPermission?: "always_allow" | undefined;
  skills?: ArkSkillBindingInput[] | undefined;
}

/**
 * Ark's read APIs never echo the agent instructions, so `systemPrompt` is only
 * present right after a write, echoed from the request we just sent.
 */
export interface ArkAgent {
  id: string;
  version: number;
  name: string;
  description: string;
  modelId: string;
  systemPrompt?: string | undefined;
}

export interface ArkAgentUpdate extends ArkAgentInput {
  currentVersion: number;
}

export interface ArkFileResourceInput {
  fileId: string;
  mountPath: string;
}

export interface ArkMemoryStoreResourceInput {
  type: "memory_store";
  memoryStoreId: string;
  access: "read_write" | "read_only";
}

export type ArkResourceInput =
  ArkFileResourceInput | ArkMemoryStoreResourceInput;

/** File inventory stays file-only for existing consumers. */
export interface ArkResource extends ArkFileResourceInput {
  id: string;
}

export interface ArkMemoryStoreInput {
  name: string;
  description?: string;
}

export interface ArkMemoryStore {
  id: string;
  name: string;
  memoryCount: number;
  storageBytes: number;
}

export interface ArkMemoryInput {
  path: string;
  content: string;
}

export interface ArkMemory extends ArkMemoryInput {
  id: string;
  contentSha256: string;
  memoryVersionId: string;
  sizeBytes: number;
}

export interface ArkDreamInput {
  memoryStoreId: string;
  sessionIds: string[];
  modelId: string;
  instructions: string;
}

export interface ArkDream {
  id: string;
  status: "pending" | "running" | "completed" | "failed" | "canceled";
  outputMemoryStoreId: string | null;
  usage: Record<string, unknown> | null;
}

export interface ArkSessionSkillSnapshot {
  type: string | null;
  skillId: string | null;
  version: string | null;
  useLatest: boolean | null;
  displayName: string | null;
}

export interface ArkSessionToolSnapshot {
  type: string | null;
  name: string | null;
  mcpServerName: string | null;
  configuredToolNames: string[] | null;
}

export interface ArkSessionEnvironmentSnapshot {
  id: string | null;
  type: string | null;
  configType: string | null;
  scope: string | null;
}

export interface ArkSessionConfigSnapshot {
  modelId: string | null;
  skills: ArkSessionSkillSnapshot[] | null;
  tools: ArkSessionToolSnapshot[] | null;
  environment: ArkSessionEnvironmentSnapshot;
  completeness: "complete" | "incomplete";
}

export interface ArkSession {
  id: string;
  agentId: string;
  agentVersion: number;
  environmentId: string;
  status: SessionStatus;
  configSnapshot: ArkSessionConfigSnapshot;
}

export interface ArkSessionInput {
  agentId: string;
  agentVersion: number;
  environmentId: string;
  resources: ArkResourceInput[];
}

export interface ArkEventInput {
  type: "user.message" | "user.interrupt";
  data: Record<string, unknown>;
}

export interface ArkFileInput {
  name: string;
  contentType: string;
  bytes: Uint8Array;
  purpose: "agent";
}

export interface ArkFile {
  id: string;
  name: string;
  contentType: string;
  size: number;
  purpose: "agent";
}

/**
 * A Skill package upload. Ark parses the package's SKILL.md itself, so `name`
 * in the response is Ark-derived while `displayTitle` is our human label.
 */
export interface ArkSkillInput {
  file: {
    name: string;
    contentType: string;
    bytes: Uint8Array;
  };
  displayTitle?: string | undefined;
}

export interface ArkSkill {
  id: string;
  name: string;
  displayTitle: string;
  description: string;
  latestVersion: string;
  source: "custom" | "skill_hub";
}

/**
 * Where Ark parked the bytes of an exported file. The Files API exposes no
 * content endpoint, so this is the only way to read an export: TOS directly.
 */
export interface ArkTosLocation {
  bucket: string;
  objectKey: string;
}

export interface ArkArtifact {
  id: string;
  sessionId: string;
  name: string;
  contentType: string;
  size: number;
  createdAt: string;
  /** Null when Ark reports no storage location, in which case the bytes are unreachable. */
  tos: ArkTosLocation | null;
}

export interface ArkGateway {
  createMemoryStore(
    input: ArkMemoryStoreInput,
    options?: ArkRequestOptions,
  ): Promise<ArkMemoryStore>;
  getMemoryStore(
    memoryStoreId: string,
    options?: ArkRequestOptions,
  ): Promise<ArkMemoryStore>;
  deleteMemoryStore(
    memoryStoreId: string,
    options?: ArkRequestOptions,
  ): Promise<void>;
  /** Complete inventory: metadata pages followed by detail reads for every entry. */
  listMemories(
    memoryStoreId: string,
    options?: ArkRequestOptions,
  ): Promise<ArkMemory[]>;
  getMemory(
    memoryStoreId: string,
    memoryId: string,
    options?: ArkRequestOptions,
  ): Promise<ArkMemory>;
  createMemory(
    memoryStoreId: string,
    input: ArkMemoryInput,
    options?: ArkRequestOptions,
  ): Promise<ArkMemory>;
  updateMemory(
    memoryStoreId: string,
    memoryId: string,
    input: ArkMemoryInput,
    options?: ArkRequestOptions,
  ): Promise<ArkMemory>;
  deleteMemory(
    memoryStoreId: string,
    memoryId: string,
    options?: ArkRequestOptions,
  ): Promise<void>;
  createDream(
    input: ArkDreamInput,
    options?: ArkRequestOptions,
  ): Promise<ArkDream>;
  getDream(dreamId: string, options?: ArkRequestOptions): Promise<ArkDream>;
  cancelDream(dreamId: string, options?: ArkRequestOptions): Promise<ArkDream>;

  createAgent(
    input: ArkAgentInput,
    options?: ArkRequestOptions,
  ): Promise<ArkAgent>;
  getAgent(agentId: string, options?: ArkRequestOptions): Promise<ArkAgent>;
  updateAgent(
    agentId: string,
    input: ArkAgentUpdate,
    options?: ArkRequestOptions,
  ): Promise<ArkAgent>;
  deleteAgent(agentId: string, options?: ArkRequestOptions): Promise<void>;

  createSession(
    input: ArkSessionInput,
    options?: ArkRequestOptions,
  ): Promise<ArkSession>;
  getSession(
    sessionId: string,
    options?: ArkRequestOptions,
  ): Promise<ArkSession>;
  deleteSession(sessionId: string, options?: ArkRequestOptions): Promise<void>;

  submitEvent(
    sessionId: string,
    event: ArkEventInput,
    options?: ArkRequestOptions,
  ): Promise<ArkEvent>;
  listEvents(
    sessionId: string,
    options?: ArkRequestOptions,
  ): Promise<ArkEvent[]>;
  streamEvents(
    sessionId: string,
    options?: ArkRequestOptions,
  ): Promise<AsyncIterable<ArkEvent>>;

  uploadFile(
    input: ArkFileInput,
    options?: ArkRequestOptions,
  ): Promise<ArkFile>;
  deleteFile(fileId: string, options?: ArkRequestOptions): Promise<void>;
  createSkill(
    input: ArkSkillInput,
    options?: ArkRequestOptions,
  ): Promise<ArkSkill>;
  getSkill(skillId: string, options?: ArkRequestOptions): Promise<ArkSkill>;
  listSessionResources(
    sessionId: string,
    options?: ArkRequestOptions,
  ): Promise<ArkResource[]>;
  listArtifacts(
    sessionId: string,
    options?: ArkRequestOptions,
  ): Promise<ArkArtifact[]>;
}

export type ArkOperation =
  | "createMemoryStore"
  | "getMemoryStore"
  | "deleteMemoryStore"
  | "listMemories"
  | "getMemory"
  | "createMemory"
  | "updateMemory"
  | "deleteMemory"
  | "createDream"
  | "getDream"
  | "cancelDream"
  | "createAgent"
  | "getAgent"
  | "updateAgent"
  | "deleteAgent"
  | "createSession"
  | "getSession"
  | "deleteSession"
  | "submitEvent"
  | "listEvents"
  | "streamEvents"
  | "uploadFile"
  | "deleteFile"
  | "createSkill"
  | "getSkill"
  | "listSessionResources"
  | "listArtifacts";

export interface ArkCall {
  operation: ArkOperation;
  input: Record<string, unknown>;
  correlationId?: string;
  idempotencyKey?: string;
}

export type { ArkEvent };
