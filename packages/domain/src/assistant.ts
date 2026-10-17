import { ResourceNotFoundError } from "./errors.js";

export interface AssistantProfileRecord {
  ownerUserId: string;
  defaultAgentId: string | null;
  displayName: string;
  persona: string;
  preferences: Record<string, unknown>;
  revision: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface AssistantAgentSummary {
  id: string;
  name: string;
  modelId: string;
  status: string;
  arkAgentId: string;
}

export interface AssistantProfileRepository {
  find(ownerUserId: string): PromiseLike<AssistantProfileRecord | undefined>;
  ensure(ownerUserId: string): PromiseLike<AssistantProfileRecord>;
  findDefaultAgent(
    ownerUserId: string,
  ): PromiseLike<AssistantAgentSummary | undefined>;
  findAgent(
    ownerUserId: string,
    agentId: string,
  ): PromiseLike<AssistantAgentSummary | undefined>;
  attachDefault(
    ownerUserId: string,
    agentId: string,
  ): PromiseLike<AssistantProfileRecord | undefined>;
  update(
    ownerUserId: string,
    input: {
      displayName?: string;
      persona?: string;
      preferences?: Record<string, unknown>;
      expectedRevision?: number;
    },
  ): PromiseLike<AssistantProfileRecord | undefined>;
}

export class AssistantProfileConflictError extends Error {
  constructor() {
    super("Assistant profile changed concurrently");
    this.name = "AssistantProfileConflictError";
  }
}

export interface AssistantView {
  profile: AssistantProfileRecord;
  agent: AssistantAgentSummary | null;
}

/**
 * The account's one default assistant. The runtime Agent is the existing
 * auto-default `personal_agents` row; this service lazily links it so no second
 * source of "which assistant is default" exists.
 */
export class AssistantProfileService {
  constructor(
    private readonly dependencies: {
      repository: AssistantProfileRepository;
    },
  ) {}

  async get(userId: string): Promise<AssistantView> {
    let profile = await this.dependencies.repository.find(userId);
    if (!profile) profile = await this.dependencies.repository.ensure(userId);

    let agent = profile.defaultAgentId
      ? await this.dependencies.repository.findAgent(
          userId,
          profile.defaultAgentId,
        )
      : undefined;
    if (!agent) {
      const fallback =
        await this.dependencies.repository.findDefaultAgent(userId);
      if (fallback) {
        agent = fallback;
        if (!profile.defaultAgentId) {
          const attached = await this.dependencies.repository.attachDefault(
            userId,
            fallback.id,
          );
          if (attached) profile = attached;
        }
      }
    }
    return { profile, agent: agent ?? null };
  }

  async update(
    userId: string,
    input: {
      displayName?: string;
      persona?: string;
      preferences?: Record<string, unknown>;
      expectedRevision?: number;
    },
  ): Promise<AssistantView> {
    const updated = await this.dependencies.repository.update(userId, input);
    if (!updated) {
      const existing = await this.dependencies.repository.find(userId);
      if (!existing) throw new ResourceNotFoundError();
      throw new AssistantProfileConflictError();
    }
    return this.get(userId);
  }
}
