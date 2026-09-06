import { describe, expect, it } from "vitest";
import { ArkGatewayError } from "../packages/ark-client/src/index.js";
import { createRepositories } from "../packages/db/src/index.js";
import {
  SessionService,
  type SessionRecord,
} from "../packages/domain/src/index.js";
import { createTestDatabase, id } from "./support/test-database.js";

async function seedUserAndAgent(
  client: Awaited<ReturnType<typeof createTestDatabase>>["client"],
) {
  const userId = id();
  const agentId = id();
  await client.query(
    `insert into users (id, auth_subject, email)
     values ($1, $2, $3)`,
    [userId, `subject-${userId}`, `${userId}@example.com`],
  );
  await client.query(
    `insert into quota_policies
      (key, personal_agent_limit, concurrent_session_limit,
       daily_session_limit, monthly_token_limit)
     values ('default', 10, 2, 5, 1000)`,
  );
  await client.query(
    `insert into personal_agents
      (id, owner_user_id, ark_agent_id, name, model_id, system_prompt,
       ark_version, status)
     values ($1, $2, 'ark-agent-1', 'Original Agent', 'model-a', 'Prompt',
             '7', 'active')`,
    [agentId, userId],
  );
  return { userId, agentId };
}

function createIntent(userId: string, agentId: string): SessionRecord {
  const sessionId = id();
  const timestamp = new Date("2026-09-06T00:00:00.000Z");
  return {
    id: sessionId,
    ownerUserId: userId,
    arkSessionId: `pending:${sessionId}`,
    agentKind: "personal",
    platformAgentId: null,
    personalAgentId: agentId,
    arkAgentId: "ark-agent-1",
    agentName: "Original Agent",
    agentVersion: "7",
    environmentId: "environment-1",
    title: "Task",
    status: "idle",
    lastErrorCode: null,
    errorRecoverable: null,
    archivedAt: null,
    deletionState: "none",
    lastEventAt: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

describe("Session database integration", () => {
  it("atomically reserves quota and stores a durable create intent", async () => {
    const database = await createTestDatabase();
    const repositories = createRepositories(database.db);
    const { userId, agentId } = await seedUserAndAgent(database.client);
    const intent = createIntent(userId, agentId);

    await repositories.sessionLifecycle.prepareCreate(intent);

    const stored = await database.client.query<{
      ark_session_id: string;
      agent_name: string;
      agent_version: string;
      environment_id: string;
      reservation_status: string;
      job_status: string;
      payload: Record<string, unknown>;
    }>(
      `select s.ark_session_id, s.agent_name, s.agent_version, s.environment_id,
              qr.status as reservation_status, j.status as job_status, j.payload
         from sessions s
         join quota_reservations qr on qr.id = s.id
         join background_jobs j on j.id = s.id
        where s.id = $1`,
      [intent.id],
    );
    expect(stored.rows[0]).toMatchObject({
      ark_session_id: `pending:${intent.id}`,
      agent_name: "Original Agent",
      agent_version: "7",
      environment_id: "environment-1",
      reservation_status: "active",
      job_status: "pending",
      payload: { operation: "create", sessionId: intent.id },
    });
    await database.close();
  });

  it("counts a pending Session row and its reservation as one daily create intent", async () => {
    const database = await createTestDatabase();
    const repositories = createRepositories(database.db);
    const { userId, agentId } = await seedUserAndAgent(database.client);
    await database.client.query(
      `update quota_policies set daily_session_limit = 2
        where key = 'default'`,
    );
    const pending = createIntent(userId, agentId);
    const second = createIntent(userId, agentId);
    const overLimit = createIntent(userId, agentId);

    await repositories.sessionLifecycle.prepareCreate(pending);
    await expect(
      repositories.sessionLifecycle.prepareCreate(second),
    ).resolves.toBeUndefined();
    await expect(
      repositories.sessionLifecycle.prepareCreate(overLimit),
    ).rejects.toMatchObject({ dimension: "daily_sessions" });
    await database.close();
  });

  it("atomically permits only one concurrent create for one remaining daily slot", async () => {
    const database = await createTestDatabase();
    const repositories = createRepositories(database.db);
    const { userId, agentId } = await seedUserAndAgent(database.client);
    await database.client.query(
      `update quota_policies set daily_session_limit = 1
        where key = 'default'`,
    );

    const creates = await Promise.allSettled([
      repositories.sessionLifecycle.prepareCreate(
        createIntent(userId, agentId),
      ),
      repositories.sessionLifecycle.prepareCreate(
        createIntent(userId, agentId),
      ),
    ]);

    expect(creates.filter(({ status }) => status === "fulfilled")).toHaveLength(
      1,
    );
    expect(creates.filter(({ status }) => status === "rejected")).toHaveLength(
      1,
    );
    expect(creates.find(({ status }) => status === "rejected")).toMatchObject({
      reason: { name: "QuotaExceededError", dimension: "daily_sessions" },
    });
    const stored = await database.client.query<{ count: number }>(
      `select count(*)::integer as count
         from sessions
        where owner_user_id = $1`,
      [userId],
    );
    expect(stored.rows[0]?.count).toBe(1);
    await database.close();
  });

  it("completes creation and keeps immutable Agent metadata in list/detail", async () => {
    const database = await createTestDatabase();
    const repositories = createRepositories(database.db);
    const { userId, agentId } = await seedUserAndAgent(database.client);
    const intent = createIntent(userId, agentId);
    await repositories.sessionLifecycle.prepareCreate(intent);

    const created = await repositories.sessionLifecycle.completeCreate(
      intent.id,
      userId,
      {
        arkSessionId: "ark-session-1",
        arkAgentId: "ark-agent-1",
        agentVersion: "7",
        status: "idle",
      },
    );
    await database.client.query(
      `update personal_agents set name = 'Renamed', ark_version = '8'
        where id = $1`,
      [agentId],
    );

    expect(created).toMatchObject({
      arkSessionId: "ark-session-1",
      agentName: "Original Agent",
      agentVersion: "7",
    });
    await expect(
      repositories.sessionLifecycle.findOwned(userId, intent.id),
    ).resolves.toMatchObject({
      agentName: "Original Agent",
      agentVersion: "7",
    });
    await expect(
      repositories.sessionLifecycle.listOwned(userId, false),
    ).resolves.toEqual([
      expect.objectContaining({
        agentName: "Original Agent",
        agentVersion: "7",
      }),
    ]);

    const state = await database.client.query<{
      reservation_status: string;
      job_status: string;
    }>(
      `select qr.status as reservation_status, j.status as job_status
         from quota_reservations qr
         join background_jobs j on j.id = qr.id
        where qr.id = $1`,
      [intent.id],
    );
    expect(state.rows[0]).toEqual({
      reservation_status: "consumed",
      job_status: "succeeded",
    });
    await database.close();
  });

  it("projects each Ark event once with status and recoverable error state", async () => {
    const database = await createTestDatabase();
    const repositories = createRepositories(database.db);
    const { userId, agentId } = await seedUserAndAgent(database.client);
    const intent = createIntent(userId, agentId);
    await repositories.sessionLifecycle.prepareCreate(intent);
    await repositories.sessionLifecycle.completeCreate(intent.id, userId, {
      arkSessionId: "ark-session-projection",
      arkAgentId: "ark-agent-1",
      agentVersion: "7",
      status: "idle",
    });

    await repositories.sessionLifecycle.projectEvent(userId, intent.id, {
      eventId: "event-1",
      observedAt: new Date("2026-09-06T00:00:01.000Z"),
      status: "running",
      errorCode: null,
      errorRecoverable: null,
    });
    await repositories.sessionLifecycle.projectEvent(userId, intent.id, {
      eventId: "event-1",
      observedAt: new Date("2026-09-06T00:00:02.000Z"),
      status: "terminated",
      errorCode: "DUPLICATE",
      errorRecoverable: false,
    });
    await repositories.sessionLifecycle.projectEvent(userId, intent.id, {
      eventId: "event-2",
      observedAt: new Date("2026-09-06T00:00:03.000Z"),
      status: "rescheduled",
      errorCode: "TEMPORARY",
      errorRecoverable: true,
    });
    await repositories.sessionLifecycle.projectEvent(id(), intent.id, {
      eventId: "foreign-event",
      observedAt: new Date("2026-09-06T00:00:04.000Z"),
      status: "terminated",
      errorCode: "FOREIGN",
      errorRecoverable: false,
    });

    const projected = await repositories.sessionLifecycle.findOwned(
      userId,
      intent.id,
    );
    expect(projected).toMatchObject({
      status: "rescheduled",
      lastErrorCode: "TEMPORARY",
      errorRecoverable: true,
    });
    expect(new Date(projected!.lastEventAt!).toISOString()).toBe(
      "2026-09-06T00:00:03.000Z",
    );
    const cursor = await database.client.query<{
      recent_event_ids: string[];
    }>(
      `select recent_event_ids
         from session_event_cursors
        where session_id = $1`,
      [intent.id],
    );
    expect(cursor.rows[0]?.recent_event_ids).toEqual(["event-1", "event-2"]);
    await database.close();
  });

  it("releases definite failures but preserves unknown outcomes for reconciliation", async () => {
    const database = await createTestDatabase();
    const repositories = createRepositories(database.db);
    const { userId, agentId } = await seedUserAndAgent(database.client);
    const failed = createIntent(userId, agentId);
    await repositories.sessionLifecycle.prepareCreate(failed);
    await repositories.sessionLifecycle.failCreate(failed.id, userId);

    await expect(
      repositories.sessionLifecycle.findCreateIntent(userId, failed.id),
    ).resolves.toBeUndefined();
    const failedState = await database.client.query<{
      reservation_status: string;
      job_status: string;
    }>(
      `select qr.status as reservation_status, j.status as job_status
         from quota_reservations qr
         join background_jobs j on j.id = qr.id
        where qr.id = $1`,
      [failed.id],
    );
    expect(failedState.rows[0]).toEqual({
      reservation_status: "released",
      job_status: "failed",
    });

    const unknown = createIntent(userId, agentId);
    await repositories.sessionLifecycle.prepareCreate(unknown);
    await repositories.sessionLifecycle.preserveCreateOutcome(
      unknown.id,
      userId,
    );
    await expect(
      repositories.sessionLifecycle.findCreateIntent(userId, unknown.id),
    ).resolves.toMatchObject({
      arkSessionId: `pending:${unknown.id}`,
    });
    await expect(
      repositories.sessionLifecycle.listOwned(userId, false),
    ).resolves.toEqual([]);
    const unknownState = await database.client.query<{
      reservation_status: string;
      job_status: string;
    }>(
      `select qr.status as reservation_status, j.status as job_status
         from quota_reservations qr
         join background_jobs j on j.id = qr.id
        where qr.id = $1`,
      [unknown.id],
    );
    expect(unknownState.rows[0]).toEqual({
      reservation_status: "consumed",
      job_status: "pending",
    });
    await database.close();
  });

  it("exposes exhausted create reconciliation and retains its consumed quota", async () => {
    const database = await createTestDatabase();
    const repositories = createRepositories(database.db);
    const { userId, agentId } = await seedUserAndAgent(database.client);
    const intent = createIntent(userId, agentId);
    await repositories.sessionLifecycle.prepareCreate(intent);
    await repositories.sessionLifecycle.preserveCreateOutcome(
      intent.id,
      userId,
    );
    await database.client.query(
      `update background_jobs
          set max_attempts = 1, run_after = '2000-01-01'
        where id = $1`,
      [intent.id],
    );
    const [claimed] = await repositories.jobs.claim({
      workerId: "session-worker",
      limit: 1,
      now: new Date("2026-09-06T01:00:00.000Z"),
      types: ["reconcile_session"],
    });
    expect(claimed).toBeDefined();

    await repositories.jobs.retry(
      intent.id,
      "session-worker",
      "Ark unavailable",
      true,
    );

    const terminal = await database.client.query<{
      status: string;
      deletion_state: string;
      reservation_status: string;
      job_status: string;
    }>(
      `select s.status, s.deletion_state,
              qr.status as reservation_status, j.status as job_status
         from sessions s
         join quota_reservations qr on qr.id = s.id
         join background_jobs j on j.id = s.id
        where s.id = $1`,
      [intent.id],
    );
    expect(terminal.rows[0]).toEqual({
      status: "terminated",
      deletion_state: "deletion_failed",
      reservation_status: "consumed",
      job_status: "failed",
    });
    await expect(
      repositories.sessionLifecycle.listOwned(userId, false),
    ).resolves.toEqual([
      expect.objectContaining({
        id: intent.id,
        status: "terminated",
        deletionState: "deletion_failed",
      }),
    ]);
    await database.close();
  });

  it("exposes an exhausted create after a worker lease expires", async () => {
    const database = await createTestDatabase();
    const repositories = createRepositories(database.db);
    const { userId, agentId } = await seedUserAndAgent(database.client);
    const intent = createIntent(userId, agentId);
    await repositories.sessionLifecycle.prepareCreate(intent);
    await repositories.sessionLifecycle.preserveCreateOutcome(
      intent.id,
      userId,
    );
    await database.client.query(
      `update background_jobs
          set status = 'running', attempts = 1, max_attempts = 1,
              locked_at = '2026-09-06T00:00:00Z', locked_by = 'crashed'
        where id = $1`,
      [intent.id],
    );

    await expect(
      repositories.jobs.claim({
        workerId: "recovery-worker",
        limit: 1,
        now: new Date("2026-09-06T00:05:00.001Z"),
        types: ["reconcile_session"],
      }),
    ).resolves.toEqual([]);

    await expect(
      repositories.sessionLifecycle.findOwned(userId, intent.id),
    ).resolves.toMatchObject({
      status: "terminated",
      deletionState: "deletion_failed",
    });
    await database.close();
  });

  it("filters archived Sessions and never returns another tenant's Session", async () => {
    const database = await createTestDatabase();
    const repositories = createRepositories(database.db);
    const { userId, agentId } = await seedUserAndAgent(database.client);
    const active = createIntent(userId, agentId);
    const archived = createIntent(userId, agentId);
    archived.archivedAt = new Date("2026-09-06T01:00:00.000Z");

    for (const intent of [active, archived]) {
      await repositories.sessionLifecycle.prepareCreate(intent);
      await repositories.sessionLifecycle.completeCreate(intent.id, userId, {
        arkSessionId: `ark-${intent.id}`,
        arkAgentId: intent.arkAgentId,
        agentVersion: intent.agentVersion,
        status: "idle",
      });
    }

    await expect(
      repositories.sessionLifecycle.listOwned(userId, false),
    ).resolves.toEqual([expect.objectContaining({ id: active.id })]);
    await expect(
      repositories.sessionLifecycle.listOwned(userId, true),
    ).resolves.toEqual([expect.objectContaining({ id: archived.id })]);
    await expect(
      repositories.sessionLifecycle.findOwned(id(), active.id),
    ).resolves.toBeUndefined();
    await database.close();
  });

  it("archives and restores by changing only archived_at for the owning tenant", async () => {
    const database = await createTestDatabase();
    const repositories = createRepositories(database.db);
    const { userId, agentId } = await seedUserAndAgent(database.client);
    const intent = createIntent(userId, agentId);
    await repositories.sessionLifecycle.prepareCreate(intent);
    await repositories.sessionLifecycle.completeCreate(intent.id, userId, {
      arkSessionId: "ark-session-archive",
      arkAgentId: intent.arkAgentId,
      agentVersion: intent.agentVersion,
      status: "idle",
    });
    const before = await database.client.query<Record<string, unknown>>(
      `select * from sessions where id = $1`,
      [intent.id],
    );
    const archivedAt = new Date("2026-09-06T03:00:00.000Z");

    const archivedRecord = await repositories.sessionLifecycle.setArchived(
      userId,
      intent.id,
      archivedAt,
    );
    expect(new Date(archivedRecord!.archivedAt!)).toEqual(archivedAt);
    await expect(
      repositories.sessionLifecycle.setArchived(id(), intent.id, null),
    ).resolves.toBeUndefined();
    const archived = await database.client.query<Record<string, unknown>>(
      `select * from sessions where id = $1`,
      [intent.id],
    );
    expect(archived.rows[0]).toEqual({
      ...before.rows[0],
      archived_at: archivedAt,
    });

    await repositories.sessionLifecycle.setArchived(userId, intent.id, null);
    await expect(
      repositories.sessionLifecycle.listOwned(userId, false),
    ).resolves.toEqual([expect.objectContaining({ id: intent.id })]);
    await database.close();
  });

  it("checkpoints and removes only the owned Session deletion graph", async () => {
    const database = await createTestDatabase();
    const repositories = createRepositories(database.db);
    const { userId, agentId } = await seedUserAndAgent(database.client);
    const intent = createIntent(userId, agentId);
    await repositories.sessionLifecycle.prepareCreate(intent);
    await repositories.sessionLifecycle.completeCreate(intent.id, userId, {
      arkSessionId: "ark-session-saga",
      arkAgentId: intent.arkAgentId,
      agentVersion: intent.agentVersion,
      status: "idle",
    });
    const inputId = id();
    const artifactId = id();
    const objectKey = `tenants/${userId}/sessions/${intent.id}/artifacts/file/version`;
    const stagedObjectKey = `tenants/${userId}/sessions/${intent.id}/artifacts/staged/version`;
    await database.client.query(
      `insert into session_inputs
        (id, owner_user_id, session_id, ark_file_id, original_name, mime_type,
         size_bytes, mount_path, status, expires_at)
       values ($1, $2, $3, 'ark-input', 'input.txt', 'text/plain', 1,
               '/mnt/session/inputs/input.txt', 'bound', now())`,
      [inputId, userId, intent.id],
    );
    await database.client.query(
      `insert into artifacts
        (id, owner_user_id, session_id, ark_file_id, tos_object_key, name,
         mime_type, size_bytes, generated_at)
       values ($1, $2, $3, 'ark-output', $4, 'output.txt', 'text/plain', 1,
               now())`,
      [artifactId, userId, intent.id, objectKey],
    );
    await database.client.query(
      `insert into usage_ledger
        (id, user_id, ark_session_id, ark_event_id, metric_type, quantity)
       values ($1, $2, 'ark-session-saga', 'event-1', 'input_tokens', 1)`,
      [id(), userId],
    );
    await database.client.query(
      `insert into background_jobs
        (id, owner_user_id, type, status, priority, payload)
       values ($1, $2, 'cleanup_artifact_object', 'pending', 90, $3::jsonb)`,
      [id(), userId, JSON.stringify({ objectKey: stagedObjectKey })],
    );
    await repositories.sessionLifecycle.beginDelete(userId, intent.id);
    await expect(
      repositories.artifacts.findSessionOwned(userId, intent.id),
    ).resolves.toBeUndefined();
    const [job] = await repositories.jobs.claim({
      workerId: "worker-1",
      limit: 1,
      types: ["delete_session"],
    });
    const payload = {
      sessionId: intent.id,
      completed: { nonRunningObserved: true },
    };

    await repositories.jobs.updatePayload(job!.id, "worker-1", payload);
    await expect(
      repositories.sessionDeletion.findDeleting(id(), intent.id),
    ).resolves.toBeUndefined();
    await expect(
      repositories.sessionDeletion.listArtifactObjectKeys(id(), intent.id),
    ).resolves.toEqual([]);
    await repositories.sessionDeletion.removeLocal(id(), intent.id);
    await expect(
      repositories.sessionDeletion.findDeleting(userId, intent.id),
    ).resolves.toMatchObject({ id: intent.id });
    await expect(
      repositories.sessionDeletion.listArtifactObjectKeys(userId, intent.id),
    ).resolves.toEqual([objectKey, stagedObjectKey].sort());

    await expect(
      repositories.sessionDeletion.removeLocal(userId, intent.id),
    ).resolves.toBe("cleanup_pending");
    await database.client.query(
      `update background_jobs
          set status = 'succeeded'
        where owner_user_id = $1
          and type = 'cleanup_artifact_object'
          and payload ->> 'objectKey' = $2`,
      [userId, stagedObjectKey],
    );
    await expect(
      repositories.sessionDeletion.removeLocal(userId, intent.id),
    ).resolves.toBe("removed");
    const remaining = await database.client.query<{ count: number }>(
      `select
         (select count(*) from sessions where id = $1)
         + (select count(*) from session_inputs where session_id = $1)
         + (select count(*) from artifacts where session_id = $1)
         + (select count(*) from usage_ledger
             where ark_session_id = 'ark-session-saga')
         + (select count(*) from quota_reservations where id = $1)
           as count`,
      [intent.id],
    );
    expect(remaining.rows[0]?.count).toBe(0);
    const retainedJob = await database.client.query<{
      payload: Record<string, unknown>;
    }>(`select payload from background_jobs where id = $1`, [intent.id]);
    expect(retainedJob.rows[0]?.payload).toEqual(payload);
    await database.close();
  });

  it("creates one tenant-owned deletion job and preserves Saga progress when rearmed", async () => {
    const database = await createTestDatabase();
    const repositories = createRepositories(database.db);
    const { userId, agentId } = await seedUserAndAgent(database.client);
    const intent = createIntent(userId, agentId);
    await repositories.sessionLifecycle.prepareCreate(intent);
    await repositories.sessionLifecycle.completeCreate(intent.id, userId, {
      arkSessionId: "ark-session-delete",
      arkAgentId: intent.arkAgentId,
      agentVersion: intent.agentVersion,
      status: "idle",
    });

    await expect(
      repositories.sessionLifecycle.beginDelete(id(), intent.id),
    ).resolves.toBeUndefined();
    await repositories.sessionLifecycle.beginDelete(userId, intent.id);
    await repositories.sessionLifecycle.beginDelete(userId, intent.id);

    const initial = await database.client.query<{
      type: string;
      status: string;
      count: number;
      payload: Record<string, unknown>;
    }>(
      `select min(type::text) as type, min(status::text) as status,
              count(*)::integer as count, min(payload::text)::jsonb as payload
         from background_jobs
        where id = $1`,
      [intent.id],
    );
    expect(initial.rows[0]).toMatchObject({
      type: "delete_session",
      status: "pending",
      count: 1,
      payload: { sessionId: intent.id, completed: {} },
    });

    await database.client.query(
      `update background_jobs
          set status = 'failed', attempts = max_attempts,
              payload = $2::jsonb, last_error = 'SESSION_DELETE_FAILED'
        where id = $1`,
      [
        intent.id,
        JSON.stringify({
          sessionId: intent.id,
          completed: { nonRunningObserved: true, arkDeleted: true },
        }),
      ],
    );
    await repositories.sessionLifecycle.beginDelete(userId, intent.id);
    const rearmed = await database.client.query<{
      status: string;
      attempts: number;
      payload: Record<string, unknown>;
    }>(`select status, attempts, payload from background_jobs where id = $1`, [
      intent.id,
    ]);
    expect(rearmed.rows[0]).toMatchObject({
      status: "pending",
      attempts: 0,
      payload: {
        sessionId: intent.id,
        completed: { nonRunningObserved: true, arkDeleted: true },
      },
    });
    await database.close();
  });

  it("leaves pending and running deletion work untouched and rearms only terminal failure", async () => {
    const database = await createTestDatabase();
    const repositories = createRepositories(database.db);
    const { userId, agentId } = await seedUserAndAgent(database.client);
    const intent = createIntent(userId, agentId);
    await repositories.sessionLifecycle.prepareCreate(intent);
    await repositories.sessionLifecycle.completeCreate(intent.id, userId, {
      arkSessionId: "ark-session-repeat-delete",
      arkAgentId: intent.arkAgentId,
      agentVersion: intent.agentVersion,
      status: "idle",
    });
    await repositories.sessionLifecycle.beginDelete(userId, intent.id);
    await database.client.query(
      `update sessions
          set deletion_state = 'deletion_failed',
              updated_at = '2030-09-06T00:00:00.000Z'
        where id = $1`,
      [intent.id],
    );
    await database.client.query(
      `update background_jobs
          set status = 'pending', attempts = 2,
              run_after = '2030-09-06T01:00:00.000Z',
              last_error = 'SESSION_DELETE_FAILED',
              updated_at = '2030-09-06T00:00:00.000Z'
        where id = $1`,
      [intent.id],
    );
    const readState = () =>
      database.client.query<{
        deletion_state: string;
        session_updated_at: Date;
        status: string;
        attempts: number;
        run_after: Date;
        locked_at: Date | null;
        locked_by: string | null;
        last_error: string | null;
        payload: Record<string, unknown>;
        job_updated_at: Date;
      }>(
        `select session.deletion_state,
                session.updated_at as session_updated_at,
                job.status::text, job.attempts, job.run_after, job.locked_at,
                job.locked_by, job.last_error, job.payload,
                job.updated_at as job_updated_at
           from sessions session
           join background_jobs job on job.id = session.id
          where session.id = $1`,
        [intent.id],
      );

    const pendingBefore = await readState();
    await expect(
      repositories.sessionLifecycle.beginDelete(userId, intent.id),
    ).resolves.toMatchObject({ deletionState: "deletion_failed" });
    const pendingAfter = await readState();
    expect(pendingAfter.rows).toEqual(pendingBefore.rows);

    const [claimed] = await repositories.jobs.claim({
      workerId: "active-delete-worker",
      limit: 1,
      now: new Date("2030-09-06T02:00:00.000Z"),
      types: ["delete_session"],
    });
    expect(claimed).toMatchObject({ id: intent.id, attempts: 3 });
    const runningBefore = await readState();
    await expect(
      repositories.sessionLifecycle.beginDelete(userId, intent.id),
    ).resolves.toMatchObject({ deletionState: "deletion_failed" });
    const runningAfter = await readState();
    expect(runningAfter.rows).toEqual(runningBefore.rows);

    const progress = {
      sessionId: intent.id,
      completed: { nonRunningObserved: true, arkDeleted: true },
    };
    await database.client.query(
      `update background_jobs
          set status = 'failed', attempts = max_attempts,
              payload = $2::jsonb, locked_at = null, locked_by = null,
              last_error = 'SESSION_DELETE_FAILED'
        where id = $1`,
      [intent.id, JSON.stringify(progress)],
    );
    await expect(
      repositories.sessionLifecycle.beginDelete(userId, intent.id),
    ).resolves.toMatchObject({ deletionState: "pending" });
    const rearmed = await readState();
    expect(rearmed.rows[0]).toMatchObject({
      deletion_state: "pending",
      status: "pending",
      attempts: 0,
      locked_at: null,
      locked_by: null,
      last_error: null,
      payload: progress,
    });
    await database.close();
  });

  it("preserves a deletion lease when a repeated request races a claim", async () => {
    const database = await createTestDatabase();
    const repositories = createRepositories(database.db);
    const { userId, agentId } = await seedUserAndAgent(database.client);
    const intent = createIntent(userId, agentId);
    await repositories.sessionLifecycle.prepareCreate(intent);
    await repositories.sessionLifecycle.completeCreate(intent.id, userId, {
      arkSessionId: "ark-session-delete-race",
      arkAgentId: intent.arkAgentId,
      agentVersion: intent.agentVersion,
      status: "idle",
    });
    await repositories.sessionLifecycle.beginDelete(userId, intent.id);
    await database.client.query(
      `update sessions set deletion_state = 'deletion_failed' where id = $1`,
      [intent.id],
    );
    await database.client.query(
      `update background_jobs
          set status = 'pending', attempts = 2,
              run_after = '2030-09-06T00:00:00.000Z',
              last_error = 'SESSION_DELETE_FAILED'
        where id = $1`,
      [intent.id],
    );

    const [requested, racedClaims] = await Promise.all([
      repositories.sessionLifecycle.beginDelete(userId, intent.id),
      repositories.jobs.claim({
        workerId: "claim-worker",
        limit: 1,
        now: new Date("2030-09-06T01:00:00.000Z"),
        types: ["delete_session"],
      }),
    ]);
    const claims =
      racedClaims.length > 0
        ? racedClaims
        : await repositories.jobs.claim({
            workerId: "claim-worker",
            limit: 1,
            now: new Date("2030-09-06T01:00:00.000Z"),
            types: ["delete_session"],
          });

    expect(requested).toMatchObject({ deletionState: "deletion_failed" });
    expect(claims).toEqual([
      expect.objectContaining({
        id: intent.id,
        attempts: 3,
        lockedBy: "claim-worker",
      }),
    ]);
    const leased = await database.client.query<{
      deletion_state: string;
      status: string;
      attempts: number;
      locked_by: string | null;
      last_error: string | null;
    }>(
      `select session.deletion_state, job.status::text, job.attempts,
              job.locked_by, job.last_error
         from sessions session
         join background_jobs job on job.id = session.id
        where session.id = $1`,
      [intent.id],
    );
    expect(leased.rows[0]).toEqual({
      deletion_state: "deletion_failed",
      status: "running",
      attempts: 3,
      locked_by: "claim-worker",
      last_error: "SESSION_DELETE_FAILED",
    });
    await database.close();
  });

  it("marks an exhausted Session deletion lease as a visible stable failure", async () => {
    const database = await createTestDatabase();
    const repositories = createRepositories(database.db);
    const { userId, agentId } = await seedUserAndAgent(database.client);
    const intent = createIntent(userId, agentId);
    await repositories.sessionLifecycle.prepareCreate(intent);
    await repositories.sessionLifecycle.completeCreate(intent.id, userId, {
      arkSessionId: "ark-session-expired-delete",
      arkAgentId: intent.arkAgentId,
      agentVersion: intent.agentVersion,
      status: "idle",
    });
    await repositories.sessionLifecycle.beginDelete(userId, intent.id);
    await database.client.query(
      `update background_jobs
          set status = 'running', attempts = max_attempts,
              locked_at = $2, locked_by = 'dead-worker',
              last_error = 'provider secret'
        where id = $1`,
      [intent.id, new Date("2026-09-06T00:00:00.000Z")],
    );

    await expect(
      repositories.jobs.claim({
        workerId: "worker-2",
        limit: 1,
        types: ["delete_session"],
        now: new Date("2026-09-06T01:00:00.000Z"),
      }),
    ).resolves.toEqual([]);
    await expect(
      repositories.sessionLifecycle.findOwned(userId, intent.id),
    ).resolves.toMatchObject({ deletionState: "deletion_failed" });
    const failed = await database.client.query<{
      status: string;
      last_error: string;
    }>(`select status, last_error from background_jobs where id = $1`, [
      intent.id,
    ]);
    expect(failed.rows[0]).toEqual({
      status: "failed",
      last_error: "SESSION_DELETE_LEASE_EXPIRED",
    });
    await database.close();
  });

  it("lease-retries partial Session deletion failures from their saved payload", async () => {
    const database = await createTestDatabase();
    const repositories = createRepositories(database.db);
    const { userId, agentId } = await seedUserAndAgent(database.client);
    const intent = createIntent(userId, agentId);
    await repositories.sessionLifecycle.prepareCreate(intent);
    await repositories.sessionLifecycle.completeCreate(intent.id, userId, {
      arkSessionId: "ark-session-retry-delete",
      arkAgentId: intent.arkAgentId,
      agentVersion: intent.agentVersion,
      status: "idle",
    });
    await repositories.sessionLifecycle.beginDelete(userId, intent.id);
    const [firstAttempt] = await repositories.jobs.claim({
      workerId: "worker-1",
      limit: 1,
      types: ["delete_session"],
      now: new Date("2030-09-06T01:00:00.000Z"),
    });
    const payload = {
      sessionId: intent.id,
      completed: { nonRunningObserved: true, arkDeleted: true },
    };
    await repositories.jobs.updatePayload(
      firstAttempt!.id,
      "worker-1",
      payload,
    );
    await repositories.jobs.retry(
      firstAttempt!.id,
      "worker-1",
      "provider secret",
      false,
      new Date("2030-09-06T01:00:00.000Z"),
    );

    await expect(
      repositories.sessionLifecycle.findOwned(userId, intent.id),
    ).resolves.toMatchObject({ deletionState: "deletion_failed" });
    const [retried] = await repositories.jobs.claim({
      workerId: "worker-2",
      limit: 1,
      types: ["delete_session"],
      now: new Date("2030-09-06T01:02:00.000Z"),
    });
    expect(retried).toMatchObject({
      id: intent.id,
      attempts: 2,
      payload,
    });
    const stored = await database.client.query<{ last_error: string }>(
      `select last_error from background_jobs where id = $1`,
      [intent.id],
    );
    expect(stored.rows[0]?.last_error).toBe("SESSION_DELETE_FAILED");
    await database.close();
  });

  it("checks monthly message quota without blocking interrupts or reads", async () => {
    const database = await createTestDatabase();
    const repositories = createRepositories(database.db);
    const { userId, agentId } = await seedUserAndAgent(database.client);
    const intent = createIntent(userId, agentId);
    await repositories.sessionLifecycle.prepareCreate(intent);
    await repositories.sessionLifecycle.completeCreate(intent.id, userId, {
      arkSessionId: "ark-session-quota",
      arkAgentId: intent.arkAgentId,
      agentVersion: intent.agentVersion,
      status: "idle",
    });
    await database.client.query(
      `insert into usage_ledger
        (id, user_id, ark_session_id, ark_event_id, metric_type, quantity)
       values ($1, $2, 'ark-session-quota', 'event-1', 'input_tokens', 1000)`,
      [id(), userId],
    );

    await expect(
      repositories.sessionLifecycle.beginMessage(userId, intent.id),
    ).rejects.toMatchObject({ dimension: "monthly_tokens" });
    await database.close();
  });

  it.each(["pending", "deletion_failed"] as const)(
    "rejects message admission from deletion state %s without changing Session accounting",
    async (deletionState) => {
      const database = await createTestDatabase();
      const repositories = createRepositories(database.db);
      const { userId, agentId } = await seedUserAndAgent(database.client);
      const intent = createIntent(userId, agentId);
      await repositories.sessionLifecycle.prepareCreate(intent);
      await repositories.sessionLifecycle.completeCreate(intent.id, userId, {
        arkSessionId: `ark-session-message-${deletionState}`,
        arkAgentId: intent.arkAgentId,
        agentVersion: intent.agentVersion,
        status: "idle",
      });
      await database.client.query(
        `update sessions
            set deletion_state = $2,
                message_in_flight_count = 0,
                message_start_pending = false,
                updated_at = '2030-09-06T00:00:00.000Z'
          where id = $1`,
        [intent.id, deletionState],
      );
      const before = await database.client.query<{
        status: string;
        deletion_state: string;
        message_in_flight_count: number;
        message_start_pending: boolean;
        updated_at: Date;
      }>(
        `select status, deletion_state, message_in_flight_count,
                message_start_pending, updated_at
           from sessions
          where id = $1`,
        [intent.id],
      );

      await expect(
        repositories.sessionLifecycle.beginMessage(userId, intent.id),
      ).resolves.toEqual({
        kind: "deletion_conflict",
        deletionState,
      });
      const after = await database.client.query<{
        status: string;
        deletion_state: string;
        message_in_flight_count: number;
        message_start_pending: boolean;
        updated_at: Date;
      }>(
        `select status, deletion_state, message_in_flight_count,
                message_start_pending, updated_at
           from sessions
          where id = $1`,
        [intent.id],
      );
      expect(after.rows).toEqual(before.rows);
      await database.close();
    },
  );

  it("atomically permits only one idle Session to claim the running quota", async () => {
    const database = await createTestDatabase();
    const repositories = createRepositories(database.db);
    const { userId, agentId } = await seedUserAndAgent(database.client);
    await database.client.query(
      `update quota_policies set concurrent_session_limit = 1
        where key = 'default'`,
    );
    const first = createIntent(userId, agentId);
    const second = createIntent(userId, agentId);
    for (const intent of [first, second]) {
      await repositories.sessionLifecycle.prepareCreate(intent);
      await repositories.sessionLifecycle.completeCreate(intent.id, userId, {
        arkSessionId: `ark-${intent.id}`,
        arkAgentId: intent.arkAgentId,
        agentVersion: intent.agentVersion,
        status: "idle",
      });
    }

    const starts = await Promise.allSettled([
      repositories.sessionLifecycle.beginMessage(userId, first.id),
      repositories.sessionLifecycle.beginMessage(userId, second.id),
    ]);

    expect(starts.filter(({ status }) => status === "fulfilled")).toHaveLength(
      1,
    );
    expect(starts.filter(({ status }) => status === "rejected")).toHaveLength(
      1,
    );
    expect(starts.find(({ status }) => status === "rejected")).toMatchObject({
      reason: { name: "QuotaExceededError", dimension: "concurrent_sessions" },
    });
    const statuses = await database.client.query<{ status: string }>(
      `select status from sessions where owner_user_id = $1 order by status`,
      [userId],
    );
    expect(statuses.rows.map(({ status }) => status).sort()).toEqual([
      "idle",
      "running",
    ]);
    await database.close();
  });

  it("accepts supplemental messages without reapplying concurrent quota", async () => {
    const database = await createTestDatabase();
    const repositories = createRepositories(database.db);
    const { userId, agentId } = await seedUserAndAgent(database.client);
    const intent = createIntent(userId, agentId);
    await repositories.sessionLifecycle.prepareCreate(intent);
    await repositories.sessionLifecycle.completeCreate(intent.id, userId, {
      arkSessionId: "ark-session-running",
      arkAgentId: intent.arkAgentId,
      agentVersion: intent.agentVersion,
      status: "running",
    });
    await database.client.query(
      `update quota_policies set concurrent_session_limit = 0
        where key = 'default'`,
    );

    await expect(
      repositories.sessionLifecycle.beginMessage(userId, intent.id),
    ).resolves.toMatchObject({
      started: false,
      session: { id: intent.id, status: "running" },
    });
    await database.close();
  });

  it("keeps a Session quota-counted when a supplemental message is queued before its first message fails", async () => {
    const database = await createTestDatabase();
    const repositories = createRepositories(database.db);
    const { userId, agentId } = await seedUserAndAgent(database.client);
    await database.client.query(
      `update quota_policies set concurrent_session_limit = 1
        where key = 'default'`,
    );
    const running = createIntent(userId, agentId);
    const waiting = createIntent(userId, agentId);
    for (const intent of [running, waiting]) {
      await repositories.sessionLifecycle.prepareCreate(intent);
      await repositories.sessionLifecycle.completeCreate(intent.id, userId, {
        arkSessionId: `ark-${intent.id}`,
        arkAgentId: intent.arkAgentId,
        agentVersion: intent.agentVersion,
        status: "idle",
      });
    }

    let rejectFirst: (reason: unknown) => void = () => undefined;
    let markFirstSubmitted: () => void = () => undefined;
    const firstSubmitted = new Promise<void>((resolve) => {
      markFirstSubmitted = resolve;
    });
    const firstResult = new Promise<never>((_resolve, reject) => {
      rejectFirst = reject;
    });
    let submissions = 0;
    const service = new SessionService({
      repository: repositories.sessionLifecycle,
      agentResolver: {
        resolveForNewSession() {
          throw new Error("not used");
        },
      },
      ark: {
        createSession() {
          throw new Error("not used");
        },
        getSession() {
          throw new Error("not used");
        },
        submitEvent: async (_sessionId, event) => {
          submissions += 1;
          if (submissions === 1) {
            markFirstSubmitted();
            return firstResult;
          }
          return {
            id: "event-supplemental",
            type: event.type,
            createdAt: new Date().toISOString(),
            data: event.data,
          };
        },
      },
      environmentId: "environment-1",
      createId: id,
    });

    const firstMessage = service.sendMessage(
      running.id,
      { content: "Start" },
      { userId, requestId: "request-first" },
    );
    await firstSubmitted;
    await expect(
      service.sendMessage(
        running.id,
        { content: "Supplement" },
        { userId, requestId: "request-supplemental" },
      ),
    ).resolves.toEqual({
      eventId: "event-supplemental",
      delivery: "queued",
    });

    rejectFirst(new ArkGatewayError("runtime_busy"));
    await expect(firstMessage).rejects.toMatchObject({
      category: "runtime_busy",
    });
    await expect(
      repositories.sessionLifecycle.findOwned(userId, running.id),
    ).resolves.toMatchObject({ status: "running" });
    await expect(
      repositories.sessionLifecycle.beginMessage(userId, waiting.id),
    ).rejects.toMatchObject({
      dimension: "concurrent_sessions",
    });
    await database.close();
  });

  it("restores idle only after both concurrent message attempts fail definitively", async () => {
    const database = await createTestDatabase();
    const repositories = createRepositories(database.db);
    const { userId, agentId } = await seedUserAndAgent(database.client);
    const intent = createIntent(userId, agentId);
    await repositories.sessionLifecycle.prepareCreate(intent);
    await repositories.sessionLifecycle.completeCreate(intent.id, userId, {
      arkSessionId: "ark-session-dual-failure",
      arkAgentId: intent.arkAgentId,
      agentVersion: intent.agentVersion,
      status: "idle",
    });

    let rejectFirst: (reason: unknown) => void = () => undefined;
    let rejectSecond: (reason: unknown) => void = () => undefined;
    let markFirstSubmitted: () => void = () => undefined;
    let markSecondSubmitted: () => void = () => undefined;
    const firstSubmitted = new Promise<void>((resolve) => {
      markFirstSubmitted = resolve;
    });
    const secondSubmitted = new Promise<void>((resolve) => {
      markSecondSubmitted = resolve;
    });
    const firstResult = new Promise<never>((_resolve, reject) => {
      rejectFirst = reject;
    });
    const secondResult = new Promise<never>((_resolve, reject) => {
      rejectSecond = reject;
    });
    let submissions = 0;
    const service = new SessionService({
      repository: repositories.sessionLifecycle,
      agentResolver: {
        resolveForNewSession() {
          throw new Error("not used");
        },
      },
      ark: {
        createSession() {
          throw new Error("not used");
        },
        getSession() {
          throw new Error("not used");
        },
        submitEvent: () => {
          submissions += 1;
          if (submissions === 1) {
            markFirstSubmitted();
            return firstResult;
          }
          markSecondSubmitted();
          return secondResult;
        },
      },
      environmentId: "environment-1",
      createId: id,
    });

    const first = service.sendMessage(
      intent.id,
      { content: "Start" },
      { userId, requestId: "request-first-failure" },
    );
    await firstSubmitted;
    const second = service.sendMessage(
      intent.id,
      { content: "Supplement" },
      { userId, requestId: "request-second-failure" },
    );
    await secondSubmitted;

    rejectFirst(new ArkGatewayError("runtime_busy"));
    await expect(first).rejects.toMatchObject({ category: "runtime_busy" });
    await expect(
      repositories.sessionLifecycle.findOwned(userId, intent.id),
    ).resolves.toMatchObject({ status: "running" });

    rejectSecond(new ArkGatewayError("runtime_busy"));
    await expect(second).rejects.toMatchObject({ category: "runtime_busy" });
    await expect(
      repositories.sessionLifecycle.findOwned(userId, intent.id),
    ).resolves.toMatchObject({ status: "idle" });
    await database.close();
  });

  it("keeps running when a definite supplemental failure precedes first-message success", async () => {
    const database = await createTestDatabase();
    const repositories = createRepositories(database.db);
    const { userId, agentId } = await seedUserAndAgent(database.client);
    const intent = createIntent(userId, agentId);
    await repositories.sessionLifecycle.prepareCreate(intent);
    await repositories.sessionLifecycle.completeCreate(intent.id, userId, {
      arkSessionId: "ark-session-mixed-success",
      arkAgentId: intent.arkAgentId,
      agentVersion: intent.agentVersion,
      status: "idle",
    });

    let resolveFirst: (event: {
      id: string;
      type: "user.message";
      createdAt: string;
      data: { content: string };
    }) => void = () => undefined;
    const firstResult = new Promise<{
      id: string;
      type: "user.message";
      createdAt: string;
      data: { content: string };
    }>((resolve) => {
      resolveFirst = resolve;
    });
    let submissions = 0;
    const service = new SessionService({
      repository: repositories.sessionLifecycle,
      agentResolver: {
        resolveForNewSession() {
          throw new Error("not used");
        },
      },
      ark: {
        createSession() {
          throw new Error("not used");
        },
        getSession() {
          throw new Error("not used");
        },
        submitEvent: async () => {
          submissions += 1;
          if (submissions === 1) return firstResult;
          throw new ArkGatewayError("runtime_busy");
        },
      },
      environmentId: "environment-1",
      createId: id,
    });

    const first = service.sendMessage(
      intent.id,
      { content: "Start" },
      { userId, requestId: "request-first-success" },
    );
    await expect(
      service.sendMessage(
        intent.id,
        { content: "Supplement" },
        { userId, requestId: "request-supplemental-failure" },
      ),
    ).rejects.toMatchObject({ category: "runtime_busy" });
    await expect(
      repositories.sessionLifecycle.findOwned(userId, intent.id),
    ).resolves.toMatchObject({ status: "running" });

    resolveFirst({
      id: "event-first",
      type: "user.message",
      createdAt: new Date().toISOString(),
      data: { content: "Start" },
    });
    await expect(first).resolves.toEqual({
      eventId: "event-first",
      delivery: "accepted",
    });
    await expect(
      repositories.sessionLifecycle.findOwned(userId, intent.id),
    ).resolves.toMatchObject({ status: "running" });
    await database.close();
  });

  it("does not let a stale definite failure override an unknown write outcome", async () => {
    const database = await createTestDatabase();
    const repositories = createRepositories(database.db);
    const { userId, agentId } = await seedUserAndAgent(database.client);
    const intent = createIntent(userId, agentId);
    await repositories.sessionLifecycle.prepareCreate(intent);
    await repositories.sessionLifecycle.completeCreate(intent.id, userId, {
      arkSessionId: "ark-session-mixed-unknown",
      arkAgentId: intent.arkAgentId,
      agentVersion: intent.agentVersion,
      status: "idle",
    });

    let rejectFirst: (reason: unknown) => void = () => undefined;
    const firstResult = new Promise<never>((_resolve, reject) => {
      rejectFirst = reject;
    });
    let submissions = 0;
    const service = new SessionService({
      repository: repositories.sessionLifecycle,
      agentResolver: {
        resolveForNewSession() {
          throw new Error("not used");
        },
      },
      ark: {
        createSession() {
          throw new Error("not used");
        },
        getSession() {
          throw new Error("not used");
        },
        submitEvent: async () => {
          submissions += 1;
          if (submissions === 1) return firstResult;
          throw new ArkGatewayError("unknown_write_outcome");
        },
      },
      environmentId: "environment-1",
      createId: id,
    });

    const first = service.sendMessage(
      intent.id,
      { content: "Start" },
      { userId, requestId: "request-stale-failure" },
    );
    await expect(
      service.sendMessage(
        intent.id,
        { content: "Supplement" },
        { userId, requestId: "request-unknown" },
      ),
    ).rejects.toMatchObject({ category: "unknown_write_outcome" });

    rejectFirst(new ArkGatewayError("runtime_busy"));
    await expect(first).rejects.toMatchObject({ category: "runtime_busy" });
    await expect(
      repositories.sessionLifecycle.findOwned(userId, intent.id),
    ).resolves.toMatchObject({ status: "running" });
    await database.close();
  });
});
