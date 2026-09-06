import type { ArkAgentInput, ArkGateway } from "@pwa/ark-client";
import { ResourceNotFoundError } from "./errors.js";

export const PLATFORM_AGENT_TOOLSET_ID = "agent_toolset_20260701";
export const PLATFORM_AGENT_TOOL_PERMISSION = "always_allow";

export type PlatformAgentStatus =
  "provisioning" | "active" | "disabled" | "failed" | "deleting";

export interface PlatformAgentRecord {
  id: string;
  arkAgentId: string;
  name: string;
  description: string;
  modelId: string;
  systemPrompt: string;
  arkVersion: string;
  status: PlatformAgentStatus;
  createdBy: string;
  updatedBy: string;
  lastErrorCode: string | null;
}

export interface DefaultAgentRecord {
  userId: string;
  platformAgentId: string;
  assignedBy: string;
  assignedAt: Date;
}

export interface AdminUserSummary {
  id: string;
  email: string;
  status: "active" | "disabled";
  defaultAgentId: string | null;
}

export interface UserQuota {
  userId: string;
  personalAgentLimit: number;
  concurrentSessionLimit: number;
  dailySessionLimit: number;
  monthlyTokenLimit: number;
}

interface AuditEntry {
  actorUserId: string;
  ownerUserId?: string | undefined;
  action: string;
  resourceType: "platform_agent" | "user_default_agent" | "user_quota";
  resourceId?: string | undefined;
  result: "succeeded" | "failed";
  requestId: string;
  arkRequestId?: string | undefined;
  errorCode?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
}

export interface PlatformAgentRepository {
  list(): PromiseLike<PlatformAgentRecord[]>;
  findById(id: string): PromiseLike<PlatformAgentRecord | undefined>;
  createProvisioning(
    record: Omit<
      PlatformAgentRecord,
      "arkAgentId" | "arkVersion" | "status" | "lastErrorCode"
    >,
  ): PromiseLike<PlatformAgentRecord>;
  markProvisioned(
    id: string,
    upstream: { arkAgentId: string; arkVersion: string },
  ): PromiseLike<PlatformAgentRecord>;
  markFailure(
    id: string,
    status: "provisioning" | "failed" | "deleting",
    errorCode: string,
  ): PromiseLike<PlatformAgentRecord>;
  update(
    id: string,
    update: Partial<
      Pick<
        PlatformAgentRecord,
        | "name"
        | "description"
        | "modelId"
        | "systemPrompt"
        | "arkVersion"
        | "status"
        | "updatedBy"
        | "lastErrorCode"
      >
    >,
  ): PromiseLike<PlatformAgentRecord>;
  beginDelete(
    id: string,
    updatedBy: string,
  ): PromiseLike<
    | {
        agent: PlatformAgentRecord;
        previousStatus: PlatformAgentStatus;
        references: { assignments: number; sessions: number };
      }
    | undefined
  >;
  remove(id: string): PromiseLike<void>;
  assignDefault(input: {
    userId: string;
    platformAgentId: string;
    assignedBy: string;
  }): PromiseLike<DefaultAgentRecord | undefined>;
  listUsers(): PromiseLike<AdminUserSummary[]>;
  updateUserQuota(
    input: UserQuota & {
      updatedBy: string;
    },
  ): PromiseLike<UserQuota | undefined>;
  audit(entry: AuditEntry): PromiseLike<void>;
}

export class InvalidModelError extends Error {
  readonly code = "VALIDATION_FAILED";
  constructor() {
    super("Model is not allowed");
    this.name = "InvalidModelError";
  }
}

export class AgentConflictError extends Error {
  readonly code = "ARK_CONFLICT";
  constructor() {
    super("Agent version conflict");
    this.name = "AgentConflictError";
  }
}

export class AgentReferencedError extends Error {
  readonly code = "AGENT_REFERENCED";
  constructor(
    public readonly assignments: number,
    public readonly sessions: number,
  ) {
    super("Platform Agent is still referenced");
    this.name = "AgentReferencedError";
  }
}

interface MutationContext {
  adminId: string;
  requestId: string;
}

interface AgentConfiguration {
  name: string;
  description: string;
  modelId: string;
  systemPrompt: string;
}

interface UpdateInput extends Partial<AgentConfiguration> {
  arkVersion?: string;
  status?: "active" | "disabled";
}

function arkErrorCode(error: unknown): string {
  const category =
    typeof error === "object" && error !== null && "category" in error
      ? String(error.category)
      : "unavailable";
  return `ARK_${category.toUpperCase()}`;
}

function isArkCategory(error: unknown, category: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "category" in error &&
    error.category === category
  );
}

function arkRequestId(error: unknown): string | undefined {
  if (
    typeof error === "object" &&
    error !== null &&
    "arkRequestId" in error &&
    typeof error.arkRequestId === "string"
  ) {
    return error.arkRequestId;
  }
  return undefined;
}

export class PlatformAgentService {
  private readonly models: Set<string>;

  constructor(
    private readonly dependencies: {
      repository: PlatformAgentRepository;
      ark: Pick<ArkGateway, "createAgent" | "updateAgent" | "deleteAgent">;
      modelAllowlist: readonly string[];
      createId: () => string;
    },
  ) {
    this.models = new Set(dependencies.modelAllowlist);
  }

  list(): PromiseLike<PlatformAgentRecord[]> {
    return this.dependencies.repository.list();
  }

  listPlatformAgents(): PromiseLike<PlatformAgentRecord[]> {
    return this.list();
  }

  createPlatformAgent(
    input: AgentConfiguration,
    context: MutationContext,
  ): Promise<PlatformAgentRecord> {
    return this.create(input, context);
  }

  async create(
    input: AgentConfiguration,
    context: MutationContext,
  ): Promise<PlatformAgentRecord> {
    this.assertModel(input.modelId);
    const id = this.dependencies.createId();
    await this.dependencies.repository.createProvisioning({
      id,
      ...input,
      createdBy: context.adminId,
      updatedBy: context.adminId,
    });

    try {
      const upstream = await this.dependencies.ark.createAgent(
        this.arkInput(input),
        { correlationId: context.requestId },
      );
      const created = await this.dependencies.repository.markProvisioned(id, {
        arkAgentId: upstream.id,
        arkVersion: String(upstream.version),
      });
      await this.audit(context, "platform_agent.create", id, "succeeded");
      return created;
    } catch (error) {
      const status = isArkCategory(error, "unknown_write_outcome")
        ? "provisioning"
        : "failed";
      const errorCode = arkErrorCode(error);
      await this.dependencies.repository.markFailure(id, status, errorCode);
      await this.audit(context, "platform_agent.create", id, "failed", {
        errorCode,
        arkRequestId: arkRequestId(error),
      });
      throw error;
    }
  }

  async update(
    id: string,
    input: UpdateInput,
    context: MutationContext,
  ): Promise<PlatformAgentRecord> {
    const current = await this.requireAgent(id);
    if (input.modelId !== undefined) this.assertModel(input.modelId);

    const hasConfiguration = [
      input.name,
      input.description,
      input.modelId,
      input.systemPrompt,
    ].some((value) => value !== undefined);
    if (hasConfiguration) {
      if (input.arkVersion !== current.arkVersion) {
        await this.audit(context, "platform_agent.update", id, "failed", {
          errorCode: "ARK_CONFLICT",
        });
        throw new AgentConflictError();
      }
      const configuration = {
        name: input.name ?? current.name,
        description: input.description ?? current.description,
        modelId: input.modelId ?? current.modelId,
        systemPrompt: input.systemPrompt ?? current.systemPrompt,
      };
      try {
        const upstream = await this.dependencies.ark.updateAgent(
          current.arkAgentId,
          {
            ...this.arkInput(configuration),
            currentVersion: Number(current.arkVersion),
          },
          { correlationId: context.requestId },
        );
        const updated = await this.dependencies.repository.update(id, {
          ...configuration,
          arkVersion: String(upstream.version),
          updatedBy: context.adminId,
          lastErrorCode: null,
        });
        await this.audit(context, "platform_agent.update", id, "succeeded");
        return updated;
      } catch (error) {
        const normalized = isArkCategory(error, "version_conflict")
          ? new AgentConflictError()
          : error;
        if (isArkCategory(error, "unknown_write_outcome")) {
          await this.dependencies.repository.markFailure(
            id,
            "failed",
            arkErrorCode(error),
          );
        }
        await this.audit(context, "platform_agent.update", id, "failed", {
          errorCode: arkErrorCode(error),
          arkRequestId: arkRequestId(error),
        });
        throw normalized;
      }
    }

    if (input.status !== undefined && input.status !== current.status) {
      const updated = await this.dependencies.repository.update(id, {
        status: input.status,
        updatedBy: context.adminId,
      });
      await this.audit(
        context,
        input.status === "active"
          ? "platform_agent.enable"
          : "platform_agent.disable",
        id,
        "succeeded",
      );
      return updated;
    }
    return current;
  }

  updatePlatformAgent(
    id: string,
    input: UpdateInput,
    context: MutationContext,
  ): Promise<PlatformAgentRecord> {
    return this.update(id, input, context);
  }

  async delete(id: string, context: MutationContext): Promise<void> {
    const deletion = await this.dependencies.repository.beginDelete(
      id,
      context.adminId,
    );
    if (!deletion) throw new ResourceNotFoundError();
    const { agent: current, previousStatus, references } = deletion;
    if (references.assignments > 0 || references.sessions > 0) {
      await this.audit(context, "platform_agent.delete", id, "failed", {
        errorCode: "AGENT_REFERENCED",
        metadata: references,
      });
      throw new AgentReferencedError(
        references.assignments,
        references.sessions,
      );
    }

    try {
      await this.dependencies.ark.deleteAgent(current.arkAgentId, {
        correlationId: context.requestId,
      });
      await this.dependencies.repository.remove(id);
      await this.audit(context, "platform_agent.delete", id, "succeeded");
    } catch (error) {
      const errorCode = arkErrorCode(error);
      if (isArkCategory(error, "unknown_write_outcome")) {
        await this.dependencies.repository.markFailure(
          id,
          "deleting",
          errorCode,
        );
      } else {
        await this.dependencies.repository.update(id, {
          status: previousStatus,
          lastErrorCode: errorCode,
          updatedBy: context.adminId,
        });
      }
      await this.audit(context, "platform_agent.delete", id, "failed", {
        errorCode,
        arkRequestId: arkRequestId(error),
      });
      throw error;
    }
  }

  deletePlatformAgent(id: string, context: MutationContext): Promise<void> {
    return this.delete(id, context);
  }

  async assignDefault(
    userId: string,
    platformAgentId: string,
    context: MutationContext,
  ): Promise<DefaultAgentRecord> {
    try {
      const agent = await this.requireAgent(platformAgentId);
      if (agent.status !== "active") throw new ResourceNotFoundError();
      const assignment = await this.dependencies.repository.assignDefault({
        userId,
        platformAgentId,
        assignedBy: context.adminId,
      });
      if (!assignment) throw new ResourceNotFoundError();
      await this.audit(
        context,
        "user_default_agent.assign",
        platformAgentId,
        "succeeded",
        { ownerUserId: userId },
      );
      return assignment;
    } catch (error) {
      await this.audit(
        context,
        "user_default_agent.assign",
        platformAgentId,
        "failed",
        { ownerUserId: userId, errorCode: "RESOURCE_NOT_FOUND" },
      );
      throw error;
    }
  }

  assignDefaultAgent(
    userId: string,
    platformAgentId: string,
    context: MutationContext,
  ): Promise<DefaultAgentRecord> {
    return this.assignDefault(userId, platformAgentId, context);
  }

  listUsers(): PromiseLike<AdminUserSummary[]> {
    return this.dependencies.repository.listUsers();
  }

  async updateUserQuota(
    userId: string,
    quota: Omit<UserQuota, "userId">,
    context: MutationContext,
  ): Promise<UserQuota> {
    const updated = await this.dependencies.repository.updateUserQuota({
      userId,
      ...quota,
      updatedBy: context.adminId,
    });
    if (!updated) throw new ResourceNotFoundError();
    await this.audit(context, "user_quota.update", userId, "succeeded", {
      ownerUserId: userId,
    });
    return updated;
  }

  private async requireAgent(id: string): Promise<PlatformAgentRecord> {
    const agent = await this.dependencies.repository.findById(id);
    if (!agent) throw new ResourceNotFoundError();
    return agent;
  }

  private assertModel(modelId: string): void {
    if (!this.models.has(modelId)) throw new InvalidModelError();
  }

  private arkInput(input: AgentConfiguration): ArkAgentInput {
    return {
      ...input,
      toolsetId: PLATFORM_AGENT_TOOLSET_ID,
      toolPermission: PLATFORM_AGENT_TOOL_PERMISSION,
    };
  }

  private audit(
    context: MutationContext,
    action: string,
    resourceId: string,
    result: "succeeded" | "failed",
    extra: {
      ownerUserId?: string | undefined;
      arkRequestId?: string | undefined;
      errorCode?: string | undefined;
      metadata?: Record<string, unknown> | undefined;
    } = {},
  ): PromiseLike<void> {
    return this.dependencies.repository.audit({
      actorUserId: context.adminId,
      action,
      resourceType:
        action === "user_default_agent.assign"
          ? "user_default_agent"
          : action === "user_quota.update"
            ? "user_quota"
            : "platform_agent",
      resourceId,
      result,
      requestId: context.requestId,
      ...extra,
    });
  }
}
