import { SessionSettlementService } from "../packages/domain/src/session-settlement.js";
import { SessionDeletionProcessor } from "../apps/worker/src/session-deletion.js";
import { SessionReconciliationProcessor } from "../apps/worker/src/session-reconciliation.js";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { describe, expect, it, vi } from "vitest";
import { createRepositories } from "../packages/db/src/index.js";
import { SessionService } from "../packages/domain/src/sessions.js";
import { createTestDatabase, id } from "./support/test-database.js";

async function fixture(
  databaseOverride?: Awaited<ReturnType<typeof createTestDatabase>>,
  admissionEnabled = true,
) {
  const database = databaseOverride ?? (await createTestDatabase());
  const userId = id();
  const agentId = id();
  await database.client.query(
    "insert into users (id, auth_subject, email) values ($1,$3,$2)",
    [userId, `${userId}@example.com`, `subject-${userId}`],
  );
  await database.client.query(
    "insert into quota_policies (key, personal_agent_limit, concurrent_session_limit, daily_session_limit, monthly_token_limit) values ('default',10,2,5,1000)",
  );
  await database.client.query(
    "insert into personal_agents (id,owner_user_id,ark_agent_id,name,model_id,system_prompt,ark_version,status) values ($1,$2,'ark-agent','Agent','model','prompt','1','active')",
    [agentId, userId],
  );
  const repositories = createRepositories(database.db);
  const createSession = vi
    .fn()
    .mockRejectedValue(new Error("Upstream must not run in the request"));
  const submitEvent = vi.fn().mockResolvedValue({
    id: "event-1",
    type: "user.message",
    createdAt: new Date().toISOString(),
    data: { content: "hello" },
  });
  const ark = {
    createSession,
    submitEvent,
    getSession: vi.fn(),
    listEvents: vi.fn().mockResolvedValue([]),
    streamEvents: vi.fn(),
  };
  const resolver = vi.fn(
    async () =>
      ({
        id: agentId,
        kind: "personal",
        arkAgentId: "ark-agent",
        name: "Agent",
        arkVersion: "1",
      }) as never,
  );
  const service = new SessionService({
    repository: repositories.sessionLifecycle,
    agentResolver: { resolveForNewSession: resolver },
    ark,
    environmentId: "env",
    submissionAdmissionEnabled: admissionEnabled,
    createId: id,
  });
  const input = {
    agentId,
    title: "Task",
    content: "hello",
    submissionId: id(),
    temporary: true,
  };
  const context = { userId, requestId: "request-test" };
  return { ...database, repositories, service, input, context, ark, resolver };
}

describe("durable submissions", () => {
  it("accepts a task without an upstream call, replays the same receipt, and reserves quota once", async () => {
    const f = await fixture();
    try {
      const first = await f.service.create(f.input, f.context);
      const replay = await f.service.create(f.input, f.context);
      expect(replay.id).toBe(first.id);
      expect(f.ark.createSession).not.toHaveBeenCalled();
      expect(await f.service.list(f.context.userId)).toHaveLength(1);
      expect(
        (await f.service.get(f.context.userId, first.id)).submissions,
      ).toEqual([
        expect.objectContaining({
          submissionId: f.input.submissionId,
          status: "queued",
          content: "hello",
        }),
      ]);
      expect(
        (await f.client.query("select * from quota_reservations")).rows,
      ).toHaveLength(1);
      expect(
        (await f.client.query("select * from message_submissions")).rows,
      ).toHaveLength(1);
      expect(
        (
          await f.client.query(
            "select * from background_jobs where payload->>'operation' = 'deliver'",
          )
        ).rows,
      ).toHaveLength(1);
      await expect(
        f.service.create({ ...f.input, content: "different" }, f.context),
      ).rejects.toMatchObject({ code: "SUBMISSION_CONFLICT" });
    } finally {
      await f.close();
    }
  });

  it("identifies aggregate material overflow separately from individual size limits", async () => {
    const f = await fixture();
    try {
      const uploadIds = Array.from({ length: 6 }, () => id());
      for (const uploadId of uploadIds)
        await f.client.query(
          "insert into session_inputs(id,owner_user_id,ark_file_id,original_name,mime_type,size_bytes,mount_path,status,expires_at) values($1,$2,$3,'brief.txt','text/plain',$4,$5,'uploaded',$6)",
          [
            uploadId,
            f.context.userId,
            uploadId,
            18 * 1024 * 1024,
            `/mnt/session/inputs/${uploadId}-brief.txt`,
            new Date(Date.now() + 60_000),
          ],
        );
      await expect(
        f.service.create({ ...f.input, uploadIds }, f.context),
      ).rejects.toMatchObject({
        name: "UploadTooLargeError",
        code: "UPLOAD_TOTAL_TOO_LARGE",
      });
      expect((await f.client.query("select * from sessions")).rows).toEqual([]);
      expect(
        (await f.client.query("select * from quota_reservations")).rows,
      ).toEqual([]);
    } finally {
      await f.close();
    }
  });

  it("pauses new durable intake while replay and accepted-work delivery still operate", async () => {
    const f = await fixture();
    try {
      const first = await f.service.create(f.input, f.context);
      const gated = new SessionService({
        repository: f.repositories.sessionLifecycle,
        agentResolver: { resolveForNewSession: f.resolver },
        ark: f.ark,
        environmentId: "env",
        createId: id,
        submissionAdmissionEnabled: false,
      } as ConstructorParameters<typeof SessionService>[0]);
      expect((await gated.create(f.input, f.context)).id).toBe(first.id);
      await expect(
        gated.create({ ...f.input, submissionId: id() }, f.context),
      ).rejects.toMatchObject({ code: "SUBMISSION_ADMISSION_PAUSED" });
      await f.client.query(
        "update sessions set ark_session_id='remote',create_attempted_at=now() where id=$1",
        [first.id],
      );
      await expect(
        gated.sendMessage(
          first.id,
          { content: "new", submissionId: id() },
          f.context,
        ),
      ).rejects.toMatchObject({ code: "SUBMISSION_ADMISSION_PAUSED" });
      await f.client.query("update sessions set status='idle' where id=$1", [
        first.id,
      ]);
      const followup = { content: "followup", submissionId: id() };
      const receipt = await f.service.sendMessage(
        first.id,
        followup,
        f.context,
      );
      expect(await gated.sendMessage(first.id, followup, f.context)).toEqual(
        receipt,
      );
      await expect(
        gated.sendMessage(
          first.id,
          { ...followup, content: "different" },
          f.context,
        ),
      ).rejects.toMatchObject({ code: "SUBMISSION_CONFLICT" });
      const [job] = await f.repositories.jobs.claim({
        workerId: "paused-intake",
        limit: 1,
        types: ["reconcile_session"],
      });
      await gated.deliverSubmission(job!.id, {
        userId: f.context.userId,
        workerId: "paused-intake",
        leaseGeneration: job!.leaseGeneration,
        requestId: "drain",
      });
      expect(
        (await gated.get(f.context.userId, first.id)).submissions?.[0]?.status,
      ).toBe("accepted");
      expect(
        (await f.client.query("select * from message_submissions")).rows,
      ).toHaveLength(2);
    } finally {
      await f.close();
    }
  });

  it("recovers sending as unknown after a lease takeover and never replays it", async () => {
    const f = await fixture();
    try {
      const session = await f.service.create(f.input, f.context);
      const [job] = await f.repositories.jobs.claim({
        workerId: "worker-1",
        limit: 1,
        types: ["reconcile_session"],
      });
      await f.repositories.sessionLifecycle.claimSubmission(
        f.context.userId,
        job!.id,
        "worker-1",
        job!.leaseGeneration,
      );
      await f.client.query(
        "update background_jobs set locked_at=now()-interval '10 minutes' where id=$1",
        [job!.id],
      );
      const [replacement] = await f.repositories.jobs.claim({
        workerId: "worker-2",
        limit: 1,
        types: ["reconcile_session"],
      });
      await f.service.deliverSubmission(replacement!.id, {
        ...f.context,
        workerId: "worker-2",
        leaseGeneration: replacement!.leaseGeneration,
      });
      expect(
        (await f.service.get(f.context.userId, session.id)).submissions?.[0]
          ?.status,
      ).toBe("unknown");
      expect(f.ark.submitEvent).not.toHaveBeenCalled();
    } finally {
      await f.close();
    }
  });
});

async function makeDeliverable(
  f: Awaited<ReturnType<typeof fixture>>,
  sessionId: string,
) {
  await f.client.query(
    "update sessions set ark_session_id='ark-session',create_attempted_at=now() where id=$1",
    [sessionId],
  );
}
async function claim(
  f: Awaited<ReturnType<typeof fixture>>,
  workerId = "worker-1",
) {
  return (
    await f.repositories.jobs.claim({
      workerId,
      limit: 1,
      types: ["reconcile_session"],
    })
  )[0]!;
}

describe("durable submission safety", () => {
  it("preserves request equality and original content when sanitized history arrives before acknowledgement", async () => {
    const f = await fixture();
    try {
      const content = "Original Authorization: Bearer sensitive.original.token";
      const session = await f.service.create(
        { ...f.input, content },
        f.context,
      );
      await makeDeliverable(f, session.id);
      await f.repositories.sessionLifecycle.appendEvents(
        f.context.userId,
        session.id,
        [
          {
            eventId: "event-1",
            sourceType: "user.message",
            type: "message",
            occurredAt: new Date(),
            payload: { content: "Original Authorization: [redacted]" },
          },
        ],
      );
      f.ark.submitEvent.mockResolvedValueOnce({
        id: "event-1",
        type: "user.message",
        createdAt: new Date().toISOString(),
        data: { content },
      });
      const job = await claim(f);
      await f.service.deliverSubmission(job.id, {
        ...f.context,
        workerId: "worker-1",
        leaseGeneration: job.leaseGeneration,
      });
      expect(
        (await f.service.get(f.context.userId, session.id)).submissions?.[0],
      ).toMatchObject({
        status: "accepted",
        content: null,
        acceptedContent: content,
      });
      expect(
        (await f.service.create({ ...f.input, content }, f.context)).id,
      ).toBe(session.id);
      await expect(
        f.service.create({ ...f.input, content: "different" }, f.context),
      ).rejects.toMatchObject({ code: "SUBMISSION_CONFLICT" });
    } finally {
      await f.close();
    }
  });

  it("persists the accepted user event before clearing the delivery body", async () => {
    const f = await fixture();
    try {
      const session = await f.service.create(f.input, f.context);
      await makeDeliverable(f, session.id);
      const job = await claim(f);
      await f.service.deliverSubmission(job.id, {
        ...f.context,
        workerId: "worker-1",
        leaseGeneration: job.leaseGeneration,
      });
      const detail = await f.service.get(f.context.userId, session.id);
      expect(detail.submissions?.[0]).toMatchObject({
        status: "accepted",
        content: null,
        acceptedContent: "hello",
        upstreamEventId: "event-1",
      });
      expect(
        await f.repositories.sessionLifecycle.listEvents(
          f.context.userId,
          session.id,
        ),
      ).toEqual([
        expect.objectContaining({
          eventId: "event-1",
          payload: { content: "hello" },
        }),
      ]);
      await expect(f.service.get(id(), session.id)).rejects.toMatchObject({
        name: "ResourceNotFoundError",
      });
    } finally {
      await f.close();
    }
  });

  it("keeps unknown delivery fenced even when an ordinary idle event arrives", async () => {
    const f = await fixture();
    try {
      const session = await f.service.create(f.input, f.context);
      await makeDeliverable(f, session.id);
      f.ark.submitEvent.mockRejectedValueOnce(
        Object.assign(new Error("lost response"), {
          category: "unknown_write_outcome",
        }),
      );
      const job = await claim(f);
      await f.service.deliverSubmission(job.id, {
        ...f.context,
        workerId: "worker-1",
        leaseGeneration: job.leaseGeneration,
      });
      await f.repositories.sessionLifecycle.projectEvent(
        f.context.userId,
        session.id,
        { eventId: "idle-1", observedAt: new Date(), status: "idle" },
      );
      expect((await f.service.get(f.context.userId, session.id)).status).toBe(
        "running",
      );
      expect(
        (await f.service.get(f.context.userId, session.id)).submissions?.[0]
          ?.status,
      ).toBe("unknown");
    } finally {
      await f.close();
    }
  });

  it("retires expired queued bodies without permanently holding the concurrent slot", async () => {
    const f = await fixture();
    try {
      const session = await f.service.create(f.input, f.context);
      await f.client.query(
        "update message_submissions set retain_until=now()-interval '1 day'",
      );
      await f.repositories.sessionLifecycle.expireSubmissionBodies();
      expect(
        (await f.service.get(f.context.userId, session.id)).submissions?.[0],
      ).toMatchObject({ status: "failed", content: null });
      expect((await f.service.get(f.context.userId, session.id)).status).toBe(
        "terminated",
      );
      expect(
        (await f.client.query("select status from quota_reservations")).rows[0],
      ).toMatchObject({ status: "released" });
    } finally {
      await f.close();
    }
  });

  it("never opens upstream streams or history for a pending local ID", async () => {
    const f = await fixture();
    try {
      const session = await f.service.create(f.input, f.context);
      const opened = await f.service.openEvents(session.id, f.context);
      for await (const event of opened.events) void event;
      await expect(
        f.service.transcriptEvents(session.id, f.context),
      ).rejects.toMatchObject({
        code: "EVENT_HISTORY_REPAIR_PENDING",
      });
      expect(f.ark.streamEvents).not.toHaveBeenCalled();
      expect(f.ark.listEvents).not.toHaveBeenCalled();
    } finally {
      await f.close();
    }
  });

  it("blocks deleted or disabled work before delivery and preserves a traceable failed receipt", async () => {
    for (const reason of ["disabled", "deleted"]) {
      const f = await fixture();
      try {
        const session = await f.service.create(f.input, f.context);
        if (reason === "disabled")
          await f.client.query(
            "update users set status='disabled' where id=$1",
            [f.context.userId],
          );
        else await f.service.requestDelete(session.id, f.context.userId);
        const job = await claim(f);
        await f.service.deliverSubmission(job.id, {
          ...f.context,
          workerId: "worker-1",
          leaseGeneration: job.leaseGeneration,
        });
        expect(
          (await f.client.query("select status from message_submissions"))
            .rows[0],
        ).toMatchObject({ status: "failed" });
        expect(f.ark.createSession).not.toHaveBeenCalled();
        expect(f.ark.submitEvent).not.toHaveBeenCalled();
      } finally {
        await f.close();
      }
    }
  });

  it("requires recorded upstream receipt evidence for administrator reconciliation", async () => {
    const f = await fixture();
    try {
      const session = await f.service.create(f.input, f.context);
      await makeDeliverable(f, session.id);
      const job = await claim(f);
      await f.repositories.sessionLifecycle.claimSubmission(
        f.context.userId,
        job.id,
        "worker-1",
        job.leaseGeneration,
      );
      await f.repositories.sessionLifecycle.finishSubmission(
        f.context.userId,
        job.id,
        job.leaseGeneration,
        { workerId: "worker-1", status: "unknown", eventId: "event-1" },
      );
      const absent = await f.service.reconcileSubmission(
        f.context.userId,
        session.id,
        f.input.submissionId,
        f.context,
      );
      expect(absent.status).toBe("unknown");
      expect(absent).not.toHaveProperty("content");
      f.ark.listEvents.mockResolvedValueOnce([
        {
          id: "event-1",
          type: "user.message",
          createdAt: new Date().toISOString(),
          data: { content: "hello" },
        },
      ] as never);
      expect(
        (
          await f.service.reconcileSubmission(
            f.context.userId,
            session.id,
            f.input.submissionId,
            f.context,
          )
        ).status,
      ).toBe("accepted");
      expect(f.ark.submitEvent).not.toHaveBeenCalled();
    } finally {
      await f.close();
    }
  });
});

describe("durable worker delivery", () => {
  it("creates the remote session in the worker and safely retries a definite rejection", async () => {
    const f = await fixture();
    try {
      f.ark.createSession.mockResolvedValueOnce({
        id: "ark-session",
        agentId: "ark-agent",
        agentVersion: 1,
        environmentId: "env",
        status: "idle",
        configSnapshot: {
          modelId: "model",
          skills: [],
          tools: [],
          environment: {
            id: "env",
            type: "environment",
            configType: "cloud",
            scope: "account",
          },
          completeness: "complete",
        },
      });
      f.ark.submitEvent.mockRejectedValueOnce(
        Object.assign(new Error("rejected"), { category: "rate_limited" }),
      );
      const session = await f.service.create(f.input, f.context);
      let job = await claim(f);
      await expect(
        f.service.deliverSubmission(job.id, {
          ...f.context,
          workerId: "worker-1",
          leaseGeneration: job.leaseGeneration,
        }),
      ).rejects.toMatchObject({ code: "ARK_RATE_LIMITED" });
      expect(
        (await f.service.get(f.context.userId, session.id)).submissions?.[0]
          ?.status,
      ).toBe("queued");
      await f.repositories.jobs.retry(
        job.id,
        "worker-1",
        "ARK_RATE_LIMITED",
        false,
        job.leaseGeneration,
        new Date(0),
      );
      job = await claim(f, "worker-2");
      await f.service.deliverSubmission(job.id, {
        ...f.context,
        workerId: "worker-2",
        leaseGeneration: job.leaseGeneration,
      });
      expect(
        (await f.service.get(f.context.userId, session.id)).submissions?.[0]
          ?.status,
      ).toBe("accepted");
      expect(f.ark.createSession).toHaveBeenCalledTimes(1);
      expect(f.ark.submitEvent).toHaveBeenCalledTimes(2);
    } finally {
      await f.close();
    }
  });

  it("stores an unknown receipt when local confirmation fails and never resends", async () => {
    const f = await fixture();
    try {
      const session = await f.service.create(f.input, f.context);
      await makeDeliverable(f, session.id);
      const job = await claim(f);
      vi.spyOn(
        f.repositories.sessionLifecycle,
        "finishSubmission",
      ).mockRejectedValueOnce(new Error("local confirmation unavailable"));
      await f.service.deliverSubmission(job.id, {
        ...f.context,
        workerId: "worker-1",
        leaseGeneration: job.leaseGeneration,
      });
      expect(
        (await f.service.get(f.context.userId, session.id)).submissions?.[0],
      ).toMatchObject({
        status: "unknown",
        upstreamEventId: "event-1",
        content: "hello",
      });
      f.ark.listEvents.mockResolvedValueOnce([
        {
          id: "event-1",
          type: "user.message",
          createdAt: new Date().toISOString(),
          data: { content: "hello" },
        },
      ] as never);
      await f.service.deliverSubmission(job.id, {
        ...f.context,
        workerId: "worker-1",
        leaseGeneration: job.leaseGeneration,
      });
      expect(
        (await f.service.get(f.context.userId, session.id)).submissions?.[0]
          ?.status,
      ).toBe("accepted");
      expect(f.ark.submitEvent).toHaveBeenCalledTimes(1);
    } finally {
      await f.close();
    }
  });

  it("fences an expired worker's acknowledgement and orders followups behind unknown work", async () => {
    const f = await fixture();
    try {
      const session = await f.service.create(f.input, f.context);
      const first = await claim(f);
      await f.repositories.sessionLifecycle.claimSubmission(
        f.context.userId,
        first.id,
        "worker-1",
        first.leaseGeneration,
      );
      await f.client.query(
        "update background_jobs set locked_at=now()-interval '10 minutes' where id=$1",
        [first.id],
      );
      const replacement = await claim(f, "worker-2");
      await f.repositories.sessionLifecycle.claimSubmission(
        f.context.userId,
        replacement.id,
        "worker-2",
        replacement.leaseGeneration,
      );
      await f.repositories.sessionLifecycle.finishSubmission(
        f.context.userId,
        first.id,
        first.leaseGeneration,
        { workerId: "worker-1", status: "accepted", eventId: "stale" },
      );
      const followupId = id();
      await f.service.sendMessage(
        session.id,
        { content: "later", submissionId: followupId },
        f.context,
      );
      const next = await claim(f, "worker-3");
      await expect(
        f.service.deliverSubmission(next.id, {
          ...f.context,
          workerId: "worker-3",
          leaseGeneration: next.leaseGeneration,
        }),
      ).rejects.toMatchObject({ code: "SUBMISSION_WAITING" });
      expect(
        (await f.service.get(f.context.userId, session.id)).submissions,
      ).toEqual([
        expect.objectContaining({ status: "unknown", content: "hello" }),
        expect.objectContaining({ status: "queued", content: "later" }),
      ]);
      expect(f.ark.submitEvent).not.toHaveBeenCalled();
    } finally {
      await f.close();
    }
  });
});

const postgresUrl = process.env.TEST_POSTGRES_URL;
(postgresUrl ? describe : describe.skip)(
  "durable submission PostgreSQL contention",
  () => {
    it("serializes competing retries into one session, reservation and delivery job", async () => {
      const schemaName = `durable_${id().replaceAll("-", "")}`;
      const administration = new Pool({ connectionString: postgresUrl });
      const pool = new Pool({
        connectionString: postgresUrl,
        max: 8,
        options: `-c search_path=${schemaName} -c statement_timeout=15000`,
      });
      try {
        await administration.query(`create schema "${schemaName}"`);
        const folder = resolve(
          import.meta.dirname,
          "../packages/db/migrations",
        );
        const files = (await readdir(folder))
          .filter((file) => file.endsWith(".sql"))
          .sort();
        const migrationClient = await pool.connect();
        try {
          for (const file of files) {
            const migration = (
              await readFile(resolve(folder, file), "utf8")
            ).replaceAll('"public".', `"${schemaName}".`);
            await migrationClient.query("begin");
            for (const statement of migration.split("--> statement-breakpoint"))
              if (statement.trim()) await migrationClient.query(statement);
            await migrationClient.query("commit");
          }
        } catch (error) {
          await migrationClient.query("rollback");
          throw error;
        } finally {
          migrationClient.release();
        }
        const f = await fixture({
          client: pool,
          db: drizzle(pool),
          close: async () => {},
        } as never);
        const sessions = await Promise.all(
          Array.from({ length: 8 }, () => f.service.create(f.input, f.context)),
        );
        expect(new Set(sessions.map((session) => session.id)).size).toBe(1);
        for (const table of [
          "sessions",
          "quota_reservations",
          "message_submissions",
        ])
          expect(
            Number(
              (await pool.query(`select count(*) as count from ${table}`))
                .rows[0].count,
            ),
          ).toBe(1);
        expect(
          Number(
            (
              await pool.query(
                "select count(*) as count from background_jobs where payload->>'operation'='deliver'",
              )
            ).rows[0].count,
          ),
        ).toBe(1);
        expect(f.ark.createSession).not.toHaveBeenCalled();
      } finally {
        await pool.end();
        await administration.query(
          `drop schema if exists "${schemaName}" cascade`,
        );
        await administration.end();
      }
    });
  },
);

describe("durable delivery lease expiry", () => {
  it("does not complete a job when its lease expires before local acknowledgement", async () => {
    const f = await fixture();
    try {
      const session = await f.service.create(f.input, f.context);
      await makeDeliverable(f, session.id);
      const job = await claim(f);
      f.ark.submitEvent.mockImplementationOnce(async () => {
        await f.client.query(
          "update background_jobs set locked_at=now()-interval '10 minutes' where id=$1",
          [job.id],
        );
        return {
          id: "event-1",
          type: "user.message",
          createdAt: new Date().toISOString(),
          data: { content: "hello" },
        };
      });
      await expect(
        f.service.deliverSubmission(job.id, {
          ...f.context,
          workerId: "worker-1",
          leaseGeneration: job.leaseGeneration,
        }),
      ).rejects.toMatchObject({ code: "DELIVERY_LEASE_LOST" });
      expect(
        (await f.service.get(f.context.userId, session.id)).submissions?.[0],
      ).toMatchObject({
        status: "sending",
        content: "hello",
        upstreamEventId: "event-1",
      });
    } finally {
      await f.close();
    }
  });
});

describe("durable receipt replay", () => {
  it("replays an accepted intent even when its agent becomes unavailable", async () => {
    const f = await fixture();
    try {
      const first = await f.service.create(f.input, f.context);
      f.resolver.mockRejectedValueOnce(new Error("Agent is no longer active"));
      expect((await f.service.create(f.input, f.context)).id).toBe(first.id);
    } finally {
      await f.close();
    }
  });
});

describe("durable memory initialization", () => {
  it("accepts an initial memory-enabled task without initializing its remote memory", async () => {
    const f = await fixture();
    const memory = {
      ensure: vi.fn(async () => {
        throw new Error("Remote memory must initialize in worker");
      }),
      gate: vi.fn(async () => {}),
    };
    const service = new SessionService({
      repository: f.repositories.sessionLifecycle,
      agentResolver: { resolveForNewSession: f.resolver },
      ark: f.ark,
      environmentId: "env",
      createId: id,
      memory,
    });
    try {
      const accepted = await service.create(
        { ...f.input, temporary: false },
        f.context,
      );
      expect(accepted.submissions?.[0]).toMatchObject({
        status: "queued",
        temporary: false,
      });
      expect(memory.ensure).not.toHaveBeenCalled();
      expect(f.ark.createSession).not.toHaveBeenCalled();
      await f.repositories.memories.reserve(f.context.userId);
      await expect(
        service.create(
          { ...f.input, submissionId: id(), temporary: false },
          f.context,
        ),
      ).rejects.toMatchObject({ code: "MEMORY_BUSY" });
      expect(
        (
          await f.client.query(
            "select count(*)::integer as count from message_submissions",
          )
        ).rows[0],
      ).toMatchObject({ count: 1 });
    } finally {
      await f.close();
    }
  });
});

describe("durable final-attempt crash", () => {
  it("preserves UNKNOWN after the worker crashes during its final leased attempt", async () => {
    const f = await fixture();
    try {
      const session = await f.service.create(f.input, f.context);
      await f.client.query(
        "update background_jobs set max_attempts=1 where payload->>'operation'='deliver'",
      );
      const job = await claim(f);
      await f.repositories.sessionLifecycle.claimSubmission(
        f.context.userId,
        job.id,
        "worker-1",
        job.leaseGeneration,
      );
      await f.client.query(
        "update background_jobs set locked_at=now()-interval '10 minutes' where id=$1",
        [job.id],
      );
      await f.service.expireSubmissionBodies();
      await f.repositories.jobs.claim({
        workerId: "worker-2",
        limit: 1,
        types: ["reconcile_session"],
      });
      expect(
        (await f.service.get(f.context.userId, session.id)).submissions?.[0]
          ?.status,
      ).toBe("unknown");
      expect(f.ark.submitEvent).not.toHaveBeenCalled();
    } finally {
      await f.close();
    }
  });
});

describe("durable minimal upstream acknowledgement", () => {
  it("keeps the accepted user text when the upstream receipt omits the body", async () => {
    const f = await fixture();
    try {
      const session = await f.service.create(f.input, f.context);
      await makeDeliverable(f, session.id);
      f.ark.submitEvent.mockResolvedValueOnce({
        id: "event-1",
        type: "user.message",
        createdAt: new Date().toISOString(),
        data: {},
      } as never);
      const job = await claim(f);
      await f.service.deliverSubmission(job.id, {
        ...f.context,
        workerId: "worker-1",
        leaseGeneration: job.leaseGeneration,
      });
      expect(
        (
          await f.repositories.sessionLifecycle.listEvents(
            f.context.userId,
            session.id,
          )
        )[0]?.payload.content,
      ).toBe("hello");
    } finally {
      await f.close();
    }
  });
});

describe("durable acknowledgement storage boundary", () => {
  it("refuses to clear a body unless the matching accepted event is persisted", async () => {
    const f = await fixture();
    try {
      const session = await f.service.create(f.input, f.context);
      const job = await claim(f);
      await f.repositories.sessionLifecycle.claimSubmission(
        f.context.userId,
        job.id,
        "worker-1",
        job.leaseGeneration,
      );
      expect(
        await f.repositories.sessionLifecycle.finishSubmission(
          f.context.userId,
          job.id,
          job.leaseGeneration,
          { workerId: "worker-1", status: "accepted", eventId: "event-1" },
        ),
      ).toBe(false);
      expect(
        (await f.service.get(f.context.userId, session.id)).submissions?.[0],
      ).toMatchObject({ status: "sending", content: "hello" });
    } finally {
      await f.close();
    }
  });
});

// Review regressions exercise the production processors and repositories.
function remoteSession() {
  return {
    id: "ark-session",
    agentId: "ark-agent",
    agentVersion: 1,
    environmentId: "env",
    status: "idle" as const,
    configSnapshot: {
      modelId: "model",
      skills: [],
      tools: [],
      environment: {
        id: "env",
        type: "environment",
        configType: "cloud",
        scope: "account",
      },
      completeness: "complete" as const,
    },
  };
}
function deletionProcessor(f: Awaited<ReturnType<typeof fixture>>) {
  const ark = { ...f.ark, deleteSession: vi.fn(async () => {}) };
  const settlement = new SessionSettlementService({
    repository: f.repositories.sessionLifecycle,
    ark,
  });
  vi.spyOn(settlement, "verify");
  return {
    ark,
    settlement,
    processor: new SessionDeletionProcessor({
      jobs: f.repositories.jobs,
      repository: f.repositories.sessionDeletion,
      ark,
      settlement,
      workerId: "delete-worker",
    }),
  };
}

describe("Task 1 review regression", () => {
  it("keeps ordered waiting work queued across the generic retry budget", async () => {
    const f = await fixture();
    try {
      const session = await f.service.create(f.input, f.context);
      const first = await claim(f);
      await f.repositories.sessionLifecycle.claimSubmission(
        f.context.userId,
        first.id,
        "worker-1",
        first.leaseGeneration,
      );
      await f.repositories.sessionLifecycle.finishSubmission(
        f.context.userId,
        first.id,
        first.leaseGeneration,
        { workerId: "worker-1", status: "unknown" },
      );
      await f.repositories.jobs.succeed(
        first.id,
        "worker-1",
        first.leaseGeneration,
      );
      const submissionId = id();
      await f.service.sendMessage(
        session.id,
        { content: "later", submissionId },
        f.context,
      );
      await f.client.query(
        "update background_jobs set max_attempts=1 where payload->>'operation'='deliver'",
      );
      const processor = new SessionReconciliationProcessor({
        jobs: f.repositories.jobs,
        service: f.service,
        workerId: "delivery-worker",
      });
      for (let attempt = 0; attempt < 4; attempt++) {
        await f.client.query(
          "update background_jobs set run_after=now()-interval '1 second' where status='pending'",
        );
        await processor.runOnce();
      }
      const receipt = (
        await f.service.get(f.context.userId, session.id)
      ).submissions!.find((item) => item.submissionId === submissionId)!;
      expect(receipt.status).toBe("queued");
      expect(
        (
          await f.client.query(
            "select status,attempts from background_jobs where id=$1",
            [receipt.id],
          )
        ).rows[0],
      ).toMatchObject({ status: "pending", attempts: 0 });
      expect(f.ark.submitEvent).not.toHaveBeenCalled();
    } finally {
      await f.close();
    }
  });

  it("deletes never-attempted local creation without sending the placeholder upstream", async () => {
    const f = await fixture();
    try {
      const session = await f.service.create(f.input, f.context);
      await f.service.requestDelete(session.id, f.context.userId);
      const deletion = deletionProcessor(f);
      deletion.ark.getSession.mockRejectedValue(
        Object.assign(new Error("placeholder missing"), {
          category: "not_found",
        }),
      );
      await deletion.processor.runOnce();
      expect(deletion.ark.getSession).not.toHaveBeenCalled();
      expect(deletion.ark.submitEvent).not.toHaveBeenCalled();
      expect(deletion.ark.deleteSession).not.toHaveBeenCalled();
      expect(
        (
          await f.client.query("select * from sessions where id=$1", [
            session.id,
          ])
        ).rows,
      ).toHaveLength(0);
      expect(
        (
          await f.client.query(
            "select status from quota_reservations where id=$1",
            [session.id],
          )
        ).rows[0],
      ).toMatchObject({ status: "released" });
      expect(
        (
          await f.client.query(
            "select status from background_jobs where payload->>'operation'='deliver'",
          )
        ).rows[0],
      ).toMatchObject({ status: "succeeded" });
    } finally {
      await f.close();
    }
  });

  it("retains pending deletion while a held remote create response is unresolved", async () => {
    const f = await fixture();
    try {
      let release!: (value: ReturnType<typeof remoteSession>) => void;
      const response = new Promise<ReturnType<typeof remoteSession>>(
        (resolve) => {
          release = resolve;
        },
      );
      f.ark.createSession.mockReturnValueOnce(response);
      const session = await f.service.create(f.input, f.context);
      const job = await claim(f);
      const delivery = f.service.deliverSubmission(job.id, {
        ...f.context,
        workerId: "worker-1",
        leaseGeneration: job.leaseGeneration,
      });
      await vi.waitFor(() =>
        expect(f.ark.createSession).toHaveBeenCalledTimes(1),
      );
      await f.service.requestDelete(session.id, f.context.userId);
      const deletion = deletionProcessor(f);
      deletion.ark.getSession.mockRejectedValue(
        Object.assign(new Error("placeholder missing"), {
          category: "not_found",
        }),
      );
      await deletion.processor.runOnce();
      expect(
        (
          await f.client.query("select id from sessions where id=$1", [
            session.id,
          ])
        ).rows,
      ).toHaveLength(1);
      expect(deletion.ark.getSession).not.toHaveBeenCalled();
      release(remoteSession());
      await delivery;
      expect(
        (
          await f.client.query(
            "select ark_session_id from sessions where id=$1",
            [session.id],
          )
        ).rows[0],
      ).toMatchObject({ ark_session_id: "ark-session" });
      expect(f.ark.submitEvent).not.toHaveBeenCalled();
      deletion.ark.getSession.mockResolvedValue(remoteSession());
      await f.client.query(
        "update background_jobs set run_after=now()-interval '1 second' where type='delete_session'",
      );
      await deletion.processor.runOnce();
      expect(deletion.ark.deleteSession).toHaveBeenCalledWith(
        "ark-session",
        expect.any(Object),
      );
      expect(
        (
          await f.client.query("select id from sessions where id=$1", [
            session.id,
          ])
        ).rows,
      ).toHaveLength(0);
    } finally {
      await f.close();
    }
  });

  it("retains pending deletion after an unknown remote creation outcome", async () => {
    const f = await fixture();
    try {
      f.ark.createSession.mockRejectedValueOnce(
        Object.assign(new Error("response lost"), {
          category: "unknown_write_outcome",
        }),
      );
      const session = await f.service.create(f.input, f.context);
      const job = await claim(f);
      await f.service.deliverSubmission(job.id, {
        ...f.context,
        workerId: "worker-1",
        leaseGeneration: job.leaseGeneration,
      });
      await f.service.requestDelete(session.id, f.context.userId);
      const deletion = deletionProcessor(f);
      deletion.ark.getSession.mockRejectedValue(
        Object.assign(new Error("placeholder missing"), {
          category: "not_found",
        }),
      );
      await deletion.processor.runOnce();
      expect(
        (
          await f.client.query("select id from sessions where id=$1", [
            session.id,
          ])
        ).rows,
      ).toHaveLength(1);
      expect(deletion.ark.getSession).not.toHaveBeenCalled();
      expect(
        (await f.client.query("select status from message_submissions"))
          .rows[0],
      ).toMatchObject({ status: "unknown" });
      expect(
        (
          await f.client.query(
            "select status from quota_reservations where id=$1",
            [session.id],
          )
        ).rows[0],
      ).toMatchObject({ status: "unknown_outcome" });
    } finally {
      await f.close();
    }
  });

  it("recovers minimal history acknowledgements and enriches a cached minimal user event", async () => {
    const f = await fixture();
    try {
      const session = await f.service.create(f.input, f.context);
      await makeDeliverable(f, session.id);
      const job = await claim(f);
      await f.repositories.sessionLifecycle.claimSubmission(
        f.context.userId,
        job.id,
        "worker-1",
        job.leaseGeneration,
      );
      await f.repositories.sessionLifecycle.finishSubmission(
        f.context.userId,
        job.id,
        job.leaseGeneration,
        { workerId: "worker-1", status: "unknown", eventId: "minimal" },
      );
      await f.repositories.sessionLifecycle.appendEvents(
        f.context.userId,
        session.id,
        [
          {
            eventId: "minimal",
            sourceType: "user.message",
            type: "message",
            occurredAt: new Date(),
            payload: {},
          },
        ],
      );
      f.ark.listEvents.mockResolvedValueOnce([
        {
          id: "minimal",
          type: "user.message",
          createdAt: new Date().toISOString(),
          data: {},
        },
      ] as never);
      expect(
        (
          await f.service.reconcileSubmission(
            f.context.userId,
            session.id,
            f.input.submissionId,
            f.context,
          )
        ).status,
      ).toBe("accepted");
      expect(
        (await f.service.get(f.context.userId, session.id)).submissions?.[0],
      ).toMatchObject({ content: null, acceptedContent: "hello" });
      expect(
        (
          await f.repositories.sessionLifecycle.listEvents(
            f.context.userId,
            session.id,
          )
        )[0]?.payload.content,
      ).toBe("hello");
    } finally {
      await f.close();
    }
  });

  it.each(["lease", "expired", "account", "deletion"])(
    "checks the final create claim after held intent reads (%s)",
    async (reason) => {
      const f = await fixture();
      try {
        const session = await f.service.create(f.input, f.context);
        const job = await claim(f);
        const original = f.repositories.sessionLifecycle.listInputs;
        let release!: () => void;
        let entered!: () => void;
        const readEntered = new Promise<void>((resolve) => {
          entered = resolve;
        });
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        vi.spyOn(
          f.repositories.sessionLifecycle,
          "listInputs",
        ).mockImplementationOnce(async (...args) => {
          entered();
          await gate;
          return original(...args);
        });
        f.ark.createSession.mockResolvedValue(remoteSession());
        const delivery = f.service
          .deliverSubmission(job.id, {
            ...f.context,
            workerId: "worker-1",
            leaseGeneration: job.leaseGeneration,
          })
          .catch(() => {});
        await readEntered;
        if (reason === "lease" || reason === "expired") {
          await f.client.query(
            "update background_jobs set locked_at=now()-interval '10 minutes' where id=$1",
            [job.id],
          );
          if (reason === "lease") await claim(f, "replacement");
        } else if (reason === "account")
          await f.client.query(
            "update users set status='disabled' where id=$1",
            [f.context.userId],
          );
        else await f.service.requestDelete(session.id, f.context.userId);
        release();
        await delivery;
        expect(f.ark.createSession).not.toHaveBeenCalled();
        expect(
          (
            await f.client.query(
              "select create_attempted_at from sessions where id=$1",
              [session.id],
            )
          ).rows[0],
        ).toMatchObject({ create_attempted_at: null });
      } finally {
        await f.close();
      }
    },
  );

  it("rejects interruption of a pending local task without reporting successful stop", async () => {
    const f = await fixture();
    try {
      const session = await f.service.create(f.input, f.context);
      await expect(
        f.service.interrupt(session.id, f.context),
      ).rejects.toMatchObject({ code: "SESSION_BUSY" });
      expect(f.ark.submitEvent).not.toHaveBeenCalled();
      expect(
        (await f.service.get(f.context.userId, session.id)).submissions?.[0]
          ?.status,
      ).toBe("queued");
    } finally {
      await f.close();
    }
  });
});
