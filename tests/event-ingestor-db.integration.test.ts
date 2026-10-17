import { describe, expect, it } from "vitest";
import { createRepositories } from "../packages/db/src/index.js";
import { createTestDatabase, id } from "./support/test-database.js";

async function seedRunningSession(
  client: Awaited<ReturnType<typeof createTestDatabase>>["client"],
  ownerUserId: string,
  sessionId: string,
) {
  const personalAgentId = id();
  await client.query(
    `insert into personal_agents
      (id, owner_user_id, ark_agent_id, name, model_id, system_prompt,
       ark_version, status)
     values ($1, $2, $3, 'Agent', 'model-a', 'Prompt', '1', 'active')`,
    [personalAgentId, ownerUserId, `ark-agent-${id()}`],
  );
  await client.query(
    `insert into sessions
      (id, owner_user_id, ark_session_id, agent_kind, personal_agent_id,
       ark_agent_id, agent_version, environment_id, status, last_event_at)
     values ($1, $2, $3, 'personal', $4, $5, '1', 'env-1', 'running', now())`,
    [
      sessionId,
      ownerUserId,
      `ark-session-${id()}`,
      personalAgentId,
      `ark-agent-${personalAgentId}`,
    ],
  );
}

describe("event ingestor lease repository", () => {
  it("grants one consumer, fences stale generations, and allows reclaim after expiry", async () => {
    const database = await createTestDatabase();
    const repositories = createRepositories(database.db);
    const ownerId = id();
    const sessionId = id();
    await database.client.query(
      `insert into users (id, auth_subject, email) values ($1, $2, $3)`,
      [ownerId, `subject-${ownerId}`, `${ownerId}@example.com`],
    );
    await seedRunningSession(database.client, ownerId, sessionId);

    const t0 = new Date("2026-10-17T00:00:00.000Z");
    const candidates = await repositories.eventConsumers.listCandidates(t0, 10);
    expect(candidates).toEqual([{ sessionId, ownerUserId: ownerId }]);

    const first = await repositories.eventConsumers.claim({
      sessionId,
      ownerUserId: ownerId,
      consumerId: "worker-1",
      now: t0,
      leaseUntil: new Date(t0.getTime() + 30_000),
    });
    expect(first).toEqual({ generation: 1, lastEventId: null });

    await expect(
      repositories.eventConsumers.claim({
        sessionId,
        ownerUserId: ownerId,
        consumerId: "worker-2",
        now: new Date(t0.getTime() + 1_000),
        leaseUntil: new Date(t0.getTime() + 31_000),
      }),
    ).resolves.toBeUndefined();

    await expect(
      repositories.eventConsumers.checkpoint({
        sessionId,
        consumerId: "worker-1",
        generation: 1,
        lastEventId: "event-1",
        now: new Date(t0.getTime() + 2_000),
        leaseUntil: new Date(t0.getTime() + 32_000),
      }),
    ).resolves.toBe(true);

    await expect(
      repositories.eventConsumers.checkpoint({
        sessionId,
        consumerId: "worker-1",
        generation: 0,
        lastEventId: "event-2",
        now: new Date(t0.getTime() + 3_000),
        leaseUntil: new Date(t0.getTime() + 33_000),
      }),
    ).resolves.toBe(false);

    await repositories.eventConsumers.release({
      sessionId,
      consumerId: "worker-1",
      generation: 1,
      now: new Date(t0.getTime() + 4_000),
    });
    await expect(
      repositories.eventConsumers.claim({
        sessionId,
        ownerUserId: ownerId,
        consumerId: "worker-2",
        now: new Date(t0.getTime() + 5_000),
        leaseUntil: new Date(t0.getTime() + 35_000),
      }),
    ).resolves.toEqual({ generation: 2, lastEventId: "event-1" });

    await database.close();
  });
});
