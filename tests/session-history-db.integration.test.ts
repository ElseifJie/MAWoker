import { afterEach, describe, expect, it } from "vitest";
import { createRepositories } from "../packages/db/src/index.js";
import {
  SessionService,
  type SessionRepository,
  type StoredSessionEvent,
} from "../packages/domain/src/index.js";
import type { ArkEvent } from "../packages/ark-client/src/index.js";
import { SessionHistoryProcessor } from "../apps/worker/src/session-history.js";
import { createTestDatabase, id } from "./support/test-database.js";

const databases: Awaited<ReturnType<typeof createTestDatabase>>[] = [];
afterEach(async () => {
  await Promise.all(databases.splice(0).map((db) => db.close()));
});

async function setup() {
  const database = await createTestDatabase();
  databases.push(database);
  const userId = id();
  const sessionId = id();
  const agentId = id();
  await database.client.query(
    "insert into users (id,auth_subject,email) values ($1,$2,$3)",
    [userId, userId, `${userId}@example.com`],
  );
  await database.client.query(
    "insert into personal_agents (id,owner_user_id,ark_agent_id,name,model_id,system_prompt,ark_version,status) values ($1,$2,'agent','Agent','model','Prompt','1','active')",
    [agentId, userId],
  );
  await database.client.query(
    `insert into sessions (id,owner_user_id,personal_agent_id,ark_session_id,agent_kind,ark_agent_id,agent_name,agent_version,environment_id,title,status,archived_at)
    values ($1,$2,$3,'ark-ready','personal','agent','Agent','1','env','Old archived task','idle',now())`,
    [sessionId, userId, agentId],
  );
  const repository = createRepositories(database.db).sessionLifecycle;
  return { ...database, repository, userId, sessionId };
}

function event(eventId: string, content = eventId): StoredSessionEvent {
  return {
    eventId,
    sourceType: "agent.message",
    type: "message",
    occurredAt: new Date("2026-01-01"),
    payload: { content },
  };
}

function service(
  repository: SessionRepository,
  listEvents: () => Promise<ArkEvent[]>,
) {
  return new SessionService({
    repository,
    ark: {
      listEvents,
      createSession: async () => undefined,
      getSession: async () => undefined,
      submitEvent: async () => undefined,
      streamEvents: async () => undefined,
    } as never,
    agentResolver: { resolveForNewSession: async () => undefined } as never,
    environmentId: "env",
    createId: id,
  });
}

describe("durable session history", () => {
  it("invalidates durable completion when a later live append fails", async () => {
    const { repository, userId, sessionId } = await setup();
    const wrapped: SessionRepository = {
      ...repository,
      appendEvents: async (...args) => {
        if (args[2].some((event) => event.eventId === "lost-live"))
          throw new Error("Live write failed");
        await repository.appendEvents(...args);
      },
    };
    const liveService = new SessionService({
      repository: wrapped,
      ark: {
        listEvents: async () => [],
        streamEvents: async () => ({
          async *[Symbol.asyncIterator]() {
            yield {
              id: "lost-live",
              type: "agent.message",
              createdAt: new Date("2026-01-01").toISOString(),
              data: { content: "Still visible" },
            };
          },
        }),
      } as never,
      agentResolver: {} as never,
      environmentId: "env",
      createId: id,
    });
    const opened = await liveService.openEvents(sessionId, {
      userId,
      requestId: "live-write-failed",
    });
    const emitted = [];
    for await (const event of opened.events) emitted.push(event);
    expect(emitted).toMatchObject([{ id: "lost-live" }]);
    expect(await repository.historyState(userId, sessionId)).toMatchObject({
      complete: false,
      repairRequired: true,
    });
  });

  it("refuses cursor and projection writes for foreign or deleting sessions", async () => {
    const { repository, client, userId, sessionId } = await setup();
    const foreign = id();
    await client.query(
      "insert into users(id,auth_subject,email) values ($1,$2,$3)",
      [foreign, foreign, `${foreign}@example.com`],
    );
    await repository.projectEvent(foreign, sessionId, {
      eventId: "foreign-projection",
      observedAt: new Date("2040-01-01"),
      status: "terminated",
    });
    await repository.beginDelete(userId, sessionId);
    await repository.projectEvent(userId, sessionId, {
      eventId: "deleted-projection",
      observedAt: new Date("2040-01-01"),
      status: "terminated",
    });
    await repository.appendEvents(userId, sessionId, [event("deleted-write")]);
    expect(
      (
        await client.query(
          "select * from session_event_cursors where session_id=$1",
          [sessionId],
        )
      ).rows,
    ).toEqual([]);
    expect(
      (
        await client.query("select status from sessions where id=$1", [
          sessionId,
        ])
      ).rows,
    ).toEqual([{ status: "idle" }]);
  });

  it("keeps deletion status readable without reopening a non-deleting history cursor", async () => {
    const { repository, userId, sessionId } = await setup();
    await repository.beginDelete(userId, sessionId);
    expect(
      await service(repository, async () => []).get(userId, sessionId),
    ).toMatchObject({ deletionState: "pending" });
  });

  it("does not invalidate a newer successful scan when a superseded request finishes late", async () => {
    const { repository, client, userId, sessionId } = await setup();
    let release!: (events: ArkEvent[]) => void;
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const old = service(repository, () => {
      started();
      return new Promise((resolve) => {
        release = resolve;
      });
    }).reconcileHistory(sessionId, { userId, requestId: "old" });
    await ready;
    await service(repository, async () => []).reconcileHistory(sessionId, {
      userId,
      requestId: "new",
    });
    release([
      {
        id: "late",
        type: "session.status",
        createdAt: new Date("2040-01-01").toISOString(),
        data: { status: "terminated" },
      },
    ]);
    await expect(old).rejects.toMatchObject({
      code: "EVENT_HISTORY_REPAIR_PENDING",
    });
    expect(await repository.historyState(userId, sessionId)).toMatchObject({
      complete: true,
      repairRequired: false,
    });
    expect(
      (
        await client.query("select status from sessions where id=$1", [
          sessionId,
        ])
      ).rows,
    ).toEqual([{ status: "idle" }]);
  });

  it("does not invalidate newer history when a request aborts before starting its scan", async () => {
    const { repository, userId, sessionId } = await setup();
    const generation = await repository.beginHistoryScan(userId, sessionId);
    await repository.markHistoryBackfilled(userId, sessionId, generation);
    const controller = new AbortController();
    controller.abort();
    await expect(
      service(repository, async () => []).reconcileHistory(
        sessionId,
        { userId, requestId: "already-aborted" },
        controller.signal,
      ),
    ).rejects.toMatchObject({ code: "EVENT_HISTORY_REPAIR_PENDING" });
    expect(await repository.historyState(userId, sessionId)).toMatchObject({
      complete: true,
      scanGeneration: generation,
    });
  });

  it("does not let a late foreground history snapshot overwrite a newer successful scan", async () => {
    const { repository, client, userId, sessionId } = await setup();
    let release!: (events: ArkEvent[]) => void;
    const history = new Promise<ArkEvent[]>((resolve) => {
      release = resolve;
    });
    const foreground = new SessionService({
      repository,
      ark: {
        listEvents: async () => history,
        streamEvents: async () => ({
          async *[Symbol.asyncIterator]() {},
        }),
      } as never,
      agentResolver: {} as never,
      environmentId: "env",
      createId: id,
    });
    const opened = await foreground.openEvents(sessionId, {
      userId,
      requestId: "foreground-old",
    });
    await service(repository, async () => []).reconcileHistory(sessionId, {
      userId,
      requestId: "background-new",
    });
    release([
      {
        id: "foreground-late",
        type: "session.status",
        createdAt: new Date("2040-01-01").toISOString(),
        data: { status: "terminated" },
      },
    ]);
    const emitted = [];
    for await (const event of opened.events) emitted.push(event);
    expect(emitted).toMatchObject([{ id: "foreground-late" }]);
    expect(
      (
        await client.query("select status from sessions where id=$1", [
          sessionId,
        ])
      ).rows,
    ).toEqual([{ status: "idle" }]);
    expect(await repository.historyState(userId, sessionId)).toMatchObject({
      complete: true,
      repairRequired: false,
    });
  });

  it("repairs an offline old complete session after restart and keeps token usage idempotent", async () => {
    const { repository, client, userId, sessionId } = await setup();
    await client.query(
      "insert into quota_policies(key,personal_agent_limit,concurrent_session_limit,daily_session_limit,monthly_token_limit) values ('default',10,10,10,1000)",
    );
    await client.query(
      "insert into quota_reservations(id,user_id,ark_session_id,status,expires_at) values ($1,$2,'ark-ready','consumed',now())",
      [id(), userId],
    );
    let sources: ArkEvent[] = [
      {
        id: "first",
        type: "agent.message",
        createdAt: new Date("2026-01-01").toISOString(),
        data: { content: "First" },
      },
    ];
    await service(repository, async () => sources).reconcileHistory(sessionId, {
      userId,
      requestId: "old-complete",
    });
    sources = [
      ...sources,
      {
        id: "offline",
        type: "agent.message",
        createdAt: new Date("2026-01-02").toISOString(),
        data: { content: "Offline result" },
      },
      {
        id: "tokens",
        type: "span.model_request_end",
        createdAt: new Date("2026-01-02").toISOString(),
        data: { model_usage: { input_tokens: 10, output_tokens: 5 } },
      },
    ];
    const now = new Date("2030-01-01");
    const scanner = new SessionHistoryProcessor({
      repository,
      service: service(repository, async () => sources),
      workerId: "restart",
      now: () => now,
      cooldownMs: 1000,
    });
    expect(await scanner.runOnce()).toBe(1);
    expect(
      (await repository.listEvents(userId, sessionId)).map((e) => e.eventId),
    ).toEqual(["first", "offline"]);
    now.setTime(now.getTime() + 1000);
    expect(await scanner.runOnce()).toBe(1);
    expect(
      (
        await client.query(
          "select sum(quantity)::integer as total from usage_ledger where metric_type in ('input_tokens','output_tokens')",
        )
      ).rows,
    ).toEqual([{ total: 15 }]);
  });

  it("fairly revisits archived idle sessions and durably backs off failures without excluding old complete flags", async () => {
    const { repository, client, userId, sessionId } = await setup();
    expect(repository).toHaveProperty("listHistoryReconcilable");
    const now = new Date("2030-01-01");
    await client.query(
      "insert into session_event_cursors(session_id,history_backfilled_at) values ($1,now())",
      [sessionId],
    );
    const selected = await repository.listHistoryReconcilable({
      now,
      limit: 2,
      cooldownMs: 1000,
    });
    expect(selected).toMatchObject([
      { sessionId, ownerUserId: userId, arkSessionId: "ark-ready" },
    ]);
    expect(
      await repository.listHistoryReconcilable({
        now,
        limit: 2,
        cooldownMs: 1000,
      }),
    ).toEqual([]);
    await repository.finishHistoryAttempt(userId, sessionId, {
      now,
      succeeded: false,
      cooldownMs: 1000,
      maxBackoffMs: 8000,
    });
    expect(
      await repository.listHistoryReconcilable({
        now: new Date(now.getTime() + 999),
        limit: 2,
        cooldownMs: 1000,
      }),
    ).toEqual([]);
    expect(
      await repository.listHistoryReconcilable({
        now: new Date(now.getTime() + 1000),
        limit: 2,
        cooldownMs: 1000,
      }),
    ).toHaveLength(1);
    await client.query("update users set status='disabled' where id=$1", [
      userId,
    ]);
    expect(
      await repository.listHistoryReconcilable({
        now: new Date(now.getTime() + 9000),
        limit: 2,
        cooldownMs: 1000,
      }),
    ).toEqual([]);
  });

  it("does not let a late scanner result overwrite a newer attempt reservation", async () => {
    const { repository, client, userId, sessionId } = await setup();
    const attemptedAt = new Date("2030-01-01");
    const newer = new Date(attemptedAt.getTime() + 1000);
    await repository.listHistoryReconcilable({
      now: attemptedAt,
      limit: 1,
      cooldownMs: 1000,
    });
    await repository.listHistoryReconcilable({
      now: newer,
      limit: 1,
      cooldownMs: 1000,
    });
    await repository.finishHistoryAttempt(userId, sessionId, {
      now: new Date(newer.getTime() + 100),
      attemptedAt,
      succeeded: false,
      cooldownMs: 1000,
      maxBackoffMs: 8000,
    });
    expect(
      (
        await client.query(
          "select history_failure_count as failures,history_next_attempt_at as next from session_event_cursors where session_id=$1",
          [sessionId],
        )
      ).rows,
    ).toEqual([{ failures: 0, next: new Date(newer.getTime() + 1000) }]);
  });

  it("fences old scans and preserves the last successful checkpoint across independent instances", async () => {
    const { repository, db, userId, sessionId } = await setup();
    expect(repository).toHaveProperty("beginHistoryScan");
    const second = createRepositories(db).sessionLifecycle;
    const generation = await repository.beginHistoryScan(userId, sessionId);
    await repository.appendEvents(
      userId,
      sessionId,
      [event("opaque-z")],
      generation,
    );
    expect(
      await repository.markHistoryBackfilled(userId, sessionId, generation),
    ).toBe(true);
    const success = await repository.historyState(userId, sessionId);
    expect(success).toMatchObject({
      complete: true,
      repairRequired: false,
      persistedSequence: "1",
    });
    expect(success.scannedAt).toBeInstanceOf(Date);
    await second.invalidateHistory(userId, sessionId);
    expect(
      await repository.markHistoryBackfilled(userId, sessionId, generation),
    ).toBe(false);
    expect(await second.historyState(userId, sessionId)).toMatchObject({
      complete: false,
      repairRequired: true,
      scannedAt: success.scannedAt,
      persistedSequence: "1",
    });
    const older = await repository.beginHistoryScan(userId, sessionId);
    const newer = await second.beginHistoryScan(userId, sessionId);
    expect(
      await repository.markHistoryBackfilled(userId, sessionId, older),
    ).toBe(false);
    await expect(
      repository.appendEvents(userId, sessionId, [event("stale")], older),
    ).rejects.toMatchObject({ code: "EVENT_HISTORY_SCAN_STALE" });
    expect(await second.markHistoryBackfilled(userId, sessionId, newer)).toBe(
      true,
    );
  });

  it("deduplicates, bounds owned local reads, and sorts equal timestamps by upstream history position", async () => {
    const { repository, userId, sessionId } = await setup();
    expect(repository).toHaveProperty("listEventsAfter");
    await repository.appendEvents(userId, sessionId, [event("opaque-a")]);
    const generation = await repository.beginHistoryScan(userId, sessionId);
    await repository.appendEvents(
      userId,
      sessionId,
      [
        { ...event("opaque-z"), historyPosition: 0 },
        { ...event("opaque-a"), historyPosition: 1 },
        { ...event("opaque-m"), historyPosition: 2 },
      ],
      generation,
    );
    const ordered = await repository.listEvents(userId, sessionId);
    expect(ordered.map((e) => e.eventId)).toEqual([
      "opaque-z",
      "opaque-a",
      "opaque-m",
    ]);
    expect(ordered.every((e) => typeof e.localSequence === "string")).toBe(
      true,
    );
    const incremental = await repository.listEventsAfter(
      userId,
      sessionId,
      "0",
      2,
    );
    expect(incremental.map((e) => e.eventId)).toEqual(["opaque-a", "opaque-z"]);
    expect(
      await repository.listEventsAfter(
        userId,
        sessionId,
        incremental[1]!.localSequence!,
        2,
      ),
    ).toHaveLength(1);
    expect(await repository.listEventsAfter(id(), sessionId, "0", 10)).toEqual(
      [],
    );
    await repository.appendEvents(id(), sessionId, [event("foreign")]);
    expect(await repository.listEvents(userId, sessionId)).toHaveLength(3);
    expect(() =>
      repository.listEventsAfter(userId, sessionId, "-1", 5),
    ).toThrow();
    await repository.beginDelete(userId, sessionId);
    await repository.appendEvents(userId, sessionId, [event("deleted")]);
    expect(await repository.listEvents(userId, sessionId)).toEqual([]);
  });

  it("does not lose original accepted user content while enriching a minimal acknowledgement", async () => {
    const { repository, userId, sessionId } = await setup();
    await repository.appendEvents(userId, sessionId, [
      {
        ...event("accepted"),
        sourceType: "user.message",
        payload: { content: "Original user content" },
      },
    ]);
    await repository.appendEvents(userId, sessionId, [
      {
        ...event("accepted"),
        sourceType: "user.message",
        payload: { content: "Different upstream content", threadId: "thread" },
      },
    ]);
    expect(
      (await repository.listEvents(userId, sessionId))[0]!.payload,
    ).toMatchObject({ content: "Original user content", threadId: "thread" });
  });

  it("leaves only successful batches durable on middle failure and cannot report complete", async () => {
    const { repository, userId, sessionId } = await setup();
    expect(repository).toHaveProperty("historyState");
    let calls = 0;
    const wrapped: SessionRepository = {
      ...repository,
      appendEvents: async (...args) => {
        if (++calls === 2) throw new Error("DB outage in batch two");
        await repository.appendEvents(...args);
      },
    };
    const sources = Array.from({ length: 121 }, (_, n) => ({
      id: `event-${n}`,
      type: "agent.message",
      createdAt: new Date("2026-01-01").toISOString(),
      data: { content: `Message ${n}` },
    }));
    await expect(
      service(wrapped, async () => sources).reconcileHistory(sessionId, {
        userId,
        requestId: "repair",
      }),
    ).rejects.toMatchObject({ code: "EVENT_HISTORY_REPAIR_PENDING" });
    expect(await repository.historyState(userId, sessionId)).toMatchObject({
      complete: false,
      repairRequired: true,
      scannedAt: null,
      persistedSequence: "50",
    });
    expect(await repository.listEvents(userId, sessionId)).toHaveLength(50);
    await service(repository, async () => sources).reconcileHistory(sessionId, {
      userId,
      requestId: "recovered",
    });
    expect(await repository.listEvents(userId, sessionId)).toHaveLength(121);
    expect(await repository.historyState(userId, sessionId)).toMatchObject({
      complete: true,
      repairRequired: false,
    });
  });
});
