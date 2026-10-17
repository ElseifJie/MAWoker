import { sql, type SQL } from "drizzle-orm";

type Row = Record<string, unknown>;

interface Database {
  execute<T extends Row = Row>(query: SQL): PromiseLike<{ rows: T[] }>;
  transaction<T>(callback: (transaction: Database) => Promise<T>): Promise<T>;
}

export interface AutomationRow extends Row {
  id: string;
  ownerUserId: string;
  title: string;
  kind: "reminder";
  schedule: Record<string, unknown>;
  timezone: string;
  nextRunAt: Date;
  enabled: boolean;
  scheduleVersion: number;
  revision: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface AutomationClaim {
  occurrenceId: string;
  ownerUserId: string;
  automationId: string;
  scheduleVersion: number;
  scheduledAt: Date;
  leaseGeneration: number;
  title: string;
  kind: "reminder";
  schedule: Record<string, unknown>;
  timezone: string;
}

const selection = sql`id, owner_user_id as "ownerUserId", title, kind,
  schedule, timezone, next_run_at as "nextRunAt", enabled,
  schedule_version as "scheduleVersion", revision,
  created_at as "createdAt", updated_at as "updatedAt"`;

function dates(row: AutomationRow): AutomationRow {
  return {
    ...row,
    nextRunAt: new Date(row.nextRunAt),
    createdAt: new Date(row.createdAt),
    updatedAt: new Date(row.updatedAt),
  };
}

export function createAutomationRepository(db: Database) {
  return {
    async createWithOccurrence(input: {
      id: string;
      occurrenceId: string;
      ownerUserId: string;
      title: string;
      schedule: Record<string, unknown>;
      timezone: string;
      nextRunAt: Date;
      now: Date;
    }): Promise<AutomationRow> {
      return db.transaction(async (transaction) => {
        const created = await transaction.execute<AutomationRow>(
          sql`insert into automations
                (id, owner_user_id, title, kind, schedule, timezone,
                 next_run_at, enabled, schedule_version, revision,
                 created_at, updated_at)
              values (
                ${input.id}, ${input.ownerUserId}, ${input.title}, 'reminder',
                ${JSON.stringify(input.schedule)}::jsonb, ${input.timezone},
                ${input.nextRunAt}, true, 1, 1, ${input.now}, ${input.now}
              )
              returning ${selection}`,
        );
        await transaction.execute(
          sql`insert into automation_occurrences
                (id, owner_user_id, automation_id, schedule_version,
                 scheduled_at, status, created_at, updated_at)
              values (
                ${input.occurrenceId}, ${input.ownerUserId}, ${input.id}, 1,
                ${input.nextRunAt}, 'pending', ${input.now}, ${input.now}
              )`,
        );
        return dates(created.rows[0]!);
      });
    },

    async listOwned(ownerUserId: string): Promise<AutomationRow[]> {
      const result = await db.execute<AutomationRow>(
        sql`select ${selection} from automations
             where owner_user_id = ${ownerUserId}
             order by created_at desc, id desc`,
      );
      return result.rows.map(dates);
    },

    async findOwned(
      ownerUserId: string,
      id: string,
    ): Promise<AutomationRow | undefined> {
      const result = await db.execute<AutomationRow>(
        sql`select ${selection} from automations
             where owner_user_id = ${ownerUserId} and id = ${id}
             limit 1`,
      );
      const row = result.rows[0];
      return row ? dates(row) : undefined;
    },

    async setEnabled(input: {
      ownerUserId: string;
      id: string;
      enabled: boolean;
      bumpVersion?: boolean;
      now: Date;
    }): Promise<AutomationRow | undefined> {
      const result = await db.execute<AutomationRow>(
        sql`update automations
               set enabled = ${input.enabled},
                   schedule_version = schedule_version + ${input.bumpVersion ? 1 : 0},
                   revision = revision + 1,
                   updated_at = ${input.now}
             where owner_user_id = ${input.ownerUserId} and id = ${input.id}
             returning ${selection}`,
      );
      const row = result.rows[0];
      return row ? dates(row) : undefined;
    },

    async advance(input: {
      ownerUserId: string;
      id: string;
      nextRunAt: Date;
      enabled: boolean;
      now: Date;
    }): Promise<void> {
      await db.execute(
        sql`update automations
               set next_run_at = ${input.nextRunAt},
                   enabled = ${input.enabled},
                   revision = revision + 1,
                   updated_at = ${input.now}
             where owner_user_id = ${input.ownerUserId} and id = ${input.id}`,
      );
    },

    async cancelPending(
      ownerUserId: string,
      id: string,
      now: Date,
    ): Promise<void> {
      await db.execute(
        sql`update automation_occurrences
               set status = 'canceled', updated_at = ${now}
             where owner_user_id = ${ownerUserId}
               and automation_id = ${id}
               and status = 'pending'`,
      );
    },

    async enqueueOccurrence(input: {
      id: string;
      ownerUserId: string;
      automationId: string;
      scheduleVersion: number;
      scheduledAt: Date;
      now: Date;
    }): Promise<void> {
      await db.execute(
        sql`insert into automation_occurrences
              (id, owner_user_id, automation_id, schedule_version,
               scheduled_at, status, created_at, updated_at)
            values (
              ${input.id}, ${input.ownerUserId}, ${input.automationId},
              ${input.scheduleVersion}, ${input.scheduledAt}, 'pending',
              ${input.now}, ${input.now}
            )
            on conflict (automation_id, schedule_version, scheduled_at) do nothing`,
      );
    },

    async claimDue(input: {
      now: Date;
      limit: number;
      leaseMs: number;
    }): Promise<AutomationClaim[]> {
      const bounded = Math.max(1, Math.min(input.limit, 50));
      return db.transaction(async (transaction) => {
        const selected = await transaction.execute<{
          occurrenceId: string;
          ownerUserId: string;
          automationId: string;
          scheduleVersion: number;
          scheduledAt: Date;
          leaseGeneration: number;
          title: string;
          kind: "reminder";
          schedule: Record<string, unknown>;
          timezone: string;
        }>(
          sql`select occurrence.id as "occurrenceId",
                     occurrence.owner_user_id as "ownerUserId",
                     occurrence.automation_id as "automationId",
                     occurrence.schedule_version as "scheduleVersion",
                     occurrence.scheduled_at as "scheduledAt",
                     occurrence.lease_generation as "leaseGeneration",
                     automation.title, automation.kind, automation.schedule,
                     automation.timezone
                from automation_occurrences occurrence
                join automations automation
                  on automation.id = occurrence.automation_id
                 and automation.owner_user_id = occurrence.owner_user_id
               where occurrence.status = 'pending'
                 and occurrence.scheduled_at <= ${input.now}
                 and automation.enabled
               order by occurrence.scheduled_at, occurrence.id
               for update of occurrence skip locked
               limit ${bounded}`,
        );
        const claims: AutomationClaim[] = [];
        for (const row of selected.rows) {
          const updated = await transaction.execute<{
            leaseGeneration: number;
          }>(
            sql`update automation_occurrences
                   set status = 'claimed',
                       lease_until = ${new Date(input.now.getTime() + input.leaseMs)},
                       lease_generation = lease_generation + 1,
                       updated_at = ${input.now}
                 where id = ${row.occurrenceId}
                   and status = 'pending'
                 returning lease_generation as "leaseGeneration"`,
          );
          const claim = updated.rows[0];
          if (!claim) continue;
          claims.push({
            occurrenceId: row.occurrenceId,
            ownerUserId: row.ownerUserId,
            automationId: row.automationId,
            scheduleVersion: Number(row.scheduleVersion),
            scheduledAt: new Date(row.scheduledAt),
            leaseGeneration: Number(claim.leaseGeneration),
            title: row.title,
            kind: row.kind,
            schedule: row.schedule,
            timezone: row.timezone,
          });
        }
        return claims;
      });
    },

    async completeOccurrence(input: {
      id: string;
      generation: number;
      now: Date;
    }): Promise<boolean> {
      const result = await db.execute<{ id: string }>(
        sql`update automation_occurrences
               set status = 'completed',
                   completed_at = ${input.now},
                   error_code = null,
                   updated_at = ${input.now}
             where id = ${input.id}
               and status = 'claimed'
               and lease_generation = ${input.generation}
             returning id`,
      );
      return result.rows.length > 0;
    },

    async failOccurrence(input: {
      id: string;
      generation: number;
      errorCode: string;
      now: Date;
    }): Promise<void> {
      await db.execute(
        sql`update automation_occurrences
               set status = 'failed',
                   error_code = ${input.errorCode},
                   updated_at = ${input.now}
             where id = ${input.id}
               and status = 'claimed'
               and lease_generation = ${input.generation}`,
      );
    },
  };
}
