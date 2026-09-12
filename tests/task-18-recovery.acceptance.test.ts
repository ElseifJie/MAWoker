import { describe, expect, it, vi } from "vitest";
import {
  HttpArkGateway,
  InMemoryArkGateway,
} from "../packages/ark-client/src/index.js";
import { createRepositories } from "../packages/db/src/index.js";
import { SessionService } from "../packages/domain/src/index.js";
import { buildApp } from "../apps/api/src/app.js";
import { SessionDeletionProcessor } from "../apps/worker/src/session-deletion.js";
import { SessionReconciliationProcessor } from "../apps/worker/src/session-reconciliation.js";
import { createTestDatabase, id } from "./support/test-database.js";
import { createTask18DatabaseHarness } from "./support/task-18-database.js";

describe("Task 18 failure and recovery acceptance", () => {
  it("bounds retries across Ark 429 and 5xx responses", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json({}, { status: 429 }))
      .mockResolvedValueOnce(Response.json({}, { status: 503 }))
      .mockResolvedValueOnce(
        Response.json({
          id: "agent-1",
          type: "agent",
          version: 1,
          name: "Recovered",
          description: "",
          model: { id: "model-a" },
          base_agent: "ark_agent_preview",
          created_at: "2026-09-07T00:00:00Z",
          updated_at: "2026-09-07T00:00:00Z",
        }),
      );
    const sleep = vi.fn(async (milliseconds: number, signal: AbortSignal) => {
      void milliseconds;
      void signal;
    });
    const gateway = new HttpArkGateway({
      baseUrl: "https://ark.example.com",
      apiKey: "test-only-key",
      fetch,
      sleep,
      random: () => 0.5,
      maxAttempts: 3,
      baseDelayMs: 100,
      maxDelayMs: 150,
    });

    await expect(gateway.getAgent("agent-1")).resolves.toMatchObject({
      id: "agent-1",
      version: 1,
    });
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls.map(([delay]) => delay)).toEqual([50, 75]);
  });

  it("changes readiness to unavailable and back without changing liveness", async () => {
    let databaseAvailable = true;
    const app = buildApp({
      readiness: {
        configurationReady: true,
        checkDatabase: async () => {
          if (!databaseAvailable) throw new Error("database unavailable");
        },
        timeoutMs: 50,
      },
    });

    try {
      expect((await app.inject({ url: "/health/live" })).statusCode).toBe(200);
      expect((await app.inject({ url: "/health/ready" })).statusCode).toBe(200);

      databaseAvailable = false;
      const unavailable = await app.inject({ url: "/health/ready" });
      expect(unavailable.statusCode).toBe(503);
      expect(unavailable.json()).toEqual({
        status: "not_ready",
        checks: { configuration: "ok", database: "failed" },
      });
      expect((await app.inject({ url: "/health/live" })).statusCode).toBe(200);

      databaseAvailable = true;
      const recovered = await app.inject({ url: "/health/ready" });
      expect(recovered.statusCode).toBe(200);
      expect(recovered.json()).toEqual({
        status: "ready",
        checks: { configuration: "ok", database: "ok" },
      });
    } finally {
      await app.close();
    }
  });

  it("persists an accepted Ark create across a DB write failure and reconciles it", async () => {
    const database = await createTestDatabase();
    const repositories = createRepositories(database.db);
    const userId = id();
    const agentId = id();
    const sessionId = id();
    const ark = new InMemoryArkGateway();
    const upstreamAgent = await ark.createAgent({
      name: "Recovery Agent",
      description: "",
      modelId: "model-a",
      systemPrompt: "Prompt",
    });
    await database.client.query(
      `insert into users (id, auth_subject, email)
       values ($1, $2, 'recovery@example.com')`,
      [userId, `managed:${userId}`],
    );
    await database.client.query(
      `insert into quota_policies
         (key, personal_agent_limit, concurrent_session_limit,
          daily_session_limit, monthly_token_limit)
       values ('default', 10, 2, 25, 1000)`,
    );
    await database.client.query(
      `insert into personal_agents
         (id, owner_user_id, ark_agent_id, name, description, model_id,
          system_prompt, ark_version, status)
       values ($1, $2, $3, 'Recovery Agent', '', 'model-a', 'Prompt',
               '1', 'active')`,
      [agentId, userId, upstreamAgent.id],
    );
    const service = new SessionService({
      repository: repositories.sessionLifecycle,
      agentResolver: {
        async resolveForNewSession() {
          return {
            id: agentId,
            arkAgentId: upstreamAgent.id,
            name: "Recovery Agent",
            description: "",
            modelId: "model-a",
            systemPrompt: "Prompt",
            arkVersion: "1",
            status: "active" as const,
            kind: "personal" as const,
            editable: true,
          };
        },
      },
      ark,
      environmentId: "environment-1",
      createId: () => sessionId,
    });
    vi.spyOn(
      repositories.sessionLifecycle,
      "completeCreate",
    ).mockRejectedValueOnce(new Error("database unavailable"));

    try {
      await expect(
        service.create(
          { agentId, title: "Recover this Session" },
          { userId, requestId: "request-create" },
        ),
      ).rejects.toThrow("database unavailable");
      const pending = await database.client.query<{
        ark_session_id: string;
        status: string;
        job_status: string;
      }>(
        `select session.ark_session_id, session.status,
                job.status as job_status
           from sessions session
           join background_jobs job on job.id = session.id
          where session.id = $1`,
        [sessionId],
      );
      expect(pending.rows[0]).toMatchObject({
        ark_session_id: "session-1",
        status: "idle",
        job_status: "pending",
      });

      await database.client.query(
        `update background_jobs set run_after = now() where id = $1`,
        [sessionId],
      );
      const processor = new SessionReconciliationProcessor({
        jobs: repositories.jobs,
        service,
        workerId: "task-18-reconciliation",
      });
      await expect(processor.runOnce()).resolves.toBe(1);
      await expect(
        repositories.sessionLifecycle.findOwned(userId, sessionId),
      ).resolves.toMatchObject({
        id: sessionId,
        arkSessionId: "session-1",
      });
      const completed = await database.client.query<{ status: string }>(
        `select status from background_jobs where id = $1`,
        [sessionId],
      );
      expect(completed.rows[0]?.status).toBe("succeeded");
      expect(
        ark.calls.filter(({ operation }) => operation === "createSession"),
      ).toHaveLength(1);
    } finally {
      await database.close();
    }
  });

  it("keeps deletion durable after a partial failure and resumes from its checkpoint", async () => {
    const harness = await createTask18DatabaseHarness();
    const ark = {
      getSession: vi.fn(async () => ({
        id: "ark-session-first",
        agentId: "ark-agent-first",
        agentVersion: 1,
        environmentId: "environment-1",
        status: "idle" as const,
      })),
      submitEvent: vi.fn(),
      deleteSession: vi.fn(async () => undefined),
    };
    // Fail the orphaning step once, so the saga checkpoints its progress and
    // must resume without repeating the Ark delete.
    const orphanDriveFiles = vi
      .fn(harness.repositories.sessionDeletion.orphanDriveFiles)
      .mockRejectedValueOnce(new Error("drive store unavailable"));
    const repository = {
      ...harness.repositories.sessionDeletion,
      orphanDriveFiles,
    };
    const processor = new SessionDeletionProcessor({
      jobs: harness.repositories.jobs,
      repository,
      ark,
      workerId: "task-18-deletion",
    });

    try {
      await harness.sessions.requestDelete(
        harness.first.sessionId,
        harness.first.userId,
      );
      await expect(processor.runOnce()).resolves.toBe(1);
      const retry = await harness.database.client.query<{
        status: string;
        payload: { completed: Record<string, true> };
      }>(`select status, payload from background_jobs where id = $1`, [
        harness.first.sessionId,
      ]);
      expect(retry.rows[0]).toMatchObject({
        status: "pending",
        payload: {
          completed: {
            nonRunningObserved: true,
            arkDeleted: true,
          },
        },
      });
      await expect(
        harness.repositories.sessionLifecycle.findOwned(
          harness.first.userId,
          harness.first.sessionId,
        ),
      ).resolves.toMatchObject({ deletionState: "deletion_failed" });

      await harness.database.client.query(
        `update background_jobs set run_after = now() where id = $1`,
        [harness.first.sessionId],
      );
      await expect(processor.runOnce()).resolves.toBe(1);
      await expect(
        harness.repositories.sessionLifecycle.findOwned(
          harness.first.userId,
          harness.first.sessionId,
        ),
      ).resolves.toBeUndefined();
      // The Ark delete ran once; the resumed attempt did not repeat it.
      expect(ark.deleteSession).toHaveBeenCalledOnce();
      expect(ark.getSession).toHaveBeenCalledTimes(1);
      expect(orphanDriveFiles).toHaveBeenCalledTimes(2);
    } finally {
      await harness.close();
    }
  });
});
