import type { ArkEvent, SessionStatus } from "@pwa/contracts";

export interface ArkRequestOptions {
  correlationId?: string;
  signal?: AbortSignal;
}

export interface ArkAgentInput {
  name: string;
  description: string;
  modelId: string;
  systemPrompt: string;
}

export interface ArkAgent extends ArkAgentInput {
  id: string;
  version: number;
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

export interface ArkArtifact {
  id: string;
  sessionId: string;
  name: string;
  contentType: string;
  size: number;
  createdAt: string;
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
  ): AsyncIterable<ArkEvent>;

  uploadFile(
    input: ArkFileInput,
    options?: ArkRequestOptions,
  ): Promise<ArkFile>;
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
  | "listSessionResources"
  | "listArtifacts";

export interface ArkCall {
  operation: ArkOperation;
  input: Record<string, unknown>;
  correlationId?: string;
}

export type { ArkEvent, SessionStatus };
