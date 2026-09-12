import { describe, expect, it, vi } from "vitest";
import {
  ArkGatewayError,
  InMemoryArkGateway,
} from "../packages/ark-client/src/index.js";
import {
  AgentConflictError,
  AgentReferencedError,
  InvalidModelError,
  PlatformAgentService,
  ResourceNotFoundError,
  type PlatformAgentRecord,
  type PlatformAgentRepository,
} from "../packages/domain/src/index.js";

const adminId = "00000000-0000-4000-8000-000000000001";
const userId = "00000000-0000-4000-8000-000000000002";
const agentId = "00000000-0000-4000-8000-000000000003";
const requestId = "req-1";
const input = {
  name: "Research",
  description: "Find evidence",
  modelId: "model-a",
  systemPrompt: "Be precise.",
};

function createRepository() {
  const records = new Map<string, PlatformAgentRecord>();
  const audits: Array<Parameters<PlatformAgentRepository["audit"]>[0]> = [];
  let references = { assignments: 0, sessions: 0 };
  const repository: PlatformAgentRepository = {
    async list() {
      return [...records.values()];
    },
    async findById(id) {
      return records.get(id);
    },
    async createProvisioning(record) {
      const created: PlatformAgentRecord = {
        ...record,
        arkAgentId: `pending:${record.id}`,
        arkVersion: "0",
        status: "provisioning",
        lastErrorCode: null,
      };
      records.set(record.id, created);
      return created;
    },
    async markProvisioned(id, upstream) {
      const current = records.get(id)!;
      const updated = {
        ...current,
        arkAgentId: upstream.arkAgentId,
        arkVersion: upstream.arkVersion,
        status: "active" as const,
        lastErrorCode: null,
      };
      records.set(id, updated);
      return updated;
    },
    async markFailure(id, status, errorCode) {
      const updated = {
        ...records.get(id)!,
        status,
        lastErrorCode: errorCode,
      };
      records.set(id, updated);
      return updated;
    },
    async update(id, update) {
      const updated = { ...records.get(id)!, ...update };
      records.set(id, updated);
      return updated;
    },
    async beginDelete(id, updatedBy) {
      const current = records.get(id);
      if (!current) return undefined;
      if (references.assignments > 0 || references.sessions > 0) {
        return { agent: current, previousStatus: current.status, references };
      }
      const agent = {
        ...current,
        status: "deleting" as const,
        updatedBy,
      };
      records.set(id, agent);
      return { agent, previousStatus: current.status, references };
    },
    async remove(id) {
      records.delete(id);
    },
    async assignDefault(assignment) {
      return {
        userId: assignment.userId,
        platformAgentId: assignment.platformAgentId,
        assignedBy: assignment.assignedBy,
        assignedAt: new Date("2026-09-06T00:00:00.000Z"),
      };
    },
    async listUsers() {
      return { users: [], nextCursor: null };
    },
    async setUserStatus() {
      return undefined;
    },
    async setUserRole() {
      return undefined;
    },
    async revokeUserSessions() {
      return undefined;
    },
    async updateUserQuota(quota) {
      const effective = {
        personalAgentLimit: quota.personalAgentLimit ?? 10,
        concurrentSessionLimit: quota.concurrentSessionLimit ?? 2,
        dailySessionLimit: quota.dailySessionLimit ?? 25,
        monthlyTokenLimit: quota.monthlyTokenLimit ?? 1000,
      };
      return {
        previous: effective,
        effective,
        overridden: {
          personalAgentLimit: quota.personalAgentLimit != null,
          concurrentSessionLimit: quota.concurrentSessionLimit != null,
          dailySessionLimit: quota.dailySessionLimit != null,
          monthlyTokenLimit: quota.monthlyTokenLimit != null,
        },
        monthTokens: 0,
      };
    },
    async audit(entry) {
      audits.push(entry);
    },
  };
  return {
    repository,
    records,
    audits,
    setReferences(value: typeof references) {
      references = value;
    },
  };
}

function createService(
  repository: PlatformAgentRepository,
  ark = new InMemoryArkGateway(),
) {
  return {
    ark,
    service: new PlatformAgentService({
      repository,
      ark,
      modelAllowlist: ["model-a"],
      createId: () => agentId,
      passwordHasher: {
        hash: async (password: string) => `hashed:${password}`,
      },
    }),
  };
}

describe("PlatformAgentService", () => {
  it("creates locally before Ark with the fixed toolset and audits success", async () => {
    const state = createRepository();
    const createProvisioning = vi.spyOn(state.repository, "createProvisioning");
    const { service, ark } = createService(state.repository);
    const createAgent = vi.spyOn(ark, "createAgent");

    const created = await service.create(input, { adminId, requestId });

    expect(createProvisioning).toHaveBeenCalledBefore(createAgent);
    expect(ark.calls[0]).toMatchObject({
      operation: "createAgent",
      input: {
        ...input,
        toolsetId: "agent_toolset_20260701",
        toolPermission: "always_allow",
      },
      correlationId: requestId,
    });
    expect(created).toMatchObject({
      id: agentId,
      arkAgentId: "agent-1",
      arkVersion: "1",
      status: "active",
    });
    expect(state.audits).toContainEqual(
      expect.objectContaining({
        action: "platform_agent.create",
        resourceId: agentId,
        result: "succeeded",
      }),
    );
  });

  it("rejects models outside the allowlist before local or upstream writes", async () => {
    const state = createRepository();
    const { service, ark } = createService(state.repository);

    await expect(
      service.create({ ...input, modelId: "model-x" }, { adminId, requestId }),
    ).rejects.toBeInstanceOf(InvalidModelError);

    expect(state.records).toHaveLength(0);
    expect(ark.calls).toHaveLength(0);
  });

  it("keeps unknown create outcomes provisioning and marks definite failures failed", async () => {
    const unknownState = createRepository();
    const unknown = createService(unknownState.repository);
    unknown.ark.failNext("createAgent", "connection_failure");

    await expect(
      unknown.service.create(input, { adminId, requestId }),
    ).rejects.toMatchObject({ category: "unknown_write_outcome" });
    expect(unknownState.records.get(agentId)).toMatchObject({
      status: "provisioning",
      lastErrorCode: "ARK_UNKNOWN_WRITE_OUTCOME",
    });

    const failedState = createRepository();
    const failed = createService(failedState.repository);
    failed.ark.failNext("createAgent", "unavailable");
    await expect(
      failed.service.create(input, { adminId, requestId }),
    ).rejects.toBeInstanceOf(ArkGatewayError);
    expect(failedState.records.get(agentId)).toMatchObject({
      status: "failed",
      lastErrorCode: "ARK_UNAVAILABLE",
    });
  });

  it("updates Ark with the expected version and exposes conflicts without overwriting", async () => {
    const state = createRepository();
    const { service } = createService(state.repository);
    const created = await service.create(input, { adminId, requestId });

    await expect(
      service.update(
        created.id,
        { name: "Changed", arkVersion: "0" },
        { adminId, requestId },
      ),
    ).rejects.toBeInstanceOf(AgentConflictError);
    expect(state.records.get(created.id)?.name).toBe("Research");
    expect(state.audits).toContainEqual(
      expect.objectContaining({
        action: "platform_agent.update",
        result: "failed",
        errorCode: "ARK_CONFLICT",
      }),
    );

    const updated = await service.update(
      created.id,
      { name: "Changed", arkVersion: "1" },
      { adminId, requestId },
    );
    expect(updated).toMatchObject({ name: "Changed", arkVersion: "2" });
  });

  it("marks an unknown update outcome for reconciliation", async () => {
    const state = createRepository();
    const { service, ark } = createService(state.repository);
    const created = await service.create(input, { adminId, requestId });
    ark.failNext("updateAgent", "connection_failure");

    await expect(
      service.update(
        created.id,
        { name: "Possibly changed", arkVersion: "1" },
        { adminId, requestId },
      ),
    ).rejects.toMatchObject({ category: "unknown_write_outcome" });
    expect(state.records.get(created.id)).toMatchObject({
      status: "failed",
      lastErrorCode: "ARK_UNKNOWN_WRITE_OUTCOME",
      name: "Research",
      arkVersion: "1",
    });
  });

  it("enables and disables locally while preserving old session references", async () => {
    const state = createRepository();
    const { service } = createService(state.repository);
    const created = await service.create(input, { adminId, requestId });

    await expect(
      service.update(
        created.id,
        { status: "disabled" },
        { adminId, requestId },
      ),
    ).resolves.toMatchObject({ status: "disabled" });
    await expect(
      service.update(created.id, { status: "active" }, { adminId, requestId }),
    ).resolves.toMatchObject({ status: "active" });
  });

  it("blocks referenced deletion before Ark and deletes an unreferenced Agent", async () => {
    const state = createRepository();
    const { service, ark } = createService(state.repository);
    const beginDelete = vi.spyOn(state.repository, "beginDelete");
    await service.create(input, { adminId, requestId });
    state.setReferences({ assignments: 1, sessions: 2 });

    await expect(
      service.delete(agentId, { adminId, requestId }),
    ).rejects.toEqual(new AgentReferencedError(1, 2));
    expect(
      ark.calls.filter(({ operation }) => operation === "deleteAgent"),
    ).toHaveLength(0);
    expect(beginDelete).toHaveBeenCalledWith(agentId, adminId);

    state.setReferences({ assignments: 0, sessions: 0 });
    await service.delete(agentId, { adminId, requestId });
    expect(state.records.has(agentId)).toBe(false);
  });

  it("removes a failed never-provisioned Agent without calling Ark", async () => {
    const state = createRepository();
    const { service, ark } = createService(state.repository);
    ark.failNext("createAgent", "connection_failure");

    await expect(
      service.create(input, { adminId, requestId }),
    ).rejects.toMatchObject({ category: "unknown_write_outcome" });
    expect(state.records.get(agentId)).toMatchObject({
      arkAgentId: `pending:${agentId}`,
      arkVersion: "0",
    });

    await service.delete(agentId, { adminId, requestId });

    expect(state.records.has(agentId)).toBe(false);
    expect(
      ark.calls.filter(({ operation }) => operation === "deleteAgent"),
    ).toHaveLength(0);
    expect(state.audits).toContainEqual(
      expect.objectContaining({
        action: "platform_agent.delete",
        result: "succeeded",
      }),
    );
  });

  it("assigns only active Agents and rejects missing Agents", async () => {
    const state = createRepository();
    const { service } = createService(state.repository);

    await expect(
      service.assignDefault(userId, agentId, { adminId, requestId }),
    ).rejects.toBeInstanceOf(ResourceNotFoundError);
    expect(state.audits).toContainEqual(
      expect.objectContaining({
        action: "user_default_agent.assign",
        result: "failed",
      }),
    );

    await service.create(input, { adminId, requestId });
    await expect(
      service.assignDefault(userId, agentId, { adminId, requestId }),
    ).resolves.toMatchObject({ userId, platformAgentId: agentId });
  });

  it("classifies quota audit entries as user_quota resources", async () => {
    const state = createRepository();
    const { service } = createService(state.repository);

    await service.updateUserQuota(
      userId,
      {
        personalAgentLimit: 3,
        concurrentSessionLimit: 1,
        dailySessionLimit: 5,
        monthlyTokenLimit: 500,
      },
      { adminId, requestId },
    );

    expect(state.audits).toContainEqual(
      expect.objectContaining({
        action: "user_quota.update",
        resourceType: "user_quota",
        resourceId: userId,
        ownerUserId: userId,
      }),
    );
  });

  it("validates quota updates before persistence and audits failures", async () => {
    const state = createRepository();
    const update = vi.spyOn(state.repository, "updateUserQuota");
    const { service } = createService(state.repository);

    await expect(
      service.updateUserQuota(
        userId,
        {
          personalAgentLimit: -1,
          concurrentSessionLimit: 1,
          dailySessionLimit: 5,
          monthlyTokenLimit: 500,
        },
        { adminId, requestId },
      ),
    ).rejects.toMatchObject({ name: "ZodError" });

    expect(update).not.toHaveBeenCalled();
    expect(state.audits).toContainEqual(
      expect.objectContaining({
        action: "user_quota.update",
        resourceType: "user_quota",
        resourceId: userId,
        ownerUserId: userId,
        result: "failed",
        errorCode: "VALIDATION_FAILED",
      }),
    );
  });
});
