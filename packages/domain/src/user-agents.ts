import type { ArkAgentInput, ArkGateway } from "@pwa/ark-client";
import {
  AgentConflictError,
  AgentReferencedError,
  InvalidModelError,
  PLATFORM_AGENT_TOOL_PERMISSION,
  PLATFORM_AGENT_TOOLSET_ID,
  type PlatformAgentStatus,
} from "./platform-agents.js";
import { ResourceNotFoundError } from "./errors.js";
import { arkErrorCode, arkRequestId, isArkCategory } from "./ark-errors.js";

export interface AgentSkillBinding {
  /** Local `skills.id`. */
  skillId: string;
  /** Upstream Ark skill id the binding resolves to. */
  arkSkillId: string;
  /** Ark skill version pinned at bind time. */
  arkVersion: string;
}

export interface AgentSkillSummary {
  id: string;
  displayTitle: string;
}

export interface PersonalAgentRecord {
  id: string;
  ownerUserId: string;
  arkAgentId: string;
  name: string;
  description: string;
  modelId: string;
  systemPrompt: string;
  arkVersion: string;
  status: PlatformAgentStatus;
  isAutoDefault: boolean;
  skills: AgentSkillBinding[];
  lastErrorCode: string | null;
}

export interface AvailableAgentRecord {
  id: string;
  arkAgentId: string;
  name: string;
  description: string;
  modelId: string;
  systemPrompt: string;
  arkVersion: string;
  status: PlatformAgentStatus;
  kind: "platform" | "personal";
  editable: boolean;
  isAutoDefault: boolean;
  skills: AgentSkillSummary[];
}

interface PersonalAgentAuditEntry {
  actorUserId: string;
  ownerUserId: string;
  action: string;
  resourceType: "personal_agent";
  resourceId: string;
  result: "succeeded" | "failed";
  requestId: string;
  arkRequestId?: string | undefined;
  errorCode?: string | undefined;
}

export interface UserAgentRepository {
  listAvailable(userId: string): PromiseLike<AvailableAgentRecord[]>;
  findRecentAvailable(userId: string): PromiseLike<string | undefined>;
  findDefaultActive(userId: string): PromiseLike<string | undefined>;
  findAutoDefault(userId: string): PromiseLike<PersonalAgentRecord | undefined>;
  /**
   * The configuration the user's exclusive default Agent is modelled on: the
   * assigned platform default Agent when there is one, otherwise the oldest
   * active platform Agent, otherwise undefined (the service falls back to the
   * model allowlist defaults).
   */
  findPlatformTemplate(
    userId: string,
  ): PromiseLike<
    Pick<
      AgentConfiguration,
      "name" | "description" | "modelId" | "systemPrompt"
    > | undefined
  >;
  findAvailableById(
    userId: string,
    id: string,
  ): PromiseLike<AvailableAgentRecord | undefined>;
  listAgentsBoundToSkill(
    skillId: string,
  ): PromiseLike<PersonalAgentRecord[]>;
  replaceSkillBindings(
    agentId: string,
    userId: string,
    bindings: AgentSkillBinding[],
  ): PromiseLike<void>;
  createProvisioning(
    record: Omit<
      PersonalAgentRecord,
      "arkAgentId" | "arkVersion" | "status" | "lastErrorCode" | "skills"
    > & { skills: AgentSkillBinding[] },
  ): PromiseLike<PersonalAgentRecord | undefined>;
  findOwned(
    userId: string,
    id: string,
  ): PromiseLike<PersonalAgentRecord | undefined>;
  markProvisioned(
    id: string,
    userId: string,
    upstream: { arkAgentId: string; arkVersion: string },
  ): PromiseLike<PersonalAgentRecord>;
  markFailure(
    id: string,
    userId: string,
    status: "provisioning" | "failed" | "deleting",
    errorCode: string,
  ): PromiseLike<PersonalAgentRecord>;
  markDefinitiveCreateFailure(
    id: string,
    userId: string,
    errorCode: string,
  ): PromiseLike<PersonalAgentRecord>;
  markCreatePersistenceFailure(
    id: string,
    userId: string,
    upstream: { arkAgentId: string; arkVersion: string },
  ): PromiseLike<PersonalAgentRecord>;
  markUpdatePersistenceFailure(
    id: string,
    userId: string,
    upstreamVersion: string,
  ): PromiseLike<PersonalAgentRecord>;
  saveUpdateIntent(
    id: string,
    userId: string,
    configuration: AgentConfiguration,
    arkVersion: string,
  ): PromiseLike<void>;
  update(
    id: string,
    userId: string,
    update: Partial<
      Pick<
        PersonalAgentRecord,
        | "name"
        | "description"
        | "modelId"
        | "systemPrompt"
        | "arkVersion"
        | "status"
        | "lastErrorCode"
      >
    >,
  ): PromiseLike<PersonalAgentRecord>;
  beginDelete(
    id: string,
    userId: string,
    enqueueReconciliation?: boolean,
  ): PromiseLike<
    | {
        agent: PersonalAgentRecord;
        conflict: "create_reconciliation_pending";
      }
    | {
        agent: PersonalAgentRecord;
        previousStatus: PlatformAgentStatus;
        references: { sessions: number };
      }
    | undefined
  >;
  remove(id: string, userId: string): PromiseLike<void>;
  audit(entry: PersonalAgentAuditEntry): PromiseLike<void>;
}

interface AgentConfiguration {
  name: string;
  description: string;
  modelId: string;
  systemPrompt: string;
  /**
   * Skill bindings pushed with the configuration. `undefined` keeps whatever
   * binding the Agent already has; an explicit array (even empty) replaces it.
   */
  skills?: AgentSkillBinding[] | undefined;
}

interface MutationContext {
  userId: string;
  requestId: string;
}

interface UpdateInput extends Partial<AgentConfiguration> {
  arkVersion: string;
}

export class PersonalAgentQuotaExceededError extends Error {
  readonly code = "QUOTA_EXCEEDED";

  constructor() {
    super("Personal Agent quota exceeded");
    this.name = "PersonalAgentQuotaExceededError";
  }
}

export class PersonalAgentBusyError extends Error {
  readonly code = "AGENT_BUSY";

  constructor() {
    super("Personal Agent creation is still being reconciled");
    this.name = "PersonalAgentBusyError";
  }
}

export class NoDefaultAgentError extends Error {
  readonly code = "NO_DEFAULT_AGENT";

  constructor() {
    super("Contact an administrator to assign a default Agent");
    this.name = "NoDefaultAgentError";
  }
}

function createCorrelationId(id: string): string {
  return `personal-agent-create:${id}`;
}

const AUTO_DEFAULT_AGENT_NAME = "My Agent";
const AUTO_DEFAULT_AGENT_DESCRIPTION =
  "Your personal default Agent. Created from the platform default and kept in sync with your Skills.";
const AUTO_DEFAULT_AGENT_PROMPT =
  "You are a helpful personal work agent. Complete the user's task with the tools and Skills available to you.";

/**
 * Order-insensitive binding equality: the sync rewrites the binding list in a
 * canonical order, so only membership and pinned versions matter.
 */
export function sameAgentSkillBindings(
  current: AgentSkillBinding[],
  desired: AgentSkillBinding[],
): boolean {
  if (current.length !== desired.length) return false;
  const key = (binding: AgentSkillBinding) =>
    `${binding.skillId}:${binding.arkSkillId}:${binding.arkVersion}`;
  const desiredKeys = new Set(desired.map(key));
  return current.every((binding) => desiredKeys.has(key(binding)));
}

const sameBindings = sameAgentSkillBindings;

export class UserAgentService {
  private readonly models: Set<string>;

  constructor(
    private readonly dependencies: {
      repository: UserAgentRepository;
      ark: Pick<
        ArkGateway,
        "createAgent" | "getAgent" | "updateAgent" | "deleteAgent"
      >;
      modelAllowlist: readonly string[];
      createId: () => string;
    },
  ) {
    this.models = new Set(dependencies.modelAllowlist);
  }

  async list(userId: string) {
    const agents = (
      await this.dependencies.repository.listAvailable(userId)
    ).map((agent) => ({ ...agent, version: agent.arkVersion }));
    const autoDefault = await this.dependencies.repository.findAutoDefault(
      userId,
    );
    if (autoDefault && autoDefault.status === "active") {
      return {
        agents,
        selection: {
          agentId: autoDefault.id,
          source: "personal_default" as const,
        },
        blocker: null,
      };
    }
    const recent = await this.dependencies.repository.findRecentAvailable(
      userId,
    );
    if (recent) {
      return {
        agents,
        selection: { agentId: recent, source: "recent" as const },
        blocker: null,
      };
    }
    const fallback =
      await this.dependencies.repository.findDefaultActive(userId);
    if (fallback) {
      return {
        agents,
        selection: { agentId: fallback, source: "default" as const },
        blocker: null,
      };
    }
    return {
      agents,
      selection: null,
      blocker: {
        code: "NO_DEFAULT_AGENT" as const,
        message: "Contact an administrator to assign a default Agent",
      },
    };
  }

  async resolveSelection(userId: string): Promise<AvailableAgentRecord> {
    const autoDefault = await this.dependencies.repository.findAutoDefault(
      userId,
    );
    const primary =
      autoDefault && autoDefault.status === "active"
        ? autoDefault.id
        : undefined;
    const recent =
      primary ??
      (await this.dependencies.repository.findRecentAvailable(userId));
    const selected =
      recent ?? (await this.dependencies.repository.findDefaultActive(userId));
    if (!selected) throw new NoDefaultAgentError();
    return this.requireAvailable(userId, selected);
  }

  async get(userId: string, id: string): Promise<AvailableAgentRecord> {
    const agent = (
      await this.dependencies.repository.listAvailable(userId)
    ).find((candidate) => candidate.id === id);
    if (!agent) throw new ResourceNotFoundError();
    return agent;
  }

  resolveForNewSession(
    userId: string,
    agentId: string,
  ): Promise<AvailableAgentRecord> {
    return this.requireAvailable(userId, agentId);
  }

  async create(
    input: AgentConfiguration & { isAutoDefault?: boolean },
    context: MutationContext,
  ): Promise<PersonalAgentRecord> {
    this.assertModel(input.modelId);
    const id = this.dependencies.createId();
    const local = await this.dependencies.repository.createProvisioning({
      id,
      ownerUserId: context.userId,
      name: input.name,
      description: input.description,
      modelId: input.modelId,
      systemPrompt: input.systemPrompt,
      isAutoDefault: input.isAutoDefault ?? false,
      skills: input.skills ?? [],
    });
    if (!local) throw new PersonalAgentQuotaExceededError();

    let upstream;
    try {
      const operationId = createCorrelationId(id);
      upstream = await this.dependencies.ark.createAgent(
        this.arkInput(input),
        {
          correlationId: operationId,
          idempotencyKey: operationId,
        },
      );
    } catch (error) {
      const errorCode = arkErrorCode(error);
      if (isArkCategory(error, "unknown_write_outcome")) {
        await this.dependencies.repository.markFailure(
          id,
          context.userId,
          "provisioning",
          errorCode,
        );
      } else {
        await this.dependencies.repository.markDefinitiveCreateFailure(
          id,
          context.userId,
          errorCode,
        );
      }
      await this.audit(context, "personal_agent.create", id, "failed", error);
      throw error;
    }

    const upstreamIdentity = {
      arkAgentId: upstream.id,
      arkVersion: String(upstream.version),
    };
    let created;
    try {
      created = await this.dependencies.repository.markProvisioned(
        id,
        context.userId,
        upstreamIdentity,
      );
    } catch (error) {
      await this.dependencies.repository.markCreatePersistenceFailure(
        id,
        context.userId,
        upstreamIdentity,
      );
      await this.audit(context, "personal_agent.create", id, "failed", {
        code: "DB_PERSISTENCE_FAILED",
      });
      throw error;
    }
    await this.audit(context, "personal_agent.create", id, "succeeded");
    return created;
  }

  /**
   * The user's exclusive default Agent: created once from the platform
   * default Agent's configuration with every owned Skill bound, then kept in
   * sync by the Skill service whenever their Skill library changes.
   */
  async ensureAutoDefault(
    userId: string,
    bindings: AgentSkillBinding[],
    context: MutationContext,
  ): Promise<PersonalAgentRecord> {
    const existing = await this.dependencies.repository.findAutoDefault(userId);
    if (existing) {
      if (existing.status !== "active") return existing;
      return existing;
    }
    const template =
      (await this.dependencies.repository.findPlatformTemplate(userId)) ??
      ({
        name: AUTO_DEFAULT_AGENT_NAME,
        description: AUTO_DEFAULT_AGENT_DESCRIPTION,
        modelId: this.allowlistDefaultModel(),
        systemPrompt: AUTO_DEFAULT_AGENT_PROMPT,
      } satisfies AgentConfiguration);
    try {
      return await this.create(
        {
          ...template,
          name: AUTO_DEFAULT_AGENT_NAME,
          isAutoDefault: true,
          skills: bindings,
        },
        context,
      );
    } catch (error) {
      // A concurrent ensure already provisioned the Agent; return theirs. A
      // failed row is not a race winner, so the original error still surfaces.
      const raced = await this.dependencies.repository.findAutoDefault(userId);
      if (raced && raced.status !== "failed") return raced;
      throw error;
    }
  }

  /** Rebinds the Agent's Skills, leaving the rest of its configuration alone. */
  async updateAgentSkills(
    id: string,
    bindings: AgentSkillBinding[],
    context: MutationContext,
  ): Promise<PersonalAgentRecord> {
    const current = await this.requireOwned(context.userId, id);
    if (current.arkAgentId.startsWith("pending:")) {
      // The Agent was never provisioned upstream: its Skills are pushed with
      // the create itself, so only the local binding rows need rewriting.
      if (!sameBindings(current.skills, bindings)) {
        await this.dependencies.repository.replaceSkillBindings(
          id,
          context.userId,
          bindings,
        );
      }
      return current;
    }
    return this.update(
      id,
      { skills: bindings, arkVersion: current.arkVersion },
      context,
    );
  }

  listAgentsBoundToSkill(skillId: string): PromiseLike<PersonalAgentRecord[]> {
    return this.dependencies.repository.listAgentsBoundToSkill(skillId);
  }

  async reconcileCreate(
    id: string,
    context: MutationContext,
  ): Promise<PersonalAgentRecord> {
    const current = await this.requireOwned(context.userId, id);
    if (current.status === "active") return current;

    const operationId = createCorrelationId(current.id);
    const upstream =
      current.arkVersion !== "0" && !current.arkAgentId.startsWith("pending:")
        ? {
            id: current.arkAgentId,
            version: Number(current.arkVersion),
          }
        : await this.dependencies.ark.createAgent(this.arkInput(current), {
            correlationId: operationId,
            idempotencyKey: operationId,
          });
    const reconciled = await this.dependencies.repository.markProvisioned(
      current.id,
      context.userId,
      {
        arkAgentId: upstream.id,
        arkVersion: String(upstream.version),
      },
    );
    await this.audit(
      context,
      "personal_agent.create.reconcile",
      current.id,
      "succeeded",
    );
    return reconciled;
  }

  async update(
    id: string,
    input: UpdateInput,
    context: MutationContext,
  ): Promise<PersonalAgentRecord> {
    const current = await this.requireOwned(context.userId, id);
    if (input.modelId !== undefined) this.assertModel(input.modelId);
    if (input.arkVersion !== current.arkVersion) {
      await this.audit(
        context,
        "personal_agent.update",
        id,
        "failed",
        new AgentConflictError(),
      );
      throw new AgentConflictError();
    }

    const configuration: AgentConfiguration & {
      skills: AgentSkillBinding[];
    } = {
      name: input.name ?? current.name,
      description: input.description ?? current.description,
      modelId: input.modelId ?? current.modelId,
      systemPrompt: input.systemPrompt ?? current.systemPrompt,
      skills: input.skills ?? current.skills,
    };
    await this.dependencies.repository.saveUpdateIntent(
      id,
      context.userId,
      configuration,
      current.arkVersion,
    );
    let upstream;
    try {
      upstream = await this.dependencies.ark.updateAgent(
        current.arkAgentId,
        {
          ...this.arkInput(configuration),
          currentVersion: Number(current.arkVersion),
        },
        { correlationId: context.requestId },
      );
    } catch (error) {
      if (isArkCategory(error, "unknown_write_outcome")) {
        await this.dependencies.repository.markFailure(
          id,
          context.userId,
          "failed",
          arkErrorCode(error),
        );
      }
      await this.audit(context, "personal_agent.update", id, "failed", error);
      if (isArkCategory(error, "version_conflict")) {
        throw new AgentConflictError();
      }
      throw error;
    }

    let updated;
    try {
      if (input.skills !== undefined) {
        await this.dependencies.repository.replaceSkillBindings(
          id,
          context.userId,
          configuration.skills,
        );
      }
      updated = await this.dependencies.repository.update(id, context.userId, {
        ...configuration,
        arkVersion: String(upstream.version),
        status: "active",
        lastErrorCode: null,
      });
    } catch (error) {
      await this.dependencies.repository.markUpdatePersistenceFailure(
        id,
        context.userId,
        String(upstream.version),
      );
      await this.audit(context, "personal_agent.update", id, "failed", {
        code: "DB_PERSISTENCE_FAILED",
      });
      throw error;
    }
    await this.audit(context, "personal_agent.update", id, "succeeded");
    return updated;
  }

  async reconcileUpdate(
    id: string,
    intent: { configuration: AgentConfiguration; arkVersion: string },
    context: MutationContext,
  ): Promise<PersonalAgentRecord> {
    const current = await this.requireOwned(context.userId, id);
    const desired = intent.configuration;
    this.assertModel(desired.modelId);

    const configurationMatches = this.matchesConfiguration(current, desired);
    const skillsMatch =
      desired.skills === undefined ||
      sameBindings(current.skills, desired.skills);
    if (
      Number(current.arkVersion) > Number(intent.arkVersion) &&
      configurationMatches &&
      skillsMatch
    ) {
      return current;
    }

    const upstream = await this.dependencies.ark.getAgent(current.arkAgentId, {
      correlationId: context.requestId,
    });
    let resolved = upstream;
    if (
      upstream.version === Number(intent.arkVersion) &&
      (!this.matchesConfiguration(upstream, desired) || !skillsMatch)
    ) {
      resolved = await this.dependencies.ark.updateAgent(
        current.arkAgentId,
        {
          ...this.arkInput(desired),
          currentVersion: upstream.version,
        },
        { correlationId: context.requestId },
      );
    } else if (
      upstream.version < Number(intent.arkVersion) ||
      !this.matchesConfiguration(upstream, desired) ||
      !skillsMatch
    ) {
      throw new AgentConflictError();
    }

    if (desired.skills !== undefined) {
      await this.dependencies.repository.replaceSkillBindings(
        id,
        context.userId,
        desired.skills,
      );
    }
    const reconciled = await this.dependencies.repository.update(
      id,
      context.userId,
      {
        name: desired.name,
        description: desired.description,
        modelId: desired.modelId,
        systemPrompt: desired.systemPrompt,
        arkVersion: String(resolved.version),
        status: "active",
        lastErrorCode: null,
      },
    );
    await this.audit(
      context,
      "personal_agent.update.reconcile",
      id,
      "succeeded",
    );
    return reconciled;
  }

  async delete(id: string, context: MutationContext): Promise<void> {
    return this.deleteInternal(id, context, true);
  }

  async reconcileDelete(id: string, context: MutationContext): Promise<void> {
    return this.deleteInternal(id, context, false);
  }

  private async deleteInternal(
    id: string,
    context: MutationContext,
    enqueueReconciliation: boolean,
  ): Promise<void> {
    const deletion = await this.dependencies.repository.beginDelete(
      id,
      context.userId,
      enqueueReconciliation,
    );
    if (!deletion) throw new ResourceNotFoundError();
    if ("conflict" in deletion) {
      const error = new PersonalAgentBusyError();
      await this.audit(context, "personal_agent.delete", id, "failed", error);
      throw error;
    }
    if (deletion.references.sessions > 0) {
      const error = new AgentReferencedError(0, deletion.references.sessions);
      await this.audit(context, "personal_agent.delete", id, "failed", error);
      throw error;
    }

    if (
      deletion.previousStatus === "failed" &&
      deletion.agent.arkVersion === "0" &&
      deletion.agent.arkAgentId.startsWith("pending:")
    ) {
      await this.dependencies.repository.remove(id, context.userId);
      await this.audit(context, "personal_agent.delete", id, "succeeded");
      return;
    }

    try {
      await this.dependencies.ark.deleteAgent(deletion.agent.arkAgentId, {
        correlationId: context.requestId,
      });
    } catch (error) {
      if (
        deletion.previousStatus === "deleting" &&
        isArkCategory(error, "not_found")
      ) {
        await this.dependencies.repository.remove(id, context.userId);
        await this.audit(context, "personal_agent.delete", id, "succeeded");
        return;
      }
      const errorCode = arkErrorCode(error);
      if (isArkCategory(error, "unknown_write_outcome")) {
        await this.dependencies.repository.markFailure(
          id,
          context.userId,
          "deleting",
          errorCode,
        );
      } else {
        await this.dependencies.repository.update(id, context.userId, {
          status: deletion.previousStatus,
          lastErrorCode: errorCode,
        });
      }
      await this.audit(context, "personal_agent.delete", id, "failed", error);
      throw error;
    }

    try {
      await this.dependencies.repository.remove(id, context.userId);
    } catch (error) {
      await this.dependencies.repository.markFailure(
        id,
        context.userId,
        "deleting",
        "DB_PERSISTENCE_FAILED",
      );
      await this.audit(context, "personal_agent.delete", id, "failed", {
        code: "DB_PERSISTENCE_FAILED",
      });
      throw error;
    }
    await this.audit(context, "personal_agent.delete", id, "succeeded");
  }

  private async requireOwned(
    userId: string,
    id: string,
  ): Promise<PersonalAgentRecord> {
    const agent = await this.dependencies.repository.findOwned(userId, id);
    if (!agent) throw new ResourceNotFoundError();
    return agent;
  }

  private async requireAvailable(
    userId: string,
    id: string,
  ): Promise<AvailableAgentRecord> {
    const agent = await this.dependencies.repository.findAvailableById(
      userId,
      id,
    );
    if (!agent) throw new ResourceNotFoundError();
    return agent;
  }

  private assertModel(modelId: string): void {
    if (!this.models.has(modelId)) throw new InvalidModelError();
  }

  private allowlistDefaultModel(): string {
    return this.models.values().next().value ?? "";
  }

  private arkInput(input: AgentConfiguration): ArkAgentInput {
    return {
      name: input.name,
      description: input.description,
      modelId: input.modelId,
      systemPrompt: input.systemPrompt,
      // Domain bindings carry both local and upstream ids; the gateway only
      // speaks upstream ids.
      skills: input.skills?.map((skill) => ({
        skillId: skill.arkSkillId,
        version: skill.arkVersion,
      })),
      toolsetId: PLATFORM_AGENT_TOOLSET_ID,
      toolPermission: PLATFORM_AGENT_TOOL_PERMISSION,
    };
  }

  private matchesConfiguration(
    agent: Pick<AgentConfiguration, "name" | "description" | "modelId"> & {
      systemPrompt?: string | undefined;
    },
    configuration: AgentConfiguration,
  ): boolean {
    return (
      agent.name === configuration.name &&
      agent.description === configuration.description &&
      agent.modelId === configuration.modelId &&
      agent.systemPrompt === configuration.systemPrompt
    );
  }

  private audit(
    context: MutationContext,
    action: string,
    resourceId: string,
    result: "succeeded" | "failed",
    error?: unknown,
  ): PromiseLike<void> {
    return this.dependencies.repository.audit({
      actorUserId: context.userId,
      ownerUserId: context.userId,
      action,
      resourceType: "personal_agent",
      resourceId,
      result,
      requestId: context.requestId,
      ...(error
        ? {
            errorCode:
              error instanceof AgentConflictError ||
              error instanceof AgentReferencedError ||
              error instanceof PersonalAgentBusyError
                ? error.code
                : typeof error === "object" &&
                    error !== null &&
                    "code" in error &&
                    typeof error.code === "string"
                  ? error.code
                  : arkErrorCode(error),
            arkRequestId: arkRequestId(error),
          }
        : {}),
    });
  }
}
