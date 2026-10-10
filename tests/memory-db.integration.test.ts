import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as persistence from "../packages/db/src/index.js";
import {
  SessionService,
  type SessionRecord,
} from "../packages/domain/src/sessions.js";
import { createTestDatabase, id } from "./support/test-database.js";

describe("personal memory persistence", () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  let repositories: ReturnType<typeof persistence.createRepositories>;
  let userId: string;
  let agentId: string;

  beforeEach(async () => {
    database = await createTestDatabase();
    repositories = persistence.createRepositories(database.db);
    userId = await addUser();
    agentId = id();
    await database.client.query(
      `insert into personal_agents
       (id, owner_user_id, ark_agent_id, name, model_id, system_prompt, ark_version, status)
       values ($1, $2, 'ark-agent', 'Agent', 'model', 'Prompt', '1', 'active')`,
      [agentId, userId],
    );
    await database.client.exec(
      `insert into quota_policies
       (key, personal_agent_limit, concurrent_session_limit, daily_session_limit, monthly_token_limit)
       values ('default', 10, 10, 100, 100000)`,
    );
  });

  afterEach(async () => database.close());

  async function addUser() {
    const user = id();
    await database.client.query(
      "insert into users (id, auth_subject, email) values ($1, $2, $3)",
      [user, `subject:${user}`, `${user}@example.com`],
    );
    return user;
  }

  function intent(memoryStoreId: string | null = "store-1"): SessionRecord {
    const sessionId = id();
    const now = new Date();
    return {
      id: sessionId,
      ownerUserId: userId,
      arkSessionId: `pending:${sessionId}`,
      agentKind: "personal",
      platformAgentId: null,
      personalAgentId: agentId,
      arkAgentId: "ark-agent",
      agentName: "Agent",
      agentVersion: "1",
      environmentId: "environment",
      memoryStoreId,
      title: "",
      status: "idle",
      lastErrorCode: null,
      errorRecoverable: null,
      archivedAt: null,
      pinnedAt: null,
      deletionState: "none",
      lastEventAt: null,
      createdAt: now,
      updatedAt: now,
    };
  }

  async function activate() {
    const { state } = await repositories.memories.reserve(userId);
    const active = {
      ...state,
      status: "active" as const,
      storeId: "store-1",
    };
    await repositories.memories.save(userId, 0, active);
    expect(active.revision).toBe(0);
    active.revision++;
    return active;
  }

  async function complete(record: SessionRecord) {
    return repositories.sessionLifecycle.completeCreate(record.id, userId, {
      arkSessionId: `ark:${record.id}`,
      arkAgentId: "ark-agent",
      agentVersion: "1",
      status: "idle",
    });
  }

  it("exports a standalone factory and reserves exactly one durable intent concurrently", async () => {
    expect(persistence.createMemoryRepository).toBeTypeOf("function");
    const reserved = await Promise.all([
      repositories.memories.reserve(userId),
      repositories.memories.reserve(userId),
    ]);
    expect(reserved.map((result) => result.created).sort()).toEqual([
      false,
      true,
    ]);
    expect(reserved[0].state).toEqual({
      userId,
      revision: 0,
      status: "provisioning",
      storeId: null,
      policyEpoch: 0,
      protectedPaths: [],
      revokedPaths: [],
      autoDream: true,
      run: null,
      lastMonitorAt: 0,
      lastCompactAt: 0,
    });
    expect(await repositories.memories.get(userId)).toEqual(reserved[0].state);
    expect(await repositories.memories.get(id())).toBeUndefined();
    expect(await repositories.memories.list()).toEqual([reserved[0].state]);
  });

  it("round-trips complete JSON, rejects stale CAS and keeps row revision synchronized", async () => {
    const active = await activate();
    const next = {
      ...active,
      policyEpoch: 3,
      protectedPaths: ["memories/profile.md"],
      revokedPaths: ["old.md"],
      autoDream: false,
      run: { cleanup: ["candidate"], step: 2 },
      lastMonitorAt: 123,
      lastCompactAt: 456,
      summarizedSources: ["source-fingerprint"],
    };
    await repositories.memories.save(userId, 1, next);
    await expect(
      repositories.memories.save(userId, 1, next),
    ).rejects.toMatchObject({ code: "MEMORY_CONFLICT" });
    await expect(
      repositories.memories.save(userId, 2, { ...next, revision: 9 }),
    ).rejects.toMatchObject({ code: "MEMORY_CONFLICT" });
    expect(next.revision).toBe(1);
    expect(await repositories.memories.get(userId)).toEqual({
      ...next,
      revision: 2,
    });
    const stored = await database.client.query(
      "select revision, fixed_store_id, state from user_memory_stores where user_id = $1",
      [userId],
    );
    expect(stored.rows[0]).toEqual({
      revision: 2,
      fixed_store_id: "store-1",
      state: { ...next, revision: 2 },
    });
  });

  it("allows only one winner for simultaneous CAS updates", async () => {
    const active = await activate();
    const results = await Promise.allSettled([
      repositories.memories.save(userId, 1, {
        ...active,
        policyEpoch: 1,
      }),
      repositories.memories.save(userId, 1, {
        ...active,
        policyEpoch: 2,
      }),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      results.find((result) => result.status === "rejected"),
    ).toMatchObject({ reason: { code: "MEMORY_CONFLICT" } });
  });

  it("enforces unique fixed IDs, nullable reservations, owner identity and cleanup retention", async () => {
    const active = await activate();
    const other = await addUser();
    const { state } = await repositories.memories.reserve(other);
    await repositories.memories.reserve(await addUser());
    await expect(
      repositories.memories.save(other, 0, {
        ...state,
        status: "active",
        storeId: active.storeId,
      }),
    ).rejects.toThrow();
    await expect(
      repositories.memories.save(other, 0, {
        ...state,
        userId,
      }),
    ).rejects.toMatchObject({ code: "MEMORY_CONFLICT" });
    expect((await repositories.memories.get(other))?.revision).toBe(0);
    await expect(
      database.client.query("delete from users where id = $1", [userId]),
    ).rejects.toThrow();
    await repositories.memories.save(userId, 1, {
      ...active,
      storeId: "store-2",
    });
    await repositories.memories.save(other, 0, {
      ...state,
      status: "active",
      storeId: "store-1",
    });
  });

  it.each(["provisioning", "draining", "applying", "repairing"] as const)(
    "gates memory-backed create/message when %s without changing admission state",
    async (status) => {
      const active = await activate();
      const record = intent();
      await repositories.sessionLifecycle.prepareCreate(record);
      await complete(record);
      await repositories.memories.save(userId, 1, {
        ...active,
        status,
      });
      await expect(repositories.memories.gate(userId)).rejects.toMatchObject({
        code: "MEMORY_BUSY",
      });
      await expect(
        repositories.sessionLifecycle.prepareCreate(intent()),
      ).rejects.toMatchObject({ code: "MEMORY_BUSY" });
      await expect(
        repositories.sessionLifecycle.beginMessage(userId, record.id),
      ).rejects.toMatchObject({ code: "MEMORY_BUSY" });
      const rows = await database.client.query(
        "select status, message_in_flight_count, message_start_pending from sessions",
      );
      expect(rows.rows).toEqual([
        {
          status: "idle",
          message_in_flight_count: 0,
          message_start_pending: false,
        },
      ]);
      const temporary = intent(null);
      await repositories.sessionLifecycle.prepareCreate(temporary);
      await complete(temporary);
      expect(
        await repositories.sessionLifecycle.beginMessage(userId, temporary.id),
      ).toMatchObject({ kind: "accepted" });
    },
  );

  it("fails closed without a binding, and permits active memory-backed admissions", async () => {
    await expect(repositories.memories.gate(userId)).rejects.toMatchObject({
      code: "MEMORY_BUSY",
    });
    await expect(
      repositories.sessionLifecycle.prepareCreate(intent()),
    ).rejects.toMatchObject({ code: "MEMORY_BUSY" });
    await activate();
    await expect(repositories.memories.gate(userId)).resolves.toBeUndefined();
    const record = intent();
    await repositories.sessionLifecycle.prepareCreate(record);
    expect(await complete(record)).toMatchObject({ memoryStoreId: "store-1" });
    expect(
      await repositories.sessionLifecycle.beginMessage(userId, record.id),
    ).toMatchObject({
      kind: "accepted",
      session: { memoryStoreId: "store-1" },
    });
  });

  it.each(["initializing", "upgrading", "failed"] as const)(
    "persists upstream session status %s",
    async (status) => {
      await activate();
      const record = intent();
      await repositories.sessionLifecycle.prepareCreate(record);
      const stored = await repositories.sessionLifecycle.completeCreate(
        record.id,
        userId,
        {
          arkSessionId: `ark:${record.id}`,
          arkAgentId: "ark-agent",
          agentVersion: "1",
          status,
        },
      );
      expect(stored.status).toBe(status);
      expect(
        await repositories.sessionLifecycle.findOwned(userId, record.id),
      ).toMatchObject({ status, memoryStoreId: "store-1" });
    },
  );

  it("includes archived sessions and marks local in-flight or unresolved upstream work pending", async () => {
    await activate();
    const pending = intent();
    const running = intent();
    const archived = intent();
    const deleting = intent();
    for (const record of [pending, running, archived, deleting]) {
      await repositories.sessionLifecycle.prepareCreate(record);
      if (record !== pending) await complete(record);
    }
    await repositories.sessionLifecycle.beginMessage(userId, running.id);
    await database.client.query(
      "update sessions set archived_at = now() where id = $1",
      [archived.id],
    );
    await database.client.query(
      "update sessions set deletion_state = 'deletion_failed' where id = $1",
      [deleting.id],
    );
    const found = await repositories.memories.sessions(userId);
    expect(found).toHaveLength(4);
    for (const record of [pending, running, deleting]) {
      expect(found.find((item) => item.id === record.id)).toMatchObject({
        pending: true,
        memoryStoreId: "store-1",
      });
    }
    expect(found.find((item) => item.id === archived.id)).toMatchObject({
      arkSessionId: `ark:${archived.id}`,
      pending: false,
    });
    expect(await repositories.memories.sessions(await addUser())).toEqual([]);
  });

  it.each(["event", "quota"] as const)(
    "keeps an unknown message outcome pending after an idle %s observation",
    async (observation) => {
      await activate();
      const record = intent();
      await repositories.sessionLifecycle.prepareCreate(record);
      await complete(record);
      expect((await repositories.memories.sessions(userId))[0].pending).toBe(
        false,
      );
      await repositories.sessionLifecycle.beginMessage(userId, record.id);
      await repositories.sessionLifecycle.finishMessage(
        userId,
        record.id,
        "unknown",
      );
      const observedAt = new Date();
      if (observation === "event") {
        await repositories.sessionLifecycle.projectEvent(userId, record.id, {
          eventId: "idle-after-unknown",
          observedAt,
          status: "idle",
        });
      } else {
        await repositories.sessionLifecycle.syncQuotaStatus(
          userId,
          record.id,
          "idle",
          observedAt,
        );
      }
      expect(
        await repositories.sessionLifecycle.findOwned(userId, record.id),
      ).toMatchObject({ status: "idle" });
      expect((await repositories.memories.sessions(userId))[0].pending).toBe(
        true,
      );
      for (const outcome of [
        "accepted_or_unknown",
        "definite_failure",
      ] as const) {
        await repositories.sessionLifecycle.beginMessage(userId, record.id);
        await repositories.sessionLifecycle.finishMessage(
          userId,
          record.id,
          outcome,
        );
        expect((await repositories.memories.sessions(userId))[0].pending).toBe(
          true,
        );
      }
    },
  );

  it.each(["create", "message"] as const)(
    "serializes draining against %s admissions in either transaction order",
    async (operation) => {
      let active = await activate();
      const record = intent();
      await repositories.sessionLifecycle.prepareCreate(record);
      await complete(record);
      const admit = () =>
        operation === "create"
          ? repositories.sessionLifecycle.prepareCreate(intent())
          : repositories.sessionLifecycle.beginMessage(userId, record.id);
      for (const drainFirst of [true, false]) {
        const drain = () =>
          repositories.memories.save(userId, active.revision, {
            ...active,
            status: "draining",
          });
        const results = await Promise.allSettled(
          drainFirst ? [drain(), admit()] : [admit(), drain()],
        );
        expect(results[drainFirst ? 0 : 1].status).toBe("fulfilled");
        if (drainFirst)
          expect(results[1]).toMatchObject({ reason: { code: "MEMORY_BUSY" } });
        else expect(results[0].status).toBe("fulfilled");
        if (!drainFirst) {
          const sessions = await repositories.memories.sessions(userId);
          expect(sessions.some((session) => session.pending)).toBe(true);
        }
        const state = (await repositories.memories.get(userId))!;
        await expect(admit()).rejects.toMatchObject({ code: "MEMORY_BUSY" });
        active = { ...state, status: "active" };
        await repositories.memories.save(userId, state.revision, active);
        active.revision++;
      }
    },
  );

  it("mounts a durable fixed store with files, bypasses temporary mode, gates retries/messages and permits interrupt", async () => {
    await activate();
    const ensure = vi.fn(async () => "store-1");
    const gate = vi.fn((owner: string) => repositories.memories.gate(owner));
    const createdInputs: unknown[] = [];
    const ark = {
      createSession: vi.fn(async (input: unknown) => {
        createdInputs.push(input);
        return {
          id: `ark:${id()}`,
          agentId: "ark-agent",
          agentVersion: 1,
          status: "idle" as const,
        };
      }),
      getSession: vi.fn(),
      submitEvent: vi.fn(async () => ({ id: "event" })),
      listEvents: vi.fn(),
      streamEvents: vi.fn(),
    };
    const service = new SessionService({
      repository: repositories.sessionLifecycle,
      ark,
      agentResolver: {
        resolveForNewSession: async () => ({
          id: agentId,
          kind: "personal",
          arkAgentId: "ark-agent",
          arkVersion: "1",
          name: "Agent",
          description: "",
          modelId: "model",
          status: "active",
        }),
      },
      memory: { ensure, gate },
      environmentId: "environment",
      createId: id,
    });
    const upload = id();
    await database.client.query(
      `insert into session_inputs
       (id, owner_user_id, ark_file_id, original_name, mime_type, size_bytes, mount_path, status, expires_at)
       values ($1, $2, 'file-1', 'brief.txt', 'text/plain', 1, '/brief.txt', 'uploaded', now() + interval '1 hour')`,
      [upload, userId],
    );
    const context = { userId, requestId: "request" };
    const created = await service.create(
      { agentId, uploadIds: [upload] },
      context,
    );
    expect(ensure).toHaveBeenCalledWith(userId);
    expect(created.memoryStoreId).toBe("store-1");
    expect(createdInputs[0]).toMatchObject({
      resources: [
        { fileId: "file-1", mountPath: "/brief.txt" },
        {
          type: "memory_store",
          memoryStoreId: "store-1",
          access: "read_write",
        },
      ],
    });
    const temporary = await service.create(
      { agentId, temporary: true },
      context,
    );
    expect(ensure).toHaveBeenCalledTimes(1);
    expect(temporary.memoryStoreId).toBeNull();
    expect(createdInputs[1]).toMatchObject({ resources: [] });
    const legacy = intent(null);
    delete legacy.memoryStoreId;
    await repositories.sessionLifecycle.prepareCreate(legacy);
    await complete(legacy);
    const retry = intent();
    await repositories.sessionLifecycle.prepareCreate(retry);
    const active = (await repositories.memories.get(userId))!;
    await repositories.memories.save(userId, active.revision, {
      ...active,
      status: "draining",
    });
    await expect(
      service.reconcileCreate(retry.id, context),
    ).rejects.toMatchObject({ code: "MEMORY_BUSY" });
    await expect(
      service.sendMessage(created.id, { content: "blocked" }, context),
    ).rejects.toMatchObject({ code: "MEMORY_BUSY" });
    expect(ark.createSession).toHaveBeenCalledTimes(2);
    expect(ark.submitEvent).not.toHaveBeenCalled();
    await service.interrupt(created.id, context);
    await service.sendMessage(temporary.id, { content: "allowed" }, context);
    await service.sendMessage(
      legacy.id,
      { content: "legacy allowed" },
      context,
    );
    expect(ark.submitEvent).toHaveBeenCalledTimes(3);
    expect(gate).toHaveBeenCalledWith(userId);
  });
});
