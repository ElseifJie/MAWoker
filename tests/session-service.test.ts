import { describe, expect, it, vi } from "vitest";
import {
  ArkGatewayError,
  type ArkSession,
} from "../packages/ark-client/src/index.js";
import {
  ResourceNotFoundError,
  SessionService,
  SessionTerminatedError,
  type SessionRecord,
  type SessionRepository,
} from "../packages/domain/src/index.js";

const userId = "00000000-0000-4000-8000-000000000001";
const agentId = "00000000-0000-4000-8000-000000000002";
const sessionId = "00000000-0000-4000-8000-000000000003";
const now = new Date("2026-09-06T00:00:00.000Z");

const completeConfigSnapshot = {
  modelId: "model-a",
  skills: [],
  tools: [],
  environment: {
    id: "environment-1",
    type: "environment",
    configType: "cloud",
    scope: "account",
  },
  completeness: "complete" as const,
};

function arkSession(overrides: Partial<ArkSession> = {}): ArkSession {
  return {
    id: "ark-session-1",
    agentId: "ark-agent-1",
    agentVersion: 7,
    environmentId: "environment-1",
    status: "idle",
    configSnapshot: completeConfigSnapshot,
    ...overrides,
  };
}

const agent = {
  id: agentId,
  arkAgentId: "ark-agent-1",
  name: "Research Agent",
  description: "",
  modelId: "model-a",
  systemPrompt: "Prompt",
  arkVersion: "7",
  status: "active" as const,
  kind: "personal" as const,
  editable: true,
};

function session(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: sessionId,
    ownerUserId: userId,
    arkSessionId: "ark-session-1",
    agentKind: "personal",
    platformAgentId: null,
    personalAgentId: agentId,
    arkAgentId: agent.arkAgentId,
    agentName: agent.name,
    agentVersion: agent.arkVersion,
    environmentId: "environment-1",
    createAttemptedAt: null,
    modelId: null,
    configSnapshot: null,
    configSnapshotState: "unverified",
    configSnapshotErrorCode: null,
    title: "Task",
    status: "idle",
    lastErrorCode: null,
    errorRecoverable: null,
    archivedAt: null,
    pinnedAt: null,
    deletionState: "none",
    lastEventAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function setup() {
  const records = new Map<string, SessionRecord>();
  const reconciliation = new Map<
    string,
    { operation: "create"; status: "pending" | "succeeded" | "failed" }
  >();
  const reservations = new Map<
    string,
    "active" | "unknown_outcome" | "consumed" | "released"
  >();
  const audits: Array<Parameters<SessionRepository["audit"]>[0]> = [];
  const messageAccounting = new Map<
    string,
    { inFlight: number; startPending: boolean }
  >();

  const repository = {
    async prepareCreate(record: SessionRecord) {
      records.set(record.id, record);
      reconciliation.set(record.id, {
        operation: "create",
        status: "pending",
      });
      reservations.set(record.id, "active");
    },
    async claimCreateAttempt(
      id: string,
      ownerUserId: string,
      attemptedAt: Date,
    ) {
      const current = records.get(id);
      if (
        !current ||
        current.ownerUserId !== ownerUserId ||
        !current.arkSessionId.startsWith("pending:") ||
        current.createAttemptedAt !== null
      ) {
        return false;
      }
      records.set(id, { ...current, createAttemptedAt: attemptedAt });
      return true;
    },
    async releaseCreateAttempt(
      id: string,
      ownerUserId: string,
      attemptedAt: Date,
    ) {
      const current = records.get(id);
      if (
        !current ||
        current.ownerUserId !== ownerUserId ||
        !current.arkSessionId.startsWith("pending:") ||
        current.createAttemptedAt?.getTime() !== attemptedAt.getTime()
      ) {
        return false;
      }
      records.set(id, { ...current, createAttemptedAt: null });
      return true;
    },
    async completeCreate(
      id: string,
      ownerUserId: string,
      upstream: {
        arkSessionId: string;
        status: SessionRecord["status"];
        modelId: string;
        configSnapshot: NonNullable<SessionRecord["configSnapshot"]>;
      },
    ) {
      const current = records.get(id);
      if (!current || current.ownerUserId !== ownerUserId) {
        throw new Error("missing");
      }
      const completed = {
        ...current,
        ...upstream,
        configSnapshotState: "verified" as const,
        configSnapshotErrorCode: null,
        updatedAt: now,
      };
      records.set(id, completed);
      reservations.set(id, "consumed");
      reconciliation.set(id, { operation: "create", status: "succeeded" });
      return completed;
    },
    async preserveCreateOutcome(
      id: string,
      ownerUserId: string,
      upstream?: {
        arkSessionId: string;
        status: SessionRecord["status"];
        modelId: string | null;
        configSnapshot: NonNullable<SessionRecord["configSnapshot"]>;
        configSnapshotState: "incomplete" | "mismatch";
        configSnapshotErrorCode: string;
      },
    ) {
      const current = records.get(id);
      if (!current || current.ownerUserId !== ownerUserId) {
        throw new Error("missing");
      }
      if (upstream) records.set(id, { ...current, ...upstream });
      reservations.set(id, upstream ? "consumed" : "unknown_outcome");
    },
    async failCreate(id: string, ownerUserId: string) {
      const current = records.get(id);
      if (current?.ownerUserId === ownerUserId) records.delete(id);
      reservations.set(id, "released");
      reconciliation.set(id, { operation: "create", status: "failed" });
    },
    async listOwned(ownerUserId: string, archived: boolean) {
      return [...records.values()].filter(
        (record) =>
          record.ownerUserId === ownerUserId &&
          !record.arkSessionId.startsWith("pending:") &&
          (archived ? record.archivedAt !== null : record.archivedAt === null),
      );
    },
    async findOwned(ownerUserId: string, id: string) {
      const record = records.get(id);
      return record?.ownerUserId === ownerUserId &&
        !record.arkSessionId.startsWith("pending:")
        ? record
        : undefined;
    },
    async findCreateIntent(ownerUserId: string, id: string) {
      const record = records.get(id);
      return record?.ownerUserId === ownerUserId ? record : undefined;
    },
    async setArchived(
      ownerUserId: string,
      id: string,
      archivedAt: Date | null,
    ) {
      const current = records.get(id);
      if (!current || current.ownerUserId !== ownerUserId) return undefined;
      const updated = { ...current, archivedAt };
      records.set(id, updated);
      return updated;
    },
    async beginDelete(ownerUserId: string, id: string) {
      const current = records.get(id);
      if (!current || current.ownerUserId !== ownerUserId) return undefined;
      const updated = { ...current, deletionState: "pending" as const };
      records.set(id, updated);
      return updated;
    },
    async beginMessage(ownerUserId: string, id: string) {
      const current = records.get(id);
      if (!current || current.ownerUserId !== ownerUserId) return undefined;
      if (
        current.deletionState === "pending" ||
        current.deletionState === "deletion_failed"
      ) {
        return {
          kind: "deletion_conflict" as const,
          deletionState: current.deletionState,
        };
      }
      const accounting = messageAccounting.get(id) ?? {
        inFlight: 0,
        startPending: false,
      };
      accounting.inFlight += 1;
      if (current.status !== "idle") {
        messageAccounting.set(id, accounting);
        return {
          kind: "accepted" as const,
          session: current,
          started: false,
        };
      }
      accounting.startPending = true;
      messageAccounting.set(id, accounting);
      const started = { ...current, status: "running" as const };
      records.set(id, started);
      return {
        kind: "accepted" as const,
        session: started,
        started: true,
      };
    },
    async finishMessage(
      ownerUserId: string,
      id: string,
      outcome: "accepted_or_unknown" | "unknown" | "definite_failure",
    ) {
      const current = records.get(id);
      const accounting = messageAccounting.get(id);
      if (!current || current.ownerUserId !== ownerUserId || !accounting)
        return;
      accounting.inFlight = Math.max(accounting.inFlight - 1, 0);
      if (outcome === "accepted_or_unknown" || outcome === "unknown")
        accounting.startPending = false;
      if (
        outcome === "definite_failure" &&
        accounting.startPending &&
        accounting.inFlight === 0 &&
        current.status === "running"
      ) {
        accounting.startPending = false;
        records.set(id, { ...current, status: "idle" });
      }
    },
    async projectEvent() {},
    listRunningForQuota: vi.fn(async () => []),
    syncQuotaStatus: vi.fn(),
    async audit(entry: Parameters<SessionRepository["audit"]>[0]) {
      audits.push(entry);
    },
  };
  const ark = {
    createSession: vi.fn(async () => arkSession()),
    getSession: vi.fn(async () => arkSession()),
    submitEvent: vi.fn(async (_id, event) => ({
      id: "event-1",
      type: event.type,
      createdAt: now.toISOString(),
      data: event.data,
    })),
    listEvents: vi.fn(async () => []),
    streamEvents: vi.fn(async () => ({
      async *[Symbol.asyncIterator]() {},
    })),
  };
  const resolveForNewSession = vi.fn(async () => agent);
  const service = new SessionService({
    repository,
    agentResolver: { resolveForNewSession },
    ark,
    environmentId: "environment-1",
    createId: () => sessionId,
    now: () => now,
  });

  return {
    service,
    repository,
    ark,
    resolveForNewSession,
    records,
    reconciliation,
    reservations,
    audits,
  };
}

describe("SessionService", () => {
  it("reconciles Ark Session state before rejecting at the concurrent threshold", async () => {
    const state = setup();
    const stale = session({ status: "running" });
    state.repository.beginMessage = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error("Concurrent quota exceeded"), {
          name: "QuotaExceededError",
          dimension: "concurrent_sessions",
        }),
      )
      .mockResolvedValueOnce({
        kind: "accepted",
        session: session({ status: "running" }),
        started: true,
      });
    state.repository.listRunningForQuota = vi.fn(async () => [stale]);
    state.repository.syncQuotaStatus = vi.fn();
    state.ark.getSession = vi.fn(async () => ({
      id: stale.arkSessionId,
      agentId: stale.arkAgentId,
      agentVersion: Number(stale.agentVersion),
      environmentId: stale.environmentId,
      status: "idle",
      configSnapshot: completeConfigSnapshot,
    }));

    await expect(
      state.service.sendMessage(
        sessionId,
        { content: "Start after reconcile" },
        { userId, requestId: "request-threshold" },
      ),
    ).resolves.toEqual({ eventId: "event-1", delivery: "accepted" });
    expect(state.repository.syncQuotaStatus).toHaveBeenCalledWith(
      userId,
      stale.id,
      "idle",
      now,
    );
    expect(state.repository.beginMessage).toHaveBeenCalledTimes(2);
  });

  it("archives and restores only the owned Session without Ark calls", async () => {
    const state = setup();
    state.records.set(sessionId, session());

    const archived = await state.service.archive(sessionId, userId);
    const restored = await state.service.restore(sessionId, userId);

    expect(archived.archivedAt).toEqual(now);
    expect(restored.archivedAt).toBeNull();
    expect(restored).toMatchObject({
      arkSessionId: "ark-session-1",
      status: "idle",
      deletionState: "none",
    });
    expect(state.ark.createSession).not.toHaveBeenCalled();
    expect(state.ark.getSession).not.toHaveBeenCalled();
    expect(state.ark.submitEvent).not.toHaveBeenCalled();
  });

  it("creates an idempotent owned permanent deletion request", async () => {
    const state = setup();
    state.records.set(sessionId, session());

    await expect(
      state.service.requestDelete(sessionId, userId),
    ).resolves.toMatchObject({
      id: sessionId,
      deletionState: "pending",
    });
    await expect(
      state.service.requestDelete(sessionId, userId),
    ).resolves.toMatchObject({
      id: sessionId,
      deletionState: "pending",
    });
    await expect(
      state.service.requestDelete(sessionId, "other-user"),
    ).rejects.toBeInstanceOf(ResourceNotFoundError);
    expect(state.ark.submitEvent).not.toHaveBeenCalled();
  });

  it("creates an idle Session with fixed environment and immutable Agent snapshot", async () => {
    const state = setup();
    const claimCreateAttempt = vi.spyOn(state.repository, "claimCreateAttempt");

    const created = await state.service.create(
      { agentId, title: " Task " },
      { userId, requestId: "request-1" },
    );

    expect(state.resolveForNewSession).toHaveBeenCalledWith(userId, agentId);
    expect(state.ark.createSession).toHaveBeenCalledWith(
      {
        agentId: "ark-agent-1",
        agentVersion: 7,
        environmentId: "environment-1",
        resources: [],
      },
      {
        correlationId: `session-create:${sessionId}`,
        idempotencyKey: `session-create:${sessionId}`,
      },
    );
    expect(created).toMatchObject({
      ownerUserId: userId,
      agentName: "Research Agent",
      agentVersion: "7",
      environmentId: "environment-1",
      title: "Task",
      status: "idle",
      modelId: "model-a",
      configSnapshotState: "verified",
      configSnapshotErrorCode: null,
      configSnapshot: {
        agentId: "ark-agent-1",
        agentVersion: "7",
        environmentId: "environment-1",
        ...completeConfigSnapshot,
      },
    });
    expect(claimCreateAttempt).toHaveBeenCalledWith(sessionId, userId, now);
    expect(claimCreateAttempt.mock.invocationCallOrder[0]).toBeLessThan(
      state.ark.createSession.mock.invocationCallOrder[0]!,
    );
    expect(state.reservations.get(sessionId)).toBe("consumed");
    expect(state.reconciliation.get(sessionId)?.status).toBe("succeeded");
  });

  it.each([
    [
      "Agent ID",
      { agentId: "ark-agent-other" },
      "ARK_SESSION_AGENT_ID_MISMATCH",
    ],
    [
      "Agent version",
      { agentVersion: 8 },
      "ARK_SESSION_AGENT_VERSION_MISMATCH",
    ],
    [
      "Environment",
      { environmentId: "environment-other" },
      "ARK_SESSION_ENVIRONMENT_ID_MISMATCH",
    ],
    [
      "snapshot Environment",
      {
        configSnapshot: {
          ...completeConfigSnapshot,
          environment: {
            ...completeConfigSnapshot.environment,
            id: "environment-other",
          },
        },
      },
      "ARK_SESSION_SNAPSHOT_ENVIRONMENT_ID_MISMATCH",
    ],
  ] as const)(
    "persists cloud identity and observed snapshot when %s mismatches intent",
    async (_label, overrides, errorCode) => {
      const state = setup();
      state.ark.createSession.mockResolvedValueOnce(arkSession(overrides));

      await expect(
        state.service.create(
          { agentId, title: "" },
          { userId, requestId: "request-mismatch" },
        ),
      ).rejects.toMatchObject({ code: errorCode });

      expect(state.records.get(sessionId)).toMatchObject({
        arkSessionId: "ark-session-1",
        arkAgentId: "ark-agent-1",
        agentVersion: "7",
        environmentId: "environment-1",
        configSnapshotState: "mismatch",
        configSnapshotErrorCode: errorCode,
        configSnapshot: expect.objectContaining({
          agentId: arkSession(overrides).agentId,
          agentVersion: String(arkSession(overrides).agentVersion),
          environmentId: arkSession(overrides).environmentId,
        }),
      });
      expect(state.reconciliation.get(sessionId)?.status).toBe("pending");
      expect(state.ark.createSession).toHaveBeenCalledTimes(1);
    },
  );

  it("persists an incomplete snapshot and reconciles it with GET only", async () => {
    const state = setup();
    state.ark.createSession.mockResolvedValueOnce(
      arkSession({
        configSnapshot: {
          ...completeConfigSnapshot,
          modelId: null,
          completeness: "incomplete",
        },
      }),
    );

    await expect(
      state.service.create(
        { agentId, title: "" },
        { userId, requestId: "request-incomplete" },
      ),
    ).rejects.toMatchObject({
      code: "ARK_SESSION_CONFIG_SNAPSHOT_INCOMPLETE",
    });
    expect(state.records.get(sessionId)).toMatchObject({
      arkSessionId: "ark-session-1",
      modelId: null,
      configSnapshotState: "incomplete",
      configSnapshotErrorCode: "ARK_SESSION_CONFIG_SNAPSHOT_INCOMPLETE",
    });

    await expect(
      state.service.reconcileCreate(sessionId, {
        userId,
        requestId: "worker-incomplete",
      }),
    ).resolves.toMatchObject({
      arkSessionId: "ark-session-1",
      modelId: "model-a",
      configSnapshotState: "verified",
    });
    expect(state.ark.createSession).toHaveBeenCalledTimes(1);
    expect(state.ark.getSession).toHaveBeenCalledOnce();
  });

  it("reconciles a mismatched known cloud Session with GET only", async () => {
    const state = setup();
    state.ark.createSession.mockResolvedValueOnce(
      arkSession({ agentVersion: 8 }),
    );
    await expect(
      state.service.create(
        { agentId, title: "" },
        { userId, requestId: "request-mismatch" },
      ),
    ).rejects.toMatchObject({
      code: "ARK_SESSION_AGENT_VERSION_MISMATCH",
    });

    await expect(
      state.service.reconcileCreate(sessionId, {
        userId,
        requestId: "worker-mismatch",
      }),
    ).resolves.toMatchObject({ configSnapshotState: "verified" });
    expect(state.ark.createSession).toHaveBeenCalledTimes(1);
    expect(state.ark.getSession).toHaveBeenCalledOnce();
  });

  it("resolves tenant Agent access before reserving quota or calling Ark", async () => {
    const state = setup();
    state.resolveForNewSession.mockRejectedValueOnce(
      new ResourceNotFoundError(),
    );

    await expect(
      state.service.create(
        { agentId, title: "" },
        { userId, requestId: "request-1" },
      ),
    ).rejects.toBeInstanceOf(ResourceNotFoundError);

    expect(state.records.size).toBe(0);
    expect(state.ark.createSession).not.toHaveBeenCalled();
  });

  it("releases reservation and local state for definite create failure", async () => {
    const state = setup();
    state.ark.createSession.mockRejectedValueOnce(
      new ArkGatewayError("rate_limited"),
    );

    await expect(
      state.service.create(
        { agentId, title: "" },
        { userId, requestId: "request-1" },
      ),
    ).rejects.toMatchObject({ category: "rate_limited" });

    expect(state.records.size).toBe(0);
    expect(state.reservations.get(sessionId)).toBe("released");
    expect(state.reconciliation.get(sessionId)?.status).toBe("failed");
  });

  it("fails closed after an unknown create outcome without another POST", async () => {
    const state = setup();
    state.ark.createSession.mockRejectedValueOnce(
      new ArkGatewayError("unknown_write_outcome"),
    );

    await expect(
      state.service.create(
        { agentId, title: "" },
        { userId, requestId: "request-1" },
      ),
    ).rejects.toMatchObject({ category: "unknown_write_outcome" });

    expect(state.records.get(sessionId)?.arkSessionId).toBe(
      `pending:${sessionId}`,
    );
    expect(state.records.get(sessionId)?.createAttemptedAt).toEqual(now);
    expect(state.reservations.get(sessionId)).toBe("unknown_outcome");
    expect(state.reconciliation.get(sessionId)?.status).toBe("pending");

    await expect(
      state.service.reconcileCreate(sessionId, {
        userId,
        requestId: "worker-1",
      }),
    ).rejects.toMatchObject({
      code: "ARK_SESSION_CREATE_OUTCOME_UNKNOWN",
    });
    expect(state.ark.createSession).toHaveBeenCalledTimes(1);
    expect(state.ark.getSession).not.toHaveBeenCalled();
    expect(state.records.get(sessionId)?.arkSessionId).toBe(
      `pending:${sessionId}`,
    );
  });

  it("allows an unattempted prepared intent exactly one first POST", async () => {
    const state = setup();
    const claimCreateAttempt = vi.spyOn(state.repository, "claimCreateAttempt");
    const prepared = session({
      arkSessionId: `pending:${sessionId}`,
      createAttemptedAt: null,
      modelId: null,
      configSnapshot: null,
      configSnapshotState: "unverified",
      configSnapshotErrorCode: null,
    });
    await state.repository.prepareCreate(prepared);

    await expect(
      state.service.reconcileCreate(sessionId, {
        userId,
        requestId: "worker-first-attempt",
      }),
    ).resolves.toMatchObject({
      arkSessionId: "ark-session-1",
      configSnapshotState: "verified",
    });
    expect(state.ark.createSession).toHaveBeenCalledOnce();
    expect(state.ark.getSession).not.toHaveBeenCalled();
    expect(claimCreateAttempt).toHaveBeenCalledOnce();
    expect(state.records.get(sessionId)?.createAttemptedAt).toEqual(now);
  });

  it("releases a prepared recovery claim after a definite create failure", async () => {
    const state = setup();
    const prepared = session({
      arkSessionId: `pending:${sessionId}`,
      createAttemptedAt: null,
    });
    await state.repository.prepareCreate(prepared);
    state.ark.createSession.mockRejectedValueOnce(
      new ArkGatewayError("rate_limited"),
    );

    await expect(
      state.service.reconcileCreate(sessionId, {
        userId,
        requestId: "worker-first-attempt",
      }),
    ).rejects.toMatchObject({ category: "rate_limited" });
    expect(state.records.get(sessionId)?.createAttemptedAt).toBeNull();

    await expect(
      state.service.reconcileCreate(sessionId, {
        userId,
        requestId: "worker-second-attempt",
      }),
    ).resolves.toMatchObject({
      arkSessionId: "ark-session-1",
      configSnapshotState: "verified",
    });
    expect(state.ark.createSession).toHaveBeenCalledTimes(2);
  });

  it("preserves the upstream identity when final local persistence fails", async () => {
    const state = setup();
    vi.spyOn(state.repository, "completeCreate").mockRejectedValueOnce(
      new Error("database unavailable"),
    );

    await expect(
      state.service.create(
        { agentId, title: "" },
        { userId, requestId: "request-1" },
      ),
    ).rejects.toThrow("database unavailable");

    expect(state.records.get(sessionId)).toMatchObject({
      arkSessionId: "ark-session-1",
      agentVersion: "7",
    });
    expect(state.reservations.get(sessionId)).toBe("consumed");
    expect(state.reconciliation.get(sessionId)?.status).toBe("pending");

    await state.service.reconcileCreate(sessionId, {
      userId,
      requestId: "worker-1",
    });
    expect(state.ark.getSession).toHaveBeenCalledWith("ark-session-1", {
      correlationId: "worker-1",
    });
    expect(state.reconciliation.get(sessionId)?.status).toBe("succeeded");
  });

  it("lists and gets only owned Sessions using immutable Agent metadata", async () => {
    const state = setup();
    state.records.set(sessionId, session());
    state.records.set(
      "00000000-0000-4000-8000-000000000004",
      session({
        id: "00000000-0000-4000-8000-000000000004",
        archivedAt: now,
        agentName: "Original Agent Name",
      }),
    );

    await expect(state.service.list(userId, false)).resolves.toEqual([
      expect.objectContaining({ id: sessionId, agentName: "Research Agent" }),
    ]);
    await expect(state.service.list(userId, true)).resolves.toEqual([
      expect.objectContaining({ agentName: "Original Agent Name" }),
    ]);
    await expect(state.service.get(userId, sessionId)).resolves.toMatchObject({
      agentVersion: "7",
      agentName: "Research Agent",
    });
    await expect(
      state.service.get("00000000-0000-4000-8000-000000000099", sessionId),
    ).rejects.toBeInstanceOf(ResourceNotFoundError);
  });

  it.each([
    ["idle", "accepted"],
    ["running", "queued"],
    ["rescheduled", "queued"],
  ] as const)(
    "submits user.message from %s with %s delivery and correct start state",
    async (status, delivery) => {
      const state = setup();
      state.records.set(sessionId, session({ status }));

      await expect(
        state.service.sendMessage(
          sessionId,
          { content: " Follow up " },
          { userId, requestId: "request-2" },
        ),
      ).resolves.toEqual({ eventId: "event-1", delivery });

      expect(state.ark.submitEvent).toHaveBeenCalledWith(
        "ark-session-1",
        { type: "user.message", data: { content: "Follow up" } },
        { correlationId: "request-2" },
      );
      expect(state.records.get(sessionId)?.status).toBe(
        status === "idle" ? "running" : status,
      );
    },
  );

  it.each([
    ["pending", "DELETION_PENDING"],
    ["deletion_failed", "DELETION_FAILED"],
  ] as const)(
    "rejects messages while Session deletion is %s without calling Ark",
    async (deletionState, code) => {
      const state = setup();
      state.records.set(sessionId, session({ deletionState }));

      await expect(
        state.service.sendMessage(
          sessionId,
          { content: "Do not restart" },
          { userId, requestId: "request-deleting" },
        ),
      ).rejects.toMatchObject({
        name: "SessionDeletionConflictError",
        code,
        deletionState,
      });
      expect(state.ark.submitEvent).not.toHaveBeenCalled();
      expect(state.records.get(sessionId)).toMatchObject({
        status: "idle",
        deletionState,
      });
    },
  );

  it("restores an idle Session when its first message definitely fails", async () => {
    const state = setup();
    state.records.set(sessionId, session({ status: "idle" }));
    state.ark.submitEvent.mockRejectedValueOnce(
      new ArkGatewayError("runtime_busy"),
    );

    await expect(
      state.service.sendMessage(
        sessionId,
        { content: "Start" },
        { userId, requestId: "request-start" },
      ),
    ).rejects.toMatchObject({ category: "runtime_busy" });

    expect(state.records.get(sessionId)?.status).toBe("idle");
  });

  it("records unknown message outcomes separately from accepted writes", async () => {
    const state = setup();
    state.records.set(sessionId, session({ status: "idle" }));
    const finish = vi.spyOn(state.repository, "finishMessage");
    state.ark.submitEvent.mockRejectedValueOnce(
      new ArkGatewayError("unknown_write_outcome"),
    );

    await expect(
      state.service.sendMessage(
        sessionId,
        { content: "Start" },
        { userId, requestId: "request-unknown" },
      ),
    ).rejects.toMatchObject({ category: "unknown_write_outcome" });

    expect(finish).toHaveBeenCalledWith(userId, sessionId, "unknown");
    expect(state.records.get(sessionId)?.status).toBe("running");
  });

  it("never converts an accepted Ark write into a definite start failure", async () => {
    const state = setup();
    state.records.set(sessionId, session({ status: "idle" }));
    vi.spyOn(state.repository, "finishMessage").mockRejectedValueOnce(
      new Error("database unavailable"),
    );

    await expect(
      state.service.sendMessage(
        sessionId,
        { content: "Start" },
        { userId, requestId: "request-accepted-db-failure" },
      ),
    ).rejects.toThrow("database unavailable");

    expect(state.ark.submitEvent).toHaveBeenCalledTimes(1);
    expect(state.repository.finishMessage).toHaveBeenCalledTimes(1);
    expect(state.records.get(sessionId)?.status).toBe("running");
  });

  it("rejects terminated messages before Ark and surfaces RuntimeBusy", async () => {
    const state = setup();
    state.records.set(sessionId, session({ status: "terminated" }));

    await expect(
      state.service.sendMessage(
        sessionId,
        { content: "No" },
        { userId, requestId: "request-3" },
      ),
    ).rejects.toBeInstanceOf(SessionTerminatedError);
    expect(state.ark.submitEvent).not.toHaveBeenCalled();

    state.records.set(sessionId, session({ status: "running" }));
    state.ark.submitEvent.mockRejectedValueOnce(
      new ArkGatewayError("runtime_busy"),
    );
    await expect(
      state.service.sendMessage(
        sessionId,
        { content: "Retry" },
        { userId, requestId: "request-4" },
      ),
    ).rejects.toMatchObject({ category: "runtime_busy" });
  });

  it("submits user.interrupt without changing state before an observed status event", async () => {
    const state = setup();
    state.records.set(sessionId, session({ status: "running" }));

    await expect(
      state.service.interrupt(sessionId, {
        userId,
        requestId: "request-5",
      }),
    ).resolves.toEqual({ eventId: "event-1", delivery: "accepted" });

    expect(state.ark.submitEvent).toHaveBeenCalledWith(
      "ark-session-1",
      { type: "user.interrupt", data: {} },
      { correlationId: "request-5" },
    );
    expect(state.records.get(sessionId)?.status).toBe("running");
  });

  it("does not fail or duplicate a successful create when audit storage fails", async () => {
    const state = setup();
    vi.spyOn(state.repository, "audit").mockRejectedValue(
      new Error("audit unavailable"),
    );

    await expect(
      state.service.create(
        { agentId, title: "Task" },
        { userId, requestId: "request-audit-create" },
      ),
    ).resolves.toMatchObject({ id: sessionId, status: "idle" });

    expect(state.ark.createSession).toHaveBeenCalledTimes(1);
    expect(state.repository.audit).toHaveBeenCalledTimes(1);
  });

  it("does not fail or duplicate a successful message when audit storage fails", async () => {
    const state = setup();
    state.records.set(sessionId, session({ status: "running" }));
    vi.spyOn(state.repository, "audit").mockRejectedValue(
      new Error("audit unavailable"),
    );

    await expect(
      state.service.sendMessage(
        sessionId,
        { content: "Continue" },
        { userId, requestId: "request-audit-message" },
      ),
    ).resolves.toEqual({ eventId: "event-1", delivery: "queued" });

    expect(state.ark.submitEvent).toHaveBeenCalledTimes(1);
    expect(state.repository.audit).toHaveBeenCalledTimes(1);
  });

  it("does not fail or duplicate a successful interrupt when audit storage fails", async () => {
    const state = setup();
    state.records.set(sessionId, session({ status: "running" }));
    vi.spyOn(state.repository, "audit").mockRejectedValue(
      new Error("audit unavailable"),
    );

    await expect(
      state.service.interrupt(sessionId, {
        userId,
        requestId: "request-audit-interrupt",
      }),
    ).resolves.toEqual({ eventId: "event-1", delivery: "accepted" });

    expect(state.ark.submitEvent).toHaveBeenCalledTimes(1);
    expect(state.repository.audit).toHaveBeenCalledTimes(1);
  });

  it("expedites memory consolidation on archive and on observed turn ends", async () => {
    const state = setup();
    const expedite = vi.fn(async () => {});
    const service = new SessionService({
      repository: state.repository,
      agentResolver: { resolveForNewSession: state.resolveForNewSession },
      ark: state.ark,
      environmentId: "environment-1",
      createId: () => sessionId,
      now: () => now,
      memory: { ensure: async () => "store-1", gate: async () => {}, expedite },
    });

    state.records.set(sessionId, session({ memoryStoreId: "store-1" }));
    await service.archive(sessionId, userId);
    expect(expedite).toHaveBeenCalledWith(userId);

    // A completed turn observed on the live stream re-arms consolidation
    // without blocking the event stream.
    expedite.mockClear();
    state.records.set(sessionId, session({ memoryStoreId: "store-1" }));
    state.ark.streamEvents = vi.fn(async function* () {
      yield {
        id: "event-9",
        type: "session.status_idle",
        createdAt: now.toISOString(),
        data: { stop_reason: { type: "end_turn" } },
      };
    });
    const opened = await service.openEvents(sessionId, {
      userId,
      requestId: "request-events",
    });
    const events = opened.events[Symbol.asyncIterator]();
    await events.next(); // the idle event crosses the expedite seam
    expect(expedite).toHaveBeenCalledWith(userId);
  });
});
