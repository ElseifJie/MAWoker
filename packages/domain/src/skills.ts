import type { ArkGateway, ArkSkillInput } from "@pwa/ark-client";
import { arkErrorCode, arkRequestId, isArkCategory } from "./ark-errors.js";
import { ResourceNotFoundError } from "./errors.js";
import {
  sameAgentSkillBindings,
  type AgentSkillBinding,
  type UserAgentService,
} from "./user-agents.js";

export type SkillStatus = "provisioning" | "active" | "failed" | "deleting";

export interface SkillRecord {
  id: string;
  /** Null marks a platform preset Skill managed by administrators. */
  ownerUserId: string | null;
  arkSkillId: string;
  /** Ark-parsed package name from the uploaded SKILL.md. */
  name: string;
  displayTitle: string;
  description: string;
  latestVersion: string;
  source: "custom" | "skill_hub";
  fileName: string;
  fileSize: number;
  status: SkillStatus;
  lastErrorCode: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface SkillUpload {
  file: {
    name: string;
    contentType: string;
    bytes: Uint8Array;
  };
  displayTitle?: string | undefined;
  description?: string | undefined;
}

export type SkillScope = "custom" | "preset";

export interface SkillListQuery {
  scope: SkillScope;
  search?: string | undefined;
}

export interface SkillAuditEntry {
  actorUserId: string;
  ownerUserId: string | null;
  action: string;
  resourceType: "skill";
  resourceId: string;
  result: "succeeded" | "failed";
  requestId: string;
  arkRequestId?: string | undefined;
  errorCode?: string | undefined;
}

export interface SkillRepository {
  findOwned(userId: string, id: string): PromiseLike<SkillRecord | undefined>;
  findPlatform(id: string): PromiseLike<SkillRecord | undefined>;
  listForOwner(userId: string, search: string | null): PromiseLike<SkillRecord[]>;
  listPlatform(search: string | null): PromiseLike<SkillRecord[]>;
  /**
   * The bindings a user's exclusive default Agent must carry: every active
   * Skill they own, pinned to its current upstream version.
   */
  listActiveBindingsForOwner(userId: string): PromiseLike<AgentSkillBinding[]>;
  /** Resolves a user-selected set of Skill ids into Ark bindings. */
  findSelectableBindings(
    userId: string,
    skillIds: string[],
  ): PromiseLike<AgentSkillBinding[]>;
  /**
   * The owner's other active Skill carrying the same Ark-parsed package name,
   * so a re-upload can replace it instead of accumulating duplicates. The
   * (name, owner) pair is the storage identity of a Skill.
   */
  findActiveByName(
    ownerUserId: string | null,
    name: string,
    excludeId: string,
  ): PromiseLike<SkillRecord | undefined>;
  createProvisioning(
    record: Pick<
      SkillRecord,
      "id" | "ownerUserId" | "displayTitle" | "description" | "fileName" | "fileSize"
    >,
  ): PromiseLike<SkillRecord>;
  markProvisioned(
    id: string,
    upstream: {
      arkSkillId: string;
      name: string;
      latestVersion: string;
      source: "custom" | "skill_hub";
    },
  ): PromiseLike<SkillRecord>;
  markFailure(
    id: string,
    status: "provisioning" | "failed" | "deleting",
    errorCode: string,
  ): PromiseLike<SkillRecord>;
  updateMetadata(
    id: string,
    input: { displayTitle?: string; description?: string },
  ): PromiseLike<SkillRecord>;
  /**
   * Editing re-uploads a package: Ark exposes no Skill update API, so the row
   * swaps in the fresh upstream identity and the sync rebinds the Agents.
   */
  replaceUpstream(
    id: string,
    upstream: {
      arkSkillId: string;
      name: string;
      latestVersion: string;
      source: "custom" | "skill_hub";
    },
    file: { fileName: string; fileSize: number },
  ): PromiseLike<SkillRecord>;
  remove(id: string): PromiseLike<void>;
  audit(entry: SkillAuditEntry): PromiseLike<void>;
}

/**
 * Keeps a user's exclusive default Agent aligned with their Skill library, and
 * cleans manual bindings when a Skill disappears.
 */
export interface DefaultAgentSync {
  ensureAndBind(
    userId: string,
    bindings: AgentSkillBinding[],
    context: { userId: string; requestId: string },
  ): Promise<void>;
  unbindEverywhere(skillId: string): Promise<void>;
}

export class InvalidSkillPackageError extends Error {
  readonly code = "INVALID_SKILL_PACKAGE";

  constructor(message = "Skill packages must be non-empty .zip archives") {
    super(message);
    this.name = "InvalidSkillPackageError";
  }
}

export class SkillNotSelectableError extends Error {
  readonly code = "SKILL_NOT_AVAILABLE";

  constructor() {
    super("One or more selected Skills are not available");
    this.name = "SkillNotSelectableError";
  }
}

export type SyncOutcome =
  | { synced: true }
  | { synced: false; errorCode: string };

/**
 * The production {@link DefaultAgentSync}: the user's exclusive default Agent
 * is provisioned on first sight and rebound whenever their Skill library
 * changes; manual Agents that pinned a deleted Skill lose just that binding.
 */
export class UserDefaultAgentSynchronizer implements DefaultAgentSync {
  constructor(
    private readonly agents: Pick<
      UserAgentService,
      "ensureAutoDefault" | "updateAgentSkills" | "listAgentsBoundToSkill"
    >,
  ) {}

  async ensureAndBind(
    userId: string,
    bindings: AgentSkillBinding[],
    context: { userId: string; requestId: string },
  ): Promise<void> {
    const agent = await this.agents.ensureAutoDefault(userId, bindings, context);
    if (!sameAgentSkillBindings(agent.skills, bindings)) {
      await this.agents.updateAgentSkills(agent.id, bindings, context);
    }
  }

  async unbindEverywhere(skillId: string): Promise<void> {
    const bound = await this.agents.listAgentsBoundToSkill(skillId);
    for (const agent of bound) {
      await this.agents.updateAgentSkills(
        agent.id,
        agent.skills.filter((binding) => binding.skillId !== skillId),
        {
          userId: agent.ownerUserId,
          requestId: `skill-unbind:${skillId}:${agent.id}`,
        },
      );
    }
  }
}

export interface SkillMutationContext {
  userId: string;
  requestId: string;
  /** Set by admin routes mutating platform preset Skills. */
  platformTarget?: boolean | undefined;
}

const MAX_SKILL_BYTES = 50 * 1024 * 1024;

function assertPackage(file: SkillUpload["file"]): void {
  if (!/\.zip$/i.test(file.name)) {
    throw new InvalidSkillPackageError();
  }
  if (file.bytes.byteLength === 0 || file.bytes.byteLength > MAX_SKILL_BYTES) {
    throw new InvalidSkillPackageError(
      `Skill packages must be between 1 byte and ${MAX_SKILL_BYTES} bytes`,
    );
  }
}

function defaultTitle(fileName: string): string {
  const base = fileName.replace(/\.zip$/i, "").trim();
  return (base || "Skill").slice(0, 80);
}

export class SkillService {
  constructor(
    private readonly dependencies: {
      repository: SkillRepository;
      ark: Pick<ArkGateway, "createSkill" | "getSkill">;
      defaultAgents: DefaultAgentSync;
      createId: () => string;
    },
  ) {}

  list(
    userId: string,
    query: SkillListQuery,
  ): PromiseLike<SkillRecord[]> {
    const search = query.search?.trim() ?? "";
    return query.scope === "preset"
      ? this.dependencies.repository.listPlatform(search || null)
      : this.dependencies.repository.listForOwner(userId, search || null);
  }

  async upload(
    input: SkillUpload,
    context: SkillMutationContext,
  ): Promise<{ skill: SkillRecord; defaultAgentSync: SyncOutcome }> {
    assertPackage(input.file);
    const displayTitle = (input.displayTitle ?? "").trim() ||
      defaultTitle(input.file.name);
    const id = this.dependencies.createId();
    await this.dependencies.repository.createProvisioning({
      id,
      ownerUserId: context.platformTarget ? null : context.userId,
      displayTitle,
      description: (input.description ?? "").trim(),
      fileName: input.file.name,
      fileSize: input.file.bytes.byteLength,
    });

    let skill: SkillRecord;
    try {
      const upstream = await this.dependencies.ark.createSkill(
        this.arkUpload(input, displayTitle),
        { correlationId: context.requestId },
      );
      // The (package name, owner) pair is the Skill's storage identity: a
      // re-upload replaces the owner's existing row instead of accumulating a
      // same-named duplicate (Ark rejects both bound to one Agent). The swap
      // happens while the new row is still provisioning, before the unique
      // active-name index would see both rows at once.
      const duplicate =
        upstream.name !== ""
          ? await this.dependencies.repository.findActiveByName(
              context.platformTarget ? null : context.userId,
              upstream.name,
              id,
            )
          : undefined;
      const upstreamIdentity = {
        arkSkillId: upstream.id,
        name: upstream.name,
        latestVersion: upstream.latestVersion,
        source: upstream.source,
      };
      if (duplicate) {
        skill = await this.dependencies.repository.replaceUpstream(
          duplicate.id,
          upstreamIdentity,
          {
            fileName: input.file.name,
            fileSize: input.file.bytes.byteLength,
          },
        );
        if (input.displayTitle?.trim()) {
          skill = await this.dependencies.repository.updateMetadata(
            duplicate.id,
            { displayTitle },
          );
        }
        await this.dependencies.repository.remove(id);
      } else {
        skill = await this.dependencies.repository.markProvisioned(
          id,
          upstreamIdentity,
        );
      }
    } catch (error) {
      const errorCode = arkErrorCode(error);
      await this.dependencies.repository.markFailure(
        id,
        isArkCategory(error, "unknown_write_outcome")
          ? "provisioning"
          : "failed",
        errorCode,
      );
      await this.audit(context, "skill.create", id, "failed", error);
      throw error;
    }
    await this.audit(context, "skill.create", id, "succeeded");

    const defaultAgentSync = context.platformTarget
      ? ({ synced: true } as const)
      : await this.syncDefaultAgent(context.userId, context);
    return { skill, defaultAgentSync };
  }

  async update(
    id: string,
    input: {
      file?: SkillUpload["file"] | undefined;
      displayTitle?: string | undefined;
      description?: string | undefined;
    },
    context: SkillMutationContext,
  ): Promise<{ skill: SkillRecord; defaultAgentSync: SyncOutcome }> {
    const current = await this.requireEditable(id, context);
    const hasFile =
      input.file !== undefined && input.file.bytes.byteLength > 0;
    if (hasFile && input.file) assertPackage(input.file);
    const displayTitle = input.displayTitle?.trim() || undefined;
    const description = input.description?.trim();

    let skill: SkillRecord;
    if (hasFile && input.file) {
      try {
        const upstream = await this.dependencies.ark.createSkill(
          this.arkUpload({ file: input.file }, displayTitle ?? current.displayTitle),
          { correlationId: context.requestId },
        );
        skill = await this.dependencies.repository.replaceUpstream(
          id,
          {
            arkSkillId: upstream.id,
            name: upstream.name,
            latestVersion: upstream.latestVersion,
            source: upstream.source,
          },
          {
            fileName: input.file.name,
            fileSize: input.file.bytes.byteLength,
          },
        );
      } catch (error) {
        const errorCode = arkErrorCode(error);
        await this.dependencies.repository.markFailure(
          id,
          isArkCategory(error, "unknown_write_outcome")
            ? "provisioning"
            : "failed",
          errorCode,
        );
        await this.audit(context, "skill.update", id, "failed", error);
        throw error;
      }
    } else {
      skill = await this.dependencies.repository.updateMetadata(id, {
        ...(displayTitle !== undefined ? { displayTitle } : {}),
        ...(description !== undefined ? { description } : {}),
      });
    }
    await this.audit(context, "skill.update", id, "succeeded");

    const defaultAgentSync = current.ownerUserId
      ? await this.syncDefaultAgent(current.ownerUserId, context)
      : ({ synced: true } as const);
    return { skill, defaultAgentSync };
  }

  async delete(
    id: string,
    context: SkillMutationContext,
  ): Promise<SyncOutcome> {
    const current = await this.requireEditable(id, context);
    // Ark has no Skill delete API: unbind locally, then drop the row. The
    // upstream object becomes unreachable for new bindings but existing
    // Sessions keep their Agent snapshot.
    await this.dependencies.defaultAgents.unbindEverywhere(id);
    await this.dependencies.repository.remove(id);
    await this.audit(context, "skill.delete", id, "succeeded");
    return current.ownerUserId
      ? this.syncDefaultAgent(current.ownerUserId, context)
      : ({ synced: true } as const);
  }

  /**
   * Resolves user-picked Skill ids for a manual Agent create/update. Users may
   * pick their own Skills plus platform presets; anything else is rejected.
   */
  async resolveBindings(
    userId: string,
    skillIds: string[],
  ): Promise<AgentSkillBinding[]> {
    const unique = [...new Set(skillIds)];
    if (unique.length === 0) return [];
    const bindings = await this.dependencies.repository.findSelectableBindings(
      userId,
      unique,
    );
    if (bindings.length !== unique.length) {
      throw new SkillNotSelectableError();
    }
    return bindings;
  }

  private arkUpload(input: SkillUpload, displayTitle: string): ArkSkillInput {
    return {
      file: {
        name: input.file.name,
        contentType: input.file.contentType || "application/zip",
        bytes: input.file.bytes,
      },
      displayTitle,
    };
  }

  /**
   * Requirement: the user's exclusive default Agent always carries every Skill
   * they own. A failed sync never fails the Skill mutation itself — it is
   * reported to the caller and retried on the next Skill change.
   */
  private async syncDefaultAgent(
    userId: string,
    context: SkillMutationContext,
  ): Promise<SyncOutcome> {
    const bindings =
      await this.dependencies.repository.listActiveBindingsForOwner(userId);
    try {
      await this.dependencies.defaultAgents.ensureAndBind(
        userId,
        bindings,
        context,
      );
      return { synced: true };
    } catch (error) {
      return {
        synced: false,
        errorCode:
          error instanceof Error && "code" in error && typeof error.code === "string"
            ? error.code
            : arkErrorCode(error),
      };
    }
  }

  private async requireEditable(
    id: string,
    context: SkillMutationContext,
  ): Promise<SkillRecord> {
    const record = context.platformTarget
      ? await this.dependencies.repository.findPlatform(id)
      : await this.dependencies.repository.findOwned(context.userId, id);
    if (!record) throw new ResourceNotFoundError();
    return record;
  }

  private audit(
    context: SkillMutationContext,
    action: string,
    resourceId: string,
    result: "succeeded" | "failed",
    error?: unknown,
  ): PromiseLike<void> {
    return this.dependencies.repository.audit({
      actorUserId: context.userId,
      ownerUserId: context.platformTarget ? null : context.userId,
      action,
      resourceType: "skill",
      resourceId,
      result,
      requestId: context.requestId,
      ...(error
        ? {
            errorCode:
              error instanceof Error &&
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
