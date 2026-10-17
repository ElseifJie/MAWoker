import { describe, expect, it } from "vitest";
import { createRepositories } from "../packages/db/src/index.js";
import { createTestDatabase, id } from "./support/test-database.js";

describe("admin system snapshot", () => {
  it("counts queue, automation, and notification backlog", async () => {
    const database = await createTestDatabase();
    const repositories = createRepositories(database.db);
    const userId = id();
    const automationId = id();
    const now = new Date("2026-10-17T12:00:00.000Z");

    await database.client.query(
      `insert into users (id, auth_subject, email, role)
       values ($1, $2, $3, 'user')`,
      [userId, `local:${userId}@example.com`, "user@example.com"],
    );
    await database.client.query(
      `insert into background_jobs (id, type, status, run_after)
       values ($1, 'cleanup_upload', 'pending', $2),
              ($3, 'cleanup_upload', 'running', $2),
              ($4, 'cleanup_upload', 'failed', $2)`,
      [id(), new Date("2026-10-17T11:58:00.000Z"), id(), id()],
    );
    await database.client.query(
      `insert into automations
         (id, owner_user_id, title, kind, schedule, timezone, next_run_at)
       values ($1, $2, '喝水', 'reminder', '{"type":"daily","time":"09:00"}',
               'Asia/Shanghai', $3)`,
      [automationId, userId, now],
    );
    await database.client.query(
      `insert into automation_occurrences
         (id, owner_user_id, automation_id, schedule_version, scheduled_at, status)
       values ($1, $2, $3, 1, $4, 'pending')`,
      [id(), userId, automationId, new Date("2026-10-17T11:00:00.000Z")],
    );
    await database.client.query(
      `insert into user_notifications
         (id, owner_user_id, source_type, kind, payload)
       values ($1, $2, 'automation', 'reminder', '{"title":"喝水"}')`,
      [id(), userId],
    );

    const snapshot = await repositories.adminSystem.snapshot(now);

    expect(snapshot.database.latencyMs).toBeGreaterThanOrEqual(0);
    expect(snapshot.jobs).toMatchObject({
      pending: 1,
      running: 1,
      failedLast24h: 1,
    });
    expect(snapshot.jobs.oldestPendingSeconds).toBe(120);
    expect(snapshot.automations).toEqual({
      active: 1,
      pending: 1,
      overdue: 1,
    });
    expect(snapshot.notifications.unread).toBe(1);
    expect(snapshot.users.active).toBe(1);
    expect(snapshot.runs.queued).toBe(0);
    await database.close();
  });
});
