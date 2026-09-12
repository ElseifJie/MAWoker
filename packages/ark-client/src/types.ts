import type { ArkEvent, SessionStatus } from "@pwa/contracts";

export interface ArkRequestOptions {
  correlationId?: string;
  idempotencyKey?: string;
  signal?: AbortSignal;
}

export interface ArkAgentInput {
  name: string;
  description: string;
  modelId: string;
  systemPrompt: string;
  toolsetId?: string | undefined;
  toolPermission?: "always_allow" | undefined;
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

export interface ArkResourceInput {
  fileId: string;
  mountPath: string;
}

export interface ArkResource extends ArkResourceInput {
  id: string;
}

export interface ArkSession {
  id: string;
  agentId: string;
  agentVersion: number;
  environmentId: string;
  status: SessionStatus;
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
  | "listSessionResources"
  | "listArtifacts";

export interface ArkCall {
  operation: ArkOperation;
  input: Record<string, unknown>;
  correlationId?: string;
  idempotencyKey?: string;
}

export type { ArkEvent, SessionStatus };
