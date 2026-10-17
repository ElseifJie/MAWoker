import { describe, expect, it } from "vitest";
import {
  QuotaExceededError,
  createRepositories,
} from "../packages/db/src/index.js";
import { createTestDatabase, id } from "./support/test-database.js";

async function seedUser(
  client: Awaited<ReturnType<typeof createTestDatabase>>["client"],
  input: {
    id: string;
    subject?: string;
    email?: string;
    role?: "user" | "admin";
  },
) {
  await client.query(
    `insert into users (id, auth_subject, email, role)
     values ($1, $2, $3, $4)`,
    [
      input.id,
      input.subject ?? `subject-${input.id}`,
      input.email ?? `${input.id}@example.com`,
      input.role ?? "user",
    ],
  );
}

async function seedPersonalSession(
  client: Awaited<ReturnType<typeof createTestDatabase>>["client"],
  input: {
    ownerUserId: string;
    personalAgentId?: string;
    arkAgentId?: string;
    sessionId?: string;
    arkSessionId?: string;
  },
) {
  const personalAgentId = input.personalAgentId ?? id();
  const arkAgentId = input.arkAgentId ?? `ark-agent-${id()}`;
  const sessionId = input.sessionId ?? id();
  const arkSessionId = input.arkSessionId ?? `ark-session-${id()}`;

  await client.query(
    `insert into personal_agents
      (id, owner_user_id, ark_agent_id, name, model_id, system_prompt, ark_version, status)
     values ($1, $2, $3, 'Agent', 'model-a', 'Prompt', '1', 'active')`,
    [personalAgentId, input.ownerUserId, arkAgentId],
  );
  await client.query(
    `insert into sessions
      (id, owner_user_id, ark_session_id, agent_kind, personal_agent_id,
       ark_agent_id, agent_version, environment_id, status)
     values ($1, $2, $3, 'personal', $4, $5, '1', 'env-1', 'idle')`,
    [sessionId, input.ownerUserId, arkSessionId, personalAgentId, arkAgentId],
  );
  await client.query(
    `insert into quota_reservations
      (id, user_id, ark_session_id, status, expires_at, resolved_at)
     values ($1, $2, $3, 'consumed', now(), now())`,
    [sessionId, input.ownerUserId, arkSessionId],
  );

  return { personalAgentId, arkAgentId, sessionId, arkSessionId };
}

describe("database schema in PGlite", () => {
  it("migrates every Task 2 table", async () => {
    const database = await createTestDatabase();
    const result = await database.client.query<{ table_name: string }>(
      `select table_name
         from information_schema.tables
        where table_schema = 'public'
        order by table_name`,
    );

    expect(result.rows.map(({ table_name }) => table_name)).toEqual(
      expect.arrayContaining([
        "artifacts",
        "drive_files",
        "audit_logs",
        "auth_sessions",
        "background_jobs",
        "personal_agents",
        "platform_agents",
        "quota_policies",
        "quota_reservations",
        "session_event_cursors",
        "session_inputs",
        "sessions",
        "usage_ledger",
        "user_default_agents",
        "user_quota_overrides",
        "users",
      ]),
    );
    await database.close();
  });

  it("enforces identity uniqueness and stores only token hashes", async () => {
    const database = await createTestDatabase();
    const userId = id();
    await seedUser(database.client, { id: userId, subject: "oidc-subject" });

    await expect(
      seedUser(database.client, { id: id(), subject: "oidc-subject" }),
    ).rejects.toMatchObject({ code: "23505" });

    const columns = await database.client.query<{ column_name: string }>(
      `select column_name
         from information_schema.columns
        where table_name = 'auth_sessions'`,
    );
    expect(columns.rows.map(({ column_name }) => column_name)).toContain(
      "token_hash",
    );
    expect(columns.rows.map(({ column_name }) => column_name)).not.toContain(
      "token",
    );
    await database.close();
  });

  it("enforces one matching agent reference and resource ownership", async () => {
    const database = await createTestDatabase();
    const ownerId = id();
    const otherUserId = id();
    const personalAgentId = id();
    await seedUser(database.client, { id: ownerId });
    await seedUser(database.client, { id: otherUserId });
    await database.client.query(
      `insert into personal_agents
        (id, owner_user_id, ark_agent_id, name, model_id, system_prompt, ark_version, status)
       values ($1, $2, 'ark-agent-1', 'Mine', 'model-a', 'Prompt', '1', 'active')`,
      [personalAgentId, ownerId],
    );

    const sessionValues = [
      id(),
      otherUserId,
      `ark-session-${id()}`,
      personalAgentId,
    ];
    await expect(
      database.client.query(
        `insert into sessions
          (id, owner_user_id, ark_session_id, agent_kind, personal_agent_id,
           ark_agent_id, agent_version, environment_id, status)
         values ($1, $2, $3, 'personal', $4, 'ark-agent-1', '1', 'env-1', 'idle')`,
        sessionValues,
      ),
    ).rejects.toMatchObject({ code: "23503" });

    await expect(
      database.client.query(
        `insert into sessions
          (id, owner_user_id, ark_session_id, agent_kind,
           ark_agent_id, agent_version, environment_id, status)
         values ($1, $2, $3, 'personal', 'ark-agent-1', '1', 'env-1', 'idle')`,
        [id(), ownerId, `ark-session-${id()}`],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await database.close();
  });

  it("enforces Ark identifier uniqueness at each ownership scope", async () => {
    const database = await createTestDatabase();
    const adminId = id();
    const firstOwnerId = id();
    const secondOwnerId = id();
    await seedUser(database.client, { id: adminId, role: "admin" });
    await seedUser(database.client, { id: firstOwnerId });
    await seedUser(database.client, { id: secondOwnerId });

    const platformValues = [id(), adminId];
    await database.client.query(
      `insert into platform_agents
        (id, ark_agent_id, name, model_id, system_prompt, ark_version,
         created_by, updated_by)
       values ($1, 'ark-platform-shared', 'Platform', 'model-a', 'Prompt', '1', $2, $2)`,
      platformValues,
    );
    await expect(
      database.client.query(
        `insert into platform_agents
          (id, ark_agent_id, name, model_id, system_prompt, ark_version,
           created_by, updated_by)
         values ($1, 'ark-platform-shared', 'Duplicate', 'model-a', 'Prompt', '1', $2, $2)`,
        [id(), adminId],
      ),
    ).rejects.toMatchObject({ code: "23505" });

    await seedPersonalSession(database.client, {
      ownerUserId: firstOwnerId,
      arkAgentId: "ark-personal-scoped",
      arkSessionId: "ark-session-unique",
    });
    await expect(
      database.client.query(
        `insert into personal_agents
          (id, owner_user_id, ark_agent_id, name, model_id, system_prompt, ark_version)
         values ($1, $2, 'ark-personal-scoped', 'Duplicate', 'model-a', 'Prompt', '1')`,
        [id(), firstOwnerId],
      ),
    ).rejects.toMatchObject({ code: "23505" });
    await database.client.query(
      `insert into personal_agents
        (id, owner_user_id, ark_agent_id, name, model_id, system_prompt, ark_version)
       values ($1, $2, 'ark-personal-scoped', 'Other tenant', 'model-a', 'Prompt', '1')`,
      [id(), secondOwnerId],
    );
    await expect(
      seedPersonalSession(database.client, {
        ownerUserId: secondOwnerId,
        arkSessionId: "ark-session-unique",
      }),
    ).rejects.toMatchObject({ code: "23505" });
    await database.close();
  });

  it("allows only one default platform-agent assignment per user", async () => {
    const database = await createTestDatabase();
    const userId = id();
    const adminId = id();
    const firstAgentId = id();
    const secondAgentId = id();
    await seedUser(database.client, { id: userId });
    await seedUser(database.client, { id: adminId, role: "admin" });
    await database.client.query(
      `insert into platform_agents
        (id, ark_agent_id, name, model_id, system_prompt, ark_version,
         created_by, updated_by)
       values
        ($1, 'ark-platform-default-1', 'First', 'model-a', 'Prompt', '1', $3, $3),
        ($2, 'ark-platform-default-2', 'Second', 'model-a', 'Prompt', '1', $3, $3)`,
      [firstAgentId, secondAgentId, adminId],
    );
    await database.client.query(
      `insert into user_default_agents (user_id, platform_agent_id, assigned_by)
       values ($1, $2, $3)`,
      [userId, firstAgentId, adminId],
    );
    await expect(
      database.client.query(
        `insert into user_default_agents (user_id, platform_agent_id, assigned_by)
         values ($1, $2, $3)`,
        [userId, secondAgentId, adminId],
      ),
    ).rejects.toMatchObject({ code: "23505" });
    await database.close();
  });

  it("stores archive state and rejects invalid deletion states", async () => {
    const database = await createTestDatabase();
    const ownerUserId = id();
    await seedUser(database.client, { id: ownerUserId });
    const session = await seedPersonalSession(database.client, {
      ownerUserId,
    });
    const archivedAt = new Date();

    const archived = await database.client.query<{
      archived_at: Date;
      deletion_state: string;
    }>(
      `update sessions
          set archived_at = $2
        where id = $1
        returning archived_at, deletion_state`,
      [session.sessionId, archivedAt],
    );
    expect(archived.rows[0]).toMatchObject({
      archived_at: archivedAt,
      deletion_state: "none",
    });
    for (const deletionState of [
      "pending",
      "deletion_failed",
      "deleted",
      "none",
    ]) {
      const updated = await database.client.query<{ deletion_state: string }>(
        `update sessions
            set deletion_state = $2
          where id = $1
          returning deletion_state`,
        [session.sessionId, deletionState],
      );
      expect(updated.rows[0]?.deletion_state).toBe(deletionState);
    }
    await expect(
      database.client.query(
        `update sessions set deletion_state = 'unknown' where id = $1`,
        [session.sessionId],
      ),
    ).rejects.toMatchObject({ code: "22P02" });
    await database.close();
  });

  it("prevents inputs and artifacts from referencing another tenant's session", async () => {
    const database = await createTestDatabase();
    const ownerUserId = id();
    const otherUserId = id();
    await seedUser(database.client, { id: ownerUserId });
    await seedUser(database.client, { id: otherUserId });
    const session = await seedPersonalSession(database.client, {
      ownerUserId,
    });

    await expect(
      database.client.query(
        `insert into session_inputs
          (id, owner_user_id, session_id, original_name, mime_type, size_bytes,
           mount_path, status, expires_at)
         values ($1, $2, $3, 'input.txt', 'text/plain', 1, '/mnt/input.txt',
                 'bound', now() + interval '1 hour')`,
        [id(), otherUserId, session.sessionId],
      ),
    ).rejects.toMatchObject({ code: "23503" });
    const driveFileId = id();
    await database.client.query(
      `insert into drive_files
         (id, owner_user_id, origin, tos_object_key, name, mime_type, size_bytes,
          deletion_state)
       values ($1, $2, 'artifact', $3, 'output.txt', 'text/plain', 1, 'none')`,
      [driveFileId, otherUserId, `object-${driveFileId}`],
    );
    await expect(
      database.client.query(
        `insert into artifacts
          (id, owner_user_id, session_id, ark_file_id, drive_file_id, name,
           mime_type, size_bytes, generated_at)
         values ($1, $2, $3, 'ark-file-1', $4, 'output.txt', 'text/plain', 1, now())`,
        [id(), otherUserId, session.sessionId, driveFileId],
      ),
    ).rejects.toMatchObject({ code: "23503" });
    await database.close();
  });

  it("rejects usage attributed to a tenant other than the session owner", async () => {
    const database = await createTestDatabase();
    const ownerUserId = id();
    const otherUserId = id();
    await seedUser(database.client, { id: ownerUserId });
    await seedUser(database.client, { id: otherUserId });
    const session = await seedPersonalSession(database.client, {
      ownerUserId,
    });

    await expect(
      database.client.query(
        `insert into usage_ledger
          (id, user_id, ark_session_id, ark_event_id, metric_type, quantity)
         values ($1, $2, $3, 'ark-event-cross-tenant', 'input_tokens', 10)`,
        [id(), otherUserId, session.arkSessionId],
      ),
    ).rejects.toMatchObject({ code: "23503" });
    await database.close();
  });

  it("deduplicates replayed usage events", async () => {
    const database = await createTestDatabase();
    const userId = id();
    await seedUser(database.client, { id: userId });
    const session = await seedPersonalSession(database.client, {
      ownerUserId: userId,
      arkSessionId: "ark-session-1",
    });
    const values = [id(), userId, session.arkSessionId, "ark-event-1"];
    const insert = () =>
      database.client.query(
        `insert into usage_ledger
          (id, user_id, ark_session_id, ark_event_id, metric_type, quantity)
         values ($1, $2, $3, $4, 'input_tokens', 10)`,
        values,
      );

    await insert();
    await expect(insert()).rejects.toMatchObject({ code: "23505" });
    await database.close();
  });
});

describe("repositories in PGlite", () => {
  it("creates one queued Run per durable submission and scopes it to the owner", async () => {
    const database = await createTestDatabase();
    const repositories = createRepositories(database.db);
    const ownerId = id();
    await seedUser(database.client, { id: ownerId });
    const session = await seedPersonalSession(database.client, {
      ownerUserId: ownerId,
    });
    await database.client.query(
      `insert into quota_policies
        (key, personal_agent_limit, concurrent_session_limit,
         daily_session_limit, monthly_token_limit)
       values ('default', 10, 5, 100, 1000000)`,
    );
    const submissionId = id();
    const input = {
      id: id(),
      ownerUserId: ownerId,
      sessionId: session.sessionId,
      submissionId,
      requestHash: "hash-run-1",
      content: "hello",
      temporary: true,
    };

    await repositories.sessionLifecycle.enqueueSubmission(input);

    await expect(
      repositories.runs.findBySubmission(ownerId, submissionId),
    ).resolves.toMatchObject({
      ownerUserId: ownerId,
      conversationId: session.sessionId,
      submissionId,
      triggerKind: "manual",
      status: "queued",
    });

    const createdRun = await repositories.runs.findBySubmission(
      ownerId,
      submissionId,
    );
    if (!createdRun) throw new Error("Run was not created");
    const running = await repositories.runs.transition({
      ownerUserId: ownerId,
      id: createdRun.id,
      from: ["queued"],
      to: "running",
      arkSessionId: session.arkSessionId,
      startedAt: new Date("2026-10-17T00:01:00.000Z"),
    });
    expect(running).toMatchObject({
      status: "running",
      arkSessionId: session.arkSessionId,
      version: 2,
    });
    await expect(
      repositories.runs.transition({
        ownerUserId: ownerId,
        id: createdRun.id,
        from: ["queued"],
        to: "completed",
      }),
    ).resolves.toBeUndefined();
    await expect(
      repositories.runs.transition({
        ownerUserId: id(),
        id: createdRun.id,
        from: ["running"],
        to: "completed",
      }),
    ).resolves.toBeUndefined();

    await database.client.query(
      `update message_submissions set upstream_event_id = $1
        where owner_user_id = $2 and submission_id = $3`,
      ["event-input-run", ownerId, submissionId],
    );
    const observation = {
      boundaryEventId: "event-boundary-run",
      inputEventId: "event-input-run",
      outcome: "completed" as const,
      summary: "done",
      expectedNames: [],
      startedAt: new Date("2026-10-17T00:00:30.000Z"),
      endedAt: new Date("2026-10-17T00:04:30.000Z"),
      usageState: "complete" as const,
    };
    const deliveryInput = {
      upstreamStatus: "idle",
      now: new Date("2026-10-17T00:05:00.000Z"),
      retryWindowMs: 60_000,
    };
    await repositories.sessionDelivery.recordObservations(
      ownerId,
      session.sessionId,
      [observation],
      deliveryInput,
    );
    const completed = await repositories.runs.findBySubmission(
      ownerId,
      submissionId,
    );
    expect(completed).toMatchObject({
      status: "completed",
      endedAt: new Date("2026-10-17T00:04:30.000Z"),
      turnId: expect.any(String),
    });
    const completedVersion = completed?.version;

    // A repeated discovery scan of the same boundary must not bump the Run.
    await repositories.sessionDelivery.recordObservations(
      ownerId,
      session.sessionId,
      [observation],
      deliveryInput,
    );
    await expect(
      repositories.runs.findBySubmission(ownerId, submissionId),
    ).resolves.toMatchObject({ version: completedVersion });

    // Replaying the same submission ID returns the existing receipt and must
    // not create a second Run.
    await repositories.sessionLifecycle.enqueueSubmission(input);
    const count = await database.client.query<{ count: number }>(
      `select count(*)::int as count from runs where owner_user_id = $1`,
      [ownerId],
    );
    expect(count.rows[0]?.count).toBe(1);

    await expect(
      repositories.runs.findBySubmission(id(), submissionId),
    ).resolves.toBeUndefined();
    await database.close();
  });

  it("scopes every tenant authorization lookup and active assignment", async () => {
    const database = await createTestDatabase();
    const repositories = createRepositories(database.db);
    const ownerId = id();
    const otherUserId = id();
    const adminId = id();
    const platformAgentId = id();
    const session = await (async () => {
      await seedUser(database.client, { id: ownerId });
      await seedUser(database.client, { id: otherUserId });
      await seedUser(database.client, { id: adminId, role: "admin" });
      return seedPersonalSession(database.client, { ownerUserId: ownerId });
    })();
    const inputId = id();
    const artifactId = id();
    const usageId = id();
    await database.client.query(
      `insert into platform_agents
        (id, ark_agent_id, name, model_id, system_prompt, ark_version, status,
         created_by, updated_by)
       values ($1, 'ark-platform-authz', 'Platform', 'model-a', 'Prompt', '1',
               'active', $2, $2)`,
      [platformAgentId, adminId],
    );
    await database.client.query(
      `insert into user_default_agents (user_id, platform_agent_id, assigned_by)
       values ($1, $2, $3)`,
      [ownerId, platformAgentId, adminId],
    );
    await database.client.query(
      `insert into session_inputs
        (id, owner_user_id, session_id, ark_file_id, original_name, mime_type,
         size_bytes, mount_path, status, expires_at)
       values ($1, $2, $3, 'ark-input-authz', 'input.txt', 'text/plain', 1,
               '/mnt/session/input.txt', 'bound', now() + interval '1 hour')`,
      [inputId, ownerId, session.sessionId],
    );
    const driveFileId = id();
    await database.client.query(
      `insert into drive_files
        (id, owner_user_id, origin, tos_object_key, name, mime_type, size_bytes,
         source_session_id, deletion_state)
       values ($1, $2, 'artifact', $3, 'result.txt', 'text/plain', 1, $4, 'none')`,
      [driveFileId, ownerId, `tenant/${driveFileId}`, session.sessionId],
    );
    await database.client.query(
      `insert into artifacts
        (id, owner_user_id, session_id, ark_file_id, drive_file_id, name,
         mime_type, size_bytes, generated_at)
       values ($1, $2, $3, 'ark-artifact-authz', $4, 'result.txt',
               'text/plain', 1, now())`,
      [artifactId, ownerId, session.sessionId, driveFileId],
    );
    await database.client.query(
      `insert into usage_ledger
        (id, user_id, ark_session_id, ark_event_id, metric_type, quantity)
       values ($1, $2, $3, 'ark-event-authz', 'input_tokens', 1)`,
      [usageId, ownerId, session.arkSessionId],
    );

    const lookups = [
      repositories.personalAgents.findOwned(ownerId, session.personalAgentId),
      repositories.sessions.findOwned(ownerId, session.sessionId),
      repositories.sessionInputs.findOwned(ownerId, inputId),
      repositories.artifacts.findOwned(ownerId, artifactId),
      repositories.usage.findOwned(ownerId, usageId),
      repositories.platformAgents.findAssignedToUser(ownerId, platformAgentId),
    ];
    await expect(Promise.all(lookups)).resolves.toEqual([
      expect.objectContaining({ id: session.personalAgentId }),
      expect.objectContaining({ id: session.sessionId }),
      expect.objectContaining({ id: inputId }),
      expect.objectContaining({ id: artifactId }),
      expect.objectContaining({ id: usageId }),
      expect.objectContaining({ id: platformAgentId }),
    ]);

    await expect(
      Promise.all([
        repositories.personalAgents.findOwned(
          otherUserId,
          session.personalAgentId,
        ),
        repositories.sessions.findOwned(otherUserId, session.sessionId),
        repositories.sessionInputs.findOwned(otherUserId, inputId),
        repositories.artifacts.findOwned(otherUserId, artifactId),
        repositories.usage.findOwned(otherUserId, usageId),
        repositories.platformAgents.findAssignedToUser(
          otherUserId,
          platformAgentId,
        ),
      ]),
    ).resolves.toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      expect.objectContaining({ id: platformAgentId }),
    ]);

    await database.client.query(
      `update platform_agents set status = 'disabled' where id = $1`,
      [platformAgentId],
    );
    await expect(
      repositories.platformAgents.findAssignedToUser(ownerId, platformAgentId),
    ).resolves.toBeUndefined();
    await database.close();
  });

  it("never returns another tenant's resources", async () => {
    const database = await createTestDatabase();
    const repositories = createRepositories(database.db);
    const ownerId = id();
    const otherUserId = id();
    const agentId = id();
    await seedUser(database.client, { id: ownerId });
    await seedUser(database.client, { id: otherUserId });
    await database.client.query(
      `insert into personal_agents
        (id, owner_user_id, ark_agent_id, name, model_id, system_prompt, ark_version, status)
       values ($1, $2, 'ark-agent-tenant', 'Mine', 'model-a', 'Prompt', '1', 'active')`,
      [agentId, ownerId],
    );

    expect(
      await repositories.personalAgents.findOwned(ownerId, agentId),
    ).toMatchObject({ id: agentId, ownerUserId: ownerId });
    expect(
      await repositories.personalAgents.findOwned(otherUserId, agentId),
    ).toBeUndefined();
    await database.close();
  });

  it("transactionally assigns only active platform agents", async () => {
    const database = await createTestDatabase();
    const repositories = createRepositories(database.db);
    const userId = id();
    const adminId = id();
    const activeAgentId = id();
    const disabledAgentId = id();
    await seedUser(database.client, { id: userId });
    await seedUser(database.client, { id: adminId, role: "admin" });
    await database.client.query(
      `insert into platform_agents
        (id, ark_agent_id, name, model_id, system_prompt, ark_version, status,
         created_by, updated_by)
       values
        ($1, 'ark-platform-1', 'Active', 'model-a', 'Prompt', '1', 'active', $3, $3),
        ($2, 'ark-platform-2', 'Disabled', 'model-a', 'Prompt', '1', 'disabled', $3, $3)`,
      [activeAgentId, disabledAgentId, adminId],
    );

    await repositories.defaultAgents.assign({
      userId,
      platformAgentId: activeAgentId,
      assignedBy: adminId,
    });
    await expect(
      repositories.defaultAgents.assign({
        userId,
        platformAgentId: disabledAgentId,
        assignedBy: adminId,
      }),
    ).rejects.toThrow(/active platform agent/i);
    expect(await repositories.defaultAgents.findForUser(userId)).toMatchObject({
      platformAgentId: activeAgentId,
    });
    await database.close();
  });

  it("applies quota reservations atomically in the PGlite test backend", async () => {
    const database = await createTestDatabase();
    const repositories = createRepositories(database.db);
    const userId = id();
    await seedUser(database.client, { id: userId });
    await database.client.query(
      `insert into quota_policies
        (key, personal_agent_limit, concurrent_session_limit,
         daily_session_limit, monthly_token_limit)
       values ('default', 10, 2, 2, 1000)`,
    );

    const attempts = await Promise.allSettled(
      [id(), id(), id()].map((reservationId) =>
        repositories.quotas.reserveSession({
          userId,
          reservationId,
          expiresAt: new Date(Date.now() + 60_000),
        }),
      ),
    );

    expect(
      attempts.filter(({ status }) => status === "fulfilled"),
    ).toHaveLength(2);
    const rejection = attempts.find(({ status }) => status === "rejected");
    expect(rejection).toMatchObject({
      reason: expect.any(QuotaExceededError),
    });
    await database.close();
  });

  it("returns claimed jobs in deterministic priority order", async () => {
    const database = await createTestDatabase();
    const repositories = createRepositories(database.db);
    const userId = id();
    await seedUser(database.client, { id: userId });
    const now = new Date();
    await database.client.query(
      `insert into background_jobs
        (id, owner_user_id, type, status, priority, payload, run_after)
       values
        ($1, $4, 'delete_session', 'pending', 30, '{}', $5),
        ($2, $4, 'cleanup_upload', 'pending', 20, '{}', $5),
        ($3, $4, 'reconcile_session', 'pending', 10, '{}', $5)`,
      [id(), id(), id(), userId, now],
    );

    const first = await repositories.jobs.claim({
      workerId: "worker-1",
      limit: 2,
      now,
    });
    const second = await repositories.jobs.claim({
      workerId: "worker-2",
      limit: 2,
      now,
    });

    expect(first.map(({ priority }) => priority)).toEqual([10, 20]);
    expect(second.map(({ priority }) => priority)).toEqual([30]);
    expect(
      new Set([...first, ...second].map(({ id: jobId }) => jobId)).size,
    ).toBe(3);
    await database.close();
  });
});

describe("repository result contracts", () => {
  it("orders claimed jobs even when the database returns updated rows out of order", async () => {
    const now = new Date();
    const jobs = [
      {
        id: "00000000-0000-4000-8000-000000000030",
        ownerUserId: null,
        type: "delete_session",
        status: "running",
        priority: 30,
        payload: {},
        attempts: 1,
        maxAttempts: 10,
        runAfter: now,
        lockedAt: now,
        lockedBy: "worker-1",
      },
      {
        id: "00000000-0000-4000-8000-000000000010",
        ownerUserId: null,
        type: "cleanup_upload",
        status: "running",
        priority: 10,
        payload: {},
        attempts: 1,
        maxAttempts: 10,
        runAfter: now,
        lockedAt: now,
        lockedBy: "worker-1",
      },
    ];
    const execute = async () => ({ rows: jobs });
    const database = {
      execute,
      transaction: async <T>(
        callback: (transaction: { execute: typeof execute }) => Promise<T>,
      ) => callback({ execute }),
    };
    const repositories = createRepositories(database);

    const claimed = await repositories.jobs.claim({
      workerId: "worker-1",
      limit: 2,
      now,
    });

    expect(claimed.map(({ priority }) => priority)).toEqual([10, 30]);
  });
});
