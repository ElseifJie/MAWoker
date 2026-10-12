import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
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
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

const observedSnapshot = {
  agentId: "ark-agent-1",
  agentVersion: "7",
  environmentId: "environment-1",
  modelId: "model-observed",
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

function verifiedCompletion(
  arkSessionId: string,
  status: SessionRecord["status"] = "idle",
) {
  return {
    arkSessionId,
    status,
    modelId: observedSnapshot.modelId,
    configSnapshot: observedSnapshot,
  };
}

const invalidVerifiedArkSessionIds = [
  ["empty", ""],
  ["whitespace-only", "   "],
  ["leading whitespace", " ark-session-valid"],
  ["trailing whitespace", "ark-session-valid "],
  ["pending namespace", "pending:reservation-id"],
  ["whitespace-prefixed pending namespace", " pending:reservation-id"],
] as const;

const invalidDirectSqlConsumedArkSessionIds = [
  ...invalidVerifiedArkSessionIds,
  ["tab prefix", "\tark-session-valid"],
  ["tab suffix", "ark-session-valid\t"],
  ["newline prefix", "\nark-session-valid"],
  ["newline suffix", "ark-session-valid\n"],
  ["carriage return", "ark-session-valid\r"],
  ["mixed whitespace", "\t\nark-session-valid\r "],
  ["tab/newline-obscured pending namespace", "\tpending:reservation-id\n"],
  ["NBSP prefix", "\u00a0ark-session-valid"],
  ["U+2003 suffix", "ark-session-valid\u2003"],
  ["U+2028 prefix", "\u2028ark-session-valid"],
  ["U+3000 suffix", "ark-session-valid\u3000"],
  ["BOM prefix", "\ufeffark-session-valid"],
] as const;

describe("Session database integration", () => {
  it("adds conservative snapshot recovery columns and backfills only old pending creates", async () => {
    const migrationsDirectory = resolve(
      import.meta.dirname,
      "../packages/db/migrations",
    );
    const migrationName = (await readdir(migrationsDirectory)).find((name) =>
      name.startsWith("0021_"),
    );
    expect(migrationName).toBeDefined();
    const migration = await readFile(
      resolve(migrationsDirectory, migrationName!),
      "utf8",
    );

    expect(migration).toMatch(
      /create type "public"\."config_snapshot_state" as enum\('unverified', 'verified', 'incomplete', 'mismatch'\)/i,
    );
    expect(migration).toMatch(
      /add column "create_attempted_at" timestamp with time zone/i,
    );
    expect(migration).toMatch(/add column "model_id" text/i);
    expect(migration).toMatch(/add column "config_snapshot" jsonb/i);
    expect(migration).toMatch(
      /add column "config_snapshot_state" "config_snapshot_state" default 'unverified' not null/i,
    );
    expect(migration).toMatch(
      /update "sessions"\s+set "create_attempted_at" = "created_at"\s+where "ark_session_id" like 'pending:%'/i,
    );
    expect(migration).not.toMatch(
      /update "sessions"[\s\S]+where "ark_session_id" not like 'pending:%'/i,
    );
  });

  it("stores an unattempted create intent and grants only one atomic POST claim", async () => {
    const database = await createTestDatabase();
    const repositories = createRepositories(database.db);
    const { userId, agentId } = await seedUserAndAgent(database.client);
    const intent = createIntent(userId, agentId);

    await repositories.sessionLifecycle.prepareCreate(intent);
    const prepared = await database.client.query<{
      create_attempted_at: Date | null;
      model_id: string | null;
      config_snapshot: Record<string, unknown> | null;
      config_snapshot_state: string;
      config_snapshot_error_code: string | null;
    }>(
      `select create_attempted_at, model_id, config_snapshot,
              config_snapshot_state, config_snapshot_error_code
         from sessions
        where id = $1`,
      [intent.id],
    );
    expect(prepared.rows[0]).toEqual({
      create_attempted_at: null,
      model_id: null,
      config_snapshot: null,
      config_snapshot_state: "unverified",
      config_snapshot_error_code: null,
    });

    const claims = await Promise.all([
      repositories.sessionLifecycle.claimCreateAttempt(
        intent.id,
        userId,
        new Date("2026-09-06T00:00:01.000Z"),
      ),
      repositories.sessionLifecycle.claimCreateAttempt(
        intent.id,
        userId,
        new Date("2026-09-06T00:00:02.000Z"),
      ),
    ]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    const attempted = await database.client.query<{
      create_attempted_at: Date;
    }>(`select create_attempted_at from sessions where id = $1`, [intent.id]);
    expect(attempted.rows[0]?.create_attempted_at).toEqual(
      claims[0]
        ? new Date("2026-09-06T00:00:01.000Z")
        : new Date("2026-09-06T00:00:02.000Z"),
    );
    await database.close();
  });

  it("releases only the matching pending create attempt token", async () => {
    const database = await createTestDatabase();
    const repositories = createRepositories(database.db);
    const { userId, agentId } = await seedUserAndAgent(database.client);
    const intent = createIntent(userId, agentId);
    const attemptedAt = new Date("2026-09-06T00:00:01.000Z");
    await repositories.sessionLifecycle.prepareCreate(intent);
    await expect(
      repositories.sessionLifecycle.claimCreateAttempt(
        intent.id,
        userId,
        attemptedAt,
      ),
    ).resolves.toBe(true);

    await expect(
      repositories.sessionLifecycle.releaseCreateAttempt(
        intent.id,
        userId,
        new Date("2026-09-06T00:00:02.000Z"),
      ),
    ).resolves.toBe(false);
    await expect(
      repositories.sessionLifecycle.releaseCreateAttempt(
        intent.id,
        id(),
        attemptedAt,
      ),
    ).resolves.toBe(false);
    await expect(
      repositories.sessionLifecycle.releaseCreateAttempt(
        intent.id,
        userId,
        attemptedAt,
      ),
    ).resolves.toBe(true);
    await expect(
      repositories.sessionLifecycle.claimCreateAttempt(
        intent.id,
        userId,
        new Date("2026-09-06T00:00:03.000Z"),
      ),
    ).resolves.toBe(true);
    await database.close();
  });

  it("persists a verified observed snapshot without overwriting create intent identity", async () => {
    const database = await createTestDatabase();
    const repositories = createRepositories(database.db);
    const { userId, agentId } = await seedUserAndAgent(database.client);
    const intent = createIntent(userId, agentId);
    await repositories.sessionLifecycle.prepareCreate(intent);

    await repositories.sessionLifecycle.completeCreate(intent.id, userId, {
      arkSessionId: "ark-session-observed",
      status: "idle",
      modelId: "model-observed",
      configSnapshot: observedSnapshot,
    });

    const stored = await database.client.query<{
      ark_session_id: string;
      ark_agent_id: string;
      agent_version: string;
      environment_id: string;
      model_id: string;
      config_snapshot: typeof observedSnapshot;
      config_snapshot_state: string;
      config_snapshot_error_code: string | null;
    }>(
      `select ark_session_id, ark_agent_id, agent_version, environment_id,
              model_id, config_snapshot, config_snapshot_state,
              config_snapshot_error_code
         from sessions
        where id = $1`,
      [intent.id],
    );
    expect(stored.rows[0]).toEqual({
      ark_session_id: "ark-session-observed",
      ark_agent_id: intent.arkAgentId,
      agent_version: intent.agentVersion,
      environment_id: intent.environmentId,
      model_id: "model-observed",
      config_snapshot: observedSnapshot,
      config_snapshot_state: "verified",
      config_snapshot_error_code: null,
    });
    const roundTrippedSnapshot = JSON.stringify(
      stored.rows[0]?.config_snapshot,
    );
    expect(roundTrippedSnapshot).not.toContain("system");
    expect(roundTrippedSnapshot).not.toContain("mcpUrl");
    expect(roundTrippedSnapshot).not.toContain("secret.example.test");
    expect(roundTrippedSnapshot).not.toContain("secret-env-value");
    await database.close();
  });

  it("retains an incomplete observed cloud identity for GET-only reconciliation", async () => {
    const database = await createTestDatabase();
    const repositories = createRepositories(database.db);
    const { userId, agentId } = await seedUserAndAgent(database.client);
    const intent = createIntent(userId, agentId);
    await repositories.sessionLifecycle.prepareCreate(intent);

    await repositories.sessionLifecycle.preserveCreateOutcome(
      intent.id,
      userId,
      {
        arkSessionId: "ark-session-incomplete",
        status: "idle",
        modelId: null,
        configSnapshot: {
          ...observedSnapshot,
          modelId: null,
          completeness: "incomplete",
        },
        configSnapshotState: "incomplete",
        configSnapshotErrorCode: "ARK_SESSION_CONFIG_SNAPSHOT_INCOMPLETE",
      },
    );

    const stored = await database.client.query<{
      ark_session_id: string;
      ark_agent_id: string;
      model_id: string | null;
      config_snapshot_state: string;
      config_snapshot_error_code: string;
      reservation_status: string;
      job_status: string;
    }>(
      `select session.ark_session_id, session.ark_agent_id, session.model_id,
              session.config_snapshot_state,
              session.config_snapshot_error_code,
              reservation.status as reservation_status,
              job.status as job_status
         from sessions session
         join quota_reservations reservation on reservation.id = session.id
         join background_jobs job on job.id = session.id
        where session.id = $1`,
      [intent.id],
    );
    expect(stored.rows[0]).toEqual({
      ark_session_id: "ark-session-incomplete",
      ark_agent_id: intent.arkAgentId,
      model_id: null,
      config_snapshot_state: "incomplete",
      config_snapshot_error_code: "ARK_SESSION_CONFIG_SNAPSHOT_INCOMPLETE",
      reservation_status: "consumed",
      job_status: "pending",
    });
    await database.close();
  });

  it.each([
    ["incomplete", false],
    ["mismatch", false],
    ["incomplete", true],
    ["mismatch", true],
  ] as const)(
    "keeps the worker lease through %s preservation and applies a %s retry",
    async (snapshotState, final) => {
      const database = await createTestDatabase();
      const repositories = createRepositories(database.db);
      const { userId, agentId } = await seedUserAndAgent(database.client);
      const intent = createIntent(userId, agentId);
      const errorCode =
        snapshotState === "incomplete"
          ? "ARK_SESSION_CONFIG_SNAPSHOT_INCOMPLETE"
          : "ARK_SESSION_AGENT_VERSION_MISMATCH";
      const observation = {
        arkSessionId: "ark-session-observed",
        status: "idle" as const,
        modelId: snapshotState === "incomplete" ? null : "model-observed",
        configSnapshot: {
          ...observedSnapshot,
          ...(snapshotState === "incomplete"
            ? { modelId: null, completeness: "incomplete" as const }
            : { agentVersion: "8" }),
        },
        configSnapshotState: snapshotState,
        configSnapshotErrorCode: errorCode,
      };
      await repositories.sessionLifecycle.prepareCreate(intent);
      await repositories.sessionLifecycle.preserveCreateOutcome(
        intent.id,
        userId,
        observation,
      );
      await database.client.query(
        `update background_jobs
            set max_attempts = $2, run_after = '2000-01-01'
          where id = $1`,
        [intent.id, final ? 1 : 3],
      );
      const [claimed] = await repositories.jobs.claim({
        workerId: "session-worker",
        limit: 1,
        now: new Date("2026-09-06T01:00:00.000Z"),
        types: ["reconcile_session"],
      });
      expect(claimed).toBeDefined();

      await repositories.sessionLifecycle.preserveCreateOutcome(
        intent.id,
        userId,
        observation,
      );
      const leased = await database.client.query<{
        status: string;
        locked_by: string | null;
      }>(
        `select status, locked_by
           from background_jobs
          where id = $1`,
        [intent.id],
      );
      expect(leased.rows[0]).toEqual({
        status: "running",
        locked_by: "session-worker",
      });

      await repositories.jobs.retry(
        intent.id,
        "session-worker",
        errorCode,
        final,
        claimed.leaseGeneration,
        new Date("2026-09-06T01:00:01.000Z"),
      );
      const stored = await database.client.query<{
        status: string;
        attempts: number;
        locked_by: string | null;
        last_error: string | null;
        session_status: string;
        deletion_state: string;
      }>(
        `select job.status, job.attempts, job.locked_by, job.last_error,
                session.status as session_status,
                session.deletion_state
           from background_jobs job
           join sessions session on session.id = job.id
          where job.id = $1`,
        [intent.id],
      );
      expect(stored.rows[0]).toEqual({
        status: final ? "failed" : "pending",
        attempts: 1,
        locked_by: null,
        last_error: errorCode,
        session_status: final ? "terminated" : "idle",
        deletion_state: final ? "deletion_failed" : "none",
      });
      await database.close();
    },
  );

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

  it("uses UTC reservation days and keeps expired unknown outcomes quota-counted", async () => {
    const database = await createTestDatabase();
    const repositories = createRepositories(database.db);
    const { userId, agentId } = await seedUserAndAgent(database.client);
    await database.client.query(
      `update quota_policies set daily_session_limit = 1
        where key = 'default'`,
    );
    const yesterday = createIntent(userId, agentId);
    yesterday.createdAt = new Date("2026-09-06T23:59:59.999Z");
    yesterday.updatedAt = yesterday.createdAt;
    await repositories.sessionLifecycle.prepareCreate(yesterday);
    await database.client.query(
      `update quota_reservations
          set expires_at = '2026-09-06T23:59:59.999Z'
        where id = $1`,
      [yesterday.id],
    );

    const midnight = createIntent(userId, agentId);
    midnight.createdAt = new Date("2026-09-07T00:00:00.000Z");
    midnight.updatedAt = midnight.createdAt;
    await expect(
      repositories.sessionLifecycle.prepareCreate(midnight),
    ).resolves.toBeUndefined();
    await database.client.query(
      `update quota_reservations
          set expires_at = '2026-09-07T00:00:00.001Z'
        where id = $1`,
      [midnight.id],
    );

    const sameDay = createIntent(userId, agentId);
    sameDay.createdAt = new Date("2026-09-07T00:00:00.002Z");
    sameDay.updatedAt = sameDay.createdAt;
    await expect(
      repositories.sessionLifecycle.prepareCreate(sameDay),
    ).rejects.toMatchObject({ dimension: "daily_sessions" });

    const reservations = await database.client.query<{
      id: string;
      status: string;
      resolved_at: Date | null;
    }>(
      `select id, status, resolved_at
         from quota_reservations
        where id in ($1, $2)
        order by created_at`,
      [yesterday.id, midnight.id],
    );
    expect(reservations.rows).toEqual([
      {
        id: yesterday.id,
        status: "unknown_outcome",
        resolved_at: null,
      },
      {
        id: midnight.id,
        status: "unknown_outcome",
        resolved_at: null,
      },
    ]);
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
      verifiedCompletion("ark-session-1"),
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
    await repositories.sessionLifecycle.completeCreate(
      intent.id,
      userId,
      verifiedCompletion("ark-session-projection"),
    );

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

  it("atomically deduplicates multi-metric usage and closes runtime intervals at Ark timestamps", async () => {
    const database = await createTestDatabase();
    const repositories = createRepositories(database.db);
    const { userId, agentId } = await seedUserAndAgent(database.client);
    const intent = createIntent(userId, agentId);
    await repositories.sessionLifecycle.prepareCreate(intent);
    await repositories.sessionLifecycle.completeCreate(
      intent.id,
      userId,
      verifiedCompletion("ark-session-usage"),
    );
    const running = {
      eventId: "event-running",
      observedAt: new Date("2026-08-31T23:59:58.000Z"),
      metrics: [],
      status: "running" as const,
      errorCode: null,
      errorRecoverable: null,
    };
    const model = {
      eventId: "event-model",
      observedAt: new Date("2026-08-31T23:59:59.999Z"),
      metrics: [
        { metricType: "input_tokens" as const, quantity: 11 },
        { metricType: "output_tokens" as const, quantity: 7 },
      ],
    };

    await repositories.sessionLifecycle.projectEvent(
      userId,
      intent.id,
      running,
    );
    await repositories.sessionLifecycle.projectEvent(userId, intent.id, model);
    await repositories.sessionLifecycle.projectEvent(userId, intent.id, model);
    await repositories.sessionLifecycle.projectEvent(userId, intent.id, {
      eventId: "event-tool",
      observedAt: new Date("2026-09-01T00:00:00.000Z"),
      metrics: [{ metricType: "tool_calls", quantity: 1 }],
      status: "running",
      errorCode: null,
      errorRecoverable: null,
    });
    await repositories.sessionLifecycle.projectEvent(userId, intent.id, {
      eventId: "event-idle",
      observedAt: new Date("2026-09-01T00:00:02.000Z"),
      metrics: [],
      status: "idle",
      errorCode: null,
      errorRecoverable: null,
    });

    const ledger = await database.client.query<{
      ark_event_id: string;
      metric_type: string;
      quantity: number;
      recorded_at: Date;
    }>(
      `select ark_event_id, metric_type, quantity, recorded_at
         from usage_ledger
        where user_id = $1
        order by ark_event_id, metric_type`,
      [userId],
    );
    expect(
      ledger.rows.map((row) => ({
        ...row,
        recorded_at: row.recorded_at.toISOString(),
      })),
    ).toEqual([
      {
        ark_event_id: "event-idle",
        metric_type: "runtime_ms",
        quantity: 4000,
        recorded_at: "2026-09-01T00:00:02.000Z",
      },
      {
        ark_event_id: "event-model",
        metric_type: "input_tokens",
        quantity: 11,
        recorded_at: "2026-08-31T23:59:59.999Z",
      },
      {
        ark_event_id: "event-model",
        metric_type: "output_tokens",
        quantity: 7,
        recorded_at: "2026-08-31T23:59:59.999Z",
      },
      {
        ark_event_id: "event-tool",
        metric_type: "tool_calls",
        quantity: 1,
        recorded_at: "2026-09-01T00:00:00.000Z",
      },
    ]);
    await expect(
      repositories.usage.monthlyTokens(
        userId,
        new Date("2026-08-15T12:00:00.000-07:00"),
      ),
    ).resolves.toBe(18);
    await expect(
      repositories.usage.monthlyTokens(
        userId,
        new Date("2026-09-15T12:00:00.000+09:00"),
      ),
    ).resolves.toBe(0);
    await expect(
      repositories.usage.summary(
        userId,
        new Date("2026-09-15T12:00:00.000+09:00"),
      ),
    ).resolves.toMatchObject({
      period: {
        startsAt: new Date("2026-09-01T00:00:00.000Z"),
        endsAt: new Date("2026-10-01T00:00:00.000Z"),
      },
      quota: { monthlyTokenLimit: 1000 },
      usage: {
        personalAgents: 1,
        concurrentSessions: 0,
        dailySessions: 0,
        inputTokens: 0,
        outputTokens: 0,
        tokens: 0,
        runtimeMs: 4000,
        toolCalls: 1,
      },
      exhausted: { monthlyTokens: false },
    });
    await database.close();
  });

  it("closes runtime at rescheduled and reopens it on the next running event", async () => {
    const database = await createTestDatabase();
    const repositories = createRepositories(database.db);
    const { userId, agentId } = await seedUserAndAgent(database.client);
    const intent = createIntent(userId, agentId);
    await repositories.sessionLifecycle.prepareCreate(intent);
    await repositories.sessionLifecycle.completeCreate(
      intent.id,
      userId,
      verifiedCompletion("ark-session-runtime"),
    );

    for (const [eventId, observedAt, status] of [
      ["event-running-1", "2026-09-01T00:00:00.000Z", "running"],
      ["event-rescheduled", "2026-09-01T00:00:02.000Z", "rescheduled"],
      ["event-running-2", "2026-09-01T00:00:03.000Z", "running"],
      ["event-idle", "2026-09-01T00:00:07.000Z", "idle"],
    ] as const) {
      await repositories.sessionLifecycle.projectEvent(userId, intent.id, {
        eventId,
        observedAt: new Date(observedAt),
        metrics: [],
        status,
        errorCode: null,
        errorRecoverable: null,
      });
    }

    const runtime = await database.client.query<{
      ark_event_id: string;
      quantity: number;
    }>(
      `select ark_event_id, quantity
         from usage_ledger
        where user_id = $1 and metric_type = 'runtime_ms'
        order by recorded_at`,
      [userId],
    );
    expect(runtime.rows).toEqual([
      { ark_event_id: "event-rescheduled", quantity: 2000 },
      { ark_event_id: "event-idle", quantity: 4000 },
    ]);
    const cursor = await database.client.query<{ running_since: Date | null }>(
      `select running_since
         from session_event_cursors
        where session_id = $1`,
      [intent.id],
    );
    expect(cursor.rows[0]?.running_since).toBeNull();
    await database.close();
  });

  it("persistently advances usage reconciliation without cross-tenant marking", async () => {
    const database = await createTestDatabase();
    const repositories = createRepositories(database.db);
    const { userId, agentId } = await seedUserAndAgent(database.client);
    const intents = Array.from({ length: 3 }, () =>
      createIntent(userId, agentId),
    );
    for (const intent of intents) {
      await repositories.sessionLifecycle.prepareCreate(intent);
      await repositories.sessionLifecycle.completeCreate(
        intent.id,
        userId,
        verifiedCompletion(`ark-${intent.id}`),
      );
    }
    const selection = {
      cutoff: new Date("2026-09-01T00:00:00.000Z"),
      limit: 2,
    };
    const firstBatch = await repositories.usage.listReconcilable(selection);
    const remaining = intents.find(
      (intent) =>
        !firstBatch.some((session) => session.sessionId === intent.id),
    );

    await repositories.usage.markReconciled(
      id(),
      firstBatch[0]!.sessionId,
      new Date("2026-09-06T00:00:00.000Z"),
    );
    const foreignMark = await database.client.query<{ count: number }>(
      `select count(*)::integer as count
         from session_event_cursors
        where session_id = $1`,
      [firstBatch[0]!.sessionId],
    );
    expect(foreignMark.rows[0]?.count).toBe(0);

    for (const session of firstBatch) {
      await repositories.usage.markReconciled(
        userId,
        session.sessionId,
        new Date("2026-09-06T00:00:00.000Z"),
      );
    }

    const secondBatch = await repositories.usage.listReconcilable(selection);
    expect(secondBatch[0]?.sessionId).toBe(remaining?.id);
    const persisted = await database.client.query<{
      session_id: string;
      last_reconciled_at: Date;
    }>(
      `select session_id, last_reconciled_at
         from session_event_cursors
        order by session_id`,
    );
    expect(persisted.rows).toHaveLength(2);
    expect(
      persisted.rows.map(({ last_reconciled_at }) =>
        last_reconciled_at.toISOString(),
      ),
    ).toEqual(["2026-09-06T00:00:00.000Z", "2026-09-06T00:00:00.000Z"]);
    await database.close();
  });

  it("atomically enqueues one leased quota interrupt per running Session and UTC month", async () => {
    const database = await createTestDatabase();
    const repositories = createRepositories(database.db);
    const { userId, agentId } = await seedUserAndAgent(database.client);
    await database.client.query(
      `update quota_policies set monthly_token_limit = 10
        where key = 'default'`,
    );
    const intent = createIntent(userId, agentId);
    await repositories.sessionLifecycle.prepareCreate(intent);
    await repositories.sessionLifecycle.completeCreate(
      intent.id,
      userId,
      verifiedCompletion("ark-session-exhausted", "running"),
    );
    const projection = {
      eventId: "event-exhausted",
      observedAt: new Date("2026-09-30T23:59:59.999Z"),
      metrics: [
        { metricType: "input_tokens" as const, quantity: 6 },
        { metricType: "output_tokens" as const, quantity: 4 },
      ],
    };

    await repositories.sessionLifecycle.projectEvent(
      userId,
      intent.id,
      projection,
    );
    await repositories.sessionLifecycle.projectEvent(
      userId,
      intent.id,
      projection,
    );

    const stored = await database.client.query<{
      user_id: string;
      session_id: string;
      month_start: Date;
      status: string;
    }>(
      `select user_id, session_id, month_start, status
         from quota_interrupt_jobs`,
    );
    expect(stored.rows).toHaveLength(1);
    expect(stored.rows[0]).toMatchObject({
      user_id: userId,
      session_id: intent.id,
      status: "pending",
    });
    expect(stored.rows[0]!.month_start.toISOString()).toBe(
      "2026-09-01T00:00:00.000Z",
    );

    const now = new Date("2026-10-01T00:00:01.000Z");
    const [claimed] = await repositories.quotaInterrupts.claim({
      workerId: "quota-worker-1",
      limit: 1,
      now,
    });
    expect(claimed).toMatchObject({
      userId,
      sessionId: intent.id,
      arkSessionId: "ark-session-exhausted",
      attempts: 1,
    });
    await expect(
      repositories.quotaInterrupts.claim({
        workerId: "quota-worker-2",
        limit: 1,
        now,
      }),
    ).resolves.toEqual([]);
    await repositories.quotaInterrupts.retry(
      claimed!.id,
      "quota-worker-1",
      "QUOTA_INTERRUPT_FAILED",
      false,
      claimed!.leaseGeneration,
      now,
    );
    const [retried] = await repositories.quotaInterrupts.claim({
      workerId: "quota-worker-2",
      limit: 1,
      now: new Date("2026-10-01T00:01:01.000Z"),
    });
    expect(retried).toMatchObject({ id: claimed!.id, attempts: 2 });
    await repositories.quotaInterrupts.succeed(
      retried!.id,
      "quota-worker-2",
      retried!.leaseGeneration,
    );
    await expect(
      repositories.quotaInterrupts.claim({
        workerId: "quota-worker-3",
        limit: 1,
        now: new Date("2026-10-01T00:10:00.000Z"),
      }),
    ).resolves.toEqual([]);
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
      reservation_status: "unknown_outcome",
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
      claimed.leaseGeneration,
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
      reservation_status: "unknown_outcome",
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

  it("converts an exhausted pending create into a retryable deletion job", async () => {
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
          set status = 'failed', attempts = max_attempts,
              last_error = 'Ark write outcome is unknown'
        where id = $1`,
      [intent.id],
    );
    await database.client.query(
      `update sessions
          set status = 'terminated', deletion_state = 'deletion_failed'
        where id = $1`,
      [intent.id],
    );

    await expect(
      repositories.sessionLifecycle.beginDelete(userId, intent.id),
    ).resolves.toMatchObject({
      id: intent.id,
      arkSessionId: `pending:${intent.id}`,
      deletionState: "pending",
    });
    const deletion = await database.client.query<{
      type: string;
      status: string;
      attempts: number;
      last_error: string | null;
      payload: Record<string, unknown>;
    }>(
      `select type, status, attempts, last_error, payload
         from background_jobs
        where id = $1`,
      [intent.id],
    );
    expect(deletion.rows[0]).toEqual({
      type: "delete_session",
      status: "pending",
      attempts: 0,
      last_error: null,
      payload: { sessionId: intent.id, completed: {} },
    });
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
      await repositories.sessionLifecycle.completeCreate(
        intent.id,
        userId,
        verifiedCompletion(`ark-${intent.id}`),
      );
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
    await repositories.sessionLifecycle.completeCreate(
      intent.id,
      userId,
      verifiedCompletion("ark-session-archive"),
    );
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
    await repositories.sessionLifecycle.completeCreate(
      intent.id,
      userId,
      verifiedCompletion("ark-session-saga"),
    );
    const inputId = id();
    const artifactId = id();
    const driveFileId = id();
    const objectKey = `tenants/${userId}/drive/artifact/${driveFileId}/output.txt`;
    await database.client.query(
      `insert into session_inputs
        (id, owner_user_id, session_id, ark_file_id, original_name, mime_type,
         size_bytes, mount_path, status, expires_at)
       values ($1, $2, $3, 'ark-input', 'input.txt', 'text/plain', 1,
               '/mnt/session/inputs/input.txt', 'bound', now())`,
      [inputId, userId, intent.id],
    );
    await database.client.query(
      `insert into drive_files
        (id, owner_user_id, origin, tos_object_key, name, mime_type, size_bytes,
         source_session_id, deletion_state)
       values ($1, $2, 'artifact', $3, 'output.txt', 'text/plain', 1, $4, 'none')`,
      [driveFileId, userId, objectKey, intent.id],
    );
    await database.client.query(
      `insert into artifacts
        (id, owner_user_id, session_id, ark_file_id, drive_file_id, name,
         mime_type, size_bytes, generated_at)
       values ($1, $2, $3, 'ark-output', $4, 'output.txt', 'text/plain', 1,
               now())`,
      [artifactId, userId, intent.id, driveFileId],
    );
    await database.client.query(
      `insert into usage_ledger
        (id, user_id, ark_session_id, ark_event_id, metric_type, quantity)
       values ($1, $2, 'ark-session-saga', 'event-1', 'input_tokens', 1)`,
      [id(), userId],
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

    await repositories.jobs.updatePayload(
      job!.id,
      "worker-1",
      payload,
      job!.leaseGeneration,
    );
    await expect(
      repositories.sessionDeletion.findDeleting(id(), intent.id),
    ).resolves.toBeUndefined();
    // Another tenant cannot even see the row, let alone orphan its bytes.
    await expect(
      repositories.sessionDeletion.orphanDriveFiles(
        id(),
        intent.id,
        new Date("2026-09-06T00:00:00.000Z"),
      ),
    ).resolves.toBe(0);
    await repositories.sessionDeletion.removeLocal(id(), intent.id);
    await expect(
      repositories.sessionDeletion.findDeleting(userId, intent.id),
    ).resolves.toMatchObject({ id: intent.id });

    // Orphaning the Session's bytes leaves the drive row for the GC to reap.
    await expect(
      repositories.sessionDeletion.orphanDriveFiles(
        userId,
        intent.id,
        new Date("2026-09-06T00:00:00.000Z"),
      ),
    ).resolves.toBe(1);
    await expect(
      repositories.sessionDeletion.removeLocal(userId, intent.id),
    ).resolves.toBe("removed");
    const remaining = await database.client.query<{
      sessions: number;
      inputs: number;
      artifacts: number;
      ledger: number;
      reservations: number;
    }>(
      `select
         (select count(*)::integer from sessions where id = $1) as sessions,
         (select count(*)::integer from session_inputs where session_id = $1)
           as inputs,
         (select count(*)::integer from artifacts where session_id = $1)
           as artifacts,
         (select count(*)::integer from usage_ledger
             where ark_session_id = 'ark-session-saga') as ledger,
         (select count(*)::integer from quota_reservations where id = $1)
           as reservations`,
      [intent.id],
    );
    expect(remaining.rows[0]).toEqual({
      sessions: 0,
      inputs: 0,
      artifacts: 0,
      ledger: 1,
      reservations: 1,
    });
    const retainedJob = await database.client.query<{
      payload: Record<string, unknown>;
    }>(`select payload from background_jobs where id = $1`, [intent.id]);
    expect(retainedJob.rows[0]?.payload).toEqual(payload);
    await database.close();
  });

  it("keeps user and admin usage stable after permanent Session deletion", async () => {
    const database = await createTestDatabase();
    const repositories = createRepositories(database.db);
    const { userId, agentId } = await seedUserAndAgent(database.client);
    const intent = createIntent(userId, agentId);
    await repositories.sessionLifecycle.prepareCreate(intent);
    await repositories.sessionLifecycle.completeCreate(
      intent.id,
      userId,
      verifiedCompletion("ark-session-retained-usage"),
    );
    await repositories.sessionLifecycle.projectEvent(userId, intent.id, {
      eventId: "event-retained-usage",
      observedAt: new Date("2026-09-06T00:00:01.000Z"),
      metrics: [{ metricType: "input_tokens", quantity: 37 }],
    });
    const beforeSummary = await repositories.usage.summary(
      userId,
      intent.createdAt,
    );
    const beforeAdmin = await repositories.usage.adminOverview({
      now: intent.createdAt,
      limit: 10,
      before: null,
    });

    await repositories.sessionLifecycle.beginDelete(userId, intent.id);
    await expect(
      repositories.sessionDeletion.removeLocal(userId, intent.id),
    ).resolves.toBe("removed");

    const afterSummary = await repositories.usage.summary(
      userId,
      intent.createdAt,
    );
    const afterAdmin = await repositories.usage.adminOverview({
      now: intent.createdAt,
      limit: 10,
      before: null,
    });
    expect(afterSummary.usage).toEqual(beforeSummary.usage);
    expect(afterAdmin.totals).toEqual(beforeAdmin.totals);
    expect(afterAdmin.users).toEqual(beforeAdmin.users);
    await database.close();
  });

  it("posts deletion-time usage only through a non-released reservation", async () => {
    const database = await createTestDatabase();
    const repositories = createRepositories(database.db);
    const { userId, agentId } = await seedUserAndAgent(database.client);
    const retained = createIntent(userId, agentId);
    await repositories.sessionLifecycle.prepareCreate(retained);
    await repositories.sessionLifecycle.completeCreate(
      retained.id,
      userId,
      verifiedCompletion("ark-session-settlement"),
    );
    await repositories.sessionLifecycle.beginDelete(userId, retained.id);
    await repositories.sessionDeletion.removeLocal(userId, retained.id);

    const settlement = {
      id: id(),
      reservationId: retained.id,
      arkEventId: "event-after-delete",
      metricType: "output_tokens" as const,
      quantity: 19,
      recordedAt: new Date("2026-09-06T00:01:00.000Z"),
    };
    await expect(
      repositories.usage.recordByReservation(settlement),
    ).resolves.toBe(true);
    await expect(
      repositories.usage.recordByReservation({ ...settlement, id: id() }),
    ).resolves.toBe(false);

    const released = createIntent(userId, agentId);
    await repositories.sessionLifecycle.prepareCreate(released);
    await repositories.sessionLifecycle.failCreate(released.id, userId);
    await expect(
      repositories.usage.recordByReservation({
        ...settlement,
        id: id(),
        reservationId: released.id,
        arkEventId: "forged-released",
      }),
    ).resolves.toBe(false);
    await database.close();
  });

  it.each(invalidVerifiedArkSessionIds)(
    "rejects a %s Ark identity through quota consumption",
    async (_caseName, arkSessionId) => {
      const database = await createTestDatabase();
      const repositories = createRepositories(database.db);
      const { userId } = await seedUserAndAgent(database.client);
      const reservationId = id();
      const now = new Date("2026-09-06T00:00:00.000Z");
      await repositories.quotas.reserveSession({
        userId,
        reservationId,
        expiresAt: new Date("2026-09-06T00:05:00.000Z"),
        now,
      });

      expect(repositories.quotas).not.toHaveProperty("resolveReservation");
      await expect(
        repositories.quotas.consumeReservation({
          reservationId,
          arkSessionId,
        }),
      ).rejects.toThrow("verified Ark Session ID");

      const reservation = await database.client.query<{
        ark_session_id: string;
        status: string;
      }>(
        `select ark_session_id, status
           from quota_reservations
          where id = $1`,
        [reservationId],
      );
      expect(reservation.rows[0]).toEqual({
        ark_session_id: `pending:${reservationId}`,
        status: "active",
      });
      await database.close();
    },
  );

  for (const transition of [
    "completeCreate",
    "preserveCreateOutcome",
  ] as const) {
    it.each(invalidVerifiedArkSessionIds)(
      `rejects a %s Ark identity through sessionLifecycle.${transition}`,
      async (_caseName, arkSessionId) => {
        const database = await createTestDatabase();
        const repositories = createRepositories(database.db);
        const { userId, agentId } = await seedUserAndAgent(database.client);
        const intent = createIntent(userId, agentId);
        await repositories.sessionLifecycle.prepareCreate(intent);

        await expect(
          repositories.sessionLifecycle[transition](
            intent.id,
            userId,
            verifiedCompletion(arkSessionId),
          ),
        ).rejects.toThrow("verified Ark Session ID");

        const stored = await database.client.query<{
          session_ark_session_id: string;
          reservation_ark_session_id: string;
          reservation_status: string;
        }>(
          `select session.ark_session_id as session_ark_session_id,
                  reservation.ark_session_id as reservation_ark_session_id,
                  reservation.status as reservation_status
             from sessions session
             join quota_reservations reservation
               on reservation.id = session.id
            where session.id = $1`,
          [intent.id],
        );
        expect(stored.rows[0]).toEqual({
          session_ark_session_id: `pending:${intent.id}`,
          reservation_ark_session_id: `pending:${intent.id}`,
          reservation_status: "active",
        });
        await database.close();
      },
    );
  }

  it.each(["completeCreate", "preserveCreateOutcome"] as const)(
    "keeps consumed identity immutable and allows exact idempotency through sessionLifecycle.%s",
    async (transition) => {
      const database = await createTestDatabase();
      const repositories = createRepositories(database.db);
      const { userId, agentId } = await seedUserAndAgent(database.client);
      const intent = createIntent(userId, agentId);
      const knownIdentity = "ark-session-immutable";
      await repositories.sessionLifecycle.prepareCreate(intent);
      await repositories.sessionLifecycle[transition](
        intent.id,
        userId,
        verifiedCompletion(knownIdentity),
      );

      await expect(
        repositories.sessionLifecycle[transition](
          intent.id,
          userId,
          verifiedCompletion(knownIdentity),
        ),
      ).resolves.toEqual(
        transition === "completeCreate"
          ? expect.objectContaining({ arkSessionId: knownIdentity })
          : undefined,
      );
      await expect(
        repositories.sessionLifecycle[transition](
          intent.id,
          userId,
          verifiedCompletion("ark-session-rewrite"),
        ),
      ).rejects.toThrow("Ark Session ID is immutable");

      const stored = await database.client.query<{
        session_ark_session_id: string;
        reservation_ark_session_id: string;
        reservation_status: string;
      }>(
        `select session.ark_session_id as session_ark_session_id,
                reservation.ark_session_id as reservation_ark_session_id,
                reservation.status as reservation_status
           from sessions session
           join quota_reservations reservation
             on reservation.id = session.id
          where session.id = $1`,
        [intent.id],
      );
      expect(stored.rows[0]).toEqual({
        session_ark_session_id: knownIdentity,
        reservation_ark_session_id: knownIdentity,
        reservation_status: "consumed",
      });
      await database.close();
    },
  );

  it.each(invalidDirectSqlConsumedArkSessionIds)(
    "rejects direct SQL consumed reservation with a %s Ark identity",
    async (_caseName, arkSessionId) => {
      const database = await createTestDatabase();
      const { userId } = await seedUserAndAgent(database.client);

      await expect(
        database.client.query(
          `insert into quota_reservations
             (id, user_id, ark_session_id, status, expires_at)
           values ($1, $2, $3, 'consumed', $4)`,
          [id(), userId, arkSessionId, new Date("2026-09-06T00:05:00.000Z")],
        ),
      ).rejects.toThrow();
      await database.close();
    },
  );

  it("allows direct SQL valid consumed and non-consumed pending identities", async () => {
    const database = await createTestDatabase();
    const { userId } = await seedUserAndAgent(database.client);
    const consumedId = id();
    const activeId = id();

    await expect(
      database.client.query(
        `insert into quota_reservations
           (id, user_id, ark_session_id, status, expires_at)
         values ($1, $3, 'ark-session-valid', 'consumed', $5),
                ($2, $3, $4, 'active', $5)`,
        [
          consumedId,
          activeId,
          userId,
          `pending:${activeId}`,
          new Date("2026-09-06T00:05:00.000Z"),
        ],
      ),
    ).resolves.toMatchObject({ affectedRows: 2 });
    await database.close();
  });

  it("atomically consumes a known Ark identity and cascades existing ledger rows", async () => {
    const database = await createTestDatabase();
    const repositories = createRepositories(database.db);
    const { userId } = await seedUserAndAgent(database.client);
    const reservationId = id();
    const now = new Date("2026-09-06T00:00:00.000Z");
    await repositories.quotas.reserveSession({
      userId,
      reservationId,
      expiresAt: new Date("2026-09-06T00:05:00.000Z"),
      now,
    });
    await repositories.usage.recordByReservation({
      id: id(),
      reservationId,
      arkEventId: "event-before-verification",
      metricType: "input_tokens",
      quantity: 5,
      recordedAt: now,
    });

    await expect(
      repositories.quotas.consumeReservation({
        reservationId,
        arkSessionId: "ark-session-cascade",
      }),
    ).resolves.toMatchObject({
      id: reservationId,
      userId,
      arkSessionId: "ark-session-cascade",
      status: "consumed",
      resolvedAt: expect.anything(),
    });

    const stored = await database.client.query<{
      reservation_ark_session_id: string;
      status: string;
      resolved_at: Date | null;
      ledger_ark_session_id: string;
    }>(
      `select reservation.ark_session_id as reservation_ark_session_id,
              reservation.status, reservation.resolved_at,
              ledger.ark_session_id as ledger_ark_session_id
         from quota_reservations reservation
         join usage_ledger ledger
           on ledger.user_id = reservation.user_id
          and ledger.ark_session_id = reservation.ark_session_id
        where reservation.id = $1
          and ledger.ark_event_id = 'event-before-verification'`,
      [reservationId],
    );
    expect(stored.rows[0]).toEqual({
      reservation_ark_session_id: "ark-session-cascade",
      status: "consumed",
      resolved_at: expect.any(Date),
      ledger_ark_session_id: "ark-session-cascade",
    });
    await database.close();
  });

  it("keeps a directly consumed reservation identity immutable and exactly idempotent", async () => {
    const database = await createTestDatabase();
    const repositories = createRepositories(database.db);
    const { userId } = await seedUserAndAgent(database.client);
    const reservationId = id();
    const now = new Date("2026-09-06T00:00:00.000Z");
    await repositories.quotas.reserveSession({
      userId,
      reservationId,
      expiresAt: new Date("2026-09-06T00:05:00.000Z"),
      now,
    });
    await repositories.quotas.consumeReservation({
      reservationId,
      arkSessionId: "ark-session-direct-immutable",
    });

    await expect(
      repositories.quotas.consumeReservation({
        reservationId,
        arkSessionId: "ark-session-direct-immutable",
      }),
    ).resolves.toMatchObject({
      id: reservationId,
      userId,
      arkSessionId: "ark-session-direct-immutable",
      status: "consumed",
    });
    await expect(
      repositories.quotas.consumeReservation({
        reservationId,
        arkSessionId: "ark-session-direct-rewrite",
      }),
    ).rejects.toThrow("Ark Session ID is immutable");

    const stored = await database.client.query<{
      ark_session_id: string;
      status: string;
    }>(
      `select ark_session_id, status
         from quota_reservations
        where id = $1`,
      [reservationId],
    );
    expect(stored.rows[0]).toEqual({
      ark_session_id: "ark-session-direct-immutable",
      status: "consumed",
    });
    await database.close();
  });

  it.each(["completeCreate", "preserveCreateOutcome"] as const)(
    "does not consume a released reservation through sessionLifecycle.%s",
    async (transition) => {
      const database = await createTestDatabase();
      const repositories = createRepositories(database.db);
      const { userId, agentId } = await seedUserAndAgent(database.client);
      const intent = createIntent(userId, agentId);
      await repositories.sessionLifecycle.prepareCreate(intent);
      await repositories.quotas.releaseReservation(intent.id);

      await expect(
        repositories.sessionLifecycle[transition](
          intent.id,
          userId,
          verifiedCompletion("ark-session-after-release"),
        ),
      ).rejects.toThrow("reservation cannot be consumed");

      const stored = await database.client.query<{
        session_ark_session_id: string;
        reservation_ark_session_id: string;
        reservation_status: string;
      }>(
        `select session.ark_session_id as session_ark_session_id,
                reservation.ark_session_id as reservation_ark_session_id,
                reservation.status as reservation_status
           from sessions session
           join quota_reservations reservation
             on reservation.id = session.id
          where session.id = $1`,
        [intent.id],
      );
      expect(stored.rows[0]).toEqual({
        session_ark_session_id: `pending:${intent.id}`,
        reservation_ark_session_id: `pending:${intent.id}`,
        reservation_status: "released",
      });
      await database.close();
    },
  );

  it("releases active or unknown reservations without regressing consumed ones", async () => {
    const database = await createTestDatabase();
    const repositories = createRepositories(database.db);
    const { userId } = await seedUserAndAgent(database.client);
    const now = new Date("2026-09-06T00:00:00.000Z");
    const activeId = id();
    await repositories.quotas.reserveSession({
      userId,
      reservationId: activeId,
      expiresAt: new Date("2026-09-06T00:05:00.000Z"),
      now,
    });
    await expect(
      repositories.quotas.releaseReservation(activeId),
    ).resolves.toMatchObject({
      id: activeId,
      userId,
      status: "released",
      resolvedAt: expect.anything(),
    });
    await expect(
      repositories.quotas.consumeReservation({
        reservationId: activeId,
        arkSessionId: "ark-session-released",
      }),
    ).resolves.toBeUndefined();

    const releasedId = id();
    await repositories.quotas.reserveSession({
      userId,
      reservationId: releasedId,
      expiresAt: new Date("2026-09-06T00:05:00.000Z"),
      now,
    });
    await database.client.query(
      `update quota_reservations
          set status = 'unknown_outcome'
        where id = $1`,
      [releasedId],
    );
    await expect(
      repositories.quotas.releaseReservation(releasedId),
    ).resolves.toMatchObject({
      id: releasedId,
      userId,
      status: "released",
      resolvedAt: expect.anything(),
    });

    const consumedId = id();
    await repositories.quotas.reserveSession({
      userId,
      reservationId: consumedId,
      expiresAt: new Date("2026-09-06T00:05:00.000Z"),
      now,
    });
    await repositories.quotas.consumeReservation({
      reservationId: consumedId,
      arkSessionId: "ark-session-consumed",
    });
    const consumedBeforeRelease = await database.client.query<{
      ark_session_id: string;
      status: string;
      resolved_at: Date;
    }>(
      `select ark_session_id, status, resolved_at
         from quota_reservations
        where id = $1`,
      [consumedId],
    );

    await expect(
      repositories.quotas.releaseReservation(consumedId),
    ).resolves.toBeUndefined();
    const consumedAfterRelease = await database.client.query<{
      ark_session_id: string;
      status: string;
      resolved_at: Date;
    }>(
      `select ark_session_id, status, resolved_at
         from quota_reservations
        where id = $1`,
      [consumedId],
    );
    expect(consumedAfterRelease.rows[0]).toEqual(consumedBeforeRelease.rows[0]);
    await database.close();
  });

  it("creates one tenant-owned deletion job and preserves Saga progress when rearmed", async () => {
    const database = await createTestDatabase();
    const repositories = createRepositories(database.db);
    const { userId, agentId } = await seedUserAndAgent(database.client);
    const intent = createIntent(userId, agentId);
    await repositories.sessionLifecycle.prepareCreate(intent);
    await repositories.sessionLifecycle.completeCreate(
      intent.id,
      userId,
      verifiedCompletion("ark-session-delete"),
    );

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
    await repositories.sessionLifecycle.completeCreate(
      intent.id,
      userId,
      verifiedCompletion("ark-session-repeat-delete"),
    );
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
    await repositories.sessionLifecycle.completeCreate(
      intent.id,
      userId,
      verifiedCompletion("ark-session-delete-race"),
    );
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
    await repositories.sessionLifecycle.completeCreate(
      intent.id,
      userId,
      verifiedCompletion("ark-session-expired-delete"),
    );
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
    await repositories.sessionLifecycle.completeCreate(
      intent.id,
      userId,
      verifiedCompletion("ark-session-retry-delete"),
    );
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
      firstAttempt!.leaseGeneration,
    );
    await repositories.jobs.retry(
      firstAttempt!.id,
      "worker-1",
      "provider secret",
      false,
      firstAttempt!.leaseGeneration,
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
    await repositories.sessionLifecycle.completeCreate(
      intent.id,
      userId,
      verifiedCompletion("ark-session-quota"),
    );
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
      await repositories.sessionLifecycle.completeCreate(
        intent.id,
        userId,
        verifiedCompletion(`ark-session-message-${deletionState}`),
      );
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
      await repositories.sessionLifecycle.completeCreate(
        intent.id,
        userId,
        verifiedCompletion(`ark-${intent.id}`),
      );
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
    await repositories.sessionLifecycle.completeCreate(
      intent.id,
      userId,
      verifiedCompletion("ark-session-running", "running"),
    );
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
      await repositories.sessionLifecycle.completeCreate(
        intent.id,
        userId,
        verifiedCompletion(`ark-${intent.id}`),
      );
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
    await repositories.sessionLifecycle.completeCreate(
      intent.id,
      userId,
      verifiedCompletion("ark-session-dual-failure"),
    );

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
    await repositories.sessionLifecycle.completeCreate(
      intent.id,
      userId,
      verifiedCompletion("ark-session-mixed-success"),
    );

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
    await repositories.sessionLifecycle.completeCreate(
      intent.id,
      userId,
      verifiedCompletion("ark-session-mixed-unknown"),
    );

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

  it("renames and pins a Session, listing pinned first", async () => {
    const database = await createTestDatabase();
    const repositories = createRepositories(database.db);
    const { userId, agentId } = await seedUserAndAgent(database.client);
    const older = createIntent(userId, agentId);
    const newer = createIntent(userId, agentId);
    for (const intent of [older, newer]) {
      await repositories.sessionLifecycle.prepareCreate(intent);
      await repositories.sessionLifecycle.completeCreate(
        intent.id,
        userId,
        verifiedCompletion(`ark-${intent.id}`),
      );
    }

    await expect(
      repositories.sessionLifecycle.rename(userId, older.id, "Renamed plan"),
    ).resolves.toMatchObject({ id: older.id, title: "Renamed plan" });
    // Another tenant cannot touch it, and learns nothing about it.
    await expect(
      repositories.sessionLifecycle.rename(id(), older.id, "Hijacked"),
    ).resolves.toBeUndefined();
    await expect(
      repositories.sessionLifecycle.setPinned(id(), older.id, new Date()),
    ).resolves.toBeUndefined();

    const pinnedAt = new Date("2026-09-06T02:00:00.000Z");
    await expect(
      repositories.sessionLifecycle.setPinned(userId, older.id, pinnedAt),
    ).resolves.toMatchObject({ pinnedAt });

    const listed = await repositories.sessionLifecycle.listOwned(userId, false);
    expect(listed.map((record) => record.id)).toEqual([older.id, newer.id]);
    await expect(
      repositories.sessionLifecycle.setPinned(userId, older.id, null),
    ).resolves.toMatchObject({ pinnedAt: null });
    await database.close();
  });

  it("stores a Session's projected events once, in order, per tenant", async () => {
    const database = await createTestDatabase();
    const repositories = createRepositories(database.db);
    const { userId, agentId } = await seedUserAndAgent(database.client);
    const intent = createIntent(userId, agentId);
    await repositories.sessionLifecycle.prepareCreate(intent);
    await repositories.sessionLifecycle.completeCreate(
      intent.id,
      userId,
      verifiedCompletion(`ark-${intent.id}`),
    );

    await expect(
      repositories.sessionLifecycle.historyBackfilled(userId, intent.id),
    ).resolves.toBe(false);

    const first = {
      eventId: "event-1",
      sourceType: "user.message",
      type: "message",
      occurredAt: new Date("2026-09-06T00:00:00.000Z"),
      payload: { content: "Start" },
    };
    const second = {
      eventId: "event-2",
      sourceType: "agent.message",
      type: "message",
      occurredAt: new Date("2026-09-06T00:01:00.000Z"),
      payload: { content: "Done" },
    };
    await repositories.sessionLifecycle.appendEvents(userId, intent.id, [
      second,
      first,
      // A replay of an event already stored must not duplicate it.
      first,
    ]);

    await expect(
      repositories.sessionLifecycle.listEvents(userId, intent.id),
    ).resolves.toEqual([first, second]);
    await expect(
      repositories.sessionLifecycle.listEvents(id(), intent.id),
    ).resolves.toEqual([]);

    await repositories.sessionLifecycle.markHistoryBackfilled(
      userId,
      intent.id,
    );
    await expect(
      repositories.sessionLifecycle.historyBackfilled(userId, intent.id),
    ).resolves.toBe(true);

    // A foreign tenant cannot write into another tenant's log.
    await repositories.sessionLifecycle.appendEvents(id(), intent.id, [
      {
        eventId: "event-3",
        sourceType: "agent.message",
        type: "message",
        occurredAt: new Date("2026-09-06T00:02:00.000Z"),
        payload: {},
      },
    ]);
    await expect(
      repositories.sessionLifecycle.listEvents(userId, intent.id),
    ).resolves.toHaveLength(2);

    // Deleting the Session takes its log with it.
    await database.client.query(`delete from sessions where id = $1`, [
      intent.id,
    ]);
    const remaining = await database.client.query<{ count: number }>(
      `select count(*)::integer as count from session_events where session_id = $1`,
      [intent.id],
    );
    expect(remaining.rows[0]!.count).toBe(0);
    await database.close();
  });

  it("attributes new usage to the verified Session snapshot, not the Agent's current model", async () => {
    const database = await createTestDatabase();
    const repositories = createRepositories(database.db);
    const { userId, agentId } = await seedUserAndAgent(database.client);
    const intent = createIntent(userId, agentId);
    await repositories.sessionLifecycle.prepareCreate(intent);
    await repositories.sessionLifecycle.completeCreate(
      intent.id,
      userId,
      verifiedCompletion("ark-session-t03b-1"),
    );

    // The Agent's model changes after the Session was created and verified.
    await database.client.query(
      `update personal_agents set model_id = 'model-b-new' where id = $1`,
      [agentId],
    );

    const projected = await repositories.sessionLifecycle.projectEvent(
      userId,
      intent.id,
      {
        eventId: "event-t03b-1",
        observedAt: new Date("2026-09-06T00:10:00.000Z"),
        metrics: [{ metricType: "input_tokens", quantity: 30 }],
      },
    );
    expect(projected).toBe(true);

    const ledger = await database.client.query<{
      model_id: string | null;
      model_attribution_precision: string;
    }>(
      `select model_id, model_attribution_precision::text
                from usage_ledger
               where ark_session_id = 'ark-session-t03b-1'`,
    );
    expect(ledger.rows).toHaveLength(1);
    // The verified snapshot's model stays; the new Agent model never lands,
    // and the precision says the attribution is exact.
    expect(ledger.rows[0]!.model_id).toBe("model-observed");
    expect(ledger.rows[0]!.model_attribution_precision).toBe("exact");
    await database.close();
  });

  it("writes unknown attribution for unverified, incomplete, and mismatch snapshots", async () => {
    const database = await createTestDatabase();
    const repositories = createRepositories(database.db);
    const { userId, agentId } = await seedUserAndAgent(database.client);

    const cases: Array<{
      arkSessionId: string;
      state: "unverified" | "incomplete" | "mismatch";
      modelId: string | null;
    }> = [
      {
        arkSessionId: "ark-t03b-unverified",
        state: "unverified",
        modelId: null,
      },
      {
        arkSessionId: "ark-t03b-incomplete",
        state: "incomplete",
        modelId: "model-observed",
      },
      {
        arkSessionId: "ark-t03b-mismatch",
        state: "mismatch",
        modelId: "model-observed",
      },
    ];
    for (const [index, c] of cases.entries()) {
      const intent = createIntent(userId, agentId);
      await repositories.sessionLifecycle.prepareCreate(intent);
      await repositories.sessionLifecycle.completeCreate(
        intent.id,
        userId,
        verifiedCompletion(c.arkSessionId),
      );
      await database.client.query(
        `update sessions
            set config_snapshot_state = $2, model_id = $3
          where id = $1`,
        [intent.id, c.state, c.modelId],
      );
      await repositories.sessionLifecycle.projectEvent(userId, intent.id, {
        eventId: `event-t03b-state-${index}`,
        observedAt: new Date("2026-09-06T00:10:00.000Z"),
        metrics: [{ metricType: "input_tokens", quantity: 10 }],
      });
    }

    const ledger = await database.client.query<{
      ark_session_id: string;
      model_id: string | null;
      precision: string;
    }>(
      `select ark_session_id, model_id, model_attribution_precision::text as precision
                from usage_ledger
               where ark_session_id like 'ark-t03b-%'
               order by ark_session_id`,
    );
    expect(ledger.rows).toHaveLength(3);
    for (const row of ledger.rows) {
      // Even a stored observed model must not be attributed when the
      // snapshot is not verified-and-consistent.
      expect(row.model_id).toBeNull();
      expect(row.precision).toBe("unknown");
    }
    await database.close();
  });

  it("keeps attribution stable across duplicate projections and Agent churn", async () => {
    const database = await createTestDatabase();
    const repositories = createRepositories(database.db);
    const { userId, agentId } = await seedUserAndAgent(database.client);
    const intent = createIntent(userId, agentId);
    await repositories.sessionLifecycle.prepareCreate(intent);
    await repositories.sessionLifecycle.completeCreate(
      intent.id,
      userId,
      verifiedCompletion("ark-session-t03b-stable"),
    );

    const project = (eventId: string) =>
      repositories.sessionLifecycle.projectEvent(userId, intent.id, {
        eventId,
        observedAt: new Date("2026-09-06T00:10:00.000Z"),
        metrics: [{ metricType: "input_tokens", quantity: 5 }],
      });

    // Duplicate projection of the same event id writes exactly one row.
    await project("event-t03b-dup");
    await project("event-t03b-dup");
    // Agent churn between projections cannot drift attribution.
    await database.client.query(
      `update personal_agents set model_id = 'model-c-churn' where id = $1`,
      [agentId],
    );
    await project("event-t03b-after-churn");

    const ledger = await database.client.query<{
      model_id: string | null;
      precision: string;
    }>(
      `select model_id, model_attribution_precision::text as precision
                from usage_ledger
               where ark_session_id = 'ark-session-t03b-stable'
               order by ark_event_id`,
    );
    expect(ledger.rows).toHaveLength(2);
    for (const row of ledger.rows) {
      expect(row.model_id).toBe("model-observed");
      expect(row.precision).toBe("exact");
    }
    await database.close();
  });

  it("persists settlement verification state and evidence", async () => {
    const database = await createTestDatabase();
    const repositories = createRepositories(database.db);
    const { userId, agentId } = await seedUserAndAgent(database.client);
    const intent = createIntent(userId, agentId);
    await repositories.sessionLifecycle.prepareCreate(intent);
    await repositories.sessionLifecycle.completeCreate(
      intent.id,
      userId,
      verifiedCompletion("ark-session-settlement"),
    );

    // The settlement target exposes the admission flags the verifier gates on.
    await database.client.query(
      `update sessions set message_unknown_outcome = true where id = $1`,
      [intent.id],
    );
    const target = await repositories.sessionLifecycle.findSettlementTarget(
      userId,
      intent.id,
    );
    expect(target).toMatchObject({
      arkSessionId: "ark-session-settlement",
      messageInFlightCount: 0,
      messageStartPending: false,
      messageUnknownOutcome: true,
    });
    // A foreign tenant cannot probe another user's settlement target.
    await expect(
      repositories.sessionLifecycle.findSettlementTarget(id(), intent.id),
    ).resolves.toBeUndefined();

    const checkedAt = new Date("2026-09-06T01:00:00.000Z");
    await repositories.sessionLifecycle.recordSettlement(userId, intent.id, {
      state: "unknown",
      evidence: {
        reason: "message_admission_unclosed",
        arkEventsRead: 0,
        historyReadComplete: false,
      },
      checkedAt,
    });
    const row = await database.client.query<{
      state: string;
      checked_at: Date;
      evidence: Record<string, unknown>;
    }>(
      `select settlement_state::text as state, settlement_checked_at as checked_at,
              settlement_evidence as evidence
         from sessions where id = $1`,
      [intent.id],
    );
    expect(row.rows[0]!.state).toBe("unknown");
    expect(new Date(row.rows[0]!.checked_at)).toEqual(checkedAt);
    expect(row.rows[0]!.evidence).toMatchObject({
      reason: "message_admission_unclosed",
    });

    await repositories.sessionLifecycle.recordSettlement(userId, intent.id, {
      state: "confirmed",
      evidence: {
        arkEventsRead: 3,
        modelRequestsStarted: 1,
        modelRequestsEnded: 1,
        modelRequestsOpen: 0,
        historyReadComplete: true,
      },
      checkedAt: new Date("2026-09-06T02:00:00.000Z"),
    });
    const confirmed = await database.client.query<{ state: string }>(
      `select settlement_state::text as state from sessions where id = $1`,
      [intent.id],
    );
    expect(confirmed.rows[0]!.state).toBe("confirmed");
    await database.close();
  });

  it("records post-deletion re-accounting with unknown attribution only", async () => {
    const database = await createTestDatabase();
    const repositories = createRepositories(database.db);
    const { userId, agentId } = await seedUserAndAgent(database.client);
    const intent = createIntent(userId, agentId);
    await repositories.sessionLifecycle.prepareCreate(intent);
    await repositories.sessionLifecycle.completeCreate(
      intent.id,
      userId,
      verifiedCompletion("ark-session-t03b-reserved"),
    );

    // The Session row is gone (permanent delete) but the reservation anchor
    // survives; controlled re-accounting has no verifiable snapshot to use.
    await database.client.query(`delete from sessions where id = $1`, [
      intent.id,
    ]);
    const recorded = await repositories.usage.recordByReservation({
      id: id(),
      reservationId: intent.id,
      arkEventId: "event-t03b-settlement",
      metricType: "output_tokens",
      quantity: 12,
    });
    expect(recorded).toBe(true);

    const ledger = await database.client.query<{
      model_id: string | null;
      precision: string;
    }>(
      `select model_id, model_attribution_precision::text as precision
                from usage_ledger
               where ark_session_id = 'ark-session-t03b-reserved'`,
    );
    expect(ledger.rows).toHaveLength(1);
    expect(ledger.rows[0]!.model_id).toBeNull();
    expect(ledger.rows[0]!.precision).toBe("unknown");
    await database.close();
  });
});
