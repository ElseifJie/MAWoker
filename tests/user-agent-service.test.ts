import { describe, expect, it, vi } from "vitest";
import {
  ArkGatewayError,
  HttpArkGateway,
  InMemoryArkGateway,
} from "../packages/ark-client/src/index.js";
import { PersonalAgentReconciliationProcessor } from "../apps/worker/src/personal-agent-reconciliation.js";
import {
  AgentConflictError,
  AgentReferencedError,
  InvalidModelError,
  NoDefaultAgentError,
  PersonalAgentQuotaExceededError,
  ResourceNotFoundError,
  UserAgentService,
  type PersonalAgentRecord,
  type UserAgentRepository,
} from "../packages/domain/src/index.js";

const userId = "00000000-0000-4000-8000-000000000001";
const otherUserId = "00000000-0000-4000-8000-000000000002";
const personalAgentId = "00000000-0000-4000-8000-000000000003";
const platformAgentId = "00000000-0000-4000-8000-000000000004";
const requestId = "req-user-agent";
const input = {
  name: "Research",
  description: "Find evidence",
  modelId: "model-a",
  systemPrompt: "Be precise.",
};

function createRepository(limit = 10) {
  const personal = new Map<string, PersonalAgentRecord>();
  const reconciliationIntents = new Map<
    string,
    {
      operation: "create" | "update" | "delete";
      configuration?: typeof input;
      arkVersion?: string;
    }
  >();
  const sessions: Array<{
    id: string;
    userId: string;
    agentId: string;
    version: string;
    createdAt: Date;
  }> = [];
  let defaultAgent:
    | {
        id: string;
        arkAgentId: string;
        arkVersion: string;
      }
    | undefined = {
    id: platformAgentId,
    arkAgentId: "ark-platform",
    arkVersion: "3",
  };

  const repository: UserAgentRepository = {
    async listAvailable(ownerUserId) {
      return [
        ...(defaultAgent
          ? [
              {
                ...defaultAgent,
                name: "Platform",
                description: "Shared",
                modelId: "model-a",
                systemPrompt: "Hidden",
                status: "active" as const,
                kind: "platform" as const,
                editable: false as const,
              },
            ]
          : []),
        ...[...personal.values()]
          .filter(({ ownerUserId: owner }) => owner === ownerUserId)
          .map((agent) => ({
            ...agent,
            kind: "personal" as const,
            editable: true as const,
          })),
      ];
    },
    async findRecentAvailable(ownerUserId) {
      const available = new Set(
        (await repository.listAvailable(ownerUserId))
          .filter(({ status }) => status === "active")
          .map(({ id }) => id),
      );
      return sessions
        .filter(
          (session) =>
            session.userId === ownerUserId && available.has(session.agentId),
        )
        .sort(
          (left, right) =>
            right.createdAt.getTime() - left.createdAt.getTime() ||
            right.id.localeCompare(left.id),
        )[0]?.agentId;
    },
    async findDefaultActive() {
      return defaultAgent?.id;
    },
    async findAvailableById(ownerUserId, id) {
      return (await repository.listAvailable(ownerUserId)).find(
        (agent) => agent.id === id && agent.status === "active",
      );
    },
    async createProvisioning(record) {
      const owned = [...personal.values()].filter(
        ({ ownerUserId }) => ownerUserId === record.ownerUserId,
      ).length;
      if (owned >= limit) return undefined;
      const created: PersonalAgentRecord = {
        ...record,
        arkAgentId: `pending:${record.id}`,
        arkVersion: "0",
        status: "provisioning",
        lastErrorCode: null,
      };
      personal.set(record.id, created);
      reconciliationIntents.set(record.id, { operation: "create" });
      return created;
    },
    async findOwned(ownerUserId, id) {
      const agent = personal.get(id);
      return agent?.ownerUserId === ownerUserId ? agent : undefined;
    },
    async markProvisioned(id, ownerUserId, upstream) {
      const current = personal.get(id)!;
      const updated = {
        ...current,
        ...upstream,
        arkVersion: upstream.arkVersion,
        status: "active" as const,
        lastErrorCode: null,
      };
      if (current.ownerUserId === ownerUserId) personal.set(id, updated);
      reconciliationIntents.delete(id);
      return updated;
    },
    async saveUpdateIntent(id, ownerUserId, configuration, arkVersion) {
      const current = personal.get(id);
      if (!current || current.ownerUserId !== ownerUserId) {
        throw new Error("Expected owned personal Agent");
      }
      reconciliationIntents.set(id, {
        operation: "update",
        configuration,
        arkVersion,
      });
    },
    async markFailure(id, ownerUserId, status, errorCode) {
      const current = personal.get(id)!;
      const updated = { ...current, status, lastErrorCode: errorCode };
      if (current.ownerUserId === ownerUserId) personal.set(id, updated);
      return updated;
    },
    async markDefinitiveCreateFailure(id, ownerUserId, errorCode) {
      const current = personal.get(id)!;
      const updated = {
        ...current,
        status: "failed" as const,
        lastErrorCode: errorCode,
      };
      if (current.ownerUserId === ownerUserId) {
        personal.set(id, updated);
        reconciliationIntents.delete(id);
      }
      return updated;
    },
    async markCreatePersistenceFailure(id, ownerUserId, upstream) {
      const current = personal.get(id)!;
      const updated = {
        ...current,
        ...upstream,
        status: "failed" as const,
        lastErrorCode: "DB_PERSISTENCE_FAILED",
      };
      if (current.ownerUserId === ownerUserId) personal.set(id, updated);
      return updated;
    },
    async markUpdatePersistenceFailure(id, ownerUserId, upstreamVersion) {
      const current = personal.get(id)!;
      const updated = {
        ...current,
        arkVersion: upstreamVersion,
        status: "failed" as const,
        lastErrorCode: "DB_PERSISTENCE_FAILED",
      };
      if (current.ownerUserId === ownerUserId) personal.set(id, updated);
      return updated;
    },
    async update(id, ownerUserId, update) {
      const current = personal.get(id)!;
      const updated = { ...current, ...update };
      if (current.ownerUserId === ownerUserId) personal.set(id, updated);
      reconciliationIntents.delete(id);
      return updated;
    },
    async beginDelete(id, ownerUserId, enqueueReconciliation = true) {
      const current = personal.get(id);
      if (!current || current.ownerUserId !== ownerUserId) return undefined;
      if (
        current.status === "provisioning" ||
        (current.arkAgentId.startsWith("pending:") &&
          current.status !== "failed") ||
        reconciliationIntents.get(id)?.operation === "create"
      ) {
        return {
          agent: current,
          conflict: "create_reconciliation_pending" as const,
        };
      }
      const references = sessions.filter(
        (session) => session.userId === ownerUserId && session.agentId === id,
      ).length;
      if (references > 0) {
        return {
          agent: current,
          previousStatus: current.status,
          references: { sessions: references },
        };
      }
      const updated = { ...current, status: "deleting" as const };
      personal.set(id, updated);
      if (enqueueReconciliation) {
        reconciliationIntents.set(id, { operation: "delete" });
      }
      return {
        agent: updated,
        previousStatus: current.status,
        references: { sessions: 0 },
      };
    },
    async remove(id, ownerUserId) {
      if (personal.get(id)?.ownerUserId === ownerUserId) {
        personal.delete(id);
        reconciliationIntents.delete(id);
      }
    },
    async audit() {},
  };

  return {
    repository,
    personal,
    reconciliationIntents,
    sessions,
    clearDefault() {
      defaultAgent = undefined;
    },
  };
}

function createService(
  repository: UserAgentRepository,
  ark = new InMemoryArkGateway(),
) {
  return {
    ark,
    service: new UserAgentService({
      repository,
      ark,
      modelAllowlist: ["model-a"],
      createId: () => personalAgentId,
    }),
  };
}

describe("UserAgentService", () => {
  it("lists assigned platform and owned personal Agents and resolves recent deterministically", async () => {
    const state = createRepository();
    const { service } = createService(state.repository);
    await service.create(input, { userId, requestId });
    state.sessions.push(
      {
        id: "session-a",
        userId,
        agentId: platformAgentId,
        version: "2",
        createdAt: new Date("2026-09-06T00:00:00Z"),
      },
      {
        id: "session-z",
        userId,
        agentId: personalAgentId,
        version: "1",
        createdAt: new Date("2026-09-06T00:00:00Z"),
      },
    );

    await expect(service.list(userId)).resolves.toMatchObject({
      agents: [
        {
          id: platformAgentId,
          kind: "platform",
          editable: false,
          version: "3",
        },
        { id: personalAgentId, kind: "personal", editable: true, version: "1" },
      ],
      selection: { agentId: personalAgentId, source: "recent" },
      blocker: null,
    });
    expect(
      (await service.list(otherUserId)).agents.some(
        ({ id }) => id === personalAgentId,
      ),
    ).toBe(false);
  });

  it("falls back to the active default and returns a clear blocker when absent", async () => {
    const state = createRepository();
    const { service } = createService(state.repository);

    await expect(service.list(userId)).resolves.toMatchObject({
      selection: { agentId: platformAgentId, source: "default" },
      blocker: null,
    });

    state.clearDefault();
    await expect(service.list(userId)).resolves.toMatchObject({
      selection: null,
      blocker: {
        code: "NO_DEFAULT_AGENT",
        message: "Contact an administrator to assign a default Agent",
      },
    });
    await expect(service.resolveSelection(userId)).rejects.toBeInstanceOf(
      NoDefaultAgentError,
    );
  });

  it("creates with the fixed toolset and enforces model and personal quota", async () => {
    const state = createRepository(1);
    const { service, ark } = createService(state.repository);

    const created = await service.create(input, { userId, requestId });
    expect(created).toMatchObject({
      id: personalAgentId,
      ownerUserId: userId,
      status: "active",
      arkVersion: "1",
    });
    expect(ark.calls[0]).toMatchObject({
      operation: "createAgent",
      input: {
        ...input,
        toolsetId: "agent_toolset_20260701",
        toolPermission: "always_allow",
      },
    });
    await expect(
      service.create(input, { userId, requestId }),
    ).rejects.toBeInstanceOf(PersonalAgentQuotaExceededError);
    await expect(
      service.create(
        { ...input, modelId: "not-allowed" },
        { userId, requestId },
      ),
    ).rejects.toBeInstanceOf(InvalidModelError);
  });

  it("preserves durable create and update reconciliation states", async () => {
    const unknownCreateState = createRepository();
    const unknownCreate = createService(unknownCreateState.repository);
    unknownCreate.ark.failNext("createAgent", "connection_failure");
    await expect(
      unknownCreate.service.create(input, { userId, requestId }),
    ).rejects.toMatchObject({ category: "unknown_write_outcome" });
    expect(unknownCreateState.personal.get(personalAgentId)).toMatchObject({
      status: "provisioning",
      lastErrorCode: "ARK_UNKNOWN_WRITE_OUTCOME",
    });
    expect(
      unknownCreateState.reconciliationIntents.get(personalAgentId),
    ).toEqual({ operation: "create" });

    const failedState = createRepository();
    const failed = createService(failedState.repository);
    failed.ark.failNext("createAgent", "unavailable");
    await expect(
      failed.service.create(input, { userId, requestId }),
    ).rejects.toBeInstanceOf(ArkGatewayError);
    expect(failedState.personal.get(personalAgentId)).toMatchObject({
      status: "failed",
      lastErrorCode: "ARK_UNAVAILABLE",
    });
    expect(failedState.reconciliationIntents.has(personalAgentId)).toBe(false);

    const updateState = createRepository();
    const update = createService(updateState.repository);
    await update.service.create(input, { userId, requestId });
    update.ark.failNext("updateAgent", "connection_failure");
    await expect(
      update.service.update(
        personalAgentId,
        { name: "Maybe", arkVersion: "1" },
        { userId, requestId },
      ),
    ).rejects.toMatchObject({ category: "unknown_write_outcome" });
    expect(updateState.personal.get(personalAgentId)).toMatchObject({
      name: "Research",
      status: "failed",
      lastErrorCode: "ARK_UNKNOWN_WRITE_OUTCOME",
    });
  });

  it("records the upstream version when DB persistence fails after an Ark update", async () => {
    const state = createRepository();
    const { service } = createService(state.repository);
    await service.create(input, { userId, requestId });
    const update = vi
      .spyOn(state.repository, "update")
      .mockRejectedValueOnce(new Error("database unavailable"));

    await expect(
      service.update(
        personalAgentId,
        { name: "Changed upstream", arkVersion: "1" },
        { userId, requestId },
      ),
    ).rejects.toThrow("database unavailable");
    expect(update).toHaveBeenCalledTimes(1);
    expect(state.personal.get(personalAgentId)).toMatchObject({
      name: "Research",
      arkVersion: "2",
      status: "failed",
      lastErrorCode: "DB_PERSISTENCE_FAILED",
    });
  });

  it("persists update intent before Ark and retains it when both post-Ark writes fail", async () => {
    const state = createRepository();
    const { service, ark } = createService(state.repository);
    await service.create(input, { userId, requestId });
    const updateAgent = vi.spyOn(ark, "updateAgent");
    vi.spyOn(state.repository, "update").mockRejectedValueOnce(
      new Error("primary write unavailable"),
    );
    vi.spyOn(
      state.repository,
      "markUpdatePersistenceFailure",
    ).mockRejectedValueOnce(new Error("fallback write unavailable"));

    await expect(
      service.update(
        personalAgentId,
        { name: "Recovered name", arkVersion: "1" },
        { userId, requestId },
      ),
    ).rejects.toThrow("fallback write unavailable");

    expect(updateAgent).toHaveBeenCalledOnce();
    expect(state.reconciliationIntents.get(personalAgentId)).toEqual({
      operation: "update",
      configuration: { ...input, name: "Recovered name" },
      arkVersion: "1",
    });
    await expect(
      service.reconcileUpdate(
        personalAgentId,
        {
          configuration: { ...input, name: "Recovered name" },
          arkVersion: "1",
        },
        { userId, requestId: "worker-update-reconcile" },
      ),
    ).resolves.toMatchObject({
      name: "Recovered name",
      arkVersion: "2",
      status: "active",
    });
  });

  it("preserves Ark identity and quota when DB persistence fails after create", async () => {
    const state = createRepository(1);
    const { service, ark } = createService(state.repository);
    vi.spyOn(state.repository, "markProvisioned").mockRejectedValueOnce(
      new Error("database unavailable"),
    );

    await expect(service.create(input, { userId, requestId })).rejects.toThrow(
      "database unavailable",
    );
    expect(state.personal.get(personalAgentId)).toMatchObject({
      arkAgentId: "agent-1",
      arkVersion: "1",
      status: "failed",
      lastErrorCode: "DB_PERSISTENCE_FAILED",
    });

    await expect(
      service.create(input, { userId, requestId }),
    ).rejects.toBeInstanceOf(PersonalAgentQuotaExceededError);
    await expect(
      service.delete(personalAgentId, { userId, requestId }),
    ).rejects.toMatchObject({
      name: "PersonalAgentBusyError",
      code: "AGENT_BUSY",
    });
    expect(
      ark.calls.filter(({ operation }) => operation === "deleteAgent"),
    ).toHaveLength(0);
    await service.reconcileCreate(personalAgentId, {
      userId,
      requestId: "worker-create-reconcile",
    });
    await service.delete(personalAgentId, { userId, requestId });
    expect(
      ark.calls.filter(({ operation }) => operation === "deleteAgent"),
    ).toHaveLength(1);
  });

  it("recovers idempotently when both post-Ark create writes fail", async () => {
    const state = createRepository(1);
    const { service, ark } = createService(state.repository);
    const markProvisioned = vi
      .spyOn(state.repository, "markProvisioned")
      .mockRejectedValueOnce(new Error("primary write unavailable"));
    const markPersistenceFailure = vi
      .spyOn(state.repository, "markCreatePersistenceFailure")
      .mockRejectedValueOnce(new Error("fallback write unavailable"));

    await expect(service.create(input, { userId, requestId })).rejects.toThrow(
      "fallback write unavailable",
    );
    expect(markProvisioned).toHaveBeenCalledTimes(1);
    expect(markPersistenceFailure).toHaveBeenCalledTimes(1);
    expect(state.personal.get(personalAgentId)).toMatchObject({
      arkAgentId: `pending:${personalAgentId}`,
      arkVersion: "0",
      status: "provisioning",
    });
    expect(
      ark.calls.filter(({ operation }) => operation === "createAgent"),
    ).toEqual([
      expect.objectContaining({
        correlationId: `personal-agent-create:${personalAgentId}`,
        idempotencyKey: `personal-agent-create:${personalAgentId}`,
      }),
    ]);

    await expect(
      service.create(input, { userId, requestId: "req-retry" }),
    ).rejects.toBeInstanceOf(PersonalAgentQuotaExceededError);
    await expect(
      service.reconcileCreate(personalAgentId, {
        userId,
        requestId: "worker-reconcile",
      }),
    ).resolves.toMatchObject({
      arkAgentId: "agent-1",
      arkVersion: "1",
      status: "active",
    });
    expect(
      ark.calls.filter(({ operation }) => operation === "createAgent"),
    ).toEqual([
      expect.objectContaining({
        correlationId: `personal-agent-create:${personalAgentId}`,
        idempotencyKey: `personal-agent-create:${personalAgentId}`,
      }),
      expect.objectContaining({
        correlationId: `personal-agent-create:${personalAgentId}`,
        idempotencyKey: `personal-agent-create:${personalAgentId}`,
      }),
    ]);
  });

  it("keeps a malformed successful create queued and quota-counted until worker recovery", async () => {
    const state = createRepository(1);
    const operationId = `personal-agent-create:${personalAgentId}`;
    const idempotencyKeys: Array<string | null> = [];
    let upstreamCreated = false;
    const fetch = vi.fn(
      async (_input: string | URL | Request, init?: RequestInit) => {
        const key = new Headers(init?.headers).get("idempotency-key");
        idempotencyKeys.push(key);
        if (!upstreamCreated) {
          upstreamCreated = true;
          return new Response("{malformed");
        }
        expect(key).toBe(operationId);
        return Response.json({
          id: "agent-existing",
          version: 1,
          ...input,
          toolsetId: "agent_toolset_20260701",
          toolPermission: "always_allow",
        });
      },
    );
    const service = new UserAgentService({
      repository: state.repository,
      ark: new HttpArkGateway({
        baseUrl: "https://ark.example.com",
        apiKey: "secret",
        fetch,
        maxAttempts: 1,
      }),
      modelAllowlist: ["model-a"],
      createId: () => personalAgentId,
    });

    await expect(
      service.create(input, { userId, requestId }),
    ).rejects.toMatchObject({ category: "unknown_write_outcome" });
    expect(state.personal.get(personalAgentId)).toMatchObject({
      arkAgentId: `pending:${personalAgentId}`,
      arkVersion: "0",
      status: "provisioning",
      lastErrorCode: "ARK_UNKNOWN_WRITE_OUTCOME",
    });
    expect(state.reconciliationIntents.get(personalAgentId)).toEqual({
      operation: "create",
    });
    await expect(
      service.create(input, { userId, requestId: "quota-check" }),
    ).rejects.toBeInstanceOf(PersonalAgentQuotaExceededError);

    const jobs = {
      claim: vi.fn().mockImplementation(async () =>
        state.reconciliationIntents.has(personalAgentId)
          ? [
              {
                id: personalAgentId,
                ownerUserId: userId,
                type: "reconcile_personal_agent" as const,
                status: "running" as const,
                priority: 100,
                payload: { operation: "create", personalAgentId },
                attempts: 1,
                maxAttempts: 3,
                runAfter: new Date(),
                lockedAt: new Date(),
                lockedBy: "worker-1",
                createdAt: new Date(),
              },
            ]
          : [],
      ),
      succeed: vi.fn().mockResolvedValue(undefined),
      retry: vi.fn().mockResolvedValue(undefined),
    };
    const processor = new PersonalAgentReconciliationProcessor({
      jobs,
      service,
      workerId: "worker-1",
    });

    await expect(processor.runOnce()).resolves.toBe(1);
    expect(state.personal.get(personalAgentId)).toMatchObject({
      arkAgentId: "agent-existing",
      arkVersion: "1",
      status: "active",
      lastErrorCode: null,
    });
    expect(state.reconciliationIntents.has(personalAgentId)).toBe(false);
    expect(jobs.succeed).toHaveBeenCalledWith(personalAgentId, "worker-1");
    expect(jobs.retry).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(idempotencyKeys).toEqual([operationId, operationId]);
  });

  it("blocks deletion until create reconciliation completes", async () => {
    const state = createRepository();
    const { service, ark } = createService(state.repository);
    await state.repository.createProvisioning({
      id: personalAgentId,
      ownerUserId: userId,
      ...input,
    });

    await expect(
      service.delete(personalAgentId, { userId, requestId }),
    ).rejects.toMatchObject({
      name: "PersonalAgentBusyError",
      code: "AGENT_BUSY",
    });
    expect(state.personal.get(personalAgentId)).toMatchObject({
      status: "provisioning",
      arkAgentId: `pending:${personalAgentId}`,
    });
    expect(state.reconciliationIntents.get(personalAgentId)).toEqual({
      operation: "create",
    });
    expect(
      ark.calls.filter(({ operation }) => operation === "deleteAgent"),
    ).toHaveLength(0);

    await expect(
      service.reconcileCreate(personalAgentId, {
        userId,
        requestId: "worker-create-reconcile",
      }),
    ).resolves.toMatchObject({
      arkAgentId: "agent-1",
      status: "active",
    });
    await expect(
      service.delete(personalAgentId, {
        userId,
        requestId: "delete-after-create",
      }),
    ).resolves.toBeUndefined();
    expect(
      ark.calls.filter(({ operation }) => operation === "deleteAgent"),
    ).toEqual([
      expect.objectContaining({
        input: { agentId: "agent-1" },
      }),
    ]);
  });

  it("updates only owned Agents and rejects stale Ark versions", async () => {
    const state = createRepository();
    const { service } = createService(state.repository);
    await service.create(input, { userId, requestId });

    await expect(
      service.update(
        personalAgentId,
        { name: "Stale", arkVersion: "0" },
        { userId, requestId },
      ),
    ).rejects.toBeInstanceOf(AgentConflictError);
    await expect(
      service.update(
        personalAgentId,
        { name: "Other tenant", arkVersion: "1" },
        { userId: otherUserId, requestId },
      ),
    ).rejects.toBeInstanceOf(ResourceNotFoundError);

    await expect(
      service.update(
        personalAgentId,
        { name: "Current", arkVersion: "1" },
        { userId, requestId },
      ),
    ).resolves.toMatchObject({ name: "Current", arkVersion: "2" });
  });

  it("keeps uncertain deletes in deleting and deletes only owned Agents", async () => {
    const state = createRepository();
    const { service, ark } = createService(state.repository);
    await service.create(input, { userId, requestId });

    await expect(
      service.delete(personalAgentId, { userId: otherUserId, requestId }),
    ).rejects.toBeInstanceOf(ResourceNotFoundError);
    ark.failNext("deleteAgent", "connection_failure");
    await expect(
      service.delete(personalAgentId, { userId, requestId }),
    ).rejects.toMatchObject({ category: "unknown_write_outcome" });
    expect(state.personal.get(personalAgentId)).toMatchObject({
      status: "deleting",
      lastErrorCode: "ARK_UNKNOWN_WRITE_OUTCOME",
    });
  });

  it("keeps delete reconciliation state when local removal fails after Ark succeeds", async () => {
    const state = createRepository();
    const { service, ark } = createService(state.repository);
    await service.create(input, { userId, requestId });
    vi.spyOn(state.repository, "remove").mockRejectedValueOnce(
      new Error("database unavailable"),
    );

    await expect(
      service.delete(personalAgentId, { userId, requestId }),
    ).rejects.toThrow("database unavailable");
    expect(state.personal.get(personalAgentId)).toMatchObject({
      status: "deleting",
      lastErrorCode: "DB_PERSISTENCE_FAILED",
    });
    expect(
      ark.calls.filter(({ operation }) => operation === "deleteAgent"),
    ).toHaveLength(1);

    await expect(
      service.delete(personalAgentId, {
        userId,
        requestId: "worker-delete-reconcile",
      }),
    ).resolves.toBeUndefined();
    expect(state.personal.has(personalAgentId)).toBe(false);
    expect(
      ark.calls.filter(({ operation }) => operation === "deleteAgent"),
    ).toHaveLength(2);
  });

  it("blocks referenced deletion before Ark and deletes pending IDs locally", async () => {
    const referencedState = createRepository();
    const referenced = createService(referencedState.repository);
    const created = await referenced.service.create(input, {
      userId,
      requestId,
    });
    referencedState.sessions.push({
      id: "existing",
      userId,
      agentId: created.id,
      version: created.arkVersion,
      createdAt: new Date(),
    });

    await expect(
      referenced.service.delete(created.id, { userId, requestId }),
    ).rejects.toEqual(new AgentReferencedError(0, 1));
    expect(
      referenced.ark.calls.filter(
        ({ operation }) => operation === "deleteAgent",
      ),
    ).toHaveLength(0);
    expect(referencedState.personal.get(created.id)?.status).toBe("active");

    const failedState = createRepository();
    const failed = createService(failedState.repository);
    failed.ark.failNext("createAgent", "unavailable");
    await expect(
      failed.service.create(input, { userId, requestId }),
    ).rejects.toBeInstanceOf(ArkGatewayError);

    await failed.service.delete(personalAgentId, { userId, requestId });
    expect(
      failed.ark.calls.filter(({ operation }) => operation === "deleteAgent"),
    ).toHaveLength(0);
    expect(failedState.personal.has(personalAgentId)).toBe(false);
  });

  it("resolves the latest version for new Sessions without changing existing snapshots", async () => {
    const state = createRepository();
    const { service } = createService(state.repository);
    await service.create(input, { userId, requestId });
    state.sessions.push({
      id: "existing",
      userId,
      agentId: personalAgentId,
      version: "1",
      createdAt: new Date(),
    });
    await service.update(
      personalAgentId,
      { name: "Version two", arkVersion: "1" },
      { userId, requestId },
    );

    await expect(
      service.resolveForNewSession(userId, personalAgentId),
    ).resolves.toMatchObject({
      id: personalAgentId,
      arkVersion: "2",
    });
    expect(state.sessions[0]?.version).toBe("1");
  });
});
