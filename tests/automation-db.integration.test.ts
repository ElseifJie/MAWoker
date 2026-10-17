import { describe, expect, it } from "vitest";
import { createRepositories } from "../packages/db/src/index.js";
import {
  AutomationService,
  InvalidAutomationScheduleError,
} from "../packages/domain/src/index.js";
import { createAutomationWorker } from "../apps/worker/src/automation.js";
import { createTestDatabase, id } from "./support/test-database.js";

async function seedUser(
  client: Awaited<ReturnType<typeof createTestDatabase>>["client"],
) {
  const userId = id();
  await client.query(
    `insert into users (id, auth_subject, email, role)
     values ($1, $2, $3, 'user')`,
    [userId, `local:${userId}@example.com`, `${userId}@example.com`],
  );
  return userId;
}

describe("automation reminders", () => {
  it("creates a daily reminder, claims it, notifies once, and schedules the next run", async () => {
    const database = await createTestDatabase();
    const repositories = createRepositories(database.db);
    const userId = await seedUser(database.client);
    let now = new Date("2026-10-17T00:00:00.000Z");
    const service = new AutomationService({
      repository: repositories.automations,
      createId: id,
      now: () => now,
    });

    const automation = await service.create(userId, {
      title: "喝水",
      schedule: { type: "daily", time: "09:00" },
      timezone: "Asia/Shanghai",
    });
    expect(automation.nextRunAt.toISOString()).toBe("2026-10-17T01:00:00.000Z");

    now = new Date("2026-10-17T01:00:00.000Z");
    const worker = createAutomationWorker({
      repository: repositories.automations,
      notifications: repositories.sessionDelivery,
      createId: id,
      now: () => now,
    });
    await expect(worker.runOnce()).resolves.toEqual({
      claimed: 1,
      notified: 1,
      failed: 0,
    });

    const notification = await database.client.query<{
      kind: string;
      session_id: string | null;
      source_type: string;
      payload: { title: string };
    }>(
      `select kind, session_id, source_type, payload
       from user_notifications where owner_user_id = $1`,
      [userId],
    );
    expect(notification.rows[0]).toMatchObject({
      kind: "reminder",
      session_id: null,
      source_type: "automation",
      payload: { title: "喝水" },
    });

    const state = await database.client.query<{
      next_run_at: string;
      enabled: boolean;
    }>("select next_run_at, enabled from automations where id = $1", [
      automation.id,
    ]);
    expect(state.rows[0]).toMatchObject({ enabled: true });
    expect(new Date(state.rows[0]!.next_run_at).toISOString()).toBe(
      "2026-10-18T01:00:00.000Z",
    );
    const occurrences = await database.client.query<{
      status: string;
      scheduled_at: string;
    }>(
      `select status, scheduled_at from automation_occurrences
       where automation_id = $1 order by scheduled_at`,
      [automation.id],
    );
    expect(occurrences.rows.map((row) => row.status)).toEqual([
      "completed",
      "pending",
    ]);

    await expect(worker.runOnce()).resolves.toMatchObject({ claimed: 0 });
    await database.close();
  });

  it("pauses, resumes with a new schedule version, and rejects invalid schedules", async () => {
    const database = await createTestDatabase();
    const repositories = createRepositories(database.db);
    const userId = await seedUser(database.client);
    let now = new Date("2026-10-17T00:00:00.000Z");
    const service = new AutomationService({
      repository: repositories.automations,
      createId: id,
      now: () => now,
    });
    const automation = await service.create(userId, {
      title: "周报",
      schedule: { type: "weekly", weekdays: [1], time: "09:00" },
      timezone: "Asia/Shanghai",
    });

    await expect(
      service.setEnabled(userId, automation.id, false),
    ).resolves.toMatchObject({ enabled: false });
    now = new Date("2026-10-18T00:00:00.000Z");
    await expect(
      service.setEnabled(userId, automation.id, true),
    ).resolves.toMatchObject({ enabled: true, scheduleVersion: 2 });

    const pending = await database.client.query<{ schedule_version: number }>(
      `select schedule_version from automation_occurrences
       where automation_id = $1 and status = 'pending'`,
      [automation.id],
    );
    expect(pending.rows).toEqual([{ schedule_version: 2 }]);

    await expect(
      service.create(userId, {
        title: "过去",
        schedule: { type: "once", at: "2020-01-01T00:00:00.000Z" },
        timezone: "UTC",
      }),
    ).rejects.toBeInstanceOf(InvalidAutomationScheduleError);
    await database.close();
  });
});
