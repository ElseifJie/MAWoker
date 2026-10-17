import { sql, type SQL } from "drizzle-orm";

type Row = Record<string, unknown>;

interface Database {
  execute<T extends Row = Row>(query: SQL): PromiseLike<{ rows: T[] }>;
}

const RUN_STATUSES = [
  "queued",
  "starting",
  "running",
  "waiting_user",
  "waiting_device",
  "completed",
  "failed",
  "canceled",
  "unknown",
] as const;

export interface AdminSystemSnapshot {
  generatedAt: string;
  database: { latencyMs: number };
  jobs: {
    pending: number;
    running: number;
    failedLast24h: number;
    oldestPendingSeconds: number | null;
  };
  runs: Record<(typeof RUN_STATUSES)[number], number>;
  sessions: { running: number };
  automations: { active: number; pending: number; overdue: number };
  notifications: { unread: number };
  users: { active: number; disabled: number };
}

function countOf(rows: Array<{ count: number | string }>): number {
  return Number(rows[0]?.count ?? 0);
}

export function createAdminSystemRepository(db: Database) {
  return {
    async snapshot(now = new Date()): Promise<AdminSystemSnapshot> {
      const started = Date.now();
      const since = new Date(now.getTime() - 24 * 60 * 60 * 1_000);
      const [
        pendingJobs,
        runningJobs,
        failedJobs,
        oldestJob,
        runCounts,
        runningSessions,
        activeAutomations,
        pendingOccurrences,
        overdueOccurrences,
        unreadNotifications,
        activeUsers,
        disabledUsers,
      ] = await Promise.all([
        db.execute<{ count: number | string }>(
          sql`select count(*)::int as count from background_jobs
               where status = 'pending' and run_after <= ${now}`,
        ),
        db.execute<{ count: number | string }>(
          sql`select count(*)::int as count from background_jobs
               where status = 'running'`,
        ),
        db.execute<{ count: number | string }>(
          sql`select count(*)::int as count from background_jobs
               where status = 'failed' and updated_at >= ${since}`,
        ),
        db.execute<{ seconds: number | string | null }>(
          sql`select extract(epoch from (${now} - min(run_after))) as seconds
               from background_jobs
               where status = 'pending' and run_after <= ${now}`,
        ),
        db.execute<{ status: string; count: number | string }>(
          sql`select status, count(*)::int as count from runs group by status`,
        ),
        db.execute<{ count: number | string }>(
          sql`select count(*)::int as count from sessions where status = 'running'`,
        ),
        db.execute<{ count: number | string }>(
          sql`select count(*)::int as count from automations where enabled`,
        ),
        db.execute<{ count: number | string }>(
          sql`select count(*)::int as count from automation_occurrences
               where status = 'pending'`,
        ),
        db.execute<{ count: number | string }>(
          sql`select count(*)::int as count from automation_occurrences
               where status = 'pending' and scheduled_at <= ${now}`,
        ),
        db.execute<{ count: number | string }>(
          sql`select count(*)::int as count from user_notifications
               where read_at is null`,
        ),
        db.execute<{ count: number | string }>(
          sql`select count(*)::int as count from users where status = 'active'`,
        ),
        db.execute<{ count: number | string }>(
          sql`select count(*)::int as count from users where status = 'disabled'`,
        ),
      ]);

      const runs = Object.fromEntries(
        RUN_STATUSES.map((status) => [status, 0]),
      ) as AdminSystemSnapshot["runs"];
      for (const row of runCounts.rows) {
        if (row.status in runs) {
          runs[row.status as keyof AdminSystemSnapshot["runs"]] = Number(
            row.count,
          );
        }
      }
      const oldestSeconds = oldestJob.rows[0]?.seconds;
      return {
        generatedAt: now.toISOString(),
        database: { latencyMs: Date.now() - started },
        jobs: {
          pending: countOf(pendingJobs.rows),
          running: countOf(runningJobs.rows),
          failedLast24h: countOf(failedJobs.rows),
          oldestPendingSeconds:
            oldestSeconds === null || oldestSeconds === undefined
              ? null
              : Math.max(0, Math.floor(Number(oldestSeconds))),
        },
        runs,
        sessions: { running: countOf(runningSessions.rows) },
        automations: {
          active: countOf(activeAutomations.rows),
          pending: countOf(pendingOccurrences.rows),
          overdue: countOf(overdueOccurrences.rows),
        },
        notifications: { unread: countOf(unreadNotifications.rows) },
        users: {
          active: countOf(activeUsers.rows),
          disabled: countOf(disabledUsers.rows),
        },
      };
    },
  };
}
